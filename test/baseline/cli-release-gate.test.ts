import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { ensurePackedCliBuilt, runPackedCli } from "../util/cli-process.js";
import { listenLoopback, readJsonBody, type ListeningServer } from "../util/http-server.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOKEN = "aw_connector_test_access_token_release_gate";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "77777777-7777-4777-8777-777777777777";
const BASELINE_ID = "88888888-8888-4888-8888-888888888888";

type PolicyFixtures = {
  identities: { candidateRunId: string; baselineId: string };
  fixtures: Record<string, { status?: number; response: unknown }>;
};

const policyFixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-release-policy-v1.fixtures.json"), "utf8")
) as PolicyFixtures;
const billingFixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-billing-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { status?: number; response: unknown }> };

const pendingGrading = billingFixtures.fixtures["status_pending_grading"]?.response as Record<
  string,
  unknown
>;

const temporaryDirectories: string[] = [];
const servers: ListeningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

beforeAll(async () => {
  await ensurePackedCliBuilt();
}, 120_000);

async function emptyCwd(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-cli-release-gate-"));
  temporaryDirectories.push(directory);
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

function identity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: "user_test",
    email: "developer@example.com",
    workspace_id: WORKSPACE,
    workspace_name: "Test Workspace",
    connector_id: "connector_test",
    connector_name: "Refunds Staging",
    scopes: ["connector:identity", "connector:run"],
    ...overrides
  };
}

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

function runEnv(apiOrigin: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AUGMENTWORKS_API_URL: apiOrigin,
    AUGMENTWORKS_TOKEN: TOKEN,
    AUGMENTWORKS_API_KEY: "",
    AUGMENTWORKS_REFRESH_TOKEN: "",
    CI: "1",
    NO_COLOR: "1"
  };
}

function fixture(name: string): { status: number; response: unknown } {
  const entry = policyFixtures.fixtures[name];
  if (entry === undefined) throw new Error(`missing fixture ${name}`);
  return { status: entry.status ?? 200, response: entry.response };
}

function assertObservationOnly(paths: readonly string[]): void {
  expect(paths.some((path) => path.startsWith("POST /v1/relay/runs"))).toBe(false);
  expect(paths).not.toContain("POST /v1/billing/quote");
  expect(paths.some((path) => path.includes(":retry-evaluation"))).toBe(false);
  expect(paths).not.toContain("POST /v1/baselines");
}

describe("packed augmentworks compare/gate/baseline", () => {
  it("exits 10 for a new required regression when pass rates match and HTTP succeeds", async () => {
    const cwd = await emptyCwd();
    const blocked = fixture("blocked_equal_pass_rate");
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/comparisons/evaluate") {
        const body = (await readJsonBody(request)) as Record<string, unknown>;
        expect(body["schemaVersion"]).toBe("aw-comparison/1");
        expect(body["candidateRunId"]).toBe(RUN_ID);
        expect(body["baselineId"]).toBe(BASELINE_ID);
        send(response, blocked.status, blocked.response);
        return true;
      }
      return false;
    });

    const result = await runPackedCli(
      ["compare", "--run", RUN_ID, "--baseline", BASELINE_ID, "--json"],
      { cwd, env: runEnv(server.baseUrl) }
    );

    expect(result.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      assessment: string;
      exit_code: number;
      decision: string;
      candidateRunId: string;
      baselineId: string;
      policyVersion: string;
      candidateEvaluationRevision: number;
      baselinePromotionRevision: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.assessment).toBe("blocked");
    expect(payload.decision).toBe("block");
    expect(payload.exit_code).toBe(10);
    expect(payload.candidateRunId).toBe(RUN_ID);
    expect(payload.baselineId).toBe(BASELINE_ID);
    expect(payload.policyVersion).toBe("aw-release-policy/1");
    expect(payload.candidateEvaluationRevision).toBe(4);
    expect(payload.baselinePromotionRevision).toBe(2);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("not a passing release");
    expect(result.stderr).not.toMatch(/^\s*\{/m);
    assertObservationOnly(paths);
    expect(paths).toContain("POST /v1/comparisons/evaluate");
  });

  it("returns stable pass JSON without leaking human diagnostics onto stdout", async () => {
    const cwd = await emptyCwd();
    const passing = fixture("pass_compatible");
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/release-gates/evaluate") {
        const body = (await readJsonBody(request)) as Record<string, unknown>;
        expect(body["schemaVersion"]).toBe("aw-release-policy/1");
        send(response, passing.status, passing.response);
        return true;
      }
      return false;
    });

    const result = await runPackedCli(
      ["gate", "--run", RUN_ID, "--baseline", BASELINE_ID, "--json"],
      { cwd, env: runEnv(server.baseUrl) }
    );

    expect(result.exitCode).toBe(EXIT.OK);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      assessment: string;
      createsBillableRun: boolean;
      candidateEvaluationRevision: number | null;
      baselineEvaluationRevision: number | null;
      baselineSnapshotHash: string | null;
      portalUrl: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.assessment).toBe("passed");
    expect(payload.createsBillableRun).toBe(false);
    expect(payload.candidateEvaluationRevision).toBe(5);
    expect(payload.baselineEvaluationRevision).toBe(3);
    expect(payload.baselineSnapshotHash).toBe(
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    );
    expect(payload.portalUrl).toContain("/portal/compare");
    expect(result.stderr).toBe("");
    assertObservationOnly(paths);
  });

  it("does not exit 0 for pending, evaluator error, incompatible scope, or missing coverage", async () => {
    const cwd = await emptyCwd();
    const cases = [
      { name: "incomplete_pending", exit: EXIT.EVALUATION_INCOMPLETE },
      { name: "evaluator_error", exit: EXIT.EVALUATION_ERROR },
      { name: "incompatible_scope", exit: EXIT.CONFIG },
      { name: "missing_required_coverage", exit: EXIT.EVALUATION_INCOMPLETE },
      { name: "unknown_decision", exit: EXIT.EVALUATION_INCOMPLETE }
    ] as const;
    for (const testCase of cases) {
      const document = fixture(testCase.name);
      const { server, paths } = await startMock(async (request, response, url) => {
        if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
          send(response, 200, identity());
          return true;
        }
        if (request.method === "POST" && url.pathname === "/v1/release-gates/evaluate") {
          send(response, document.status, document.response);
          return true;
        }
        return false;
      });
      const result = await runPackedCli(
        ["gate", "--run", RUN_ID, "--baseline", BASELINE_ID, "--json"],
        { cwd, env: runEnv(server.baseUrl) }
      );
      expect(result.exitCode, testCase.name).toBe(testCase.exit);
      expect(result.exitCode, testCase.name).not.toBe(0);
      assertObservationOnly(paths);
    }
  });

  it("maps missing baseline and auth errors without colliding with billing exit 13", async () => {
    const cwd = await emptyCwd();
    const missing = fixture("missing_baseline");
    const missingServer = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/release-gates/evaluate") {
        send(response, missing.status, missing.response);
        return true;
      }
      return false;
    });
    const missingResult = await runPackedCli(
      ["gate", "--run", RUN_ID, "--baseline", BASELINE_ID, "--json"],
      { cwd, env: runEnv(missingServer.server.baseUrl) }
    );
    expect(missingResult.exitCode).toBe(EXIT.CONFIG);
    expect(JSON.parse(missingResult.stdout).code).toBe("MISSING_BASELINE");
    assertObservationOnly(missingServer.paths);

    const authServer = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 401, { error: "invalid_token" });
        return true;
      }
      return false;
    });
    const authResult = await runPackedCli(
      ["compare", "--run", RUN_ID, "--baseline", BASELINE_ID, "--json"],
      { cwd, env: runEnv(authServer.server.baseUrl) }
    );
    expect(authResult.exitCode).toBe(EXIT.AUTH);
    expect(authResult.exitCode).not.toBe(EXIT.BILLING);
    expect(authServer.paths.some((path) => path.startsWith("POST /v1/"))).toBe(false);
  });

  it("times out wait on the original run without substituting a newer run", async () => {
    const cwd = await emptyCwd();
    let statusReads = 0;
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        send(response, 200, billingFixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/status") {
        expect(url.searchParams.get("runId")).toBe(RUN_ID);
        statusReads += 1;
        send(response, 200, { ...pendingGrading, runId: RUN_ID, originalRunId: RUN_ID });
        return true;
      }
      return false;
    });

    const result = await runPackedCli(
      ["gate", "--run", RUN_ID, "--baseline", BASELINE_ID, "--wait", "--timeout-ms", "1", "--json"],
      { cwd, env: runEnv(server.baseUrl) }
    );

    expect(result.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    const payload = JSON.parse(result.stdout) as { ok: boolean; code: string; safe_message: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("EVALUATION_INCOMPLETE");
    expect(payload.safe_message).toContain(RUN_ID);
    expect(payload.safe_message).not.toMatch(/retry-evaluation|POST \/v1\/relay\/runs/i);
    expect(statusReads).toBeGreaterThanOrEqual(1);
    expect(paths).not.toContain("POST /v1/release-gates/evaluate");
    assertObservationOnly(paths);
  });

  it("returns 409 promotion conflict for an authorized pin update", async () => {
    const cwd = await emptyCwd();
    const conflict = fixture("promotion_conflict");
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity({ actions: ["baseline:promote", "baseline:create"], principal_kind: "user" }));
        return true;
      }
      if (request.method === "POST" && url.pathname === `/v1/baselines/${BASELINE_ID}/promote`) {
        const body = (await readJsonBody(request)) as Record<string, unknown>;
        expect(body["runId"]).toBe(RUN_ID);
        expect(body["expectedPromotionRevision"]).toBe(2);
        expect(body).not.toHaveProperty("candidateRunId");
        send(response, conflict.status, conflict.response);
        return true;
      }
      return false;
    });

    const result = await runPackedCli(
      [
        "baseline",
        "promote",
        "--run",
        RUN_ID,
        "--baseline",
        BASELINE_ID,
        "--expected-revision",
        "2",
        "--json"
      ],
      { cwd, env: runEnv(server.baseUrl) }
    );

    expect(result.exitCode).toBe(EXIT.RELAY);
    expect(JSON.parse(result.stdout).code).toBe("PROMOTION_CONFLICT");
    expect(paths).toContain(`POST /v1/baselines/${BASELINE_ID}/promote`);
    assertObservationOnly(paths);
  });

  it("creates the first baseline and promotes a newer run with CLI commands only (AUG-383)", async () => {
    const cwd = await emptyCwd();
    const producer = JSON.parse(
      await readFile(resolve(projectRoot, "contracts/aw-feature-v1.producer.fixtures.json"), "utf8")
    ) as { fixtures: Record<string, { document: Record<string, unknown> }> };
    const NEXT_RUN = "99999999-9999-4999-8999-999999999990";
    let promotionRevision = 0;
    let pinnedRun = "";
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity({ actions: ["baseline:promote", "baseline:create"], principal_kind: "user" }));
        return true;
      }
      const record = () => ({
        ok: true,
        createsBillableRun: false,
        record: {
          ...producer.fixtures["baseline_record"]?.document,
          baselineId: BASELINE_ID,
          runId: pinnedRun,
          promotionRevision
        }
      });
      // Mirrors the server's parseCreateBody and parsePromoteBody.
      if (request.method === "POST" && url.pathname === "/v1/baselines") {
        const body = (await readJsonBody(request)) as Record<string, unknown>;
        expect(body).toMatchObject({
          name: "main",
          applicationName: "support-bot",
          environmentName: "production",
          runId: RUN_ID
        });
        pinnedRun = RUN_ID;
        promotionRevision = 1;
        send(response, 201, record());
        return true;
      }
      if (request.method === "POST" && url.pathname === `/v1/baselines/${BASELINE_ID}/promote`) {
        const body = (await readJsonBody(request)) as Record<string, unknown>;
        if (typeof body["runId"] !== "string") {
          send(response, 400, { error: { code: "invalid_request", message: "runId must be a UUID." } });
          return true;
        }
        if (body["expectedPromotionRevision"] !== promotionRevision) {
          send(response, 409, { error: { code: "promotion_conflict", message: "stale revision" } });
          return true;
        }
        pinnedRun = body["runId"];
        promotionRevision += 1;
        send(response, 200, record());
        return true;
      }
      return false;
    });

    const created = await runPackedCli(
      [
        "baseline",
        "create",
        "--run",
        RUN_ID,
        "--name",
        "main",
        "--application",
        "support-bot",
        "--environment",
        "production",
        "--json"
      ],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(created.exitCode).toBe(EXIT.OK);
    const createdJson = JSON.parse(created.stdout) as Record<string, unknown>;
    expect(createdJson).toMatchObject({ ok: true, assessment: "created", createsBillableRun: false });

    const human = await runPackedCli(
      ["baseline", "promote", "--run", NEXT_RUN, "--baseline", BASELINE_ID, "--expected-revision", "1"],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain(`Promoted ${BASELINE_ID}`);
    expect(pinnedRun).toBe(NEXT_RUN);
    expect(promotionRevision).toBe(2);
    assertObservationOnly(paths.filter((path) => path !== "POST /v1/baselines"));
  });

  it("refuses an expected revision of 0 before calling the server", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity({ actions: ["baseline:promote"], principal_kind: "user" }));
        return true;
      }
      return false;
    });
    const result = await runPackedCli(
      ["baseline", "promote", "--run", RUN_ID, "--baseline", BASELINE_ID, "--expected-revision", "0", "--json"],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(JSON.parse(result.stdout).code).toBe("INVALID_PROMOTION_REVISION");
    expect(paths.some((path) => path.includes("/promote"))).toBe(false);
  });

  it("refuses machine promotion locally and lists baselines without admission", async () => {
    const cwd = await emptyCwd();
    const listed = fixture("applications_ok");
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity({ principal_kind: "machine", actions: ["run:read"] }));
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/applications") {
        send(response, listed.status, listed.response);
        return true;
      }
      return false;
    });

    const forbidden = await runPackedCli(
      [
        "baseline",
        "promote",
        "--run",
        RUN_ID,
        "--baseline",
        BASELINE_ID,
        "--expected-revision",
        "2",
        "--json"
      ],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(forbidden.exitCode).toBe(EXIT.AUTH);
    expect(JSON.parse(forbidden.stdout).code).toBe("PROMOTION_FORBIDDEN");
    expect(paths.some((path) => path.includes("/promote"))).toBe(false);

    const status = await runPackedCli(["baseline", "status", "--json"], {
      cwd,
      env: runEnv(server.baseUrl)
    });
    expect(status.exitCode).toBe(EXIT.OK);
    const payload = JSON.parse(status.stdout) as { ok: boolean; createsBillableRun: boolean };
    expect(payload.ok).toBe(true);
    expect(payload.createsBillableRun).toBe(false);
    assertObservationOnly(paths);
  });

  it("rejects createsBillableRun on an otherwise passing gate", async () => {
    const cwd = await emptyCwd();
    const billed = fixture("creates_billable_run");
    const { server, paths } = await startMock(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/release-gates/evaluate") {
        send(response, billed.status, billed.response);
        return true;
      }
      return false;
    });
    const result = await runPackedCli(
      ["gate", "--run", RUN_ID, "--baseline", BASELINE_ID, "--json"],
      { cwd, env: runEnv(server.baseUrl) }
    );
    expect(result.exitCode).toBe(EXIT.RELAY);
    expect(JSON.parse(result.stdout).code).toBe("CREATES_BILLABLE_RUN");
    assertObservationOnly(paths);
  });
});
