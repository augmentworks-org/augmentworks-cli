import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import { runRecover } from "../../src/commands/recover.js";
import { runEstimate, runTest, type TestDependencies } from "../../src/commands/test.js";
import { targetBoundarySha256 } from "../../src/config/boundary.js";
import { resolveConfig } from "../../src/config/resolve.js";
import type { ResolvedConfig } from "../../src/config/types.js";
import { loadPersistedDispatchPolicy } from "../../src/real-data/hosted.js";
import { loadExecutionScopeBinding } from "../../src/real-data/scope-store.js";
import type { DispatchPolicy } from "../../src/real-data/policy.js";
import type { RelayRunner } from "../../src/relay/runner.js";
import { loadCustomerSuiteFile } from "../../src/suite/load.js";
import { nativeSuiteContentHash, nativeSuiteSource } from "../../src/suite/native.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import type { ExecutionScopeResponse } from "../../src/real-data/documents.js";
import { relayCommand } from "../relay/helpers.js";
import { listenLoopback, readJsonBody } from "../util/http-server.js";
import { contractResponse, hostedScopeResponse, WORKSPACE_ID } from "./helpers.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const billing = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-billing-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { response: unknown }> };

const API = "http://127.0.0.1:8787";
const SUITE_REVISION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID = "run-authorized";
const temporaryDirectories: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const scopeResponse = hostedScopeResponse();
const defaultScopeResponse = scopeResponse;

async function projectDir(response: ExecutionScopeResponse = scopeResponse): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-authorized-admit-"));
  temporaryDirectories.push(directory);
  const fixture = await readFile(resolve(projectRoot, "test/fixtures/customer-suites/authorized.yaml"), "utf8");
  await writeFile(
    join(directory, "authorized.yaml"),
    fixture
      .replace(/scope_id: .*/u, `scope_id: ${response.scope.scopeId}`)
      .replace(/revision: 1/u, `revision: ${String(response.scope.revision)}`),
    "utf8"
  );
  return directory;
}

function resolvedFor(baseUrl: string): ResolvedConfig {
  const inspection = resolveConfig(
    {
      version: 1,
      target: {
        name: "support",
        connector: "http",
        base_url: baseUrl,
        operations: {
          send: {
            method: "POST",
            path: "/chat",
            request: { message: "$input.message.content" },
            response: { content: "$.answer" }
          }
        }
      }
    },
    "/tmp/augmentworks.yaml",
    "/tmp",
    {}
  );
  if (inspection.resolvedConfig === undefined) {
    throw new Error(`test config did not resolve: ${JSON.stringify(inspection.diagnostics)}`);
  }
  return inspection.resolvedConfig;
}

type Recorded = {
  paths: string[];
  quotes: Array<Record<string, unknown>>;
  creates: Array<Record<string, unknown>>;
  suites: Array<Record<string, unknown>>;
};

/** A server that admits only the boundary the execution scope registered, as hosted admission does. */
function admittingServer(cwd: string, scopeResponse: ExecutionScopeResponse = defaultScopeResponse) {
  const recorded: Recorded = { paths: [], quotes: [], creates: [], suites: [] };
  const mismatch = () =>
    Response.json(
      {
        error: {
          code: "TARGET_SCOPE_MISMATCH",
          message: "TARGET_SCOPE_MISMATCH: The compiled target boundary does not match the bound execution scope."
        }
      },
      { status: 403 }
    );
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    recorded.paths.push(`${method} ${url.pathname}`);
    const body =
      init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
    const boundary = (body?.["target"] as { boundary_sha256?: string } | undefined)?.boundary_sha256;
    if (url.pathname === "/v1/capabilities") return Response.json(contractResponse("get_capabilities"));
    if (url.pathname === `/v1/execution-scopes/${scopeResponse.scope.scopeId}`) return Response.json(scopeResponse);
    if (url.pathname === "/v1/suites") {
      recorded.suites.push(body ?? {});
      const loaded = await loadCustomerSuiteFile("authorized.yaml", cwd);
      return Response.json({
        suiteId: loaded.document.suiteId,
        suiteRevisionId: SUITE_REVISION,
        canonicalHash: nativeSuiteContentHash(nativeSuiteSource(loaded, scopeResponse.scope)),
        schemaVersion: "aw-customer-suite/3"
      });
    }
    if (url.pathname === "/v1/billing/capabilities") {
      return Response.json(billing.fixtures["eligible_trial"]?.response);
    }
    if (url.pathname === "/v1/billing/quote") {
      recorded.quotes.push(body ?? {});
      if (boundary !== scopeResponse.scope.targetBoundaryHash) return mismatch();
      return Response.json(billing.fixtures["quote_success_with_balance"]?.response);
    }
    if (url.pathname === "/v1/relay/runs" && method === "POST") {
      recorded.creates.push(body ?? {});
      if (boundary !== scopeResponse.scope.targetBoundaryHash) return mismatch();
      const request = body ?? {};
      return Response.json({
        protocol_version: "aw-relay/0.3",
        create_request_id: request["create_request_id"],
        create_request_sha256: sha256(canonicalize(request)),
        create_disposition: "created",
        run_id: RUN_ID,
        session_id: "session-1",
        packet: { ...(request["packet"] as object), sha256: "a".repeat(64) },
        config_sha256: request["config_sha256"],
        fencing_epoch: 1,
        status: "running",
        dashboard_url: `${API}/portal/runs/${RUN_ID}`,
        run_expires_at: "2099-09-06T00:00:00.000Z",
        credit_state: "reserved"
      });
    }
    if (url.pathname === `/v1/relay/runs/${RUN_ID}`) {
      return Response.json({
        protocol_version: "aw-relay/0.1",
        run_id: RUN_ID,
        status: "running",
        credit_state: "reserved",
        outcome: null
      });
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  });
  return { fetchMock, recorded };
}

function hostedDependencies(resolved: ResolvedConfig, fetchMock: typeof fetch) {
  return {
    doctor: async () => ({
      ok: true as const,
      configPath: resolved.configPath,
      offline: true as const,
      diagnostics: [],
      resolvedConfig: resolved
    }),
    isInteractive: () => false,
    apiOrigin: () => new URL(API),
    accessToken: async () => "token",
    identity: async () => ({
      subject: "user-1",
      workspaceId: WORKSPACE_ID,
      workspaceName: "Fixture workspace",
      connectorId: "connector-1",
      scopes: ["connector:identity", "connector:run"]
    }),
    cloud: (options: { apiOrigin: URL; accessToken: string; accessTokenProvider: () => Promise<string> }) =>
      new CloudClient({
        apiUrl: options.apiOrigin,
        accessToken: options.accessToken,
        accessTokenProvider: options.accessTokenProvider,
        fetch: fetchMock
      }),
    stdout: { write: () => true },
    stderr: { write: () => true }
  } satisfies TestDependencies;
}

function fakeRunner(onRun: (policy: DispatchPolicy | undefined) => void, result: "interrupt" | "complete") {
  return (options: ConstructorParameters<typeof RelayRunner>[0]) =>
    ({
      run: async () => {
        onRun(options.dispatchPolicy);
        if (result === "interrupt") throw new Error("interrupted before the run finished");
        return { protocol_version: "aw-relay/0.1", run_id: RUN_ID, status: "completed", outcome: "passed", credit_state: "consumed" };
      },
      requestCancellation: async () => {
        throw new Error("must not cancel");
      }
    }) as unknown as RelayRunner;
}

describe("authorized hosted admission (AUG-356)", () => {
  it("quotes and creates with the execution scope's boundary hash, and recover --resume continues the run", async () => {
    const cwd = await projectDir();
    const resolved = resolvedFor("https://support.example.com");
    expect(targetBoundarySha256(resolved)).not.toBe(scopeResponse.scope.targetBoundaryHash);
    const { fetchMock, recorded } = admittingServer(cwd);
    const policies: Array<DispatchPolicy | undefined> = [];

    const estimate = await runEstimate(
      { cwd, suite: "authorized.yaml", env: { AUGMENTWORKS_API_URL: API } },
      hostedDependencies(resolved, fetchMock)
    );
    expect(estimate.quote.quoteId).toBeDefined();

    await expect(
      runTest(
        {
          cwd,
          suite: "authorized.yaml",
          maxCredits: "30",
          yes: true,
          stateDirectory: cwd,
          handleSignals: false,
          env: { AUGMENTWORKS_API_URL: API }
        },
        { ...hostedDependencies(resolved, fetchMock), runner: fakeRunner((policy) => policies.push(policy), "interrupt") }
      )
    ).rejects.toThrow("interrupted");
    for (const body of [...recorded.quotes, ...recorded.creates]) {
      expect((body["target"] as { boundary_sha256: string }).boundary_sha256).toBe(
        scopeResponse.scope.targetBoundaryHash
      );
    }
    expect(recorded.quotes).toHaveLength(2);
    expect(recorded.creates).toHaveLength(1);
    expect(recorded.suites.length).toBeGreaterThan(0);
    for (const upload of recorded.suites) {
      expect(upload["executionScope"]).toEqual(scopeResponse.scope);
      expect(upload).not.toHaveProperty("packetOverlay");
    }
    expect(policies[0]?.kind).toBe("authorized");
    const binding = await loadExecutionScopeBinding(RUN_ID, { stateDirectory: cwd });
    expect(binding?.targetBoundary).toEqual(scopeResponse.targetBoundary);

    const report = await runRecover(
      { resume: true, stateDirectory: cwd, env: {}, handleSignals: false },
      { ...hostedDependencies(resolved, fetchMock), runner: fakeRunner((policy) => policies.push(policy), "complete") }
    );
    expect(report.outcome).toBe("resumed");
    expect(policies[1]?.kind).toBe("authorized");
    expect(recorded.creates).toHaveLength(1);
  });

  it("stops before uploading or quoting when augmentworks.yaml is outside the scope's boundary", async () => {
    const cwd = await projectDir();
    const resolved = resolvedFor("https://staging.example.com");
    const { fetchMock, recorded } = admittingServer(cwd);
    await expect(
      runTest(
        {
          cwd,
          suite: "authorized.yaml",
          maxCredits: "30",
          yes: true,
          stateDirectory: cwd,
          handleSignals: false,
          env: { AUGMENTWORKS_API_URL: API }
        },
        hostedDependencies(resolved, fetchMock)
      )
    ).rejects.toMatchObject({ code: "TARGET_SCOPE_MISMATCH", message: expect.stringContaining("Set base_url to") });
    expect(recorded.paths).not.toContain("POST /v1/suites");
    expect(recorded.quotes).toHaveLength(0);
    expect(recorded.creates).toHaveLength(0);
  });
});

describe("private targets verified by connector challenge (AUG-399)", () => {
  const privateScope = (verificationMethod: "connector_challenge" | "https_challenge") =>
    hostedScopeResponse({ boundary: { assessedIdentity: "http://127.0.0.1:8000" }, verificationMethod });

  it("quotes and runs a verified 127.0.0.1 target, and recover --resume keeps it allowed", async () => {
    const response = privateScope("connector_challenge");
    const cwd = await projectDir(response);
    const resolved = resolvedFor("http://127.0.0.1:8000");
    const { fetchMock, recorded } = admittingServer(cwd, response);
    const policies: Array<DispatchPolicy | undefined> = [];

    const estimate = await runEstimate(
      { cwd, suite: "authorized.yaml", env: { AUGMENTWORKS_API_URL: API } },
      hostedDependencies(resolved, fetchMock)
    );
    expect(estimate.quote.quoteId).toBeDefined();

    await expect(
      runTest(
        {
          cwd,
          suite: "authorized.yaml",
          maxCredits: "30",
          yes: true,
          stateDirectory: cwd,
          handleSignals: false,
          env: { AUGMENTWORKS_API_URL: API }
        },
        { ...hostedDependencies(resolved, fetchMock), runner: fakeRunner((policy) => policies.push(policy), "interrupt") }
      )
    ).rejects.toThrow("interrupted");
    expect(recorded.quotes).toHaveLength(2);
    expect(recorded.creates).toHaveLength(1);
    for (const body of [...recorded.quotes, ...recorded.creates]) {
      expect((body["target"] as { boundary_sha256: string }).boundary_sha256).toBe(
        response.scope.targetBoundaryHash
      );
    }
    expect(policies[0]).toMatchObject({
      kind: "authorized",
      local: false,
      allowPrivate: true,
      origin: "http://127.0.0.1:8000"
    });
    const binding = await loadExecutionScopeBinding(RUN_ID, { stateDirectory: cwd });
    expect(binding?.allowPrivate).toBe(true);
    await expect(
      loadPersistedDispatchPolicy({
        runId: RUN_ID,
        configSha256: resolved.configDigest,
        workspaceId: WORKSPACE_ID,
        resolved,
        stateDirectory: cwd
      })
    ).resolves.toBeUndefined();

    const report = await runRecover(
      { resume: true, stateDirectory: cwd, env: {}, handleSignals: false },
      { ...hostedDependencies(resolved, fetchMock), runner: fakeRunner((policy) => policies.push(policy), "complete") }
    );
    expect(report.outcome).toBe("resumed");
    expect(policies[1]).toMatchObject({ kind: "authorized", allowPrivate: true, origin: "http://127.0.0.1:8000" });
    expect(recorded.creates).toHaveLength(1);
  });

  it("sends a relay command to the verified 127.0.0.1 target with the real runner and connector", async () => {
    const targetRequests: unknown[] = [];
    const target = await listenLoopback(
      createServer((request, response) => {
        void readJsonBody(request).then((body) => {
          targetRequests.push(body);
          const reply = JSON.stringify({ answer: "Weekday hours are 9:00-17:00 UTC." });
          response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(reply) });
          response.end(reply);
        });
      })
    );
    closers.push(() => target.close());
    const scoped = hostedScopeResponse({
      boundary: { assessedIdentity: target.baseUrl },
      verificationMethod: "connector_challenge"
    });
    const cwd = await projectDir(scoped);
    const resolved = resolvedFor(target.baseUrl);
    const { fetchMock: admit, recorded } = admittingServer(cwd, scoped);
    const completions: Array<Record<string, unknown>> = [];
    let created: Record<string, unknown> | undefined;
    let polls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const body =
        init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
      if (url.pathname === "/v1/relay/sessions/session-1/commands:poll") {
        polls += 1;
        const command =
          polls === 1 && created !== undefined
            ? {
                ...relayCommand("send"),
                run_id: RUN_ID,
                session_id: "session-1",
                packet: { ...(created["packet"] as object), sha256: "a".repeat(64) },
                config_sha256: created["config_sha256"],
                fencing_epoch: 1
              }
            : null;
        return Response.json({
          protocol_version: "aw-relay/0.1",
          run_id: RUN_ID,
          session_id: "session-1",
          status: command === null ? "completed" : "running",
          command
        });
      }
      if (url.pathname.startsWith("/v1/relay/commands/") && url.pathname.endsWith(":complete")) {
        completions.push(body ?? {});
        return Response.json({ protocol_version: "aw-relay/0.1", command_id: body?.["command_id"], accepted: true });
      }
      if (url.pathname === `/v1/relay/runs/${RUN_ID}` && completions.length > 0) {
        return Response.json({
          protocol_version: "aw-relay/0.1",
          run_id: RUN_ID,
          status: "completed",
          credit_state: "consumed",
          outcome: "passed",
          evaluation_status: "complete"
        });
      }
      const forwarded = await admit(input, init);
      if (url.pathname === "/v1/relay/runs" && forwarded.ok) created = body;
      return forwarded;
    });

    const result = await runTest(
      {
        cwd,
        suite: "authorized.yaml",
        maxCredits: "30",
        yes: true,
        stateDirectory: cwd,
        handleSignals: false,
        env: { AUGMENTWORKS_API_URL: API }
      },
      hostedDependencies(resolved, fetchMock)
    );
    expect(recorded.creates).toHaveLength(1);
    expect(result.run.status).toBe("completed");
    expect(targetRequests).toEqual([{ message: "Refund the order" }]);
    expect(completions).toHaveLength(1);
    expect(JSON.stringify(completions[0])).toContain("Weekday hours are 9:00-17:00 UTC.");
  });

  it("still refuses a private target whose authority was verified any other way, before uploading or quoting", async () => {
    const response = privateScope("https_challenge");
    const cwd = await projectDir(response);
    const resolved = resolvedFor("http://127.0.0.1:8000");
    const { fetchMock, recorded } = admittingServer(cwd, response);
    await expect(
      runTest(
        {
          cwd,
          suite: "authorized.yaml",
          maxCredits: "30",
          yes: true,
          stateDirectory: cwd,
          handleSignals: false,
          env: { AUGMENTWORKS_API_URL: API }
        },
        hostedDependencies(resolved, fetchMock)
      )
    ).rejects.toMatchObject({
      code: "TARGET_SCOPE_MISMATCH",
      message: expect.stringContaining("verified from this machine (connector challenge)")
    });
    expect(recorded.paths).not.toContain("POST /v1/suites");
    expect(recorded.quotes).toHaveLength(0);
    expect(recorded.creates).toHaveLength(0);
  });
});

