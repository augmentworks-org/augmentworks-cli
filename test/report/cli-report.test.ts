import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { createRunCommand } from "../../src/commands/run.js";
import { RUN_REPORT_EXPORT_SCHEMA_VERSION } from "../../src/report/schema.js";
import { ensurePackedCliBuilt, runPackedCli } from "../util/cli-process.js";
import { listenLoopback, type ListeningServer } from "../util/http-server.js";
import {
  FIXTURE_WORKSPACE_ID,
  OTHER_WORKSPACE_ID,
  REPORT_RUN_ID,
  asRecord,
  fixtureIdentity,
  fixtureResponse,
  mutatedFixtureResponse
} from "./fixtures.js";

const API_KEY = "aw_api_test_packed_report_key_value";
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

async function emptyHome(): Promise<{ cwd: string; home: string; state: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "aw-cli-report-cwd-"));
  const home = await mkdtemp(join(tmpdir(), "aw-cli-report-home-"));
  const state = await mkdtemp(join(tmpdir(), "aw-cli-report-state-"));
  temporaryDirectories.push(cwd, home, state);
  return { cwd, home, state };
}

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

describe("packed augmentworks run report", () => {
  it("registers the command, emits JSON-only stdout, and never creates or rejudges", async () => {
    const { cwd, home, state } = await emptyHome();
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, fixtureIdentity("machine_report_only"));
        return true;
      }
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        const fixture = fixtureResponse("report_required_fail", server.baseUrl);
        send(response, fixture.status, fixture.body);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        const fixture = fixtureResponse("criterion_index_r01_fail", server.baseUrl);
        send(response, fixture.status, fixture.body);
        return true;
      }
      return false;
    });

    const result = await runPackedCli(["run", "report", REPORT_RUN_ID, "--json"], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_STATE_HOME: state,
        AUGMENTWORKS_STATE_DIR: state,
        DBUS_SESSION_BUS_ADDRESS: "",
        AUGMENTWORKS_API_URL: server.baseUrl,
        AUGMENTWORKS_API_KEY: API_KEY,
        AUGMENTWORKS_TOKEN: "",
        AUGMENTWORKS_REFRESH_TOKEN: "",
        CI: "1",
        NO_COLOR: "1"
      }
    });

    expect(result.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    expect(result.stdout.trim().startsWith("{")).toBe(true);
    const payload = JSON.parse(result.stdout) as {
      schemaVersion: string;
      retrieved: boolean;
      complete: boolean;
      report?: { outcome: string | null };
    };
    expect(payload.schemaVersion).toBe("aw-run-report-export/1");
    expect(payload.retrieved).toBe(true);
    expect(payload.complete).toBe(true);
    expect(payload.report?.outcome).toBe("failed");
    expect(result.stdout).not.toContain(API_KEY);
    expect(paths.filter((path) => path.startsWith("POST "))).toEqual([]);
    expect(paths).not.toContain("POST /v1/billing/quote");
    expect(paths).not.toContain("POST /v1/relay/runs");
    expect(paths.some((path) => path.includes(":retry-evaluation"))).toBe(false);
    expect(paths).toContain("GET /api/v1/cli/auth/me");
    expect(paths).toContain(`GET /v1/relay/runs/${REPORT_RUN_ID}/report`);
  });

  it("treats a completed null-outcome report as exit 11, not 0", async () => {
    const { cwd, home, state } = await emptyHome();
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, fixtureIdentity("machine_report_only"));
        return true;
      }
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        const fixture = fixtureResponse("report_null_outcome", server.baseUrl);
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
    const result = await runPackedCli(["run", "report", REPORT_RUN_ID, "--json"], {
      cwd,
      env: {
        HOME: home,
        AUGMENTWORKS_STATE_DIR: state,
        AUGMENTWORKS_API_URL: server.baseUrl,
        AUGMENTWORKS_API_KEY: API_KEY,
        AUGMENTWORKS_TOKEN: "",
        AUGMENTWORKS_REFRESH_TOKEN: ""
      }
    });
    expect(result.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    const payload = JSON.parse(result.stdout) as { retrieved: boolean; report?: { outcome: null } };
    expect(payload.retrieved).toBe(true);
    expect(payload.report?.outcome).toBeNull();
  });

  it("exports a complete pass without billing calls (zero-balance read path)", async () => {
    const { cwd, home, state } = await emptyHome();
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, fixtureIdentity("machine_report_only"));
        return true;
      }
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
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
    const result = await runPackedCli(["run", "report", REPORT_RUN_ID, "--json"], {
      cwd,
      env: {
        HOME: home,
        AUGMENTWORKS_STATE_DIR: state,
        AUGMENTWORKS_API_URL: server.baseUrl,
        AUGMENTWORKS_API_KEY: API_KEY,
        AUGMENTWORKS_TOKEN: "",
        AUGMENTWORKS_REFRESH_TOKEN: ""
      }
    });
    expect(result.exitCode).toBe(EXIT.OK);
    const payload = JSON.parse(result.stdout) as { retrieved: boolean; complete: boolean };
    expect(payload.retrieved).toBe(true);
    expect(payload.complete).toBe(true);
    expect(paths.some((path) => path.includes("/v1/billing"))).toBe(false);
    expect(paths.filter((path) => path.startsWith("POST "))).toEqual([]);
  });

  it("does not exit 0 when a terminal page omits an attempt", async () => {
    const { cwd, home, state } = await emptyHome();
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, fixtureIdentity("machine_report_only"));
        return true;
      }
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        const fixture = mutatedFixtureResponse("report_all_pass_one_page", server.baseUrl, (body) => {
          asRecord(body["page"])["totalAttempts"] = 2;
          asRecord(body["coverage"])["plannedAttempts"] = 2;
          asRecord(body["coverage"])["completedAttempts"] = 2;
        });
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
    const result = await runPackedCli(["run", "report", REPORT_RUN_ID, "--json"], {
      cwd,
      env: {
        HOME: home,
        AUGMENTWORKS_STATE_DIR: state,
        AUGMENTWORKS_API_URL: server.baseUrl,
        AUGMENTWORKS_API_KEY: API_KEY,
        AUGMENTWORKS_TOKEN: "",
        AUGMENTWORKS_REFRESH_TOKEN: ""
      }
    });
    expect(result.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(result.stdout.trim().startsWith("{")).toBe(true);
    const payload = JSON.parse(result.stdout) as {
      complete: boolean;
      diagnostics: Array<{ code: string; message: string }>;
    };
    expect(payload.complete).toBe(false);
    expect(payload.diagnostics.some((item) => item.code === "REPORT_TOTAL_BOUNDS")).toBe(true);
    expect(result.stderr.toLowerCase()).toContain("do not start another billed assessment");
    expect(result.stdout).not.toContain(API_KEY);
    expect(result.stderr).not.toContain(API_KEY);
  });

  it("rejects mixed-workspace report pages through run report", async () => {
    const { cwd, home, state } = await emptyHome();
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, fixtureIdentity("machine_report_only"));
        return true;
      }
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        const fixture = mutatedFixtureResponse("report_all_pass_one_page", server.baseUrl, (body) => {
          body["workspaceId"] = OTHER_WORKSPACE_ID;
        });
        send(response, fixture.status, fixture.body);
        return true;
      }
      return false;
    });
    const result = await runPackedCli(["run", "report", REPORT_RUN_ID, "--json"], {
      cwd,
      env: {
        HOME: home,
        AUGMENTWORKS_STATE_DIR: state,
        AUGMENTWORKS_API_URL: server.baseUrl,
        AUGMENTWORKS_API_KEY: API_KEY,
        AUGMENTWORKS_TOKEN: "",
        AUGMENTWORKS_REFRESH_TOKEN: ""
      }
    });
    expect(result.exitCode).toBe(EXIT.RELAY);
    const payload = JSON.parse(result.stdout) as {
      retrieved: boolean;
      complete: boolean;
      error?: { code: string };
    };
    expect(payload.retrieved).toBe(false);
    expect(payload.complete).toBe(false);
    expect(payload.error?.code).toBe("REPORT_WORKSPACE_MISMATCH");
    expect(result.stderr.toLowerCase()).toContain("do not start another billed assessment");
  });

  it("threads the authenticated workspaceId into the exporter", async () => {
    let captured: string | undefined;
    let exitCode = 0;
    const stdout: string[] = [];
    const command = createRunCommand({
      stdout: {
        write: (chunk) => {
          stdout.push(String(chunk));
          return true;
        }
      },
      stderr: { write: () => true },
      setExitCode: (code) => {
        exitCode = code;
      },
      accessToken: async () => "token",
      identity: async () => ({
        subject: "machine",
        workspaceId: FIXTURE_WORKSPACE_ID,
        connectorId: "connector_qa",
        scopes: ["connector:identity"]
      }),
      apiOrigin: () => new URL("http://127.0.0.1:8787/"),
      exportReport: async (_runId, options) => {
        captured = options.expectedWorkspaceId;
        return {
          schemaVersion: RUN_REPORT_EXPORT_SCHEMA_VERSION,
          retrieved: true,
          complete: false,
          diagnostics: [
            {
              code: "REPORT_TOTAL_BOUNDS",
              message: "Collected 1 distinct attempts; totalAttempts is 2."
            }
          ]
        };
      }
    }).exitOverride();
    await command.parseAsync(["node", "augmentworks", "report", REPORT_RUN_ID, "--json"], {
      from: "node"
    });
    expect(captured).toBe(FIXTURE_WORKSPACE_ID);
    expect(exitCode).not.toBe(EXIT.OK);
    expect(stdout.join("").trim().startsWith("{")).toBe(true);
  });

  it("rejects a claimed pass with a required fail before exit 0", async () => {
    const { cwd, home, state } = await emptyHome();
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, fixtureIdentity("machine_report_only"));
        return true;
      }
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        const fixture = mutatedFixtureResponse("report_required_fail", server.baseUrl, (body) => {
          body["outcome"] = "passed";
        });
        send(response, fixture.status, fixture.body);
        return true;
      }
      if (url.pathname.includes("/criteria")) {
        const fixture = fixtureResponse("criterion_index_r01_fail", server.baseUrl);
        send(response, fixture.status, fixture.body);
        return true;
      }
      return false;
    });
    const result = await runPackedCli(["run", "report", REPORT_RUN_ID, "--json"], {
      cwd,
      env: {
        HOME: home,
        AUGMENTWORKS_STATE_DIR: state,
        AUGMENTWORKS_API_URL: server.baseUrl,
        AUGMENTWORKS_API_KEY: API_KEY,
        AUGMENTWORKS_TOKEN: "",
        AUGMENTWORKS_REFRESH_TOKEN: ""
      }
    });
    expect(result.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(result.stdout.trim().startsWith("{")).toBe(true);
    const payload = JSON.parse(result.stdout) as {
      retrieved: boolean;
      complete: boolean;
      report?: { outcome: string };
      criteria?: Array<{ verdict?: string; evidence?: { text?: string } }>;
      diagnostics: Array<{ code: string; message: string }>;
    };
    expect(payload.retrieved).toBe(true);
    expect(payload.complete).toBe(false);
    expect(payload.report?.outcome).toBe("passed");
    expect(payload.criteria?.[0]?.verdict).toBe("fail");
    expect(payload.criteria?.[0]?.evidence?.text).toContain("365 days");
    const diagnostic = payload.diagnostics.find((item) => item.code === "REPORT_EVIDENCE_CONTRADICTION");
    expect(diagnostic?.message.toLowerCase()).toContain("cannot be used as a passing release check");
    expect(diagnostic?.message).not.toContain("365 days");
    expect(result.stderr.toLowerCase()).toContain("cannot be used as a passing release check");
    expect(result.stderr.toLowerCase()).toContain("do not start another billed assessment");
    expect(result.stdout).not.toContain(API_KEY);
    expect(result.stderr).not.toContain(API_KEY);
    expect(paths.filter((path) => path.startsWith("POST "))).toEqual([]);
    expect(paths.some((path) => path.includes("quote") || path.includes("retry-evaluation"))).toBe(
      false
    );
  });

  it("rejects finished coverage hidden by an empty attempt page", async () => {
    const { cwd, home, state } = await emptyHome();
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, fixtureIdentity("machine_report_only"));
        return true;
      }
      if (url.pathname === `/v1/relay/runs/${REPORT_RUN_ID}/report`) {
        const fixture = mutatedFixtureResponse("report_all_pass_one_page", server.baseUrl, (body) => {
          body["attempts"] = [];
          asRecord(body["page"])["totalAttempts"] = 0;
        });
        send(response, fixture.status, fixture.body);
        return true;
      }
      return false;
    });
    const result = await runPackedCli(["run", "report", REPORT_RUN_ID, "--json"], {
      cwd,
      env: {
        HOME: home,
        AUGMENTWORKS_STATE_DIR: state,
        AUGMENTWORKS_API_URL: server.baseUrl,
        AUGMENTWORKS_API_KEY: API_KEY,
        AUGMENTWORKS_TOKEN: "",
        AUGMENTWORKS_REFRESH_TOKEN: ""
      }
    });
    expect(result.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    const payload = JSON.parse(result.stdout) as {
      complete: boolean;
      report?: { attempts: unknown[]; coverage: { completedAttempts: number } };
      diagnostics: Array<{ code: string; message: string }>;
    };
    expect(payload.complete).toBe(false);
    expect(payload.report?.attempts).toEqual([]);
    expect(payload.report?.coverage.completedAttempts).toBe(1);
    expect(payload.diagnostics.some((item) => item.code === "REPORT_COVERAGE_MISMATCH")).toBe(true);
    expect(result.stderr.toLowerCase()).toContain("cannot be used as a passing release check");
    expect(result.stderr.toLowerCase()).toContain("do not start another billed assessment");
    expect(result.stdout).not.toContain(API_KEY);
    expect(paths.filter((path) => path.startsWith("POST "))).toEqual([]);
  });
});
