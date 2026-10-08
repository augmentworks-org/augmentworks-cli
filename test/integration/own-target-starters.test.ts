import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runInit } from "../../src/commands/init.js";
import { runProbeCommand } from "../../src/commands/probe.js";
import { runPreviewMapping } from "../../src/commands/preview-mapping.js";
import { loadCustomerSuiteFile } from "../../src/suite/load.js";
import { previewCustomerSuite } from "../../src/suite/preview.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const directories: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "augmentworks-own-target-"));
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  throw new Error("fixture server did not become healthy");
}

function startFixture(script: string, origin: string, token: string, cwd: string): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, [script], {
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
  return child;
}

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
  await Promise.all(directories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("packaged own-target starters", () => {
  it("keeps example fixture servers aligned with packaged assets", async () => {
    expect(await readFile(resolve(projectRoot, "examples/refund-agent/server.mjs"), "utf8")).toBe(
      await readFile(resolve(projectRoot, "assets/starters/workflow/server.mjs"), "utf8")
    );
    expect(await readFile(resolve(projectRoot, "examples/response-agent/server.mjs"), "utf8")).toBe(
      await readFile(resolve(projectRoot, "assets/starters/response-quality/server.mjs"), "utf8")
    );
    expect(await readFile(resolve(projectRoot, "examples/response-agent/session-server.mjs"), "utf8")).toBe(
      await readFile(resolve(projectRoot, "assets/starters/response-quality/session-server.mjs"), "utf8")
    );
    expect(await readFile(resolve(projectRoot, "examples/basic-chat/server.mjs"), "utf8")).toBe(
      await readFile(resolve(projectRoot, "assets/starters/response-quality/server.mjs"), "utf8")
    );
    expect(await readFile(resolve(projectRoot, "examples/faq-chatbot/server.mjs"), "utf8")).toBe(
      await readFile(resolve(projectRoot, "assets/starters/response-quality/server.mjs"), "utf8")
    );
  });

  it("probes the packaged response-only server and validates the five-question suite", async () => {
    const directory = await temporaryDirectory();
    await runInit({ cwd: directory, starter: "response-quality" });
    const origin = `http://127.0.0.1:${String(await freeLoopbackPort())}`;
    const token = "own-target-chat-key";
    const child = startFixture(resolve(directory, "server.mjs"), origin, token, directory);
    await waitForHealth(origin, child);
    const preview = await runPreviewMapping({
      cwd: directory,
      config: "augmentworks.yaml",
      operation: "send",
      fixture: "fixtures/send-response.json"
    });
    expect(preview.ok).toBe(true);
    expect(preview.offline).toBe(true);
    const { report } = await runProbeCommand({
      cwd: directory,
      yes: true,
      processEnv: { CHATBOT_BASE_URL: origin, CHATBOT_API_KEY: token }
    });
    expect(report.ok).toBe(true);
    expect(report.pattern).toBe("response-only");
    const suite = await loadCustomerSuiteFile(resolve(directory, "own-chatbot.suite.yaml"), directory);
    const suitePreview = previewCustomerSuite(suite);
    expect(suitePreview.caseCount).toBe(5);
    expect(suitePreview.localPreview.executesTarget).toBe(false);
    expect(suitePreview.localPreview.callsLlm).toBe(false);
    expect(suite.document.cases.map((item) => item.caseId)).toEqual([
      "faq.returns-window",
      "faq.shipping",
      "faq.password-reset",
      "faq.restocking",
      "faq.warranty"
    ]);
    const session = await runProbeCommand({
      cwd: directory,
      config: "augmentworks.session.yaml",
      yes: true,
      processEnv: { CHATBOT_BASE_URL: origin, CHATBOT_API_KEY: token }
    });
    expect(session.report.ok).toBe(true);
    expect(session.report.preflight.call_count).toBe(2);
    expect(session.report.conversation_strategy).toBe("explicit_session_v1");
  });

  it("probes the packaged workflow server including cleanup", async () => {
    const directory = await temporaryDirectory();
    await runInit({ cwd: directory, starter: "stateful" });
    expect(directory).toBeTruthy();
    const origin = `http://127.0.0.1:${String(await freeLoopbackPort())}`;
    const token = "own-target-workflow-key";
    const child = startFixture(resolve(directory, "server.mjs"), origin, token, directory);
    await waitForHealth(origin, child);
    const { report } = await runProbeCommand({
      cwd: directory,
      yes: true,
      processEnv: { CHATBOT_BASE_URL: origin, CHATBOT_API_KEY: token }
    });
    expect(report.ok).toBe(true);
    expect(report.pattern).toBe("stateful");
    expect(report.calls.map((call) => call.phase)).toEqual(["prepare", "send", "observe", "cleanup"]);
    expect(report.calls.every((call) => call.ok)).toBe(true);
  });
});
