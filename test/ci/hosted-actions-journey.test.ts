import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { FEATURE_ACTIONS, MACHINE_CI_RECOMMENDED_ACTIONS } from "../../src/auth/types.js";
import { CLI_VERSION } from "../../src/version.js";
import { ensurePackedCliBuilt, runPackedCli, runSourceCli } from "../util/cli-process.js";
import { listenLoopback, readJsonBody, type ListeningServer } from "../util/http-server.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const starterRoot = resolve(projectRoot, "assets/starters/response-quality");
const API_KEY = "aw_api_ci_machine_key_value_not_for_production";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "77777777-7777-4777-8777-777777777777";
const BASELINE_ID = "88888888-8888-4888-8888-888888888888";

const billingFixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-billing-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { status?: number; response: unknown }> };
const policyFixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-release-policy-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { status?: number; response: unknown }> };
const reportFixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-run-report-v1.fixtures.json"), "utf8")
) as { identities: Record<string, Record<string, unknown>> };

const temporaryDirectories: string[] = [];
const servers: ListeningServer[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

function childHasExited(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (childHasExited(child)) return;
  await Promise.race([
    new Promise<void>((fulfill) => {
      const onExit = (): void => fulfill();
      child.once("exit", onExit);
      if (childHasExited(child)) {
        child.off("exit", onExit);
        fulfill();
      }
    }),
    new Promise<void>((fulfill) => {
      const timer = setTimeout(fulfill, timeoutMs);
      timer.unref?.();
    })
  ]);
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (childHasExited(child)) return;
  child.kill("SIGTERM");
  await waitForChildExit(child, 5_000);
  if (childHasExited(child)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child, 2_000);
}

function isRetryableRemoveError(error: unknown): boolean {
  if (process.platform !== "win32" || typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = error.code;
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

async function removeDirectory(directory: string): Promise<void> {
  const attempts = process.platform === "win32" ? 8 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableRemoveError(error) || attempt === attempts - 1) throw error;
      await new Promise((fulfill) => setTimeout(fulfill, 25 * 2 ** attempt));
    }
  }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stopChild(child)));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

beforeAll(async () => {
  await ensurePackedCliBuilt();
}, 120_000);

async function starterCwd(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-cli-hosted-ci-"));
  temporaryDirectories.push(directory);
  await cp(starterRoot, directory, { recursive: true });
  return directory;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function ciIdentity(actions: readonly string[]): Record<string, unknown> {
  const reportOnly = reportFixtures.identities["machine_report_only"];
  if (reportOnly === undefined) throw new Error("missing AW-QA-1 machine_report_only identity");
  return {
    ...reportOnly,
    workspace_id: WORKSPACE,
    subject: "machine_ci",
    credential_id: "cred_ci",
    actions
  };
}

const executeActions = MACHINE_CI_RECOMMENDED_ACTIONS;

const reportOnlyActions = [
  FEATURE_ACTIONS.runRead,
  FEATURE_ACTIONS.evaluationRead,
  FEATURE_ACTIONS.criterionDetailRead
] as const;

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) => Promise<boolean> | boolean;

async function startMock(handler: Handler): Promise<{ server: ListeningServer; paths: string[] }> {
  const paths: string[] = [];
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    paths.push(`${request.method ?? "GET"} ${url.pathname}`);
    void Promise.resolve(handler(request, response, url)).then((handled) => {
      if (!handled && !response.writableEnded) {
        send(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
      }
    });
  });
  const server = await listenLoopback(httpServer);
  servers.push(server);
  return { server, paths };
}

function packedEnv(apiOrigin: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DBUS_SESSION_BUS_ADDRESS: "",
    AUGMENTWORKS_API_URL: apiOrigin,
    AUGMENTWORKS_API_KEY: API_KEY,
    AUGMENTWORKS_TOKEN: "",
    AUGMENTWORKS_REFRESH_TOKEN: "",
    AUGMENTWORKS_HEADLESS: "1",
    CI: "1",
    NO_COLOR: "1",
    CHATBOT_BASE_URL: "http://127.0.0.1:9",
    CHATBOT_API_KEY: "ci-synthetic-target-key",
    ...extra
  };
}

async function isolatedPackedEnv(
  apiOrigin: string,
  extra: Record<string, string | undefined> = {}
): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
  const cwd = await starterCwd();
  const home = await mkdtemp(join(tmpdir(), "aw-cli-hosted-ci-home-"));
  const state = await mkdtemp(join(tmpdir(), "aw-cli-hosted-ci-state-"));
  temporaryDirectories.push(home, state);
  return {
    cwd,
    env: packedEnv(apiOrigin, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_STATE_HOME: state,
      AUGMENTWORKS_STATE_DIR: state,
      ...extra
    })
  };
}

function fixture(name: string): { status: number; response: unknown } {
  const entry = policyFixtures.fixtures[name];
  if (entry === undefined) throw new Error(`missing policy fixture ${name}`);
  return { status: entry.status ?? 200, response: entry.response };
}

function billing(name: string): { status: number; response: unknown } {
  const entry = billingFixtures.fixtures[name];
  if (entry === undefined) throw new Error(`missing billing fixture ${name}`);
  return { status: entry.status ?? 200, response: entry.response };
}

function capabilities(): unknown {
  return billing("eligible_trial").response;
}

const HOSTED_RECIPE = "docs/examples/github-actions-hosted.yml";
const GATE_RECIPE = "docs/examples/github-actions-hosted-gate.yml";
const HOSTED_RECIPE_STEP = "Estimate, admit with a ceiling, wait, gate, and recover";
const GATE_RECIPE_STEP = "Estimate, run with an explicit ceiling, wait, then gate";

const recipeCases = [
  { file: HOSTED_RECIPE, step: HOSTED_RECIPE_STEP },
  { file: GATE_RECIPE, step: GATE_RECIPE_STEP }
] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function readRecipe(path: string): Promise<string> {
  return (await readFile(resolve(projectRoot, path), "utf8")).replace(/\r\n?/gu, "\n");
}

function extractStepScript(yaml: string, stepName: string): string {
  const lines = yaml.split("\n");
  const nameIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (nameIndex < 0) throw new Error(`missing step ${stepName}`);
  let runIndex = -1;
  let runIndent = 0;
  for (let index = nameIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s+- name:/.test(line)) break;
    const match = /^(\s+)run:\s+\|\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      runIndex = index;
      runIndent = match[1].length;
      break;
    }
  }
  if (runIndex < 0) throw new Error(`missing run script for ${stepName}`);
  const bodyIndent = runIndent + 2;
  const body: string[] = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
    if (indent < bodyIndent) break;
    body.push(line.slice(bodyIndent));
  }
  return `${body.join("\n")}\n`;
}

function waitJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    observation: "succeeded",
    work: "terminal",
    assessment: "incomplete",
    exit_code: EXIT.EVALUATION_INCOMPLETE,
    schemaVersion: "aw-billing/1",
    runId: RUN_ID,
    originalRunId: RUN_ID,
    executionStatus: "completed",
    evaluationStatus: "complete",
    outcome: null,
    ...overrides
  };
}

function captureChild(child: ReturnType<typeof spawn>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  children.push(child);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

let bashProbe: Promise<boolean> | undefined;

function bashAvailable(): Promise<boolean> {
  bashProbe ??= new Promise((resolveAvailable) => {
    const child = spawn("bash", ["-c", "exit 0"], { stdio: "ignore", windowsHide: true });
    child.once("error", () => resolveAvailable(false));
    child.once("exit", (code) => resolveAvailable(code === 0));
  });
  return bashProbe;
}

const CLI_STUB = `import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const logPath = process.env.AW_LOG;
if (logPath !== undefined && logPath !== "") {
  appendFileSync(logPath, JSON.stringify(args) + "\\n");
}
const command = args[0];
const subcommand = args[1];
if (command === "whoami") {
  process.stdout.write("{}\\n");
  process.exit(0);
}
if (command === "test" && args.includes("--estimate")) {
  process.stdout.write("{}\\n");
  process.exit(0);
}
if (command === "test") {
  process.stdout.write(JSON.stringify({ run_id: process.env.AW_RUN_ID }) + "\\n");
  process.exit(0);
}
if (command === "run" && subcommand === "wait") {
  const waitFile = process.env.AW_WAIT_FILE;
  if (waitFile === undefined || waitFile === "") {
    process.stderr.write("AW_WAIT_FILE missing\\n");
    process.exit(99);
  }
  const body = readFileSync(waitFile, "utf8");
  process.stdout.write(body.endsWith("\\n") ? body : body + "\\n");
  process.exit(Number(process.env.AW_WAIT_CODE));
}
if (command === "gate") {
  process.stdout.write('{"ok":true}\\n');
  process.exit(Number(process.env.AW_GATE_CODE ?? "0"));
}
if (command === "recover" || (command === "run" && subcommand === "report")) {
  process.stdout.write("{}\\n");
  process.exit(0);
}
process.stderr.write("unexpected argv " + JSON.stringify(args) + "\\n");
process.exit(99);
`;

async function executeRecipe(
  script: string,
  input: { readonly waitBody: string; readonly waitCode: number; readonly gateCode: number }
): Promise<{ exitCode: number; stdout: string; stderr: string; log: string; summary: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "aw-cli-hosted-recipe-"));
  temporaryDirectories.push(cwd);
  const bin = join(cwd, "bin");
  await mkdir(join(cwd, ".augmentworks", "ci"), { recursive: true });
  await mkdir(bin, { recursive: true });
  const stubPath = join(bin, "aw-stub.mjs");
  await writeFile(stubPath, CLI_STUB, "utf8");
  const nodePath = process.execPath;
  await writeFile(
    join(bin, "npx"),
    `#!/bin/sh
if [ "$1" != "--yes" ]; then
  echo "unexpected npx invocation: $*" >&2
  exit 99
fi
shift 2
exec ${shellQuote(nodePath)} ${shellQuote(stubPath)} "$@"
`,
    "utf8"
  );
  await writeFile(
    join(bin, "node"),
    `#!/bin/sh
if [ "$1" = "dist/index.js" ]; then
  shift
  exec ${shellQuote(nodePath)} ${shellQuote(stubPath)} "$@"
fi
exec ${shellQuote(nodePath)} "$@"
`,
    "utf8"
  );
  await chmod(join(bin, "npx"), 0o755);
  await chmod(join(bin, "node"), 0o755);
  const waitFile = join(cwd, "wait-fixture.json");
  await writeFile(waitFile, input.waitBody, "utf8");
  const logPath = join(cwd, "invocations.log");
  const summaryPath = join(cwd, "summary.md");
  const runnerTemp = join(cwd, "runner");
  await mkdir(runnerTemp, { recursive: true });
  await writeFile(join(runnerTemp, "chatbot-api-key"), "ci-synthetic-target-key", "utf8");
  await writeFile(join(cwd, "recipe.sh"), script, "utf8");
  const result = await captureChild(
    spawn("bash", ["-e", "-o", "pipefail", join(cwd, "recipe.sh")], {
      cwd,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
        AW_LOG: logPath,
        AW_WAIT_FILE: waitFile,
        AW_WAIT_CODE: String(input.waitCode),
        AW_GATE_CODE: String(input.gateCode),
        AW_RUN_ID: RUN_ID,
        AUGMENTWORKS_BASELINE_ID: BASELINE_ID,
        AUGMENTWORKS_WORKSPACE_ID: WORKSPACE,
        RUNNER_TEMP: runnerTemp,
        GITHUB_STEP_SUMMARY: summaryPath
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    })
  );
  const log = await readFile(logPath, "utf8").catch(() => "");
  const summary = await readFile(summaryPath, "utf8").catch(() => "");
  return { ...result, log, summary };
}

function invocations(log: string): string[][] {
  return log
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as string[]);
}

function gateInvocation(log: string): string[] | undefined {
  return invocations(log).find((args) => args[0] === "gate");
}

async function freeLoopbackPort(): Promise<number> {
  return await new Promise((fulfill, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not bind a loopback port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error !== undefined) reject(error);
        else fulfill(port);
      });
    });
  });
}

async function waitForHealth(origin: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`fixture server exited ${String(child.exitCode)}`);
    }
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(400) });
      if (response.ok) return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  throw new Error("fixture server did not become healthy");
}

describe("hosted GitHub Actions recipe", () => {
  it("documents fork-PR skipping, no pull_request_target, cleanup, and provenance via gate", async () => {
    const recipe = (await readFile(resolve(projectRoot, "docs/examples/github-actions-hosted.yml"), "utf8")).replace(
      /\r\n?/gu,
      "\n"
    );
    expect(recipe).toContain("AUGMENTWORKS_API_KEY");
    expect(recipe).toContain("AUGMENTWORKS_BASELINE_ID");
    expect(recipe).toContain("AUGMENTWORKS_WORKSPACE_ID");
    expect(recipe).toContain("--headless");
    expect(recipe).toContain("--max-credits");
    expect(recipe).toContain("run wait");
    expect(recipe).toContain("gate --run");
    expect(recipe).toContain("doctor --offline");
    expect(recipe).toContain("preview-mapping");
    expect(recipe).toContain("suite validate");
    expect(recipe).toContain("investigation inspect");
    expect(recipe).toContain("recover --json");
    expect(recipe).toContain("GITHUB_STEP_SUMMARY");
    expect(recipe).toContain("upload-artifact");
    expect(recipe).toContain("retention-days: 7");
    expect(recipe).toContain("timeout-minutes: 20");
    expect(recipe).toContain("cancel-in-progress: false");
    expect(recipe).toContain("contents: read");
    expect(recipe).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(recipe).toContain("Stop synthetic target");
    expect(recipe).toContain("if: ${{ always() }}");
    expect(recipe).toContain("own_target.ci_result_recorded");
    expect(recipe).toContain("/v1/release-gates/evaluate");
    expect(recipe).toMatch(/Do not use[\s#]{1,20}pull_request_target/);
    expect(recipe).not.toMatch(/(?:^|\n)\s+pull_request_target:/u);
    expect(recipe).not.toMatch(/(?:^|\n)\s+logout\b/u);
    expect(recipe).not.toContain("baseline promote");
    expect(recipe).not.toContain("npx @augmentworks/cli@latest");
    expect(recipe).toContain(`@augmentworks/cli@${CLI_VERSION}`);
    expect(recipe).toContain("run:execute");
    expect(recipe).toContain("Do not grant purchase");
  });

  it("completes offline doctor, mapping preview, and suite validate against the packaged starter", async () => {
    const cwd = await starterCwd();
    const port = await freeLoopbackPort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const token = "ci-synthetic-target-key";
    const child = spawn(process.execPath, [resolve(cwd, "server.mjs")], {
      cwd,
      env: {
        ...process.env,
        CHATBOT_BASE_URL: origin,
        CHATBOT_API_KEY: token
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    children.push(child);
    await waitForHealth(origin, child);

    const isolated = await isolatedPackedEnv("http://127.0.0.1:1", {
      AUGMENTWORKS_API_KEY: "",
      CHATBOT_BASE_URL: origin,
      CHATBOT_API_KEY: token
    });
    const env = isolated.env;
    const doctor = await runPackedCli(["doctor", "--offline", "-c", "augmentworks.yaml"], {
      cwd,
      env
    });
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain("OFFLINE_CHECK_COMPLETE");

    const preview = await runPackedCli(
      [
        "preview-mapping",
        "-c",
        "augmentworks.yaml",
        "--operation",
        "send",
        "--fixture",
        "./fixtures/send-response.json",
        "--json"
      ],
      { cwd, env }
    );
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).not.toContain(token);
    expect(preview.stdout).not.toContain(API_KEY);

    const suite = await runPackedCli(["suite", "validate", "own-chatbot.suite.yaml", "--json"], { cwd, env });
    expect(suite.exitCode).toBe(0);
    const payload = JSON.parse(suite.stdout) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });

  it("exits 3 without credentials in headless mode and does not contact the API", async () => {
    const { server, paths } = await startMock(() => false);
    const { cwd, env } = await isolatedPackedEnv(server.baseUrl, {
      AUGMENTWORKS_API_KEY: "",
      AUGMENTWORKS_TOKEN: ""
    });
    const result = await runPackedCli(
      ["test", "--suite", "own-chatbot.suite.yaml", "--estimate", "--json", "--headless"],
      { cwd, env }
    );
    expect(result.exitCode).toBe(EXIT.AUTH);
    const payload = JSON.parse(result.stdout) as { ok: boolean; code: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("AUTH_REQUIRED");
    expect(result.stdout).not.toContain("login first");
    expect(paths).toEqual([]);
  });

  it("maps a revoked machine key to exit 3 without quoting", async () => {
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 401, { error: "invalid_token" });
        return true;
      }
      return false;
    });
    const { cwd, env } = await isolatedPackedEnv(server.baseUrl);
    const result = await runPackedCli(
      ["test", "--suite", "own-chatbot.suite.yaml", "--estimate", "--json", "--headless"],
      { cwd, env }
    );
    expect(result.exitCode).toBe(EXIT.AUTH);
    const payload = JSON.parse(result.stdout) as { ok: boolean; code: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("API_KEY_REVOKED");
    expect(paths).toEqual(["GET /api/v1/cli/auth/me"]);
    expect(paths.some((path) => path.includes("/v1/billing/quote"))).toBe(false);
    expect(paths.some((path) => path.includes("/v1/relay/runs"))).toBe(false);
  });

  it("blocks a report-only machine key before suite pin or quote", async () => {
    const reportOnly = reportFixtures.identities["machine_report_only"];
    if (reportOnly === undefined) throw new Error("missing AW-QA-1 machine_report_only identity");
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, reportOnly);
        return true;
      }
      return false;
    });
    const { cwd, env } = await isolatedPackedEnv(server.baseUrl);
    const result = await runPackedCli(
      ["test", "--suite", "own-chatbot.suite.yaml", "--estimate", "--json", "--headless"],
      { cwd, env }
    );
    expect(result.exitCode).toBe(EXIT.AUTH);
    const payload = JSON.parse(result.stdout) as { ok: boolean; code: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("MACHINE_ACTION_DENIED");
    expect(reportOnlyActions).toEqual(reportOnly["actions"]);
    expect(paths).toEqual(["GET /api/v1/cli/auth/me"]);
    expect(paths).not.toContain("POST /v1/suites");
    expect(paths).not.toContain("POST /v1/billing/quote");
    expect(paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);
  });

  it("returns billing denial exit 13 without creating a run", async () => {
    const denied = billing("error_insufficient_credits");
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, ciIdentity(executeActions));
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/suites") {
        const body = (await readJsonBody(request)) as { contentHash: string };
        send(response, 200, {
          suiteId: "customer.own_chatbot.faq",
          revisionId: "rev_ci_1",
          contentHash: body.contentHash
        });
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        send(response, 200, capabilities());
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/billing/quote") {
        send(response, denied.status, denied.response);
        return true;
      }
      return false;
    });
    const { cwd, env } = await isolatedPackedEnv(server.baseUrl);
    const result = await runPackedCli(
      [
        "test",
        "--assessment",
        "augmentworks.assessment.yaml",
        "--max-credits",
        "30",
        "--yes",
        "--json",
        "--headless"
      ],
      { cwd, env }
    );
    expect(result.exitCode).toBe(EXIT.BILLING);
    expect(paths).not.toContain("POST /v1/relay/runs");
    expect(paths.filter((path) => path === "POST /v1/billing/quote")).toHaveLength(1);
  });

  it("keeps an integration failure on the original command and does not create a run", async () => {
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, ciIdentity(executeActions));
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        send(response, 500, { error: { code: "NOT_FOUND", message: "upstream failed" } });
        return true;
      }
      return false;
    });
    const { cwd, env } = await isolatedPackedEnv(server.baseUrl);
    const result = await runPackedCli(
      [
        "test",
        "--assessment",
        "augmentworks.assessment.yaml",
        "--max-credits",
        "30",
        "--yes",
        "--json",
        "--headless"
      ],
      { cwd, env }
    );
    expect(result.exitCode).not.toBe(EXIT.OK);
    expect(result.exitCode).not.toBe(EXIT.ASSESSMENT_FAILED);
    expect(paths).toContain("GET /v1/billing/capabilities");
    expect(paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);
    expect(paths).not.toContain("POST /v1/billing/quote");
  });

  it("blocks a required regression at gate and never treats pending grading as a pass", async () => {
    const blocked = fixture("blocked_equal_pass_rate");
    const pending = fixture("incomplete_pending");
    const gradingError = fixture("evaluator_error");
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, ciIdentity(executeActions));
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/release-gates/evaluate") {
        const body = (await readJsonBody(request)) as Record<string, unknown>;
        expect(body["schemaVersion"]).toBe("aw-release-policy/1");
        expect(body["candidateRunId"]).toBe(RUN_ID);
        expect(body["baselineId"]).toBe(BASELINE_ID);
        send(response, blocked.status, blocked.response);
        return true;
      }
      return false;
    });
    const { cwd, env } = await isolatedPackedEnv(server.baseUrl);
    const regression = await runPackedCli(
      ["gate", "--run", RUN_ID, "--baseline", BASELINE_ID, "--json"],
      { cwd, env }
    );
    expect(regression.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    const regressionPayload = JSON.parse(regression.stdout) as {
      ok: boolean;
      assessment: string;
      candidateRunId: string;
      createsBillableRun: boolean;
    };
    expect(regressionPayload.ok).toBe(true);
    expect(regressionPayload.assessment).toBe("blocked");
    expect(regressionPayload.candidateRunId).toBe(RUN_ID);
    expect(regressionPayload.createsBillableRun).toBe(false);
    expect(regression.stdout).not.toContain(API_KEY);
    expect(paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);

    const pendingServer = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, ciIdentity(executeActions));
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/release-gates/evaluate") {
        send(response, pending.status, pending.response);
        return true;
      }
      return false;
    });
    const pendingCtx = await isolatedPackedEnv(pendingServer.server.baseUrl);
    const incomplete = await runPackedCli(
      ["gate", "--run", RUN_ID, "--baseline", BASELINE_ID, "--json"],
      pendingCtx
    );
    expect(incomplete.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(incomplete.exitCode).not.toBe(EXIT.OK);
    expect(pendingServer.paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);

    const errorServer = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, ciIdentity(executeActions));
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/release-gates/evaluate") {
        send(response, gradingError.status, gradingError.response);
        return true;
      }
      return false;
    });
    const errorCtx = await isolatedPackedEnv(errorServer.server.baseUrl);
    const gradingFailed = await runPackedCli(
      ["gate", "--run", RUN_ID, "--baseline", BASELINE_ID, "--json"],
      errorCtx
    );
    expect(gradingFailed.exitCode).toBe(EXIT.EVALUATION_ERROR);
    expect(errorServer.paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);
  });

  it("keeps wait and recover observation-only on the original run id", async () => {
    const pendingStatus = billing("status_pending_grading");
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, ciIdentity(executeActions));
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        send(response, 200, capabilities());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/status") {
        const status = pendingStatus.response as Record<string, unknown>;
        send(response, 200, { ...status, runId: RUN_ID, originalRunId: RUN_ID });
        return true;
      }
      return false;
    });
    const { cwd, env } = await isolatedPackedEnv(server.baseUrl);
    const wait = await runPackedCli(["run", "wait", RUN_ID, "--json", "--timeout-ms", "1"], {
      cwd,
      env
    });
    expect(wait.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(wait.stdout).toContain(RUN_ID);
    expect(paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);
    expect(paths).not.toContain("POST /v1/billing/quote");

    const recover = await runPackedCli(["recover", "--json"], { cwd, env });
    expect(recover.exitCode).toBe(0);
    expect(paths.filter((path) => path === "POST /v1/relay/runs")).toHaveLength(0);
  });

  it("reports interruption on the original cancelled run without quoting", async () => {
    const pendingStatus = billing("status_pending_grading");
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, ciIdentity(executeActions));
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        send(response, 200, capabilities());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/status") {
        const status = pendingStatus.response as Record<string, unknown>;
        send(response, 200, {
          ...status,
          runId: RUN_ID,
          originalRunId: RUN_ID,
          executionStatus: "cancelled",
          evaluationStatus: "absent"
        });
        return true;
      }
      return false;
    });
    const { cwd, env } = await isolatedPackedEnv(server.baseUrl, {
      AUGMENTWORKS_API_KEY: "",
      AUGMENTWORKS_TOKEN: API_KEY
    });
    const wait = await runPackedCli(["run", "wait", RUN_ID, "--json", "--timeout-ms", "1000"], {
      cwd,
      env
    });
    expect(wait.exitCode).toBe(EXIT.INTERRUPTED);
    expect(wait.stdout).toContain(RUN_ID);
    expect(paths).not.toContain("POST /v1/billing/quote");
    expect(paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);
  });

  it("keeps a completed grading status with a null billing outcome at wait exit 11", async () => {
    const pendingStatus = billing("status_pending_grading");
    const completed = {
      ...(pendingStatus.response as Record<string, unknown>),
      runId: RUN_ID,
      originalRunId: RUN_ID,
      workspaceId: WORKSPACE,
      executionStatus: "completed",
      evaluationStatus: "complete",
      outcome: null,
      savedEvidence: true,
      retryEligible: false,
      progress: {
        completedAttempts: 4,
        plannedAttempts: 4,
        completedJudgeJobs: 4,
        plannedJudgeJobs: 4
      }
    };
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, ciIdentity(executeActions));
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        send(response, 200, capabilities());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/status") {
        send(response, 200, completed);
        return true;
      }
      return false;
    });
    const { cwd, env } = await isolatedPackedEnv(server.baseUrl);
    const wait = await runPackedCli(["run", "wait", RUN_ID, "--json", "--timeout-ms", "1000"], {
      cwd,
      env
    });
    expect(wait.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(wait.exitCode).not.toBe(EXIT.OK);
    const waited = JSON.parse(wait.stdout) as {
      ok: boolean;
      assessment: string;
      work: string;
      executionStatus: string;
      evaluationStatus: string;
      outcome: unknown;
    };
    expect(waited.ok).toBe(true);
    expect(waited.assessment).toBe("incomplete");
    expect(waited.work).toBe("terminal");
    expect(waited.executionStatus).toBe("completed");
    expect(waited.evaluationStatus).toBe("complete");
    expect(waited.outcome).toBeNull();

    const status = await runPackedCli(["run", "status", RUN_ID, "--json"], { cwd, env });
    expect(status.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(status.exitCode).not.toBe(EXIT.OK);
    expect(paths.some((path) => path.startsWith("POST /v1/release-gates"))).toBe(false);
    expect(paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);
    expect(paths).not.toContain("POST /v1/billing/quote");
  });

  it("still dispatches existing commands from the same registry", async () => {
    const help = await runSourceCli(["--help"], { cwd: projectRoot });
    expect(help.exitCode).toBe(0);
    for (const command of [
      "login",
      "whoami",
      "test",
      "suite",
      "investigation",
      "run",
      "compare",
      "gate",
      "baseline",
      "recover"
    ]) {
      expect(help.stdout).toMatch(new RegExp(`^  ${command}`, "m"));
    }
  });

  it(
    "gates only a run that run wait graded, and stops while grading is unfinished (AUG-384)",
    { timeout: 60_000 },
    async () => {
      const scripts = await Promise.all(
        recipeCases.map(async ({ file, step }) => extractStepScript(await readRecipe(file), step))
      );
      const hostedScript = scripts[0];
      const gateScript = scripts[1];
      if (hostedScript === undefined || gateScript === undefined) throw new Error("missing recipe script");
      for (const script of [hostedScript, gateScript]) {
        expect(script).not.toContain("grading_ready");
      }

      if (!(await bashAvailable())) {
        if (process.platform === "win32") return;
        throw new Error("bash is required to execute the hosted GitHub Actions recipe");
      }
      for (const script of [hostedScript, gateScript]) {
        const checked = await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
          const child = spawn("bash", ["-n"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
          let stderr = "";
          child.stderr?.setEncoding("utf8");
          child.stderr?.on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.once("error", reject);
          child.once("exit", (code) => resolve({ exitCode: code ?? 1, stderr }));
          child.stdin?.end(script);
        });
        expect(checked.exitCode, checked.stderr).toBe(0);

        const passed = await executeRecipe(script, {
          waitBody: `${JSON.stringify(waitJson({ assessment: "passed", outcome: "passed", exit_code: 0 }))}\n`,
          waitCode: 0,
          gateCode: 0
        });
        expect(passed.exitCode, passed.stderr).toBe(EXIT.OK);
        expect(passed.stderr).not.toContain("Wait did not finish");
        expect(gateInvocation(passed.log)).toEqual(["gate", "--run", RUN_ID, "--baseline", BASELINE_ID, "--json"]);

        // A graded failure still reaches the gate, which compares it with the pin.
        const failed = await executeRecipe(script, {
          waitBody: `${JSON.stringify(waitJson({ assessment: "failed", outcome: "failed", exit_code: 10 }))}\n`,
          waitCode: 10,
          gateCode: 10
        });
        expect(failed.exitCode, failed.stderr).toBe(EXIT.ASSESSMENT_FAILED);
        expect(failed.stderr).not.toContain("Wait did not finish");
        expect(gateInvocation(failed.log)).toBeDefined();

        for (const [body, code] of [
          [waitJson(), EXIT.EVALUATION_INCOMPLETE],
          [waitJson({ evaluationStatus: "partial" }), EXIT.EVALUATION_INCOMPLETE],
          [{ ok: false, code: "EVALUATION_INCOMPLETE", exit_code: 11 }, EXIT.EVALUATION_INCOMPLETE],
          [waitJson({ assessment: "evaluator_error", evaluationStatus: "error", exit_code: 12 }), EXIT.EVALUATION_ERROR]
        ] as const) {
          const stopped = await executeRecipe(script, {
            waitBody: `${JSON.stringify(body)}\n`,
            waitCode: code,
            gateCode: 0
          });
          expect(stopped.exitCode, stopped.stderr).toBe(code);
          expect(stopped.stderr).toContain("Wait did not finish");
          expect(gateInvocation(stopped.log)).toBeUndefined();
        }
      }

      const hostedGraded = await executeRecipe(hostedScript, {
        waitBody: `${JSON.stringify(waitJson({ assessment: "passed", outcome: "passed", exit_code: 0 }))}\n`,
        waitCode: 0,
        gateCode: 0
      });
      expect(hostedGraded.summary).toContain("pending or partial evaluation never reaches this step");
      expect(invocations(hostedGraded.log).some((args) => args[0] === "recover")).toBe(false);
    });
});
