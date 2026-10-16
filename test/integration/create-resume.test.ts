import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { canonicalize, sha256 } from "../../src/util/canonical.js";
import { readJsonBody, sendJson, listenLoopback } from "../util/http-server.js";
import { runSourceCli } from "../util/cli-process.js";
import { gradedReport, reportPathFor } from "../util/graded-report.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

test("a lost create response is resumed with one durable request and reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aw-create-resume-"));
  const stateDirectory = join(directory, "state");
  const createBodies: string[] = [];
  const idempotencyKeys: string[] = [];
  const serverErrors: Error[] = [];
  const packet = {
    key: "support-smoke",
    version: "0.1.0",
    sha256: "b".repeat(64)
  } as const;
  const expiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
  let relayBaseUrl = "";
  let createAttempts = 0;
  let logicalReservations = 0;
  let committedRequest: string | undefined;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.headers.authorization !== "Bearer integration-access-token") {
      sendJson(response, 401, {
        error: { code: "CLOUD_AUTH_REJECTED", message: "Unauthorized" }
      });
      return;
    }
    const path = new URL(request.url ?? "/", "http://relay.invalid").pathname;
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
      const serialized = canonicalize(body);
      createBodies.push(serialized);
      idempotencyKeys.push(String(request.headers["idempotency-key"] ?? ""));
      createAttempts += 1;
      if (committedRequest === undefined) {
        committedRequest = serialized;
        logicalReservations += 1;
      } else if (committedRequest !== serialized) {
        sendJson(response, 409, {
          error: {
            code: "CREATE_REQUEST_CONFLICT",
            message: "Request changed"
          }
        });
        return;
      }

      // Simulate a relay commit followed by a lost response for every in-process retry.
      if (createAttempts <= 3) {
        response.destroy();
        return;
      }

      sendJson(response, 200, {
        protocol_version: "aw-relay/0.1",
        create_request_id: body["create_request_id"],
        create_request_sha256: sha256(serialized),
        create_disposition: "replayed",
        run_id: "run-resume-1",
        session_id: "session-resume-1",
        packet,
        config_sha256: body["config_sha256"],
        fencing_epoch: 1,
        status: "connected",
        dashboard_url: `${relayBaseUrl}/dashboard/run-resume-1`,
        run_expires_at: expiresAt,
        credit_state: "reserved",
        poll_after_ms: 0
      });
      return;
    }
    if (request.method === "POST" && path === "/v1/relay/sessions/session-resume-1/commands:poll") {
      await readJsonBody(request);
      sendJson(response, 200, {
        protocol_version: "aw-relay/0.1",
        run_id: "run-resume-1",
        session_id: "session-resume-1",
        status: "completed",
        command: null,
        retry_after_ms: 0
      });
      return;
    }
    if (request.method === "POST" && path === "/v1/relay/run-intents:reconcile") {
      sendJson(response, 404, {
        error: { code: "NOT_FOUND", message: "Not found" }
      });
      return;
    }
    if (request.method === "GET" && path === reportPathFor("run-resume-1")) {
      sendJson(response, 200, gradedReport("run-resume-1", "workspace-integration"));
      return;
    }
    if (request.method === "GET" && path === "/v1/relay/runs/run-resume-1") {
      sendJson(response, 200, {
        protocol_version: "aw-relay/0.1",
        run_id: "run-resume-1",
        status: "completed",
        credit_state: "released",
        outcome: "passed",
        dashboard_url: `${relayBaseUrl}/dashboard/run-resume-1`
      });
      return;
    }
    sendJson(response, 404, {
      error: { code: "NOT_FOUND", message: "Not found" }
    });
  };

  const server = await listenLoopback(
    createServer((request, response) => {
      void handle(request, response).catch((error: unknown) => {
        const caught = error instanceof Error ? error : new Error(String(error));
        serverErrors.push(caught);
        if (!response.headersSent && !response.destroyed) {
          sendJson(response, 500, {
            error: { code: "MOCK_FAILURE", message: caught.message }
          });
        }
      });
    })
  );
  relayBaseUrl = server.baseUrl;

  try {
    await writeFile(
      join(directory, "augmentworks.yaml"),
      `version: 1

target:
  name: resume-integration
  connector: http
  base_url: \${CHATBOT_BASE_URL}
  operations:
    send:
      method: POST
      path: /chat
      request: $input
`,
      { encoding: "utf8", mode: 0o600 }
    );
    const environment = {
      AUGMENTWORKS_API_URL: server.baseUrl,
      AUGMENTWORKS_TOKEN: "integration-access-token",
      AUGMENTWORKS_API_KEY: "",
      AUGMENTWORKS_STATE_DIR: stateDirectory,
      CHATBOT_BASE_URL: "http://127.0.0.1:65535",
      CHATBOT_API_KEY: "must-never-leave"
    };
    const args = ["test", "-c", "augmentworks.yaml", "--packet", "support-smoke@0.1.0"];

    const interrupted = await runSourceCli(args, {
      cwd: directory,
      timeoutMs: 30_000,
      env: environment
    });
    expect(interrupted.exitCode).not.toBe(0);
    expect(createAttempts).toBe(3);
    expect(logicalReservations).toBe(1);
    expect(
      (await readdir(join(stateDirectory, "runs"))).some((name) => name.endsWith(".json"))
    ).toBe(true);

    const resumed = await runSourceCli([...args, "--json"], {
      cwd: directory,
      timeoutMs: 30_000,
      env: environment
    });
    expect(resumed.exitCode, `stderr:\n${resumed.stderr}\nstdout:\n${resumed.stdout}`).toBe(0);
    expect(resumed.stderr).toContain("Resuming run-resume-1");
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      run_id: "run-resume-1",
      status: "completed",
      outcome: "passed",
      credit_state: "released"
    });
    expect(createAttempts).toBe(4);
    expect(logicalReservations).toBe(1);
    expect(new Set(createBodies).size).toBe(1);
    expect(new Set(idempotencyKeys).size).toBe(1);
    expect(idempotencyKeys[0]).toMatch(/^crq_[A-Za-z0-9_-]+$/);
    const serializedCreate = createBodies[0] ?? "";
    expect(serializedCreate).not.toContain("CHATBOT_BASE_URL");
    expect(serializedCreate).not.toContain("CHATBOT_API_KEY");
    expect(serializedCreate).not.toContain("must-never-leave");
    expect(serializedCreate).not.toContain("http://127.0.0.1:65535");
    expect(serializedCreate).not.toContain("/chat");
    expect(serializedCreate).not.toContain("$input");
    expect(
      (await readdir(join(stateDirectory, "runs"))).some((name) => name.endsWith(".json"))
    ).toBe(false);
    expect(serverErrors).toEqual([]);
  } finally {
    await server.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
