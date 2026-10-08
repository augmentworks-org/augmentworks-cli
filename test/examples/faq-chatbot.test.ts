import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runInit } from "../../src/commands/init.js";
import { runSourceCli } from "../util/cli-process.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const exampleRoot = resolve(projectRoot, "examples/faq-chatbot");
const directories: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "augmentworks-faq-example-"));
  directories.push(directory);
  return directory;
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
  }
  throw new Error("fixture server did not become healthy");
}

function startServer(directory: string, origin: string, token: string, policy: "current" | "stale"): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ["--env-file=.env", "server.mjs"], {
    cwd: directory,
    env: {
      ...process.env,
      AW_FAQ_POLICY: policy,
      CHATBOT_BASE_URL: origin,
      CHATBOT_API_KEY: token
    },
    stdio: "ignore",
    windowsHide: true
  });
  children.push(child);
  return child;
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  await new Promise((fulfill) => setTimeout(fulfill, 200));
  if (child.exitCode === null) child.kill("SIGTERM");
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stopChild(child)));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("faq chatbot example", () => {
  it("rejects an unknown policy mode before listening", async () => {
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: exampleRoot,
      env: { ...process.env, AW_FAQ_POLICY: "wrong" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exitCode = await new Promise<number | null>((fulfill) => {
      child.once("close", (code) => fulfill(code));
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("AW_FAQ_POLICY must be current or stale.");
  });

  it("passes the current answer and fails the stale answer with local exits 0 and 10", async () => {
    const directory = await temporaryDirectory();
    await cp(exampleRoot, directory, { recursive: true });
    const port = await freeLoopbackPort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const token = "faq-example-local";
    await writeFile(
      resolve(directory, ".env"),
      `CHATBOT_BASE_URL=${origin}\nCHATBOT_API_KEY=${token}\n`,
      "utf8"
    );

    const current = startServer(directory, origin, token, "current");
    await waitForHealth(origin, current);

    const doctor = await runSourceCli(["doctor", "-c", "augmentworks.yaml"], { cwd: directory });
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain("WARN ASSESSMENT_FILE_ABSENT");
    expect(doctor.stdout).toContain("Doctor passed.");

    const preview = await runSourceCli(
      ["preview-mapping", "-c", "augmentworks.yaml", "--operation", "send", "--fixture", "./fixtures/send-response.json"],
      { cwd: directory }
    );
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("Missing required fields");
    expect(preview.stdout).toContain("(none)");

    const passed = await runSourceCli(
      ["test", "--local", "-c", "augmentworks.yaml", "--packet", "./packet.json", "--output-dir", resolve(directory, "out-pass")],
      { cwd: directory, timeoutMs: 30_000 }
    );
    expect(passed.exitCode).toBe(0);
    expect(passed.stderr).toContain("LOCAL MODE — only the configured target will be contacted.");
    expect(passed.stderr).toContain("Starting 1 local attempt(s).");
    expect(passed.stderr).toContain("Running faq-chatbot-return-window.direct repetition 1.");
    expect(passed.stderr).toContain("Attempt passed.");
    expect(passed.stdout).toContain("Local assessment passed.");
    expect(passed.stdout).toContain("Local, customer-executed result.");

    const incompatible = await runSourceCli(
      [
        "preview-mapping",
        "-c",
        "augmentworks.incompatible.yaml",
        "--operation",
        "send",
        "--fixture",
        "./fixtures/send-response.json"
      ],
      { cwd: directory }
    );
    expect(incompatible.exitCode).toBe(2);
    expect(incompatible.stdout).toContain("$.reply");
    expect(incompatible.stdout).toContain("Missing required fields");
    expect(incompatible.stdout).toContain("MAPPING_VALUE_MISSING");
    expect(incompatible.stdout).toContain("No value exists at $.reply.");

    const probe = await runSourceCli(
      ["probe", "-c", "augmentworks.incompatible.yaml", "--yes"],
      { cwd: directory, env: { CHATBOT_BASE_URL: origin, CHATBOT_API_KEY: token }, timeoutMs: 30_000 }
    );
    expect(probe.exitCode).toBe(5);
    expect(probe.stdout).toContain("PROBE_RESPONSE_SELECTOR");
    expect(probe.stdout).toContain("Mapped field content was missing at $.reply.");
    expect(probe.stdout).toContain("This is not a chatbot semantic failure.");

    await stopChild(current);

    const stale = startServer(directory, origin, token, "stale");
    await waitForHealth(origin, stale);
    const failed = await runSourceCli(
      ["test", "--local", "-c", "augmentworks.yaml", "--packet", "./packet.json", "--output-dir", resolve(directory, "out-fail")],
      { cwd: directory, timeoutMs: 30_000 }
    );
    expect(failed.exitCode).toBe(10);
    expect(failed.stderr).toContain("Attempt failed.");
    expect(failed.stdout).toContain("Local assessment failed.");
    const failedJson = await runSourceCli(
      [
        "test",
        "--local",
        "-c",
        "augmentworks.yaml",
        "--packet",
        "./packet.json",
        "--output-dir",
        resolve(directory, "out-fail-json"),
        "--json"
      ],
      { cwd: directory, timeoutMs: 30_000 }
    );
    expect(failedJson.exitCode).toBe(10);
    const parsed = JSON.parse(failedJson.stdout) as { outcome: string; attempts: Array<{ assertions: Array<{ key: string; passed: boolean }> }> };
    expect(parsed.outcome).toBe("failed");
    expect(parsed.attempts[0]?.assertions.find((item) => item.key === "states-30-day-window")?.passed).toBe(false);
  });

  it("reports malformed YAML and a missing target credential as configuration errors", async () => {
    const directory = await temporaryDirectory();
    await cp(exampleRoot, directory, { recursive: true });
    const malformed = await runSourceCli(["doctor", "-c", "augmentworks.malformed.yaml"], {
      cwd: directory,
      env: { CHATBOT_BASE_URL: "http://127.0.0.1:9", CHATBOT_API_KEY: "present" }
    });
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stdout).toContain("YAML_PARSE_ERROR");
    expect(malformed.stdout).toContain("Flow sequence in block collection must be sufficiently indented and end with a ]");
    expect(malformed.stdout).toContain("Doctor found configuration errors.");

    const missing = await runSourceCli(["doctor", "-c", "augmentworks.yaml"], {
      cwd: directory,
      env: { CHATBOT_BASE_URL: "", CHATBOT_API_KEY: "" }
    });
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toContain("ENV_REQUIRED");
    expect(missing.stdout).toContain("Required environment variable CHATBOT_API_KEY is not set.");
  });

  it("preserves an existing .env when init is forced", async () => {
    const directory = await temporaryDirectory();
    const envPath = resolve(directory, ".env");
    await writeFile(envPath, "CHATBOT_API_KEY=keep-this-marker\n", "utf8");
    const forced = await runInit({ cwd: directory, force: true, starter: "response-quality" });
    expect(forced.preserved.some((path) => path.endsWith(".env"))).toBe(true);
    expect(await readFile(envPath, "utf8")).toBe("CHATBOT_API_KEY=keep-this-marker\n");

    const second = await runSourceCli(["init", "--starter", "response-quality"], { cwd: directory });
    expect(second.exitCode).toBe(2);
    expect(second.stderr).toContain("Refusing to overwrite existing file");
  });
});
