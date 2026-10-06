import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { exportHostedRunReport, classifyRunReportExport } from "../../src/report/client.js";
import {
  REPORT_COVERAGE_MISMATCH,
  REPORT_EVIDENCE_CONTRADICTION
} from "../../src/report/consistency.js";
import { listenLoopback, type ListeningServer } from "../util/http-server.js";
import {
  CANONICAL_ORIGIN,
  FIXTURE_WORKSPACE_ID,
  OTHER_WORKSPACE_ID,
  REPORT_RUN_ID,
  asRecord,
  fixtureIdentity,
  fixtureResponse,
  mutatedFixtureResponse,
  rewriteOrigin
} from "./fixtures.js";

const TOKEN = "aw_api_test_report_export_token";

const servers: ListeningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function send(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

async function startMock(
  handler: (request: IncomingMessage, response: ServerResponse, url: URL) => boolean
): Promise<{ server: ListeningServer; paths: string[] }> {
  const paths: string[] = [];
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    paths.push(`${request.method ?? "GET"} ${url.pathname}`);
    if (!handler(request, response, url) && !response.writableEnded) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
    }
  });
  const server = await listenLoopback(httpServer);
  servers.push(server);
  return { server, paths };
}

async function exportFrom(
  server: ListeningServer,
  options: { expectedWorkspaceId?: string | null; signal?: AbortSignal } = {}
): Promise<ReturnType<typeof exportHostedRunReport>> {
  const expectedWorkspaceId =
    options.expectedWorkspaceId === null
      ? undefined
      : (options.expectedWorkspaceId ?? FIXTURE_WORKSPACE_ID);
  return await exportHostedRunReport(REPORT_RUN_ID, {
    apiOrigin: new URL(server.baseUrl),
    credentialSource: "api_key",
    accessTokenProvider: async () => TOKEN,
    sleep: async () => undefined,
    ...(expectedWorkspaceId === undefined ? {} : { expectedWorkspaceId }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
}

function serveMutated(
  response: ServerResponse,
  name: string,
  origin: string,
  mutate: (body: Record<string, unknown>) => void
): void {
  const fixture = mutatedFixtureResponse(name, origin, mutate);
  send(response, fixture.status, fixture.body, fixture.headers ?? {});
}

function pageRecord(body: Record<string, unknown>): Record<string, unknown> {
  return asRecord(body["page"]);
}

function coverageRecord(body: Record<string, unknown>): Record<string, unknown> {
  return asRecord(body["coverage"]);
}

function serveFixture(response: ServerResponse, name: string, origin: string): void {
  const fixture = fixtureResponse(name, origin);
  send(response, fixture.status, fixture.body, fixture.headers ?? {});
}

describe("hosted report HTTP contract", () => {
  it("exports a one-page passed report with criterion evidence", async () => {
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method !== "GET") return false;
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.report?.outcome).toBe("passed");
    expect(document.criteria).toHaveLength(1);
    expect(document.criteria?.[0]?.["verdict"]).toBe("pass");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.OK);
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
    expect(JSON.stringify(document)).not.toContain(TOKEN);
  });

  it("exports a complete failed assessment with exit 10, never pass", async () => {
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(response, "report_required_fail", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_fail", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.report?.outcome).toBe("failed");
    expect(document.report?.attempts[0]?.mappedResponse.text).toContain("365 days");
    expect(document.criteria?.[0]?.["verdict"]).toBe("fail");
    const classified = classifyRunReportExport(document);
    expect(classified.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    expect(classified.assessment).toBe("failed");
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  });

  it("follows multi-page reports and criterion pagination under one binding", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(
          response,
          url.searchParams.get("cursor") === "page-2" ? "report_page_2" : "report_page_1",
          server.baseUrl
        );
        return true;
      }
      if (url.pathname.endsWith("/criteria")) {
        if (url.pathname.includes("/attempts/cccccccc-cccc-4ccc-8ccc-cccccccccccc/")) {
          if (url.searchParams.get("cursor") === "crit-2") {
            serveFixture(response, "criterion_index_page_2", server.baseUrl);
            return true;
          }
          serveFixture(response, "criterion_index_page_1", server.baseUrl);
          return true;
        }
        if (url.pathname.includes("/attempts/cececece-cece-4cec-8cec-cececececece/")) {
          serveFixture(response, "criterion_index_r04_pass", server.baseUrl);
          return true;
        }
      }
      if (url.pathname.endsWith("/dddddddd-dddd-4ddd-8ddd-dddddddddddd")) {
        serveFixture(response, "criterion_detail_r01_pass", server.baseUrl);
        return true;
      }
      if (url.pathname.endsWith("/dfdfdfdf-dfdf-4dfd-8dfd-dfdfdfdfdfdf")) {
        serveFixture(response, "criterion_detail_r01_clarity", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.report?.attempts).toHaveLength(2);
    expect(document.criteria).toHaveLength(3);
  });

  it("rejects a report whose runId does not match the request", async () => {
    const { server } = await startMock((_request, response) => {
      const fixture = fixtureResponse("report_all_pass_one_page", server.baseUrl);
      const body = fixture.body as { runId: string };
      send(response, 200, { ...body, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.complete).toBe(false);
    expect(document.error?.code).toBe("REPORT_ID_MISMATCH");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.RELAY);
  });

  it("maps missing report scope to auth exit 3", async () => {
    const { server } = await startMock((_request, response) => {
      send(response, 403, { error: "insufficient_scope" });
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("SCOPE_DENIED");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.AUTH);
  });

  it("does not treat reportReady false as a passing assessment", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        const fixture = fixtureResponse("report_all_pass_one_page", server.baseUrl);
        send(response, 200, { ...(fixture.body as object), reportReady: false });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.report?.outcome).toBe("passed");
    expect(document.report?.reportReady).toBe(false);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("fails when evaluation binding changes during pagination", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(
          response,
          url.searchParams.get("cursor") === "page-2"
            ? "report_binding_changed_page_2"
            : "report_page_1",
          server.baseUrl
        );
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.complete).toBe(false);
    expect(document.error?.code).toBe("REPORT_BINDING_CHANGED");
  });

  it("refuses hostile off-origin criterion links with the bearer", async () => {
    const { server } = await startMock((_request, response) => {
      serveFixture(response, "report_off_origin_link", server.baseUrl);
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("UNSAFE_REPORT_LINK");
  });

  it("refuses cursor cycles", async () => {
    const { server } = await startMock((_request, response) => {
      serveFixture(response, "report_cursor_cycle", server.baseUrl);
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.diagnostics.some((item) => item.code === "REPORT_CURSOR_CYCLE")).toBe(true);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("retries 429 then succeeds", async () => {
    let hits = 0;
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        hits += 1;
        if (hits === 1) {
          serveFixture(response, "error_429", server.baseUrl);
          return true;
        }
        serveFixture(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(hits).toBe(2);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
  });

  it("returns typed 410 purge failures", async () => {
    const { server } = await startMock((_request, response) => {
      serveFixture(response, "error_410", server.baseUrl);
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("REPORT_PURGED");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.RELAY);
  });

  it("returns typed 503 failures after the retry budget", async () => {
    const { server } = await startMock((_request, response) => {
      serveFixture(response, "error_503", server.baseUrl);
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("REPORT_UNAVAILABLE");
    expect(document.error?.retryable).toBe(true);
  });

  it("rejects malformed schemas", async () => {
    const { server } = await startMock((_request, response) => {
      serveFixture(response, "report_malformed", server.baseUrl);
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("REPORT_SCHEMA_INVALID");
  });

  it("marks missing required evidence incomplete, not a pass", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(response, "report_missing_evidence", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("detects mappedResponse hash mismatches", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(response, "report_bad_hash", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.diagnostics.some((item) => item.code === "MAPPED_RESPONSE_HASH_MISMATCH")).toBe(
      true
    );
  });

  it("maps invalid API keys to retrieved false without following CANONICAL_ORIGIN", async () => {
    const { server } = await startMock((_request, response) => {
      serveFixture(response, "error_401", server.baseUrl);
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("API_KEY_REVOKED");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.AUTH);
    expect(CANONICAL_ORIGIN).toContain("augmentworks.ai");
  });

  it("rewrites fixture origins for loopback tests without changing wire field names", () => {
    const rewritten = rewriteOrigin({ dashboardUrl: `${CANONICAL_ORIGIN}/portal/runs/x` }, "http://127.0.0.1:9");
    expect(rewritten).toEqual({ dashboardUrl: "http://127.0.0.1:9/portal/runs/x" });
    expect(fixtureIdentity("machine_report_only")["email"]).toBeUndefined();
    expect(fixtureIdentity("machine_report_only")["principal_kind"]).toBe("machine");
  });
});

describe("hosted report retrieval completeness", () => {
  it("rejects a terminal page that omits an attempt even when coverage counters agree (AUG-59)", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveMutated(response, "report_all_pass_one_page", server.baseUrl, (body) => {
          pageRecord(body)["totalAttempts"] = 2;
          coverageRecord(body)["plannedAttempts"] = 2;
          coverageRecord(body)["completedAttempts"] = 2;
          coverageRecord(body)["requiredJudgmentsPlanned"] = 2;
          coverageRecord(body)["requiredJudgmentsComplete"] = 2;
          body["aggregate"] = { passed: 2, failed: 0, error: 0 };
        });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.diagnostics.some((item) => item.code === "REPORT_TOTAL_BOUNDS")).toBe(true);
    expect(document.diagnostics[0]?.message).toMatch(/do not start another billed assessment/i);
    expect(JSON.stringify(document)).not.toContain(TOKEN);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(classifyRunReportExport(document).exitCode).not.toBe(EXIT.OK);
  });

  it("rejects 1 of 2 criteria on a terminal criterion index", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveMutated(response, "criterion_index_r01_pass", server.baseUrl, (body) => {
          pageRecord(body)["totalCriteria"] = 2;
        });
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.diagnostics.some((item) => item.code === "CRITERION_TOTAL_BOUNDS")).toBe(true);
    expect(classifyRunReportExport(document).exitCode).not.toBe(EXIT.OK);
  });

  it("rejects contradictory totalAttempts across pages", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        if (url.searchParams.get("cursor") === "page-2") {
          serveMutated(response, "report_page_2", server.baseUrl, (body) => {
            pageRecord(body)["totalAttempts"] = 3;
          });
          return true;
        }
        serveFixture(response, "report_page_1", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.diagnostics.some((item) => item.code === "REPORT_TOTAL_CONFLICT")).toBe(true);
    expect(classifyRunReportExport(document).exitCode).not.toBe(EXIT.OK);
  });

  it("rejects duplicate attempt IDs and never exits 0", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        if (url.searchParams.get("cursor") === "page-2") {
          serveMutated(response, "report_page_2", server.baseUrl, (body) => {
            const attempts = body["attempts"] as Array<Record<string, unknown>>;
            attempts[0]!["attemptId"] = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
          });
          return true;
        }
        serveFixture(response, "report_page_1", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.complete).toBe(false);
    expect(document.retrieved === false || document.complete === false).toBe(true);
    expect(document.error?.code === "REPORT_ATTEMPT_DUPLICATE" || document.complete === false).toBe(
      true
    );
    expect(classifyRunReportExport(document).exitCode).not.toBe(EXIT.OK);
  });

  it("does not treat unknown totalAttempts as zero or as a pass", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveMutated(response, "report_all_pass_one_page", server.baseUrl, (body) => {
          pageRecord(body)["totalAttempts"] = null;
        });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.diagnostics.some((item) => item.code === "REPORT_TOTAL_UNKNOWN")).toBe(true);
    expect(classifyRunReportExport(document).exitCode).not.toBe(EXIT.OK);
  });

  it("does not treat unknown coverage as a passing assessment", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveMutated(response, "report_all_pass_one_page", server.baseUrl, (body) => {
          coverageRecord(body)["plannedAttempts"] = null;
          coverageRecord(body)["completedAttempts"] = null;
        });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(classifyRunReportExport(document).exitCode).not.toBe(EXIT.OK);
  });

  it("does not treat pending grading as a pass", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(response, "report_pending", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.diagnostics.some((item) => item.code === "REPORT_COVERAGE_MISMATCH")).toBe(false);
    expect(document.diagnostics.some((item) => item.code === "REPORT_EVIDENCE_CONTRADICTION")).toBe(
      false
    );
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(classifyRunReportExport(document).exitCode).not.toBe(EXIT.OK);
  });

  it("does not treat evaluator error as a pass", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveMutated(response, "report_all_pass_one_page", server.baseUrl, (body) => {
          body["evaluationStatus"] = "error";
          body["outcome"] = "error";
        });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_ERROR);
    expect(classifyRunReportExport(document).exitCode).not.toBe(EXIT.OK);
  });

  it("marks truncated mappedResponse incomplete, not a pass", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveMutated(response, "report_all_pass_one_page", server.baseUrl, (body) => {
          const attempts = body["attempts"] as Array<Record<string, unknown>>;
          asRecord(attempts[0]!["mappedResponse"])["truncated"] = true;
        });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.diagnostics.some((item) => item.code === "MAPPED_RESPONSE_TRUNCATED")).toBe(true);
    expect(classifyRunReportExport(document).exitCode).not.toBe(EXIT.OK);
  });

  it("maps an aborted report read to interrupted, never pass", async () => {
    const { server } = await startMock((_request, response) => {
      serveFixture(response, "report_all_pass_one_page", server.baseUrl);
      return true;
    });
    const controller = new AbortController();
    controller.abort();
    const document = await exportFrom(server, { signal: controller.signal });
    expect(document.retrieved).toBe(false);
    expect(document.complete).toBe(false);
    expect(document.error?.code).toBe("INTERRUPTED");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.INTERRUPTED);
  });
});

describe("hosted report workspace pinning", () => {
  it("rejects a first report page from another workspace (AUG-59)", async () => {
    const { server } = await startMock((_request, response) => {
      serveMutated(response, "report_all_pass_one_page", server.baseUrl, (body) => {
        body["workspaceId"] = OTHER_WORKSPACE_ID;
      });
      return true;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.complete).toBe(false);
    expect(document.error?.code).toBe("REPORT_WORKSPACE_MISMATCH");
    expect(document.error?.message).toMatch(/do not start another billed assessment/i);
    expect(JSON.stringify(document)).not.toContain(TOKEN);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.RELAY);
  });

  it("rejects a later report page from another workspace", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        if (url.searchParams.get("cursor") === "page-2") {
          serveMutated(response, "report_page_2", server.baseUrl, (body) => {
            body["workspaceId"] = OTHER_WORKSPACE_ID;
          });
          return true;
        }
        serveFixture(response, "report_page_1", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("REPORT_WORKSPACE_MISMATCH");
    expect(classifyRunReportExport(document).exitCode).not.toBe(EXIT.OK);
  });

  it("rejects a criterion index from another workspace", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveMutated(response, "criterion_index_r01_pass", server.baseUrl, (body) => {
          body["workspaceId"] = OTHER_WORKSPACE_ID;
        });
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("REPORT_WORKSPACE_MISMATCH");
  });

  it("rejects a criterion detail from another workspace", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (url.pathname.endsWith("/criteria")) {
        serveMutated(response, "criterion_index_r01_pass", server.baseUrl, (body) => {
          const criteria = body["criteria"] as Array<Record<string, unknown>>;
          delete criteria[0]!["evidence"];
          criteria[0]!["detailUrl"] =
            `${server.baseUrl}/v1/runs/${REPORT_RUN_ID}/evaluations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/attempts/cccccccc-cccc-4ccc-8ccc-cccccccccccc/criteria/dddddddd-dddd-4ddd-8ddd-dddddddddddd`;
        });
        return true;
      }
      if (url.pathname.endsWith("/dddddddd-dddd-4ddd-8ddd-dddddddddddd")) {
        serveMutated(response, "criterion_detail_r01_pass", server.baseUrl, (body) => {
          body["workspaceId"] = OTHER_WORKSPACE_ID;
        });
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(false);
    expect(document.error?.code).toBe("REPORT_WORKSPACE_MISMATCH");
  });

  it("accepts a criterion index that omits optional workspaceId", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveFixture(response, "report_all_pass_one_page", server.baseUrl);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveMutated(response, "criterion_index_r01_pass", server.baseUrl, (body) => {
          delete body["workspaceId"];
        });
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.OK);
  });
});

function expectSafeInconsistency(
  document: Awaited<ReturnType<typeof exportHostedRunReport>>,
  code: string
): void {
  const diagnostic = document.diagnostics.find((item) => item.code === code);
  expect(diagnostic).toBeDefined();
  expect(diagnostic?.message.toLowerCase()).toContain("cannot be used as a passing release check");
  expect(diagnostic?.message.toLowerCase()).toContain("do not start another billed assessment");
  expect(diagnostic?.message).not.toMatch(/365 days|30 days|https?:\/\//i);
  expect(diagnostic?.message).not.toContain(TOKEN);
}

describe("hosted report consistency aw-report-consistency/1", () => {
  it("keeps a coherent required failure at exit 10 when aggregate detail is absent", async () => {
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method !== "GET") return false;
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveMutated(response, "report_required_fail", server.baseUrl, (body) => {
          body["aggregate"] = null;
        });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_fail", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.report?.outcome).toBe("failed");
    expect(document.criteria?.[0]?.["verdict"]).toBe("fail");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
  });

  it("rejects a claimed pass that still has a completed required fail", async () => {
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method !== "GET") return false;
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveMutated(response, "report_required_fail", server.baseUrl, (body) => {
          body["outcome"] = "passed";
        });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_fail", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.report?.outcome).toBe("passed");
    expect(document.report?.attempts[0]?.mappedResponse.text).toContain("365 days");
    expect(document.criteria?.[0]?.["verdict"]).toBe("fail");
    expect(document.criteria?.[0]?.["required"]).toBe(true);
    expectSafeInconsistency(document, REPORT_EVIDENCE_CONTRADICTION);
    expect(document.diagnostics.some((item) => item.code === REPORT_COVERAGE_MISMATCH)).toBe(false);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(classifyRunReportExport(document).assessment).toBe("incomplete");
    expect(paths.every((path) => path.startsWith("GET "))).toBe(true);
    expect(paths.some((path) => path.includes("quote") || path.includes("retry-evaluation"))).toBe(
      false
    );
  });

  it("rejects a claimed pass when only the known aggregate failed count contradicts it", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveMutated(response, "report_all_pass_one_page", server.baseUrl, (body) => {
          body["aggregate"] = { passed: 1, failed: 1, error: 0 };
        });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.report?.outcome).toBe("passed");
    expect(document.criteria?.[0]?.["verdict"]).toBe("pass");
    expectSafeInconsistency(document, REPORT_EVIDENCE_CONTRADICTION);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("still rejects a claimed pass when aggregate detail is absent and a required verdict fails", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveMutated(response, "report_required_fail", server.baseUrl, (body) => {
          body["outcome"] = "passed";
          body["aggregate"] = null;
        });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_fail", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.complete).toBe(false);
    expectSafeInconsistency(document, REPORT_EVIDENCE_CONTRADICTION);
    expect(classifyRunReportExport(document).exitCode).not.toBe(EXIT.OK);
  });

  it("rejects coverage that claims finished attempts hidden by a zero page total", async () => {
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method !== "GET") return false;
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveMutated(response, "report_all_pass_one_page", server.baseUrl, (body) => {
          body["attempts"] = [];
          pageRecord(body)["totalAttempts"] = 0;
        });
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.report?.attempts).toEqual([]);
    expect(document.report?.coverage.completedAttempts).toBe(1);
    expect(document.report?.coverage.plannedAttempts).toBe(1);
    expect(document.report?.page.totalAttempts).toBe(0);
    expect(document.criteria).toEqual([]);
    expectSafeInconsistency(document, REPORT_COVERAGE_MISMATCH);
    expect(document.diagnostics.some((item) => item.code === REPORT_EVIDENCE_CONTRADICTION)).toBe(
      false
    );
    expect(document.diagnostics.some((item) => item.code === "REPORT_TOTAL_BOUNDS")).toBe(false);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(paths.every((path) => path.startsWith("GET "))).toBe(true);
    expect(paths.some((path) => path.includes("/criteria"))).toBe(false);
  });

  it("rejects a finished required-judgment count that exceeds retrieved required judgments", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveMutated(response, "report_all_pass_one_page", server.baseUrl, (body) => {
          coverageRecord(body)["requiredJudgmentsPlanned"] = 2;
          coverageRecord(body)["requiredJudgmentsComplete"] = 2;
        });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(false);
    expect(document.criteria).toHaveLength(1);
    expectSafeInconsistency(document, REPORT_COVERAGE_MISMATCH);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("keeps an advisory fail with a required pass as a coherent pass", async () => {
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method !== "GET") return false;
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveMutated(response, "report_all_pass_one_page", server.baseUrl, (body) => {
          const attempts = body["attempts"] as Array<Record<string, unknown>>;
          attempts[0]!["outcome"] = "fail";
          attempts[0]!["cleanupState"] = "failed";
        });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveMutated(response, "criterion_index_r01_pass", server.baseUrl, (body) => {
          const criteria = body["criteria"] as Array<Record<string, unknown>>;
          const evidence = asRecord(criteria[0]!["evidence"]);
          criteria.push({
            criterionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            criterionKey: "response-quality/0.1.0/R01/clarity",
            required: false,
            verdict: "fail",
            detailUrl: null,
            evidence
          });
          pageRecord(body)["totalCriteria"] = 2;
        });
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.report?.outcome).toBe("passed");
    expect(document.report?.attempts[0]?.outcome).toBe("fail");
    expect(document.criteria?.some((item) => item["required"] === false && item["verdict"] === "fail")).toBe(
      true
    );
    expect(document.diagnostics.some((item) => item.code === REPORT_EVIDENCE_CONTRADICTION)).toBe(
      false
    );
    expect(document.diagnostics.some((item) => item.code === REPORT_COVERAGE_MISMATCH)).toBe(false);
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.OK);
    expect(paths.every((path) => path.startsWith("GET "))).toBe(true);
  });

  it("does not treat an absent aggregate as a contradiction of a coherent pass", async () => {
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        serveMutated(response, "report_all_pass_one_page", server.baseUrl, (body) => {
          body["aggregate"] = null;
        });
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        serveFixture(response, "criterion_index_r01_pass", server.baseUrl);
        return true;
      }
      return false;
    });
    const document = await exportFrom(server);
    expect(document.retrieved).toBe(true);
    expect(document.complete).toBe(true);
    expect(document.report?.aggregate).toBeNull();
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.OK);
  });
});
