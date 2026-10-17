import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import { RELAY_PROTOCOL_VERSION } from "../../src/cloud/protocol.js";
import { hostedExitCode, runTest } from "../../src/commands/test.js";
import { resolveConfig } from "../../src/config/resolve.js";
import { EXIT } from "../../src/errors.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import { gradedReport, reportPathFor } from "../util/graded-report.js";

const WORKSPACE = "workspace-1";
const API = "http://127.0.0.1:8787/";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function resolved() {
  const inspection = resolveConfig(
    {
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
    },
    "/tmp/augmentworks.yaml",
    "/tmp",
    {}
  );
  if (inspection.resolvedConfig === undefined) throw new Error("test config did not resolve");
  return inspection.resolvedConfig;
}

/**
 * A server shaped like production: the relay status says the target passed and
 * carries no grading state; only the run report has the graded outcome.
 */
async function runWithReports(reports: ReadonlyArray<Record<string, unknown> | undefined>) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "aw-graded-"));
  temporaryDirectories.push(stateDirectory);
  let reportReads = 0;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/relay/runs" && init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({
        protocol_version: RELAY_PROTOCOL_VERSION,
        create_request_id: request["create_request_id"],
        create_request_sha256: sha256(canonicalize(request)),
        create_disposition: "created",
        run_id: "run-1",
        session_id: "session-1",
        packet: { key: "support-refunds", version: "0.1.0", sha256: "a".repeat(64) },
        config_sha256: request["config_sha256"],
        fencing_epoch: 1,
        status: "completed",
        dashboard_url: `${API}portal/runs/run-1`,
        run_expires_at: new Date(Date.now() + 60_000).toISOString(),
        credit_state: "consumed"
      });
    }
    if (url.pathname === reportPathFor("run-1")) {
      const report = reports[Math.min(reportReads, reports.length - 1)];
      reportReads += 1;
      if (report === undefined) return Response.json({ error: { code: "NOT_FOUND", message: "missing" } }, { status: 404 });
      return Response.json(report);
    }
    return Response.json({
      protocol_version: RELAY_PROTOCOL_VERSION,
      run_id: "run-1",
      status: "completed",
      outcome: "passed",
      credit_state: "consumed"
    });
  });
  const config = resolved();
  const sleeps: number[] = [];
  const stderr: string[] = [];
  const result = await runTest(
    { env: {}, packet: "support-refunds@0.1.0", stateDirectory, handleSignals: false },
    {
      doctor: async () => ({
        ok: true,
        configPath: config.configPath,
        offline: true,
        diagnostics: [],
        resolvedConfig: config
      }),
      apiOrigin: () => new URL(API),
      accessToken: async () => "token",
      identity: async () => ({
        subject: "user-1",
        workspaceId: WORKSPACE,
        connectorId: "connector-1",
        scopes: ["connector:identity", "connector:run"]
      }),
      cloud: ({ accessToken, accessTokenProvider }) =>
        new CloudClient({ apiUrl: API, accessToken, accessTokenProvider, fetch: fetchMock }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      stdout: { write: () => true },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          stderr.push(String(chunk));
          return true;
        }
      }
    }
  );
  return { result, sleeps, reportReads, stderr: stderr.join("") };
}

describe("hosted test takes its result from grading (AUG-384)", () => {
  it("waits for grading and exits 10 when a required check failed, though the target passed", async () => {
    const pending = gradedReport("run-1", WORKSPACE, { reportReady: false, evaluationStatus: "pending" });
    const failed = gradedReport("run-1", WORKSPACE, { outcome: "failed" });
    const { result, sleeps, reportReads, stderr } = await runWithReports([pending, failed]);
    expect(reportReads).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(stderr).toContain("Waiting for grading");
    expect(result.run).toMatchObject({ outcome: "failed", evaluation_status: "complete" });
    expect(hostedExitCode(result.run)).toBe(EXIT.ASSESSMENT_FAILED);
  });

  it("exits 0 only once the graded report passed", async () => {
    const { result } = await runWithReports([gradedReport("run-1", WORKSPACE)]);
    expect(result.run).toMatchObject({ outcome: "passed", evaluation_status: "complete" });
    expect(hostedExitCode(result.run)).toBe(EXIT.OK);
  });

  it("reports grading pending, never passed, when the report can't be read", async () => {
    const { result } = await runWithReports([undefined]);
    expect(result.run).toMatchObject({ outcome: null, evaluation_status: "pending" });
    expect(hostedExitCode(result.run)).toBe(EXIT.EVALUATION_INCOMPLETE);
  });
});
