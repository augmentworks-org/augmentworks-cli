import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import {
  classifyRunReportExport,
  exportHostedAuthorizedReport,
  exportHostedLiveInformationalReport,
  exportHostedRunReport
} from "../../src/report/client.js";
import {
  RUN_REPORT_AUTHORIZED_SCOPE_SCHEMA_VERSION,
  RUN_REPORT_LIVE_SCOPE_SCHEMA_VERSION
} from "../../src/report/schema.js";
import { listenLoopback, type ListeningServer } from "../util/http-server.js";
import { FIXTURE_WORKSPACE_ID, REPORT_RUN_ID, fixtureResponse } from "./fixtures.js";

const TOKEN = "aw_api_test_live_scope_token";
const HASH = "a".repeat(64);
const servers: ListeningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

async function startMock(
  handler: (request: IncomingMessage, response: ServerResponse, url: URL) => boolean
): Promise<{ server: ListeningServer; hrefs: string[] }> {
  const hrefs: string[] = [];
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    hrefs.push(`${request.method ?? "GET"} ${url.pathname}${url.search}`);
    if (!handler(request, response, url) && !response.writableEnded) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
    }
  });
  const server = await listenLoopback(httpServer);
  servers.push(server);
  return { server, hrefs };
}

function liveDocument(runId = REPORT_RUN_ID): Record<string, unknown> {
  return {
    schemaVersion: RUN_REPORT_LIVE_SCOPE_SCHEMA_VERSION,
    runId,
    workspaceId: FIXTURE_WORKSPACE_ID,
    asOf: "2026-09-18T00:00:00.000Z",
    executionMode: "informational",
    assessmentKind: "bounded_informational_assessment",
    approvedOrigin: "https://support.example.com",
    authorizationKind: "owned_target",
    authorizationRef: "fixture-pilot-approval",
    authorizationHash: HASH,
    liveTargetHash: HASH,
    suiteId: "live.informational.fixture",
    suiteRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    suiteContentHash: HASH,
    packetOverlay: "aw-packet/live-informational-1",
    packetHash: HASH,
    allowedMessages: 3,
    dispatchedMessages: 2,
    indeterminateSends: 1,
    completedSends: 1,
    expiresAt: "2099-12-31T23:59:59Z",
    createsBillableRun: false
  };
}

describe("live-informational report scope", () => {
  it("requests ?scope=live-informational and strictly parses aw-run-report-live-scope/1", async () => {
    const { server, hrefs } = await startMock((_request, response, url) => {
      if (url.pathname !== `/v1/relay/runs/${REPORT_RUN_ID}/report`) return false;
      if (url.searchParams.get("scope") !== "live-informational") {
        send(response, 400, { error: { code: "SCOPE_REQUIRED", message: "missing live scope" } });
        return true;
      }
      send(response, 200, liveDocument());
      return true;
    });
    const document = await exportHostedLiveInformationalReport(REPORT_RUN_ID, {
      apiOrigin: new URL(server.baseUrl),
      credentialSource: "api_key",
      accessTokenProvider: async () => TOKEN,
      expectedWorkspaceId: FIXTURE_WORKSPACE_ID,
      sleep: async () => undefined
    });
    expect(document).toMatchObject({
      schemaVersion: "aw-run-report-live-scope/1",
      assessmentKind: "bounded_informational_assessment",
      approvedOrigin: "https://support.example.com",
      dispatchedMessages: 2,
      createsBillableRun: false
    });
    expect(JSON.stringify(document)).not.toContain("penetration");
    expect(hrefs).toEqual([`GET /v1/relay/runs/${REPORT_RUN_ID}/report?scope=live-informational`]);
  });

  it("does not attach the live scope to legacy synthetic v1 exports", async () => {
    const { server, hrefs } = await startMock((request, response, url) => {
      if (request.method !== "GET") return false;
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        if (url.searchParams.get("scope") !== null) {
          send(response, 400, { error: { code: "UNEXPECTED_SCOPE", message: "v1 must omit scope" } });
          return true;
        }
        const fixture = fixtureResponse("report_all_pass_one_page", server.baseUrl);
        send(response, fixture.status, fixture.body);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        const fixture = fixtureResponse("criterion_index_r01_pass", server.baseUrl);
        send(response, fixture.status, fixture.body);
        return true;
      }
      return false;
    });
    const document = await exportHostedRunReport(REPORT_RUN_ID, {
      apiOrigin: new URL(server.baseUrl),
      credentialSource: "api_key",
      accessTokenProvider: async () => TOKEN,
      expectedWorkspaceId: FIXTURE_WORKSPACE_ID,
      sleep: async () => undefined
    });
    expect(document.schemaVersion).toBe("aw-run-report-export/1");
    expect(document.retrieved).toBe(true);
    expect(document.report?.schemaVersion).toBe("aw-run-report/1");
    expect(classifyRunReportExport(document).exitCode).toBe(EXIT.OK);
    expect(hrefs.some((href) => href.includes("scope=live-informational"))).toBe(false);
  });

  it("rejects a v1 body when the live overlay was requested", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname !== `/v1/relay/runs/${REPORT_RUN_ID}/report`) return false;
      const fixture = fixtureResponse("report_all_pass_one_page", server.baseUrl);
      send(response, fixture.status, fixture.body);
      return true;
    });
    const document = await exportHostedLiveInformationalReport(REPORT_RUN_ID, {
      apiOrigin: new URL(server.baseUrl),
      credentialSource: "api_key",
      accessTokenProvider: async () => TOKEN,
      expectedWorkspaceId: FIXTURE_WORKSPACE_ID,
      sleep: async () => undefined
    });
    expect(document).toMatchObject({
      schemaVersion: "aw-run-report-live-scope/1",
      retrieved: false,
      error: { code: "REPORT_SCOPE_SCHEMA_INVALID" }
    });
  });
});

describe("authorized-1 report scope", () => {
  it("requests ?scope=authorized-1 and strictly parses the overlay without mutating v1", async () => {
    const overlay = {
      schemaVersion: RUN_REPORT_AUTHORIZED_SCOPE_SCHEMA_VERSION,
      workspaceId: FIXTURE_WORKSPACE_ID,
      runId: REPORT_RUN_ID,
      scopeHash: HASH,
      environment: "staging",
      dataOrigin: "customer_records",
      dataClass: "public",
      effects: "informational",
      targetId: "11111111-1111-4111-8111-111111111111",
      targetBoundaryHash: HASH,
      policyHash: HASH,
      profileHash: HASH,
      actualCounts: { messages: 1, commands: 1, actions: 0 },
      evidenceStatus: "available",
      actionEvidenceStatus: "not_applicable",
      representationHashes: [HASH],
      limitations: ["Remote revocation is not proven by this overlay."],
      v1ReportUnchanged: true,
      independentlyVerifiedBusinessState: false
    };
    const { server, hrefs } = await startMock((_request, response, url) => {
      if (url.pathname !== `/v1/relay/runs/${REPORT_RUN_ID}/report`) return false;
      if (url.searchParams.get("scope") !== "authorized-1") {
        send(response, 400, { error: { code: "SCOPE_REQUIRED", message: "missing authorized scope" } });
        return true;
      }
      send(response, 200, overlay);
      return true;
    });
    const document = await exportHostedAuthorizedReport(REPORT_RUN_ID, {
      apiOrigin: new URL(server.baseUrl),
      credentialSource: "api_key",
      accessTokenProvider: async () => TOKEN,
      expectedWorkspaceId: FIXTURE_WORKSPACE_ID,
      sleep: async () => undefined
    });
    expect(document).toMatchObject({
      schemaVersion: RUN_REPORT_AUTHORIZED_SCOPE_SCHEMA_VERSION,
      dataOrigin: "customer_records",
      evidenceStatus: "available"
    });
    expect(hrefs).toEqual([`GET /v1/relay/runs/${REPORT_RUN_ID}/report?scope=authorized-1`]);
  });

  it("fails closed when authorized evidence is missing", async () => {
    const { server } = await startMock((_request, response, url) => {
      if (url.pathname !== `/v1/relay/runs/${REPORT_RUN_ID}/report`) return false;
      send(response, 200, {
        schemaVersion: RUN_REPORT_AUTHORIZED_SCOPE_SCHEMA_VERSION,
        workspaceId: FIXTURE_WORKSPACE_ID,
        runId: REPORT_RUN_ID,
        scopeHash: HASH,
        environment: "staging",
        dataOrigin: "customer_records",
        dataClass: "public",
        effects: "informational",
        targetId: "11111111-1111-4111-8111-111111111111",
        targetBoundaryHash: HASH,
        policyHash: HASH,
        profileHash: HASH,
        actualCounts: { messages: 0, commands: 0, actions: 0 },
        evidenceStatus: "unavailable",
        actionEvidenceStatus: "not_applicable",
        representationHashes: [],
        limitations: [],
        v1ReportUnchanged: true,
        independentlyVerifiedBusinessState: false
      });
      return true;
    });
    const document = await exportHostedAuthorizedReport(REPORT_RUN_ID, {
      apiOrigin: new URL(server.baseUrl),
      credentialSource: "api_key",
      accessTokenProvider: async () => TOKEN,
      expectedWorkspaceId: FIXTURE_WORKSPACE_ID,
      sleep: async () => undefined
    });
    expect(document).toMatchObject({
      schemaVersion: RUN_REPORT_AUTHORIZED_SCOPE_SCHEMA_VERSION,
      retrieved: false
    });
    expect(JSON.stringify(document)).not.toMatch(/syntheticOnly/);
  });
});
