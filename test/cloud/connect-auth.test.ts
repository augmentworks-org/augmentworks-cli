import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import { RELAY_PROTOCOL_VERSION } from "../../src/cloud/protocol.js";
import { runConnect } from "../../src/commands/connect.js";
import { runTest } from "../../src/commands/test.js";
import { resolveConfig } from "../../src/config/resolve.js";
import type { AugmentWorksConfig } from "../../src/config/types.js";
import type { HttpConnector } from "../../src/connector/http.js";
import { RunIntentStore } from "../../src/relay/run-intent.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import { gradedReport, reportPathFor } from "../util/graded-report.js";

describe("long-running command authentication lifecycle", () => {
  it("uses the async token provider after remaining connected for more than an hour", async () => {
    let elapsedMs = 0;
    const bearerHeaders: string[] = [];
    const accessToken = vi.fn(async () =>
      elapsedMs < 3_600_000 ? "hour-one-token" : "hour-two-token"
    );
    const apiOrigin = new URL("http://127.0.0.1:8787/");
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      bearerHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
      if (url.pathname === "/v1/relay/sessions") {
        elapsedMs = 61 * 60_000;
        return Response.json({
          protocol_version: RELAY_PROTOCOL_VERSION,
          session_id: "session-1",
          fencing_epoch: 1,
          status: "connected",
          dashboard_url: `${apiOrigin.origin}/portal/connectors/session-1`
        });
      }
      if (url.pathname.endsWith(":poll")) {
        return Response.json({
          protocol_version: RELAY_PROTOCOL_VERSION,
          session_id: "session-1",
          fencing_epoch: 1,
          status: "closed",
          run: null
        });
      }
      return Response.json({
        protocol_version: RELAY_PROTOCOL_VERSION,
        session_id: "session-1",
        fencing_epoch: 1,
        status: "closed",
        dashboard_url: `${apiOrigin.origin}/portal/connectors/session-1`
      });
    });
    const resolvedConfig = resolved();

    const result = await runConnect(
      { env: {}, handleSignals: false },
      {
        doctor: async () => ({
          ok: true,
          configPath: resolvedConfig.configPath,
          offline: true,
          diagnostics: [],
          resolvedConfig
        }),
        apiOrigin: () => apiOrigin,
        accessToken,
        identity: async () => ({
          subject: "user-1",
          workspaceId: "workspace-1",
          connectorId: "connector-1",
          scopes: ["connector:identity", "connector:run"]
        }),
        cloud: ({ accessToken: initial, accessTokenProvider }) =>
          new CloudClient({
            apiUrl: apiOrigin,
            accessToken: initial,
            accessTokenProvider,
            fetch: fetchMock
          }),
        connector: () => ({}) as HttpConnector,
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );

    expect(result).toMatchObject({ status: "closed", runs: [] });
    expect(bearerHeaders).toEqual([
      "Bearer hour-one-token",
      "Bearer hour-two-token",
      "Bearer hour-two-token"
    ]);
    expect(accessToken.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps an ordinary assessment on the same async token-provider path", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "augmentworks-test-auth-"));
    try {
      let elapsedMs = 0;
      const bearerHeaders: string[] = [];
      const accessToken = vi.fn(async () =>
        elapsedMs < 3_600_000 ? "hour-one-token" : "hour-two-token"
      );
      const apiOrigin = new URL("http://127.0.0.1:8787/");
      const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        bearerHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
        if (url.pathname === "/v1/relay/runs" && init?.method === "POST") {
          const request = JSON.parse(String(init.body)) as Record<string, unknown>;
          elapsedMs = 61 * 60_000;
          return Response.json({
            protocol_version: RELAY_PROTOCOL_VERSION,
            create_request_id: request["create_request_id"],
            create_request_sha256: sha256(canonicalize(request)),
            create_disposition: "created",
            run_id: "run-1",
            session_id: "session-1",
            packet: {
              key: "support-refunds",
              version: "0.1.0",
              sha256: "a".repeat(64)
            },
            config_sha256: request["config_sha256"],
            fencing_epoch: 1,
            status: "completed",
            dashboard_url: `${apiOrigin.origin}/portal/runs/run-1`,
            run_expires_at: new Date(Date.now() + 60_000).toISOString(),
            credit_state: "consumed"
          });
        }
        if (url.pathname === reportPathFor("run-1")) {
          return Response.json(gradedReport("run-1", "workspace-1"));
        }
        return Response.json({
          protocol_version: RELAY_PROTOCOL_VERSION,
          run_id: "run-1",
          status: "completed",
          outcome: "passed",
          credit_state: "consumed"
        });
      });
      const resolvedConfig = resolved();

      const result = await runTest(
        {
          env: {},
          packet: "support-refunds@0.1.0",
          stateDirectory,
          handleSignals: false
        },
        {
          doctor: async () => ({
            ok: true,
            configPath: resolvedConfig.configPath,
            offline: true,
            diagnostics: [],
            resolvedConfig
          }),
          apiOrigin: () => apiOrigin,
          accessToken,
          identity: async () => ({
            subject: "user-1",
            workspaceId: "workspace-1",
            connectorId: "connector-1",
            scopes: ["connector:identity", "connector:run"]
          }),
          cloud: ({ accessToken: initial, accessTokenProvider }) =>
            new CloudClient({
              apiUrl: apiOrigin,
              accessToken: initial,
              accessTokenProvider,
              fetch: fetchMock
            }),
          stdout: { write: () => true },
          stderr: { write: () => true }
        }
      );

      expect(result.run).toMatchObject({
        status: "completed",
        outcome: "passed"
      });
      expect(bearerHeaders).toEqual(["Bearer hour-one-token", "Bearer hour-two-token", "Bearer hour-two-token"]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("does not issue a create request after the authenticated tenant changes", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "augmentworks-tenant-switch-"));
    const apiOrigin = new URL("http://127.0.0.1:8787/");
    try {
      const prior = new RunIntentStore({
        apiOrigin,
        tenant: {
          workspace_id: "workspace-original",
          connector_id: "connector-original"
        },
        stateDirectory,
        createRequestId: () => `crq_${"a".repeat(32)}`
      });
      await prior.open();
      await prior.loadOrCreate({
        protocol_version: RELAY_PROTOCOL_VERSION,
        packet: { key: "support-refunds", version: "0.1.0" },
        config_sha256: "a".repeat(64),
        target: {
          name: "refunds",
          boundary_sha256: "b".repeat(64),
          capabilities: {
            prepare: false,
            observation: false,
            cleanup: false,
            tool_events: false,
            observation_keys: []
          }
        }
      });
      await prior.close();

      const relayFetch = vi.fn<typeof fetch>();
      const resolvedConfig = resolved();
      await expect(
        runTest(
          {
            env: {},
            packet: "support-refunds@0.1.0",
            stateDirectory,
            handleSignals: false
          },
          {
            doctor: async () => ({
              ok: true,
              configPath: resolvedConfig.configPath,
              offline: true,
              diagnostics: [],
              resolvedConfig
            }),
            apiOrigin: () => apiOrigin,
            accessToken: async () => "tenant-switch-token",
            identity: async () => ({
              subject: "user-2",
              workspaceId: "workspace-other",
              connectorId: "connector-other",
              scopes: ["connector:identity", "connector:run"]
            }),
            cloud: ({ accessToken, accessTokenProvider }) =>
              new CloudClient({
                apiUrl: apiOrigin,
                accessToken,
                accessTokenProvider,
                fetch: relayFetch
              }),
            stdout: { write: () => true },
            stderr: { write: () => true }
          }
        )
      ).rejects.toMatchObject({ code: "ACTIVE_RUN_TENANT_MISMATCH" });
      expect(relayFetch).not.toHaveBeenCalled();
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("re-verifies a changed bearer before allowing it to create a run", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "augmentworks-token-switch-"));
    const apiOrigin = new URL("http://127.0.0.1:8787/");
    try {
      let tokenCalls = 0;
      const relayFetch = vi.fn<typeof fetch>();
      const resolvedConfig = resolved();
      await expect(
        runTest(
          {
            env: {},
            packet: "support-refunds@0.1.0",
            stateDirectory,
            handleSignals: false
          },
          {
            doctor: async () => ({
              ok: true,
              configPath: resolvedConfig.configPath,
              offline: true,
              diagnostics: [],
              resolvedConfig
            }),
            apiOrigin: () => apiOrigin,
            accessToken: async () => {
              tokenCalls += 1;
              return tokenCalls === 1 ? "connector-one-token" : "connector-two-token";
            },
            identity: async ({ accessToken }) => ({
              subject: "user-1",
              workspaceId:
                accessToken === "connector-one-token" ? "workspace-one" : "workspace-two",
              connectorId:
                accessToken === "connector-one-token" ? "connector-one" : "connector-two",
              scopes: ["connector:identity", "connector:run"]
            }),
            cloud: ({ accessToken, accessTokenProvider }) =>
              new CloudClient({
                apiUrl: apiOrigin,
                accessToken,
                accessTokenProvider,
                fetch: relayFetch
              }),
            stdout: { write: () => true },
            stderr: { write: () => true }
          }
        )
      ).rejects.toMatchObject({ code: "AUTH_TENANT_CHANGED" });
      expect(relayFetch).not.toHaveBeenCalled();
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});

function resolved() {
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
