import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { ensurePackedCliBuilt, runPackedCli } from "../util/cli-process.js";
import { gradedReport, reportPathFor } from "../util/graded-report.js";
import { listenLoopback, type ListeningServer } from "../util/http-server.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOKEN = "aw_connector_test_access_token_run_wait";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "66666666-6666-4666-8666-666666666666";
const fixturesUrl = resolve(projectRoot, "contracts/aw-billing-v1.fixtures.json");

type FixtureFile = {
  fixtures: Record<string, { status?: number; response: unknown }>;
};

const fixtures = JSON.parse(await readFile(fixturesUrl, "utf8")) as FixtureFile;
const pendingGrading = fixtures.fixtures["status_pending_grading"]?.response as Record<
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
  const directory = await mkdtemp(join(tmpdir(), "aw-cli-run-wait-"));
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

function identity(): Record<string, unknown> {
  return {
    subject: "user_test",
    email: "developer@example.com",
    workspace_id: WORKSPACE,
    workspace_name: "Test Workspace",
    connector_id: "connector_test",
    connector_name: "Refunds Staging",
    scopes: ["connector:identity", "connector:run"]
  };
}

function billingStatus(overrides: Record<string, unknown>): Record<string, unknown> {
  const progressOverride = overrides["progress"];
  const progress =
    progressOverride !== undefined &&
    typeof progressOverride === "object" &&
    progressOverride !== null
      ? {
          ...(pendingGrading["progress"] as Record<string, unknown>),
          ...(progressOverride as Record<string, unknown>)
        }
      : pendingGrading["progress"];
  return {
    ...pendingGrading,
    ...overrides,
    progress
  };
}

const runningAbsent = billingStatus({
  executionStatus: "running",
  evaluationStatus: "absent",
  outcome: null,
  savedEvidence: false,
  nextActions: ["wait", "inspect", "open_dashboard"],
  progress: {
    completedAttempts: 0,
    plannedAttempts: 10,
    completedJudgeJobs: 0,
    plannedJudgeJobs: 0
  }
});

const deterministicPassed = billingStatus({
  executionStatus: "completed",
  evaluationStatus: "absent",
  outcome: "passed",
  savedEvidence: true,
  nextActions: ["inspect", "open_dashboard"],
  progress: {
    completedAttempts: 10,
    plannedAttempts: 10,
    completedJudgeJobs: 0,
    plannedJudgeJobs: 0
  }
});

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
    CI: "1",
    NO_COLOR: "1"
  };
}

describe("packed augmentworks run wait/status", () => {
  it("does not end wait successfully on running/absent/0-of-10/null-outcome", async () => {
    const cwd = await emptyCwd();
    let statusReads = 0;
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/status") {
        expect(url.searchParams.get("runId")).toBe(RUN_ID);
        statusReads += 1;
        send(response, 200, runningAbsent);
        return true;
      }
      return false;
    });

    const result = await runPackedCli(
      ["run", "wait", RUN_ID, "--json", "--timeout-ms", "1"],
      { cwd, env: runEnv(server.baseUrl) }
    );

    expect(result.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      code: string;
      exit_code: number;
      safe_message: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("EVALUATION_INCOMPLETE");
    expect(payload.exit_code).toBe(11);
    expect(payload.safe_message).toContain(RUN_ID);
    expect(payload.safe_message).toContain(`augmentworks run wait ${RUN_ID}`);
    expect(statusReads).toBeGreaterThanOrEqual(1);
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
    expect(paths).not.toContain("POST /v1/billing/quote");
    expect(paths).not.toContain("POST /v1/relay/runs");
    expect(paths.some((path) => path.includes(":retry-evaluation"))).toBe(false);
  });

  it("waits until running/absent becomes deterministic terminal success", async () => {
    const cwd = await emptyCwd();
    let statusReads = 0;
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/status") {
        expect(url.searchParams.get("runId")).toBe(RUN_ID);
        statusReads += 1;
        send(response, 200, statusReads === 1 ? runningAbsent : deterministicPassed);
        return true;
      }
      return false;
    });

    const result = await runPackedCli(["run", "wait", RUN_ID, "--json"], {
      cwd,
      env: runEnv(server.baseUrl),
      timeoutMs: 15_000
    });

    expect(result.exitCode).toBe(EXIT.OK);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      observation: string;
      assessment: string;
      exit_code: number;
      executionStatus: string;
      evaluationStatus: string;
      outcome?: string | null;
      originalRunId: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.observation).toBe("succeeded");
    expect(payload.assessment).toBe("passed");
    expect(payload.exit_code).toBe(0);
    expect(payload.executionStatus).toBe("completed");
    expect(payload.evaluationStatus).toBe("absent");
    expect(payload.outcome).toBe("passed");
    expect(payload.originalRunId).toBe(RUN_ID);
    expect(statusReads).toBe(2);
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
    expect(paths).not.toContain("POST /v1/billing/quote");
    expect(paths).not.toContain("POST /v1/relay/runs");
  });

  it("reports status of the reproduction as observation success with a non-zero gate", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/status") {
        send(response, 200, runningAbsent);
        return true;
      }
      return false;
    });

    const result = await runPackedCli(["run", "status", RUN_ID, "--json"], {
      cwd,
      env: runEnv(server.baseUrl)
    });

    expect(result.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      observation: string;
      work: string;
      assessment: string;
      exit_code: number;
      originalRunId: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.observation).toBe("succeeded");
    expect(payload.work).toBe("in_progress");
    expect(payload.assessment).toBe("incomplete");
    expect(payload.exit_code).toBe(11);
    expect(payload.originalRunId).toBe(RUN_ID);
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  });

  it("times out with read-only observation and keeps the original run id", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/status") {
        send(response, 200, runningAbsent);
        return true;
      }
      return false;
    });

    const result = await runPackedCli(["run", "wait", RUN_ID, "--timeout-ms", "1"], {
      cwd,
      env: runEnv(server.baseUrl)
    });

    expect(result.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(result.stderr).toContain("EVALUATION_INCOMPLETE");
    expect(result.stderr).toContain(RUN_ID);
    expect(result.stderr).toContain(`augmentworks run wait ${RUN_ID}`);
    expect(paths.filter((path) => path === "GET /v1/billing/status").length).toBeGreaterThanOrEqual(1);
    expect(paths).not.toContain("POST /v1/billing/quote");
    expect(paths).not.toContain("POST /v1/relay/runs");
    expect(paths.some((path) => path.includes(":retry-evaluation"))).toBe(false);
  });

  // Production billing status has no outcome field (AUG-384); the graded
  // outcome comes from the run report.
  describe("graded outcome from the run report (AUG-384)", () => {
    const gradedComplete = {
      ...pendingGrading,
      evaluationStatus: "complete",
      progress: { completedAttempts: 10, plannedAttempts: 10, completedJudgeJobs: 4, plannedJudgeJobs: 4 }
    };

    async function waitWithReport(report: Record<string, unknown> | undefined) {
      const cwd = await emptyCwd();
      const { server, paths } = await startMock((request, response, url) => {
        if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
          send(response, 200, identity());
          return true;
        }
        if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
          send(response, 200, fixtures.fixtures["absent_capability"]?.response);
          return true;
        }
        if (request.method === "GET" && url.pathname === "/v1/billing/status") {
          send(response, 200, gradedComplete);
          return true;
        }
        if (request.method === "GET" && url.pathname === reportPathFor(RUN_ID) && report !== undefined) {
          send(response, 200, report);
          return true;
        }
        return false;
      });
      const result = await runPackedCli(["run", "wait", RUN_ID, "--json", "--timeout-ms", "1"], {
        cwd,
        env: runEnv(server.baseUrl)
      });
      return { result, paths };
    }

    it("exits 0 when the graded report passed", async () => {
      const { result, paths } = await waitWithReport(gradedReport(RUN_ID, WORKSPACE));
      expect(result.exitCode).toBe(EXIT.OK);
      expect(JSON.parse(result.stdout)).toMatchObject({ assessment: "passed", outcome: "passed" });
      expect(paths).toContain(`GET ${reportPathFor(RUN_ID)}`);
    });

    it("exits 10 when a graded required check failed", async () => {
      const { result } = await waitWithReport(gradedReport(RUN_ID, WORKSPACE, { outcome: "failed" }));
      expect(result.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
      expect(JSON.parse(result.stdout)).toMatchObject({ assessment: "failed", outcome: "failed" });
    });

    it("never passes without a ready report", async () => {
      for (const report of [undefined, gradedReport(RUN_ID, WORKSPACE, { reportReady: false })]) {
        const { result } = await waitWithReport(report);
        expect(result.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
      }
    });
  });
});
