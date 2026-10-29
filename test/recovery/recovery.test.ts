import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import { RELAY_PROTOCOL_VERSION } from "../../src/cloud/protocol.js";
import { RUN_INTENT_RECONCILE_PROTOCOL_VERSION } from "../../src/cloud/recovery-protocol.js";
import { createRecoverCommand, runRecover } from "../../src/commands/recover.js";
import { runTest } from "../../src/commands/test.js";
import { targetBoundarySha256 } from "../../src/config/boundary.js";
import { resolveConfig } from "../../src/config/resolve.js";
import type { AugmentWorksConfig } from "../../src/config/types.js";
import { RunIntentStore } from "../../src/relay/run-intent.js";
import { RelayJournal } from "../../src/relay/journal.js";
import type { RelayRunner } from "../../src/relay/runner.js";
import { relayCommand, resultFor } from "../relay/helpers.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import { gradedReport, reportPathFor } from "../util/graded-report.js";

const temporaryDirectories: string[] = [];
const PACKET = {
  key: "support-refunds",
  version: "0.1.0",
  sha256: "a".repeat(64)
} as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function stateDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-recovery-"));
  temporaryDirectories.push(directory);
  return directory;
}

function resolvedConfig() {
  const config: AugmentWorksConfig = {
    version: 1,
    target: {
      name: "refunds",
      connector: "http",
      base_url: "http://127.0.0.1:8000",
      operations: {
        send: {
          method: "POST",
          path: "/chat",
          request: { message: "$input.message" },
          response: { content: "$.answer" }
        }
      }
    }
  };
  const inspection = resolveConfig(config, "/tmp/augmentworks.yaml", "/tmp", {});
  if (inspection.resolvedConfig === undefined) throw new Error("test config did not resolve");
  return inspection.resolvedConfig;
}

function identity() {
  return {
    subject: "user-1",
    workspaceId: "workspace-1",
    connectorId: "connector-1",
    scopes: ["connector:identity", "connector:run"]
  };
}

function doctorFor() {
  const resolved = resolvedConfig();
  return async () => ({
    ok: true as const,
    configPath: resolved.configPath,
    offline: true as const,
    diagnostics: [],
    resolvedConfig: resolved
  });
}

function bindingFor(
  request: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  return {
    protocol_version: RELAY_PROTOCOL_VERSION,
    create_request_id: request["create_request_id"],
    create_request_sha256: sha256(canonicalize(request)),
    create_disposition: "created",
    run_id: "run-1",
    session_id: "session-1",
    packet: PACKET,
    config_sha256: request["config_sha256"],
    fencing_epoch: 1,
    status: "completed",
    dashboard_url: "http://127.0.0.1:8787/portal/runs/run-1",
    run_expires_at: new Date(Date.now() + 60_000).toISOString(),
    credit_state: "consumed",
    ...overrides
  };
}

function statusFor(overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: RELAY_PROTOCOL_VERSION,
    run_id: "run-1",
    status: "completed",
    outcome: "passed",
    credit_state: "consumed",
    ...overrides
  };
}

describe("CLI recovery (B04)", () => {
  it("CLI-01: a typed rejected create is retired so a corrected packet can start", async () => {
    const stateDirectory = await stateDir();
    const creates: unknown[] = [];
    const reconciles: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      if (url.pathname === "/v1/relay/runs") {
        creates.push(body);
        const request = body as Record<string, unknown>;
        const packet = request["packet"] as { key: string };
        if (packet.key === "unknown-pack") {
          return Response.json(
            {
              error: {
                code: "PACKET_NOT_FOUND",
                message: "Unknown packet.",
                create_disposition: "rejected_uncreated",
                create_request_id: request["create_request_id"],
                create_request_sha256: sha256(canonicalize(request))
              }
            },
            { status: 400 }
          );
        }
        return Response.json(bindingFor(request));
      }
      if (url.pathname === "/v1/relay/run-intents:reconcile") {
        const request = body as Record<string, unknown>;
        reconciles.push(request);
        if (creates.length === 1) {
          return Response.json({
            protocol_version: RUN_INTENT_RECONCILE_PROTOCOL_VERSION,
            outcome: "rejected_uncreated",
            create_request_id: request["create_request_id"],
            create_request_sha256: request["create_request_sha256"],
            rejection: { code: "PACKET_NOT_FOUND", message: "Unknown packet." }
          });
        }
        return Response.json({
          protocol_version: RUN_INTENT_RECONCILE_PROTOCOL_VERSION,
          outcome: "unknown",
          create_request_id: request["create_request_id"],
          create_request_sha256: request["create_request_sha256"],
          reason: "unavailable"
        });
      }
      return Response.json(statusFor());
    });
    const dependencies = {
      doctor: doctorFor(),
      apiOrigin: () => new URL("http://127.0.0.1:8787/"),
      accessToken: async () => "token",
      identity: async () => identity(),
      cloud: ({ accessToken, accessTokenProvider }: { accessToken: string; accessTokenProvider: () => Promise<string> }) =>
        new CloudClient({
          apiUrl: "http://127.0.0.1:8787/",
          accessToken,
          accessTokenProvider,
          fetch: fetchMock
        }),
      stdout: { write: () => true },
      stderr: { write: () => true }
    };

    await expect(
      runTest(
        { packet: "unknown-pack@0.1.0", stateDirectory, handleSignals: false, env: {} },
        dependencies
      )
    ).rejects.toMatchObject({ code: "PACKET_NOT_FOUND" });
    expect(creates).toHaveLength(1);
    expect(reconciles[0]?.["retire_if_uncreated"]).toBe(false);

    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory
    });
    await store.open();
    expect(store.intent).toBeUndefined();
    await store.close();

    const result = await runTest(
      { packet: "support-refunds@0.1.0", stateDirectory, handleSignals: false, env: {} },
      dependencies
    );
    expect(result.run.status).toBe("completed");
    expect(creates).toHaveLength(2);
    expect((creates[1] as { packet: { key: string } }).packet.key).toBe("support-refunds");
    expect((creates[0] as { create_request_id: string }).create_request_id).not.toBe(
      (creates[1] as { create_request_id: string }).create_request_id
    );
  });

  it("CLI-02: a lost create response is bound by reconciliation without a new key", async () => {
    const stateDirectory = await stateDir();
    let creates = 0;
    let committed: Record<string, unknown> | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      if (url.pathname === "/v1/relay/runs") {
        creates += 1;
        committed = body as Record<string, unknown>;
        throw new TypeError("socket closed after commit");
      }
      if (url.pathname === "/v1/relay/run-intents:reconcile") {
        const request = body as Record<string, unknown>;
        return Response.json({
          protocol_version: RUN_INTENT_RECONCILE_PROTOCOL_VERSION,
          outcome: "bound",
          create_request_id: request["create_request_id"],
          create_request_sha256: request["create_request_sha256"],
          binding: bindingFor(committed ?? request, { create_disposition: "replayed", status: "completed" }),
          run: statusFor(),
          target_execution: "terminal",
          evaluation: "not_applicable"
        });
      }
      if (url.pathname === reportPathFor("run-1")) return Response.json(gradedReport("run-1", "workspace-1"));
      return Response.json(statusFor());
    });
    const result = await runTest(
      { packet: "support-refunds@0.1.0", stateDirectory, handleSignals: false, env: {} },
      {
        doctor: doctorFor(),
        apiOrigin: () => new URL("http://127.0.0.1:8787/"),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: ({ accessToken, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: "http://127.0.0.1:8787/",
            accessToken,
            accessTokenProvider,
            fetch: fetchMock,
            requestTimeoutMs: 50
          }),
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );
    expect(result.binding.run_id).toBe("run-1");
    expect(creates).toBe(3);
    expect(committed?.["create_request_id"]).toBe(result.binding.create_request_id);
    expect(result.run.outcome).toBe("passed");
  });

  it("CLI-05: a bound terminal run past replay is inspected without calling create", async () => {
    const stateDirectory = await stateDir();
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory,
      createRequestId: () => `crq_${"b".repeat(32)}`
    });
    await store.open();
    const loaded = await store.loadOrCreate({
      protocol_version: RELAY_PROTOCOL_VERSION,
      packet: { key: PACKET.key, version: PACKET.version },
      config_sha256: "a".repeat(64),
      target: {
        name: "refunds",
        boundary_sha256: "c".repeat(64),
        capabilities: {
          prepare: false,
          observation: false,
          cleanup: false,
          tool_events: false,
          observation_keys: []
        }
      }
    });
    await store.bind(
      bindingFor(loaded.intent.request as unknown as Record<string, unknown>, {
        status: "completed"
      }) as never
    );
    await store.close();

    const creates: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/relay/runs" && init?.method === "POST") {
        creates.push(url.pathname);
        return Response.json({ error: { code: "CREATE_REPLAY_EXPIRED", message: "expired" } }, { status: 409 });
      }
      if (url.pathname === "/v1/relay/run-intents:reconcile") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(typeof body["retire_if_uncreated"]).toBe("boolean");
        return Response.json({
          protocol_version: RUN_INTENT_RECONCILE_PROTOCOL_VERSION,
          outcome: "bound",
          create_request_id: body["create_request_id"],
          create_request_sha256: body["create_request_sha256"],
          binding: bindingFor(loaded.intent.request as unknown as Record<string, unknown>, {
            status: "completed"
          }),
          run: statusFor(),
          target_execution: "terminal",
          evaluation: "not_applicable"
        });
      }
      if (url.pathname.endsWith(":cancel")) {
        throw new Error("cancel must not run during inspection");
      }
      return Response.json(statusFor());
    });

    const inspected = await runRecover(
      { stateDirectory, env: {} },
      {
        doctor: async () => ({
          ok: false,
          configPath: "/tmp/missing.yaml",
          offline: true,
          diagnostics: [{ level: "error", code: "CONFIG_FILE_NOT_FOUND", message: "missing" }]
        }),
        apiOrigin: () => new URL("http://127.0.0.1:8787/"),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: ({ accessToken, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: "http://127.0.0.1:8787/",
            accessToken,
            accessTokenProvider,
            fetch: fetchMock
          }),
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );
    expect(creates).toEqual([]);
    expect(inspected.outcome).toBe("terminal");
    expect(inspected.run_id).toBe("run-1");

    const retired = await runRecover(
      { retire: true, stateDirectory, env: {} },
      {
        doctor: async () => ({
          ok: false,
          configPath: "/tmp/missing.yaml",
          offline: true,
          diagnostics: [{ level: "error", code: "CONFIG_FILE_NOT_FOUND", message: "missing" }]
        }),
        apiOrigin: () => new URL("http://127.0.0.1:8787/"),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: ({ accessToken, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: "http://127.0.0.1:8787/",
            accessToken,
            accessTokenProvider,
            fetch: fetchMock
          }),
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );
    expect(creates).toEqual([]);
    expect(retired.outcome).toBe("terminal");
  });

  it("CLI-07: a changed packet does not create or execute while a run is active", async () => {
    const stateDirectory = await stateDir();
    const resolved = resolvedConfig();
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory,
      createRequestId: () => `crq_${"c".repeat(32)}`
    });
    await store.open();
    const loaded = await store.loadOrCreate({
      protocol_version: RELAY_PROTOCOL_VERSION,
      packet: { key: PACKET.key, version: PACKET.version },
      config_sha256: resolved.configDigest,
      target: {
        name: resolved.config.target.name,
        boundary_sha256: "c".repeat(64),
        capabilities: {
          prepare: false,
          observation: false,
          cleanup: false,
          tool_events: false,
          observation_keys: []
        }
      }
    });
    await store.bind(
      bindingFor(loaded.intent.request as unknown as Record<string, unknown>, {
        config_sha256: loaded.intent.request.config_sha256,
        status: "running",
        credit_state: "consumed"
      }) as never
    );
    await store.close();

    const creates: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/relay/runs") {
        creates.push("create");
        return Response.json({ error: { code: "SHOULD_NOT_CREATE", message: "no" } }, { status: 500 });
      }
      if (url.pathname === "/v1/relay/runs/run-1") {
        return Response.json(statusFor({ status: "running", outcome: null, credit_state: "consumed" }));
      }
      if (url.pathname === "/v1/relay/run-intents:reconcile") {
        return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
      }
      return Response.json(statusFor({ status: "running" }));
    });

    await expect(
      runTest(
        { packet: "other-packet@1.0.0", stateDirectory, handleSignals: false, env: {} },
        {
          doctor: doctorFor(),
          apiOrigin: () => new URL("http://127.0.0.1:8787/"),
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: ({ accessToken, accessTokenProvider }) =>
            new CloudClient({
              apiUrl: "http://127.0.0.1:8787/",
              accessToken,
              accessTokenProvider,
              fetch: fetchMock
            }),
          stdout: { write: () => true },
          stderr: { write: () => true }
        }
      )
    ).rejects.toMatchObject({ code: "ACTIVE_RUN_EXISTS" });
    expect(creates).toEqual([]);
  });

  it("CLI-08: auth and isolation failures preserve intent and do not reveal another tenant", async () => {
    const stateDirectory = await stateDir();
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory,
      createRequestId: () => `crq_${"d".repeat(32)}`
    });
    await store.open();
    await store.loadOrCreate({
      protocol_version: RELAY_PROTOCOL_VERSION,
      packet: { key: PACKET.key, version: PACKET.version },
      config_sha256: "a".repeat(64),
      target: {
        name: "refunds",
        boundary_sha256: "c".repeat(64),
        capabilities: {
          prepare: false,
          observation: false,
          cleanup: false,
          tool_events: false,
          observation_keys: []
        }
      }
    });
    await store.close();

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/relay/run-intents:reconcile") {
        return Response.json({ error: { code: "CLOUD_AUTH_REJECTED", message: "no" } }, { status: 401 });
      }
      return Response.json({ error: { code: "CLOUD_AUTH_REJECTED", message: "no" } }, { status: 401 });
    });

    await expect(
      runRecover(
        { stateDirectory, env: {} },
        {
          doctor: async () => ({
            ok: false,
            configPath: "/tmp/missing.yaml",
            offline: true,
            diagnostics: [{ level: "error", code: "CONFIG_FILE_NOT_FOUND", message: "missing" }]
          }),
          apiOrigin: () => new URL("http://127.0.0.1:8787/"),
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: ({ accessToken, accessTokenProvider }) =>
            new CloudClient({
              apiUrl: "http://127.0.0.1:8787/",
              accessToken,
              accessTokenProvider,
              fetch: fetchMock
            }),
          stdout: { write: () => true },
          stderr: { write: () => true }
        }
      )
    ).rejects.toMatchObject({ code: "CLOUD_AUTH_REJECTED" });

    const remaining = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory
    });
    await remaining.open();
    expect(remaining.intent?.phase).toBe("pending_create");
    await remaining.close();
  });

  it("CLI-12: an old server yields explicit unsupported recovery and does not clear the journal", async () => {
    const stateDirectory = await stateDir();
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory,
      createRequestId: () => `crq_${"e".repeat(32)}`
    });
    await store.open();
    await store.loadOrCreate({
      protocol_version: RELAY_PROTOCOL_VERSION,
      packet: { key: PACKET.key, version: PACKET.version },
      config_sha256: "a".repeat(64),
      target: {
        name: "refunds",
        boundary_sha256: "c".repeat(64),
        capabilities: {
          prepare: false,
          observation: false,
          cleanup: false,
          tool_events: false,
          observation_keys: []
        }
      }
    });
    await store.close();

    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 })
    );
    const report = await runRecover(
      { stateDirectory, env: {} },
      {
        doctor: async () => ({
          ok: false,
          configPath: "/tmp/missing.yaml",
          offline: true,
          diagnostics: [{ level: "error", code: "CONFIG_FILE_NOT_FOUND", message: "missing" }]
        }),
        apiOrigin: () => new URL("http://127.0.0.1:8787/"),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: ({ accessToken, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: "http://127.0.0.1:8787/",
            accessToken,
            accessTokenProvider,
            fetch: fetchMock
          }),
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );
    expect(report.outcome).toBe("unknown");
    expect(report.recovery_unsupported).toBe(true);
    expect(report.next_action).toMatch(/do not delete the journal/i);

    await expect(
      runRecover(
        { retire: true, stateDirectory, env: {} },
        {
          doctor: async () => ({
            ok: false,
            configPath: "/tmp/missing.yaml",
            offline: true,
            diagnostics: [{ level: "error", code: "CONFIG_FILE_NOT_FOUND", message: "missing" }]
          }),
          apiOrigin: () => new URL("http://127.0.0.1:8787/"),
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: ({ accessToken, accessTokenProvider }) =>
            new CloudClient({
              apiUrl: "http://127.0.0.1:8787/",
              accessToken,
              accessTokenProvider,
              fetch: fetchMock
            }),
          stdout: { write: () => true },
          stderr: { write: () => true }
        }
      )
    ).rejects.toMatchObject({ code: "RECOVERY_UNSUPPORTED" });

    const remaining = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory
    });
    await remaining.open();
    expect(remaining.intent?.phase).toBe("pending_create");
    await remaining.close();
  });

  it("CLI-13: default recover is inspect-only and recovery flags are mutually exclusive", async () => {
    await expect(
      runRecover(
        { retire: true, resume: true, env: {} },
        {
          doctor: doctorFor(),
          apiOrigin: () => new URL("http://127.0.0.1:8787/"),
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: () => {
            throw new Error("cloud must not be created");
          }
        }
      )
    ).rejects.toMatchObject({ code: "RECOVERY_FLAGS_CONFLICT" });

    const stateDirectory = await stateDir();
    let retireFlag: boolean | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/relay/run-intents:reconcile") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        retireFlag = body["retire_if_uncreated"] === true;
        return Response.json({
          protocol_version: RUN_INTENT_RECONCILE_PROTOCOL_VERSION,
          outcome: "unknown",
          create_request_id: body["create_request_id"],
          create_request_sha256: body["create_request_sha256"],
          reason: "incomplete_evidence"
        });
      }
      return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
    });
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory,
      createRequestId: () => `crq_${"f".repeat(32)}`
    });
    await store.open();
    await store.loadOrCreate({
      protocol_version: RELAY_PROTOCOL_VERSION,
      packet: { key: PACKET.key, version: PACKET.version },
      config_sha256: "a".repeat(64),
      target: {
        name: "refunds",
        boundary_sha256: "c".repeat(64),
        capabilities: {
          prepare: false,
          observation: false,
          cleanup: false,
          tool_events: false,
          observation_keys: []
        }
      }
    });
    await store.close();

    const report = await runRecover(
      { stateDirectory, env: {} },
      {
        doctor: async () => ({
          ok: false,
          configPath: "/tmp/missing.yaml",
          offline: true,
          diagnostics: [{ level: "error", code: "CONFIG_FILE_NOT_FOUND", message: "missing" }]
        }),
        apiOrigin: () => new URL("http://127.0.0.1:8787/"),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: ({ accessToken, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: "http://127.0.0.1:8787/",
            accessToken,
            accessTokenProvider,
            fetch: fetchMock
          }),
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );
    expect(report.outcome).toBe("unknown");
    expect(retireFlag).toBe(false);

    const idle = await runRecover(
      { retire: true, stateDirectory, env: {} },
      {
        doctor: async () => ({
          ok: false,
          configPath: "/tmp/missing.yaml",
          offline: true,
          diagnostics: [{ level: "error", code: "CONFIG_FILE_NOT_FOUND", message: "missing" }]
        }),
        apiOrigin: () => new URL("http://127.0.0.1:8787/"),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: ({ accessToken, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: "http://127.0.0.1:8787/",
            accessToken,
            accessTokenProvider,
            fetch: fetchMock
          }),
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );
    expect(idle.outcome).toBe("unknown");
    const remaining = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory
    });
    await remaining.open();
    expect(remaining.intent?.phase).toBe("pending_create");
    await remaining.close();
  });

  it("CLI-11: pending grading does not block retiring a terminal local execution intent", async () => {
    const stateDirectory = await stateDir();
    const resolved = resolvedConfig();
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory,
      createRequestId: () => `crq_${"g".repeat(32)}`
    });
    await store.open();
    const loaded = await store.loadOrCreate({
      protocol_version: RELAY_PROTOCOL_VERSION,
      packet: { key: PACKET.key, version: PACKET.version },
      config_sha256: resolved.configDigest,
      target: {
        name: resolved.config.target.name,
        boundary_sha256: "c".repeat(64),
        capabilities: {
          prepare: false,
          observation: false,
          cleanup: false,
          tool_events: false,
          observation_keys: []
        }
      }
    });
    await store.bind(
      bindingFor(loaded.intent.request as unknown as Record<string, unknown>, {
        config_sha256: loaded.intent.request.config_sha256,
        status: "completed"
      }) as never
    );
    await store.close();

    let cancelled = false;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(":cancel")) {
        cancelled = true;
        return Response.json(statusFor({ status: "cancelled" }));
      }
      if (url.pathname === "/v1/relay/run-intents:reconcile") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body["retire_if_uncreated"]).toBe(false);
        return Response.json({
          protocol_version: RUN_INTENT_RECONCILE_PROTOCOL_VERSION,
          outcome: "bound",
          create_request_id: body["create_request_id"],
          create_request_sha256: body["create_request_sha256"],
          binding: bindingFor(loaded.intent.request as unknown as Record<string, unknown>, {
            config_sha256: loaded.intent.request.config_sha256,
            status: "completed"
          }),
          run: statusFor(),
          target_execution: "terminal",
          evaluation: "pending"
        });
      }
      return Response.json(statusFor());
    });

    const report = await runRecover(
      { retire: true, stateDirectory, env: {} },
      {
        doctor: doctorFor(),
        apiOrigin: () => new URL("http://127.0.0.1:8787/"),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: ({ accessToken, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: "http://127.0.0.1:8787/",
            accessToken,
            accessTokenProvider,
            fetch: fetchMock
          }),
        connector: () => {
          throw new Error("target must not execute during terminal retirement");
        },
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );
    expect(cancelled).toBe(false);
    expect(report.outcome).toBe("terminal");
    expect(report.next_action).toMatch(/grading/i);

    const remaining = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory
    });
    await remaining.open();
    expect(remaining.intent).toBeUndefined();
    await remaining.close();

    const idle = await runRecover(
      { retire: true, stateDirectory, env: {} },
      {
        doctor: doctorFor(),
        apiOrigin: () => new URL("http://127.0.0.1:8787/"),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: ({ accessToken, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: "http://127.0.0.1:8787/",
            accessToken,
            accessTokenProvider,
            fetch: async () => {
              throw new Error("repeated terminal retire must not call the server");
            }
          }),
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );
    expect(idle.outcome).toBe("idle");
  });

  it("CLI-09: repeated inspect after retirement stays idle and keeps the archive", async () => {
    const stateDirectory = await stateDir();
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory,
      createRequestId: () => `crq_${"i".repeat(32)}`
    });
    await store.open();
    const loaded = await store.loadOrCreate({
      protocol_version: RELAY_PROTOCOL_VERSION,
      packet: { key: PACKET.key, version: PACKET.version },
      config_sha256: "a".repeat(64),
      target: {
        name: "refunds",
        boundary_sha256: "c".repeat(64),
        capabilities: {
          prepare: false,
          observation: false,
          cleanup: false,
          tool_events: false,
          observation_keys: []
        }
      }
    });
    const requestId = loaded.intent.request.create_request_id;
    await store.retirePendingUncreated("retired_uncreated");
    await store.close();

    const inspected = await runRecover(
      { stateDirectory, env: {} },
      {
        doctor: async () => ({
          ok: false,
          configPath: "/tmp/missing.yaml",
          offline: true,
          diagnostics: [{ level: "error", code: "CONFIG_FILE_NOT_FOUND", message: "missing" }]
        }),
        apiOrigin: () => new URL("http://127.0.0.1:8787/"),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: ({ accessToken, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: "http://127.0.0.1:8787/",
            accessToken,
            accessTokenProvider,
            fetch: async () => {
              throw new Error("idle recover must not call the server");
            }
          }),
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );
    expect(inspected.outcome).toBe("idle");

    const archiveStore = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory
    });
    await archiveStore.open();
    const archive = await archiveStore.readArchive(requestId);
    expect(archive?.reason).toBe("retired_uncreated");
    expect(JSON.stringify(archive)).not.toContain("support-refunds");
    await archiveStore.close();
  });

  it("does not create or execute a new target when resuming a bound run", async () => {
    const stateDirectory = await stateDir();
    const resolved = resolvedConfig();
    const boundary = targetBoundarySha256(resolved);
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory,
      createRequestId: () => `crq_${"j".repeat(32)}`
    });
    await store.open();
    const loaded = await store.loadOrCreate({
      protocol_version: RELAY_PROTOCOL_VERSION,
      packet: { key: PACKET.key, version: PACKET.version },
      config_sha256: resolved.configDigest,
      target: {
        name: resolved.config.target.name,
        boundary_sha256: boundary,
        capabilities: {
          prepare: false,
          observation: false,
          cleanup: false,
          tool_events: false,
          observation_keys: []
        }
      }
    });
    await store.bind(
      bindingFor(loaded.intent.request as unknown as Record<string, unknown>, {
        config_sha256: loaded.intent.request.config_sha256,
        status: "running",
        credit_state: "consumed"
      }) as never
    );
    await store.close();

    let creates = 0;
    let targetRuns = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/relay/runs") {
        creates += 1;
        return Response.json({ error: { code: "SHOULD_NOT_CREATE", message: "no" } }, { status: 500 });
      }
      if (url.pathname === "/v1/relay/runs/run-1") {
        return Response.json(statusFor({ status: "running", outcome: null, credit_state: "consumed" }));
      }
      return Response.json(statusFor());
    });
    const report = await runRecover(
      { resume: true, stateDirectory, env: {}, handleSignals: false },
      {
        doctor: doctorFor(),
        apiOrigin: () => new URL("http://127.0.0.1:8787/"),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: ({ accessToken, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: "http://127.0.0.1:8787/",
            accessToken,
            accessTokenProvider,
            fetch: fetchMock
          }),
        runner: () =>
          ({
            run: async () => {
              targetRuns += 1;
              return statusFor();
            },
            requestCancellation: async () => {
              throw new Error("resume must not cancel");
            }
          }) as unknown as RelayRunner,
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );
    expect(creates).toBe(0);
    expect(targetRuns).toBe(1);
    expect(report.outcome).toBe("resumed");
  });

  it("completes recover --resume for a synthetic run against an HTML 404 fallback", async () => {
    const stateDirectory = await stateDir();
    const resolved = resolvedConfig();
    const boundary = targetBoundarySha256(resolved);
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory,
      createRequestId: () => `crq_${"k".repeat(32)}`
    });
    await store.open();
    const loaded = await store.loadOrCreate({
      protocol_version: RELAY_PROTOCOL_VERSION,
      packet: { key: PACKET.key, version: PACKET.version },
      config_sha256: resolved.configDigest,
      target: {
        name: resolved.config.target.name,
        boundary_sha256: boundary,
        capabilities: {
          prepare: false,
          observation: false,
          cleanup: false,
          tool_events: false,
          observation_keys: []
        }
      }
    });
    await store.bind(
      bindingFor(loaded.intent.request as unknown as Record<string, unknown>, {
        config_sha256: loaded.intent.request.config_sha256,
        status: "running",
        credit_state: "consumed"
      }) as never
    );
    await store.close();

    const paths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/v1/relay/runs") {
        throw new Error("resume must not create");
      }
      if (url.pathname === "/v1/relay/runs/run-1") {
        return Response.json(statusFor({ status: "running", outcome: null, credit_state: "consumed" }));
      }
      const body = "<!DOCTYPE html><html><body>404: This page could not be found.</body></html>";
      return new Response(body, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    const report = await runRecover(
      { resume: true, stateDirectory, env: {}, handleSignals: false },
      {
        doctor: doctorFor(),
        apiOrigin: () => new URL("http://127.0.0.1:8787/"),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: ({ accessToken, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: "http://127.0.0.1:8787/",
            accessToken,
            accessTokenProvider,
            fetch: fetchMock
          }),
        runner: () =>
          ({
            run: async () => statusFor(),
            requestCancellation: async () => {
              throw new Error("resume must not cancel");
            }
          }) as unknown as RelayRunner,
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );
    expect(report.outcome).toBe("resumed");
    expect(paths.some((path) => path.includes("execution-scope"))).toBe(false);
  });
});

describe("generic create errors are not treated as no-create", () => {
  it("keeps a pending intent after HTTP 400 without typed rejection", async () => {
    const stateDirectory = await stateDir();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/relay/runs") {
        return Response.json(
          { error: { code: "PACKET_NOT_FOUND", message: "Unknown packet." } },
          { status: 400 }
        );
      }
      if (url.pathname === "/v1/relay/run-intents:reconcile") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          protocol_version: RUN_INTENT_RECONCILE_PROTOCOL_VERSION,
          outcome: "unknown",
          create_request_id: body["create_request_id"],
          create_request_sha256: body["create_request_sha256"],
          reason: "incomplete_evidence"
        });
      }
      return Response.json(statusFor());
    });
    await expect(
      runTest(
        { packet: "unknown-pack@0.1.0", stateDirectory, handleSignals: false, env: {} },
        {
          doctor: doctorFor(),
          apiOrigin: () => new URL("http://127.0.0.1:8787/"),
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: ({ accessToken, accessTokenProvider }) =>
            new CloudClient({
              apiUrl: "http://127.0.0.1:8787/",
              accessToken,
              accessTokenProvider,
              fetch: fetchMock
            }),
          stdout: { write: () => true },
          stderr: { write: () => true }
        }
      )
    ).rejects.toMatchObject({ code: "PACKET_NOT_FOUND" });
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory
    });
    await store.open();
    expect(store.intent?.phase).toBe("pending_create");
    await store.close();
  });

  it("CLI-03: a post-commit relay error keeps the pending journal", async () => {
    const stateDirectory = await stateDir();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/relay/runs") {
        return Response.json(
          { error: { code: "SCHEDULER_UNAVAILABLE", message: "The scheduler could not be kicked." } },
          { status: 500 }
        );
      }
      if (url.pathname === "/v1/relay/run-intents:reconcile") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          protocol_version: RUN_INTENT_RECONCILE_PROTOCOL_VERSION,
          outcome: "unknown",
          create_request_id: body["create_request_id"],
          create_request_sha256: body["create_request_sha256"],
          reason: "in_flight"
        });
      }
      return Response.json(statusFor());
    });
    await expect(
      runTest(
        { packet: "support-refunds@0.1.0", stateDirectory, handleSignals: false, env: {} },
        {
          doctor: doctorFor(),
          apiOrigin: () => new URL("http://127.0.0.1:8787/"),
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: ({ accessToken, accessTokenProvider }) =>
            new CloudClient({
              apiUrl: "http://127.0.0.1:8787/",
              accessToken,
              accessTokenProvider,
              fetch: fetchMock,
              requestTimeoutMs: 50
            }),
          stdout: { write: () => true },
          stderr: { write: () => true }
        }
      )
    ).rejects.toMatchObject({ code: "SCHEDULER_UNAVAILABLE" });
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory
    });
    await store.open();
    expect(store.intent?.phase).toBe("pending_create");
    await store.close();
  });

  it("CLI-06/AUG-404: a refused saved completion keeps the intent; once settled, a terminal run with outstanding cleanup is released with a warning", async () => {
    const stateDirectory = await stateDir();
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory,
      createRequestId: () => `crq_${"h".repeat(32)}`
    });
    await store.open();
    const loaded = await store.loadOrCreate({
      protocol_version: RELAY_PROTOCOL_VERSION,
      packet: { key: PACKET.key, version: PACKET.version },
      config_sha256: "a".repeat(64),
      target: {
        name: "refunds",
        boundary_sha256: "c".repeat(64),
        capabilities: {
          prepare: false,
          observation: false,
          cleanup: false,
          tool_events: false,
          observation_keys: []
        }
      }
    });
    await store.bind(
      bindingFor(loaded.intent.request as unknown as Record<string, unknown>, {
        status: "completed"
      }) as never
    );
    await store.close();

    const journal = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    const prepare = relayCommand("prepare");
    await journal.accept(prepare);
    await journal.markStarted(prepare.command_id);
    await journal.recordSuccess(prepare.command_id, resultFor(prepare));
    await journal.close();

    const completionBodies: unknown[] = [];
    let refuseCompletion = true;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === `/v1/relay/commands/${prepare.command_id}:complete`) {
        completionBodies.push(JSON.parse(String(init?.body)));
        if (refuseCompletion) {
          return Response.json(
            { error: { code: "FENCE_BINDING_MISMATCH", message: "Unknown future epoch." } },
            { status: 409 }
          );
        }
        return Response.json({
          protocol_version: RELAY_PROTOCOL_VERSION,
          command_id: prepare.command_id,
          accepted: true
        });
      }
      if (url.pathname === "/v1/relay/run-intents:reconcile") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          protocol_version: RUN_INTENT_RECONCILE_PROTOCOL_VERSION,
          outcome: "bound",
          create_request_id: body["create_request_id"],
          create_request_sha256: body["create_request_sha256"],
          binding: bindingFor(loaded.intent.request as unknown as Record<string, unknown>, {
            status: "completed"
          }),
          run: statusFor(),
          target_execution: "terminal",
          evaluation: "not_applicable"
        });
      }
      return Response.json(statusFor());
    });

    const inspected = await runRecover(
      { stateDirectory, env: {} },
      {
        doctor: async () => ({
          ok: false,
          configPath: "/tmp/missing.yaml",
          offline: true,
          diagnostics: [{ level: "error", code: "CONFIG_FILE_NOT_FOUND", message: "missing" }]
        }),
        apiOrigin: () => new URL("http://127.0.0.1:8787/"),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: ({ accessToken, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: "http://127.0.0.1:8787/",
            accessToken,
            accessTokenProvider,
            fetch: fetchMock
          }),
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );
    expect(inspected.outcome).toBe("cleanup_outstanding");

    await expect(
      runRecover(
        { retire: true, stateDirectory, env: {} },
        {
          doctor: async () => ({
            ok: false,
            configPath: "/tmp/missing.yaml",
            offline: true,
            diagnostics: [{ level: "error", code: "CONFIG_FILE_NOT_FOUND", message: "missing" }]
          }),
          apiOrigin: () => new URL("http://127.0.0.1:8787/"),
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: ({ accessToken, accessTokenProvider }) =>
            new CloudClient({
              apiUrl: "http://127.0.0.1:8787/",
              accessToken,
              accessTokenProvider,
              fetch: fetchMock
            }),
          stdout: { write: () => true },
          stderr: { write: () => true }
        }
      )
    ).rejects.toMatchObject({
      code: "RELAY_JOURNAL_INCOMPLETE",
      runId: "run-1",
      details: { resend_error_code: "FENCE_BINDING_MISMATCH" }
    });

    const remaining = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory
    });
    await remaining.open();
    expect(remaining.intent?.phase).toBe("bound");
    await remaining.close();

    // The re-sent body is the journaled completion, bound to the run's wire protocol.
    expect(completionBodies[0]).toEqual({
      protocol_version: RELAY_PROTOCOL_VERSION,
      command_id: prepare.command_id,
      session_id: prepare.session_id,
      run_id: prepare.run_id,
      packet: prepare.packet,
      config_sha256: prepare.config_sha256,
      sequence: prepare.sequence,
      fencing_epoch: prepare.fencing_epoch,
      result: resultFor(prepare),
      result_sha256: sha256(canonicalize(resultFor(prepare)))
    });

    // The server now takes it as an identical repeat. A terminal run can never send
    // the cleanup, so the fixture is abandoned with a warning and the run released.
    refuseCompletion = false;
    const notices: string[] = [];
    const retired = await runRecover(
      { retire: true, stateDirectory, env: {} },
      {
        doctor: async () => ({
          ok: false,
          configPath: "/tmp/missing.yaml",
          offline: true,
          diagnostics: [{ level: "error", code: "CONFIG_FILE_NOT_FOUND", message: "missing" }]
        }),
        apiOrigin: () => new URL("http://127.0.0.1:8787/"),
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: ({ accessToken, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: "http://127.0.0.1:8787/",
            accessToken,
            accessTokenProvider,
            fetch: fetchMock
          }),
        stdout: { write: () => true },
        stderr: {
          write: (chunk: string | Uint8Array) => {
            notices.push(String(chunk));
            return true;
          }
        }
      }
    );
    expect(retired.outcome).toBe("terminal");
    expect(completionBodies).toHaveLength(2);
    expect(completionBodies[1]).toEqual(completionBodies[0]);
    expect(notices.join("")).toContain("attempt-1");
    const released = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory
    });
    await released.open();
    expect(released.intent).toBeUndefined();
    await released.close();
  });
});

describe("AUG-404 terminal-run journal settlement", () => {
  async function boundTerminalIntent(stateDirectory: string): Promise<void> {
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory,
      createRequestId: () => `crq_${"k".repeat(32)}`
    });
    await store.open();
    const loaded = await store.loadOrCreate({
      protocol_version: RELAY_PROTOCOL_VERSION,
      packet: { key: PACKET.key, version: PACKET.version },
      config_sha256: "a".repeat(64),
      target: {
        name: "refunds",
        boundary_sha256: "c".repeat(64),
        capabilities: {
          prepare: false,
          observation: false,
          cleanup: false,
          tool_events: false,
          observation_keys: []
        }
      }
    });
    await store.bind(
      bindingFor(loaded.intent.request as unknown as Record<string, unknown>, {
        status: "failed"
      }) as never
    );
    await store.close();
  }

  function recoverDependencies(
    fetchMock: typeof fetch,
    stdout: { write: (chunk: string) => boolean } = { write: () => true }
  ) {
    return {
      doctor: async () => ({
        ok: false as const,
        configPath: "/tmp/missing.yaml",
        offline: true as const,
        diagnostics: [{ level: "error" as const, code: "CONFIG_FILE_NOT_FOUND", message: "missing" }]
      }),
      apiOrigin: () => new URL("http://127.0.0.1:8787/"),
      accessToken: async () => "token",
      identity: async () => identity(),
      cloud: ({
        accessToken,
        accessTokenProvider
      }: Pick<ConstructorParameters<typeof CloudClient>[0], "accessToken" | "accessTokenProvider">) =>
        new CloudClient({
          apiUrl: "http://127.0.0.1:8787/",
          accessToken,
          ...(accessTokenProvider === undefined ? {} : { accessTokenProvider }),
          fetch: fetchMock
        }),
      connector: () => {
        throw new Error("recover must never execute a target operation on a terminal run");
      },
      stdout,
      stderr: { write: () => true }
    };
  }

  function terminalRelay(completion: () => Response, seen: string[]) {
    return vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      seen.push(url.pathname);
      if (url.pathname === "/v1/relay/runs") throw new Error("recover must never create a run");
      if (url.pathname.endsWith(":complete") || url.pathname.endsWith(":fail")) return completion();
      if (url.pathname === "/v1/relay/run-intents:reconcile") {
        return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
      }
      return Response.json(statusFor({ status: "failed", outcome: "error" }));
    });
  }

  async function journalWithUnacknowledgedSend(stateDirectory: string, complete: boolean) {
    const journal = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    const send = relayCommand("send");
    await journal.accept(send);
    await journal.markStarted(send.command_id);
    if (complete) await journal.recordSuccess(send.command_id, resultFor(send));
    await journal.close();
    return send;
  }

  async function intentAfter(stateDirectory: string) {
    const store = new RunIntentStore({
      apiOrigin: new URL("http://127.0.0.1:8787/"),
      tenant: { workspace_id: "workspace-1", connector_id: "connector-1" },
      stateDirectory
    });
    await store.open();
    const intent = store.intent;
    await store.close();
    return intent;
  }

  for (const [label, status, code] of [
    ["RUN_TERMINAL", 409, "RUN_TERMINAL"],
    ["RELAY_CONFLICT (server closed it with another result)", 409, "RELAY_CONFLICT"],
    ["STALE_FENCE (session replaced) while the run is terminal", 409, "STALE_FENCE"],
    ["RUN_BINDING_MISMATCH while the run is terminal", 409, "RUN_BINDING_MISMATCH"]
  ] as const) {
    it(`releases the run when the saved completion is answered with ${label}`, async () => {
      const stateDirectory = await stateDir();
      await boundTerminalIntent(stateDirectory);
      const send = await journalWithUnacknowledgedSend(stateDirectory, true);
      const seen: string[] = [];
      const fetchMock = terminalRelay(
        () => Response.json({ error: { code, message: "Refused." } }, { status }),
        seen
      );
      const report = await runRecover(
        { retire: true, stateDirectory, env: {} },
        recoverDependencies(fetchMock) as never
      );
      expect(report.outcome).toBe("terminal");
      expect(seen).toContain(`/v1/relay/commands/${send.command_id}:complete`);
      expect(await intentAfter(stateDirectory)).toBeUndefined();
      const journal = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
      expect(journal.state(send.command_id)).toMatchObject({ acknowledged: true });
      await journal.close();
    });
  }

  it("records an accepted-but-never-completed command as abandoned without re-running it", async () => {
    const stateDirectory = await stateDir();
    await boundTerminalIntent(stateDirectory);
    const send = await journalWithUnacknowledgedSend(stateDirectory, false);
    const seen: string[] = [];
    const fetchMock = terminalRelay(() => {
      throw new Error("an uncompleted command has nothing to re-send");
    }, seen);
    const report = await runRecover(
      { retire: true, stateDirectory, env: {} },
      recoverDependencies(fetchMock) as never
    );
    expect(report.outcome).toBe("terminal");
    expect(seen.some((path) => path.includes("/v1/relay/commands/"))).toBe(false);
    expect(await intentAfter(stateDirectory)).toBeUndefined();
    const journal = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    expect(journal.state(send.command_id)).toMatchObject({ abandoned: "run_terminal_uncompleted" });
    await journal.close();
  });

  it("AUG-412: recover --json writes the run ID in its error output", async () => {
    const stateDirectory = await stateDir();
    await boundTerminalIntent(stateDirectory);
    await journalWithUnacknowledgedSend(stateDirectory, true);
    const fetchMock = terminalRelay(
      () => Response.json({ error: { code: "COMMAND_BINDING_MISMATCH", message: "No." } }, { status: 409 }),
      []
    );
    const written: string[] = [];
    let exitCode = 0;
    const command = createRecoverCommand({
      ...recoverDependencies(fetchMock, {
        write: (chunk: string) => {
          written.push(chunk);
          return true;
        }
      }),
      setExitCode: (code: number) => {
        exitCode = code;
      }
    } as never);
    process.env["AUGMENTWORKS_STATE_DIR"] = stateDirectory;
    try {
      await command.parseAsync(["node", "recover", "--retire", "--json"]);
    } finally {
      delete process.env["AUGMENTWORKS_STATE_DIR"];
    }
    const payload = JSON.parse(written.join("")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: "RELAY_JOURNAL_INCOMPLETE",
      run_id: "run-1",
      details: { resend_error_code: "COMMAND_BINDING_MISMATCH" }
    });
    expect(exitCode).toBe(6);
    expect(await intentAfter(stateDirectory)).toBeDefined();
  });
});
