import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadAssessmentFile } from "../../src/assessment/load.js";
import { EXIT } from "../../src/errors.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import {
  admitCompiledSelection,
  requireSavedSuiteManifest,
  savedSuitePinFromManifest,
  shardCreateFields
} from "../../src/selection/admit.js";
import {
  CAPABILITY_FREE_SELECTION_ADVERTISEMENT,
  compileRequestFromAssessment,
  compileRequestFromFlags
} from "../../src/selection/request.js";
import { parseCompiledSuiteSelectionManifest } from "../../src/selection/parse.js";
import {
  CompileSuiteSelectionRequestSchema,
  SuiteSelectionManifestSchema
} from "../../src/selection/schema.js";
import { runSourceCli } from "../util/cli-process.js";
import { listenLoopback, readJsonBody, type ListeningServer } from "../util/http-server.js";
import { chatConnectorYaml } from "./connectors.js";
import {
  CANONICAL_HASH,
  OTHER_REVISION,
  PACKET_SHA,
  PLAN_HASH,
  POLICY_SCENARIO_IDS,
  SUITE_ID,
  SUITE_REVISION,
  savedSuiteAssessmentYaml,
  savedSuiteBinding,
  savedSuiteManifest
} from "./saved-suite-fixtures.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOKEN = "aw_connector_test_access_token_saved_suite";
const billingFixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-billing-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { response: unknown }> };
const v1Fixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-suite-selection-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { status?: number; response: unknown }> };

const temporaryDirectories: string[] = [];
const servers: ListeningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function identity(): Record<string, unknown> {
  return {
    subject: "user_test",
    email: "developer@example.com",
    workspace_id: "11111111-1111-4111-8111-111111111111",
    workspace_name: "Test Workspace",
    connector_id: "connector_test",
    connector_name: "Policy Staging",
    scopes: ["connector:identity", "connector:run"]
  };
}

async function startMock(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) => Promise<boolean> | boolean
): Promise<{ server: ListeningServer; paths: string[] }> {
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

function runEnv(apiOrigin: string, stateDirectory?: string): NodeJS.ProcessEnv {
  return {
    AUGMENTWORKS_API_URL: apiOrigin,
    AUGMENTWORKS_TOKEN: TOKEN,
    AUGMENTWORKS_API_KEY: "",
    AUGMENTWORKS_REFRESH_TOKEN: "",
    CI: "1",
    NO_COLOR: "1",
    ...(stateDirectory === undefined ? {} : { AUGMENTWORKS_STATE_DIR: stateDirectory })
  };
}

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "aw-saved-suite-"));
  temporaryDirectories.push(cwd);
  await writeFile(join(cwd, "augmentworks.yaml"), chatConnectorYaml(), "utf8");
  await writeFile(join(cwd, "policy.assessment.yaml"), savedSuiteAssessmentYaml(), "utf8");
  return cwd;
}

function expectSuiteTriple(assessment: Record<string, unknown> | undefined): void {
  expect(assessment?.["suite_id"]).toBe(SUITE_ID);
  expect(assessment?.["suite_revision_id"]).toBe(SUITE_REVISION);
  expect(assessment?.["suite_content_hash"]).toBe(CANONICAL_HASH);
  expect(assessment?.["selected_scenario_ids"]).toEqual([...POLICY_SCENARIO_IDS]);
  expect(assessment?.["plan_hash"]).toBe(PLAN_HASH);
}

function expectCode(run: () => void, code: string): void {
  try {
    run();
  } catch (error) {
    expect((error as { code: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("saved-suite v2 schema", () => {
  it("accepts a suite-only v2 manifest with catalogChecksum null and a complete binding", () => {
    const parsed = SuiteSelectionManifestSchema.safeParse(savedSuiteManifest());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.schemaVersion).toBe("aw-suite-selection/2");
    expect(parsed.data.catalogChecksum).toBeNull();
    expect(parsed.data.suiteBinding?.schemaVersion).toBe("aw-saved-suite-binding/1");
    expect(parsed.data.suiteBinding?.canonicalHash).toBe(CANONICAL_HASH);
  });

  it("still rejects a v1 catalogChecksum null the way current main did before this handoff", () => {
    const v1 = v1Fixtures.fixtures["compile_executable"]?.response as Record<string, unknown>;
    const parsed = SuiteSelectionManifestSchema.safeParse({ ...v1, catalogChecksum: null });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."))).toContain(
      "catalogChecksum"
    );
  });

  it("rejects duplicate, mixed-identity, over-limit, and tampered bindings before quote", () => {
    const duplicate = SuiteSelectionManifestSchema.safeParse(
      savedSuiteManifest({
        binding: savedSuiteBinding({
          cases: [
            { caseId: "policy-p01", scenarioId: POLICY_SCENARIO_IDS[0], repetitions: 1 },
            { caseId: "policy-p01", scenarioId: POLICY_SCENARIO_IDS[1], repetitions: 1 }
          ]
        })
      })
    );
    expect(duplicate.success).toBe(false);

    expectCode(
      () => requireSavedSuiteManifest(savedSuiteManifest({ suiteRevisionId: OTHER_REVISION })),
      "SAVED_SUITE_BINDING_INVALID"
    );
    expectCode(
      () => requireSavedSuiteManifest(savedSuiteManifest({ maxCases: 1 })),
      "SAVED_SUITE_BINDING_INVALID"
    );
    expectCode(
      () => requireSavedSuiteManifest(savedSuiteManifest({ tamperHash: true })),
      "SAVED_SUITE_BINDING_INVALID"
    );
    expectCode(
      () => requireSavedSuiteManifest(savedSuiteManifest({ catalogChecksum: CANONICAL_HASH })),
      "SAVED_SUITE_BINDING_INVALID"
    );
  });
});

describe("saved-suite compile request negotiation", () => {
  it("sends exactly aw-suite-selection/2 for a saved-suite assessment and omits it for catalog compiles", async () => {
    const cwd = await workspace();
    const loaded = await loadAssessmentFile({ path: "policy.assessment.yaml", cwd });
    const saved = compileRequestFromAssessment(loaded, CAPABILITY_FREE_SELECTION_ADVERTISEMENT);
    expect(saved.acceptedManifestVersions).toEqual(["aw-suite-selection/2"]);
    expect(saved.suiteRevisionId).toBe(SUITE_REVISION);
    expect(saved.includeCatalog).toBeUndefined();
    expect(saved.schemaVersion).toBe("aw-suite-selection/1");
    expect(JSON.parse(canonicalize(saved))["acceptedManifestVersions"]).toEqual(["aw-suite-selection/2"]);

    const catalog = compileRequestFromFlags({
      advertisement: CAPABILITY_FREE_SELECTION_ADVERTISEMENT,
      profile: "smoke",
      includeCatalog: true
    });
    expect(catalog.acceptedManifestVersions).toBeUndefined();
    expect(catalog.suiteRevisionId).toBeUndefined();
    expect(catalog.includeCatalog).toBe(true);
    expect("acceptedManifestVersions" in JSON.parse(canonicalize(catalog))).toBe(false);

    expect(
      CompileSuiteSelectionRequestSchema.safeParse({
        ...catalog,
        acceptedManifestVersions: ["aw-suite-selection/2"]
      }).success
    ).toBe(false);
  });

  it("parses a valid v2 compile and maps a v1 body to SAVED_SUITE_BINDING_UNSUPPORTED", async () => {
    const cwd = await workspace();
    const loaded = await loadAssessmentFile({ path: "policy.assessment.yaml", cwd });
    const request = compileRequestFromAssessment(loaded, CAPABILITY_FREE_SELECTION_ADVERTISEMENT);
    const parsed = parseCompiledSuiteSelectionManifest(savedSuiteManifest(), request);
    expect(parsed.schemaVersion).toBe("aw-suite-selection/2");
    expectCode(
      () => parseCompiledSuiteSelectionManifest(v1Fixtures.fixtures["compile_executable"]?.response, request),
      "SAVED_SUITE_BINDING_UNSUPPORTED"
    );
  });
});

describe("saved-suite admission pin", () => {
  it("projects the complete suite triple from the binding and keeps plan_hash as the shard hash", () => {
    const manifest = savedSuiteManifest();
    requireSavedSuiteManifest(manifest);
    const pin = savedSuitePinFromManifest(manifest);
    expect(pin).toEqual({
      suite_id: SUITE_ID,
      suite_revision_id: SUITE_REVISION,
      suite_content_hash: CANONICAL_HASH
    });
    if (pin === undefined) throw new Error("expected saved-suite pin");
    const created = shardCreateFields(manifest.shards[0]!, { suitePin: pin });
    expect(created.packet).toEqual({ key: "aw-customer-suite", version: "1.0.0" });
    expectSuiteTriple(created.assessment as unknown as Record<string, unknown>);
  });

  it("rejects a stale assessment revision after a valid v2 compile", () => {
    expectCode(
      () =>
        admitCompiledSelection(savedSuiteManifest(), {
          requestedSavedSuite: true,
          suiteVersion: "2.0.0",
          suiteRevisionId: OTHER_REVISION
        }),
      "SAVED_SUITE_BINDING_STALE"
    );
  });
});

describe("saved-suite local HTTP handoff", () => {
  it("compiles, estimates, and creates with the same suite triple and no extra quotes", async () => {
    const cwd = await workspace();
    const quoteBodies: Array<Record<string, unknown>> = [];
    const createBodies: Array<Record<string, unknown>> = [];
    const compileBodies: Array<Record<string, unknown>> = [];
    let apiOrigin = "http://127.0.0.1";
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        send(response, 200, billingFixtures.fixtures["eligible_trial"]?.response);
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/suite-selections/compile") {
        compileBodies.push((await readJsonBody(request)) as Record<string, unknown>);
        send(response, 200, savedSuiteManifest());
        return true;
      }
      if (request.method === "GET" && url.pathname === `/v1/suites/${SUITE_ID}/revisions/${SUITE_REVISION}`) {
        // A synthetic suite: no execution scope, so the run carries the config's boundary.
        send(response, 200, {
          suiteId: SUITE_ID,
          revisionId: SUITE_REVISION,
          contentHash: CANONICAL_HASH,
          canonicalDocument: { schemaVersion: "aw-customer-suite/2", suiteId: SUITE_ID }
        });
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/billing/quote") {
        quoteBodies.push((await readJsonBody(request)) as Record<string, unknown>);
        send(response, 200, billingFixtures.fixtures["quote_success_with_balance"]?.response);
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/relay/runs") {
        const body = (await readJsonBody(request)) as Record<string, unknown>;
        createBodies.push(body);
        send(response, 200, {
          protocol_version: "aw-relay/0.3",
          create_request_id: body["create_request_id"],
          create_request_sha256: sha256(canonicalize(body)),
          create_disposition: "created",
          run_id: "run-saved-suite",
          session_id: "session-saved-suite",
          packet: { key: "aw-customer-suite", version: "1.0.0", sha256: PACKET_SHA },
          config_sha256: body["config_sha256"],
          fencing_epoch: 1,
          status: "completed",
          dashboard_url: `${apiOrigin}/portal/runs/run-saved-suite`,
          run_expires_at: "2099-09-11T00:00:00.000Z",
          credit_state: "reserved"
        });
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/relay/runs/run-saved-suite") {
        send(response, 200, {
          protocol_version: "aw-relay/0.1",
          run_id: "run-saved-suite",
          status: "completed",
          credit_state: "reserved",
          outcome: "passed",
          evaluation_status: "complete"
        });
        return true;
      }
      return false;
    });
    apiOrigin = server.baseUrl;

    const compiled = await runSourceCli(
      ["selection", "compile", "--assessment", "policy.assessment.yaml", "--json"],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(compiled.exitCode).toBe(0);
    expect(compileBodies[0]?.["acceptedManifestVersions"]).toEqual(["aw-suite-selection/2"]);
    expect(compileBodies[0]?.["suiteRevisionId"]).toBe(SUITE_REVISION);
    expect(compileBodies[0]).not.toHaveProperty("includeCatalog");
    const compileJson = JSON.parse(compiled.stdout) as { schemaVersion: string; catalogChecksum: null };
    expect(compileJson.schemaVersion).toBe("aw-suite-selection/2");
    expect(compileJson.catalogChecksum).toBeNull();
    expect(paths).not.toContain("POST /v1/billing/quote");

    const estimate = await runSourceCli(
      ["test", "--assessment", "policy.assessment.yaml", "--estimate", "--json"],
      { cwd, env: runEnv(server.baseUrl, join(cwd, "state-estimate")) }
    );
    expect(estimate.exitCode).toBe(0);
    expect(quoteBodies).toHaveLength(1);
    expectSuiteTriple(quoteBodies[0]?.["assessment"] as Record<string, unknown>);
    expect(createBodies).toHaveLength(0);
    expect(paths.filter((path) => path === "POST /v1/relay/runs")).toEqual([]);

    const created = await runSourceCli(
      ["test", "--assessment", "policy.assessment.yaml", "--max-credits", "30", "--yes", "--json"],
      { cwd, env: runEnv(server.baseUrl, join(cwd, "state-create")) }
    );
    expect(created.exitCode).toBe(0);
    expect(quoteBodies).toHaveLength(2);
    expect(createBodies).toHaveLength(1);
    expectSuiteTriple(quoteBodies[1]?.["assessment"] as Record<string, unknown>);
    expectSuiteTriple(createBodies[0]?.["assessment"] as Record<string, unknown>);
    expect(createBodies[0]?.["quote_id"]).toBe("55555555-5555-4555-8555-555555555555");
    expect(createBodies[0]?.["max_credits"]).toBe(30);
    expect(canonicalize(quoteBodies[0]?.["assessment"])).toBe(canonicalize(createBodies[0]?.["assessment"]));
  });

  it("fails a legacy v1 response and HTTP 400 with SAVED_SUITE_BINDING_UNSUPPORTED and zero quotes", async () => {
    for (const mode of ["v1", "http400"] as const) {
      const cwd = await workspace();
      const { server, paths } = await startMock(async (request, response, url) => {
        if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
          send(response, 200, identity());
          return true;
        }
        if (request.method === "POST" && url.pathname === "/v1/suite-selections/compile") {
          if (mode === "v1") {
            send(response, 200, v1Fixtures.fixtures["compile_executable"]?.response);
          } else {
            send(response, 400, {
              error: {
                code: "SAVED_SUITE_BINDING_UNSUPPORTED",
                message: "This server does not emit aw-suite-selection/2."
              }
            });
          }
          return true;
        }
        if (url.pathname === "/v1/billing/quote" || url.pathname === "/v1/relay/runs") {
          throw new Error(`must not ${url.pathname}`);
        }
        return false;
      });
      const result = await runSourceCli(
        ["test", "--assessment", "policy.assessment.yaml", "--estimate", "--json"],
        { cwd, env: runEnv(server.baseUrl, join(cwd, "state")) }
      );
      expect(result.exitCode).toBe(EXIT.RELAY);
      expect(`${result.stdout}\n${result.stderr}`).toContain("SAVED_SUITE_BINDING_UNSUPPORTED");
      expect(paths).not.toContain("POST /v1/billing/quote");
      expect(paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);
    }
  });

  it("does not quote tampered, stale, or mixed bindings", async () => {
    const cases: Array<{
      readonly name: string;
      readonly code: string;
      readonly manifest: ReturnType<typeof savedSuiteManifest>;
      readonly assessment?: string;
    }> = [
      { name: "tampered", manifest: savedSuiteManifest({ tamperHash: true }), code: "SAVED_SUITE_BINDING_INVALID" },
      {
        name: "mixed",
        manifest: savedSuiteManifest({ suiteRevisionId: OTHER_REVISION }),
        code: "SAVED_SUITE_BINDING_INVALID"
      },
      {
        name: "stale",
        assessment: savedSuiteAssessmentYaml({ revisionId: OTHER_REVISION }),
        manifest: savedSuiteManifest(),
        code: "SAVED_SUITE_BINDING_STALE"
      }
    ];
    for (const entry of cases) {
      const cwd = await workspace();
      if (entry.assessment !== undefined) {
        await writeFile(join(cwd, "policy.assessment.yaml"), entry.assessment, "utf8");
      }
      const { server, paths } = await startMock(async (request, response, url) => {
        if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
          send(response, 200, identity());
          return true;
        }
        if (request.method === "POST" && url.pathname === "/v1/suite-selections/compile") {
          send(response, 200, entry.manifest);
          return true;
        }
        if (url.pathname === "/v1/billing/quote" || url.pathname === "/v1/relay/runs") {
          throw new Error(`must not ${url.pathname}`);
        }
        return false;
      });
      const result = await runSourceCli(
        ["test", "--assessment", "policy.assessment.yaml", "--estimate", "--json"],
        { cwd, env: runEnv(server.baseUrl, join(cwd, "state")) }
      );
      expect(result.exitCode, entry.name).toBe(EXIT.RELAY);
      expect(`${result.stdout}\n${result.stderr}`, entry.name).toContain(entry.code);
      expect(paths, entry.name).not.toContain("POST /v1/billing/quote");
    }
  });
});
