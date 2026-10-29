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
import { fixtureResponse, timedOutAttemptReport } from "../report/fixtures.js";

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

  // AUG-403: a timed-out attempt left the evaluation inconclusive. A fixed
  // server reports it complete; an older one keeps it partial with no judge
  // job left. Either way the run is finished and exits 10, not 11.
  describe("finished grading with a timed-out attempt (AUG-403)", () => {
    function statusWith(
      evaluationStatus: "complete" | "partial",
      completedJudgeJobs: number
    ): Record<string, unknown> {
      return {
        ...pendingGrading,
        executionStatus: "completed",
        evaluationStatus,
        nextActions: completedJudgeJobs < 1 ? ["wait", "inspect", "open_dashboard"] : ["inspect", "open_dashboard"],
        retryEligible: false,
        retryReason: null,
        progress: { completedAttempts: 2, plannedAttempts: 2, completedJudgeJobs, plannedJudgeJobs: 1 }
      };
    }

    async function serve(
      evaluationStatus: "complete" | "partial",
      completedJudgeJobs: number
    ): Promise<{ server: ListeningServer; paths: string[] }> {
      const holder: { origin?: string } = {};
      const started = await startMock((request, response, url) => {
        if (request.method !== "GET") return false;
        if (url.pathname === "/api/v1/cli/auth/me") {
          send(response, 200, identity());
          return true;
        }
        if (url.pathname === "/v1/billing/capabilities") {
          send(response, 200, fixtures.fixtures["absent_capability"]?.response);
          return true;
        }
        if (url.pathname === "/v1/billing/status") {
          send(response, 200, {
            ...statusWith(evaluationStatus, completedJudgeJobs),
            runId: RUN_ID,
            originalRunId: RUN_ID,
            workspaceId: WORKSPACE
          });
          return true;
        }
        if (url.pathname === reportPathFor(RUN_ID)) {
          send(response, 200, {
            ...timedOutAttemptReport(holder.origin ?? "", evaluationStatus),
            runId: RUN_ID,
            workspaceId: WORKSPACE
          });
          return true;
        }
        if (url.pathname.includes("/criteria")) {
          const fixture = fixtureResponse("criterion_index_r01_fail", holder.origin ?? "");
          send(response, fixture.status, {
            ...(fixture.body as Record<string, unknown>),
            runId: RUN_ID,
            workspaceId: WORKSPACE
          });
          return true;
        }
        return false;
      });
      holder.origin = started.server.baseUrl;
      return started;
    }

    for (const evaluationStatus of ["complete", "partial"] as const) {
      it(`run wait returns at once with exit 10 (${evaluationStatus})`, async () => {
        const cwd = await emptyCwd();
        const { server, paths } = await serve(evaluationStatus, 1);
        const started = Date.now();
        const result = await runPackedCli(["run", "wait", RUN_ID, "--json", "--timeout-ms", "600000"], {
          cwd,
          env: runEnv(server.baseUrl),
          timeoutMs: 30_000
        });
        expect(Date.now() - started).toBeLessThan(30_000);
        expect(result.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
        const payload = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(payload).toMatchObject({
          ok: true,
          assessment: "failed",
          exit_code: EXIT.ASSESSMENT_FAILED,
          evaluationStatus
        });
        expect(payload["outcome"]).toBe("failed");
        expect(paths).toContain(`GET ${reportPathFor(RUN_ID)}`);
        expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
      });
    }

    it("run wait keeps waiting on partial while a judge job remains", async () => {
      const cwd = await emptyCwd();
      const { server } = await serve("partial", 0);
      const result = await runPackedCli(["run", "wait", RUN_ID, "--json", "--timeout-ms", "1"], {
        cwd,
        env: runEnv(server.baseUrl)
      });
      expect(result.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
      expect((JSON.parse(result.stdout) as { safe_message: string }).safe_message).toContain(
        "Grading is still pending"
      );
    });

    for (const evaluationStatus of ["complete", "partial"] as const) {
      it(`run report exits 10, not 11 (${evaluationStatus})`, async () => {
        const cwd = await emptyCwd();
        const { server, paths } = await serve(evaluationStatus, 1);
        const result = await runPackedCli(["run", "report", RUN_ID, "--json"], {
          cwd,
          env: runEnv(server.baseUrl)
        });
        const document = JSON.parse(result.stdout) as { retrieved: boolean; complete: boolean };
        expect(document.retrieved).toBe(true);
        expect(document.complete).toBe(true);
        expect(result.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
        expect(paths.includes("GET /v1/billing/status")).toBe(evaluationStatus === "partial");
      });
    }
  });
});
