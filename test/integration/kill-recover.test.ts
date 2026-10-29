import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import type { RelayCommand } from "../../src/cloud/protocol.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import { listenLoopback, readJsonBody, sendJson, type ListeningServer } from "../util/http-server.js";
import { runSourceCli } from "../util/cli-process.js";
import { gradedReport, reportPathFor } from "../util/graded-report.js";

const protocolVersion = "aw-relay/0.1" as const;
const packet = { key: "support-smoke", version: "0.1.0", sha256: "b".repeat(64) } as const;

interface FakeRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly command: RelayCommand;
  status: "connected" | "running" | "completed";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function sendCommand(runId: string, sessionId: string, configSha256: string): RelayCommand {
  return {
    protocol_version: protocolVersion,
    kind: "send",
    command_id: `${runId}-send-1`,
    session_id: sessionId,
    run_id: runId,
    attempt_id: `${runId}-attempt-1`,
    packet,
    config_sha256: configSha256,
    sequence: 1,
    fencing_epoch: 1,
    idempotency_key: `${runId}-idempotency-1`,
    issued_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    input: {
      protocol_version: "aw-target/0.1",
      turn_id: `${runId}-turn-1`,
      idempotency_key: `${runId}-idempotency-1`,
      message: { role: "user", content: "Where is my order?" },
      metadata: {}
    }
  };
}

test(
  "AUG-404: kill -9 between upload and acknowledgement, then recover, then a new test succeeds",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "aw-kill-recover-"));
    const runs = new Map<string, FakeRun>();
    const runsByCreate = new Map<string, FakeRun>();
    const completions = new Map<string, string>();
    const completionPosts: Array<{ commandId: string; body: string }> = [];
    const paths: string[] = [];
    const serverErrors: Error[] = [];
    let chatCalls = 0;
    let firstChild: ChildProcess | undefined;
    let relayBaseUrl = "";
    let target: ListeningServer | undefined;
    let relay: ListeningServer | undefined;

    const handleTarget = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const body = record(await readJsonBody(request), "target request");
      chatCalls += 1;
      sendJson(response, 200, {
        protocol_version: "aw-target/0.1",
        turn_id: body["turn_id"],
        message: { role: "assistant", content: "It ships tomorrow.", finish_reason: "stop" },
        events: [],
        finished: true
      });
    };

    const handleRelay = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      if (request.headers.authorization !== "Bearer integration-access-token") {
        sendJson(response, 401, { error: { code: "CLOUD_AUTH_REJECTED", message: "Unauthorized" } });
        return;
      }
      const path = new URL(request.url ?? "/", "http://relay.invalid").pathname;
      paths.push(`${request.method} ${path}`);
      if (request.method === "GET" && path === "/api/v1/cli/auth/me") {
        sendJson(response, 200, {
          subject: "user-integration",
          workspace_id: "workspace-integration",
          connector_id: "connector-integration",
          scopes: ["connector:identity", "connector:run"]
        });
        return;
      }
      if (request.method === "POST" && path === "/v1/relay/runs") {
        const body = record(await readJsonBody(request), "create request");
        const createRequestId = String(body["create_request_id"]);
        let run = runsByCreate.get(createRequestId);
        if (run === undefined) {
          const runId = `run-kill-${runs.size + 1}`;
          const sessionId = `session-kill-${runs.size + 1}`;
          run = {
            runId,
            sessionId,
            command: sendCommand(runId, sessionId, String(body["config_sha256"])),
            status: "connected"
          };
          runs.set(runId, run);
          runsByCreate.set(createRequestId, run);
        }
        sendJson(response, 200, {
          protocol_version: protocolVersion,
          create_request_id: createRequestId,
          create_request_sha256: sha256(canonicalize(body)),
          create_disposition: "created",
          run_id: run.runId,
          session_id: run.sessionId,
          packet,
          config_sha256: body["config_sha256"],
          fencing_epoch: 1,
          status: run.status,
          dashboard_url: `${relayBaseUrl}/dashboard/${run.runId}`,
          run_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          credit_state: "reserved",
          poll_after_ms: 0
        });
        return;
      }
      const pollMatch = /^\/v1\/relay\/sessions\/([^/]+)\/commands:poll$/.exec(path);
      if (request.method === "POST" && pollMatch !== null) {
        const body = record(await readJsonBody(request), "poll request");
        const run = [...runs.values()].find((candidate) => candidate.sessionId === pollMatch[1]);
        if (run === undefined) throw new Error("poll for an unknown session");
        const open =
          !completions.has(run.command.command_id) &&
          run.command.sequence > Number(body["after_sequence"]);
        if (open) run.status = "running";
        sendJson(response, 200, {
          protocol_version: protocolVersion,
          run_id: run.runId,
          session_id: run.sessionId,
          status: open ? "running" : "completed",
          command: open ? run.command : null,
          retry_after_ms: 0
        });
        return;
      }
      const completeMatch = /^\/v1\/relay\/commands\/([^/]+):complete$/.exec(path);
      if (request.method === "POST" && completeMatch !== null) {
        const commandId = decodeURIComponent(completeMatch[1] ?? "");
        const body = canonicalize(record(await readJsonBody(request), "completion"));
        completionPosts.push({ commandId, body });
        const existing = completions.get(commandId);
        if (existing !== undefined) {
          if (existing !== body) {
            sendJson(response, 409, {
              error: { code: "RELAY_CONFLICT", message: "Command already has another terminal result." }
            });
            return;
          }
          sendJson(response, 200, { protocol_version: protocolVersion, command_id: commandId, accepted: true });
          return;
        }
        completions.set(commandId, body);
        const run = [...runs.values()].find((candidate) => candidate.command.command_id === commandId);
        if (run !== undefined) run.status = "completed";
        if (run?.runId === "run-kill-1") {
          // The upload is durable on the server; the CLI dies before it journals the ack.
          firstChild?.kill("SIGKILL");
          setTimeout(() => response.destroy(), 200).unref();
          return;
        }
        sendJson(response, 200, { protocol_version: protocolVersion, command_id: commandId, accepted: true });
        return;
      }
      if (request.method === "POST" && path === "/v1/relay/run-intents:reconcile") {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
        return;
      }
      const statusMatch = /^\/v1\/relay\/runs\/([^/:]+)$/.exec(path);
      if (request.method === "GET" && statusMatch !== null) {
        const run = runs.get(decodeURIComponent(statusMatch[1] ?? ""));
        if (run === undefined) throw new Error("status for an unknown run");
        sendJson(response, 200, {
          protocol_version: protocolVersion,
          run_id: run.runId,
          status: run.status,
          dashboard_url: `${relayBaseUrl}/dashboard/${run.runId}`,
          credit_state: "consumed",
          outcome: run.status === "completed" ? "passed" : null
        });
        return;
      }
      for (const run of runs.values()) {
        if (request.method === "GET" && path === reportPathFor(run.runId)) {
          sendJson(response, 200, gradedReport(run.runId, "workspace-integration"));
          return;
        }
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
    };

    const guarded =
      (handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) =>
      (request: IncomingMessage, response: ServerResponse): void => {
        void handler(request, response).catch((error: unknown) => {
          const caught = error instanceof Error ? error : new Error(String(error));
          serverErrors.push(caught);
          if (!response.headersSent) {
            sendJson(response, 500, { error: { code: "MOCK_FAILURE", message: caught.message } });
          } else response.destroy(caught);
        });
      };

    try {
      target = await listenLoopback(createServer(guarded(handleTarget)));
      relay = await listenLoopback(createServer(guarded(handleRelay)));
      relayBaseUrl = relay.baseUrl;
      const configPath = join(directory, "augmentworks.yaml");
      await writeFile(
        configPath,
        `version: 1

target:
  name: kill-recover
  connector: http
  base_url: \${CHATBOT_BASE_URL}
  operations:
    send:
      method: POST
      path: /chat
      request: $input
      response:
        protocol_version: $.protocol_version
        turn_id: $.turn_id
        message: $.message
        tool_events: $.events
        finished: $.finished
`,
        { encoding: "utf8", mode: 0o600 }
      );
      if (process.platform !== "win32") await chmod(configPath, 0o600);
      const options = {
        cwd: directory,
        timeoutMs: 30_000,
        env: {
          AUGMENTWORKS_API_URL: relay.baseUrl,
          AUGMENTWORKS_TOKEN: "integration-access-token",
          AUGMENTWORKS_API_KEY: "",
          AUGMENTWORKS_STATE_DIR: join(directory, "state"),
          CHATBOT_BASE_URL: target.baseUrl
        }
      };
      const testArgs = ["test", "-c", "augmentworks.yaml", "--packet", "support-smoke@0.1.0"];

      const killed = await runSourceCli(testArgs, {
        ...options,
        allowSignal: true,
        onSpawn: (child) => {
          firstChild = child;
        }
      });
      expect(killed.signal, `stderr:\n${killed.stderr}`).toBe("SIGKILL");
      expect(chatCalls).toBe(1);
      expect(completions.has("run-kill-1-send-1")).toBe(true);

      const inspected = await runSourceCli(["recover", "--json"], options);
      expect(inspected.exitCode, inspected.stderr).toBe(6);
      expect(JSON.parse(inspected.stdout)).toMatchObject({
        outcome: "cleanup_outstanding",
        run_id: "run-kill-1"
      });

      const createsBeforeRecover = paths.filter((entry) => entry === "POST /v1/relay/runs").length;
      const retired = await runSourceCli(["recover", "--retire", "--json"], options);
      expect(retired.exitCode, `stderr:\n${retired.stderr}\nstdout:\n${retired.stdout}`).toBe(0);
      expect(JSON.parse(retired.stdout)).toMatchObject({ outcome: "terminal", run_id: "run-kill-1" });
      // recover re-sent the saved completion byte for byte, created nothing, and
      // never touched the target again.
      const resent = completionPosts.filter((post) => post.commandId === "run-kill-1-send-1");
      expect(resent).toHaveLength(2);
      expect(resent[1]?.body).toBe(resent[0]?.body);
      expect(paths.filter((entry) => entry === "POST /v1/relay/runs")).toHaveLength(createsBeforeRecover);
      expect(chatCalls).toBe(1);

      const next = await runSourceCli([...testArgs, "--json"], options);
      expect(next.exitCode, `stderr:\n${next.stderr}\nstdout:\n${next.stdout}`).toBe(0);
      expect(JSON.parse(next.stdout)).toMatchObject({ run_id: "run-kill-2", status: "completed" });
      expect(chatCalls).toBe(2);
      expect(serverErrors).toEqual([]);
    } finally {
      firstChild?.kill("SIGKILL");
      await relay?.close().catch(() => undefined);
      await target?.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000
);
