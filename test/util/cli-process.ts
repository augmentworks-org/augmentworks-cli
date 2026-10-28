import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sourceEntrypoint = resolve(projectRoot, "src/index.ts");
const packedEntrypoint = resolve(projectRoot, "dist/index.js");
const tsxImportUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const maxCapturedBytes = 2 * 1024 * 1024;

export interface CliProcessOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly stdin?: string;
  /** Receives the child process, for tests that kill it at a chosen moment. */
  readonly onSpawn?: (child: ChildProcess) => void;
  /** Report a signal-terminated child instead of throwing. */
  readonly allowSignal?: boolean;
}

export interface CliProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runSourceCli(
  args: readonly string[],
  options: CliProcessOptions
): Promise<CliProcessResult> {
  return runNodeCli(
    ["--disable-warning=DEP0205", "--import", tsxImportUrl, sourceEntrypoint, ...args],
    options
  );
}

export async function runPackedCli(
  args: readonly string[],
  options: CliProcessOptions
): Promise<CliProcessResult> {
  await ensurePackedCliBuilt();
  return runNodeCli([packedEntrypoint, ...args], options);
}

let packedBuild: Promise<void> | undefined;

export async function ensurePackedCliBuilt(): Promise<string> {
  packedBuild ??= buildPackedCli();
  await packedBuild;
  return packedEntrypoint;
}

function newestTypescriptMtime(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestTypescriptMtime(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

function packedCliIsCurrent(): boolean {
  if (!existsSync(packedEntrypoint)) return false;
  const distMtime = statSync(packedEntrypoint).mtimeMs;
  const tsupConfig = resolve(projectRoot, "tsup.config.ts");
  const sourceMtime = Math.max(
    newestTypescriptMtime(resolve(projectRoot, "src")),
    existsSync(tsupConfig) ? statSync(tsupConfig).mtimeMs : 0
  );
  return distMtime >= sourceMtime;
}

async function buildPackedCli(): Promise<void> {
  // npm ci `prepare` and `npm run check` already produce dist/. Spawning `npm`
  // here fails on Windows (Node 22+ spawn npm.cmd ENOENT/EINVAL). Rebuild when
  // the artifact is missing or older than TypeScript sources — `npm run check`
  // runs vitest before `npm run build`, so a leftover dist would otherwise
  // hide packed `run wait` classification changes. Invoke tsup through node.
  if (packedCliIsCurrent()) return;
  const tsupCli = createRequire(import.meta.url).resolve("tsup/dist/cli-default.js");
  const result = await runNodeCli([tsupCli], {
    cwd: projectRoot,
    timeoutMs: 120_000
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not build packed CLI (exit ${String(result.exitCode)}): ${result.stderr || result.stdout}`
    );
  }
  if (!existsSync(packedEntrypoint)) {
    throw new Error("Packed CLI build finished without dist/index.js");
  }
}

async function runNodeCli(
  argv: readonly string[],
  options: CliProcessOptions
): Promise<CliProcessResult> {
  const child = spawn(process.execPath, [...argv], {
    cwd: options.cwd,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      ...options.env
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  options.onSpawn?.(child);

  let stdout = "";
  let stderr = "";
  let capturedBytes = 0;
  const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
    capturedBytes += chunk.byteLength;
    if (capturedBytes > maxCapturedBytes) {
      child.kill("SIGTERM");
      return;
    }
    if (target === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));

  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  else child.stdin.end();

  const timeoutMs = options.timeoutMs ?? 20_000;
  let timeout: NodeJS.Timeout | undefined;
  const result = await new Promise<CliProcessResult>((fulfill, reject) => {
    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);
    timeout.unref?.();
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      fulfill({ exitCode, signal, stdout, stderr });
    });
  }).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });

  if (capturedBytes > maxCapturedBytes) {
    throw new Error(`CLI output exceeded ${String(maxCapturedBytes)} bytes`);
  }
  if (result.signal !== null && options.allowSignal !== true) {
    throw new Error(`CLI was terminated by ${result.signal}; stderr: ${result.stderr}`);
  }
  return result;
}
