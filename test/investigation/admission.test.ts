import { cp, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runEstimate, runTest } from "../../src/commands/test.js";
import type { RelayRunner } from "../../src/relay/runner.js";
import { runReleasePolicyCommand } from "../../src/baseline/execute.js";
import { inspectInvestigation, fetchInvestigation } from "../../src/investigation/execute.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import {
  billingFixtures,
  cleanupDirs,
  copyInvestigation,
  doctorFor,
  FAQ_CASE,
  FAQ_HASH,
  FAQ_REVISION,
  FAQ_SUITE_ID,
  faqPinnedDocument,
  hostedCloud,
  identity,
  policyFixtures,
  projectRoot,
  refundPinnedDocument,
  tempDir
} from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupDirs(temporaryDirectories);
});

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode = 0;
  return {
    stdout: { write: (chunk: string) => (stdout.push(chunk), true) },
    stderr: { write: (chunk: string) => (stderr.push(chunk), true) },
    setExitCode: (code: number) => {
      exitCode = code;
    },
    output: () => ({ stdout: stdout.join(""), stderr: stderr.join(""), exitCode })
  };
}

describe("investigation reproduction admission", () => {
  it("inspects without admission, then reproduces the pinned case with a new quote and compares", async () => {
    const cwd = await tempDir("aw-inv-admit-");
    temporaryDirectories.push(cwd);
    await copyInvestigation("response-only.json", cwd, "investigation.json");
    const paths: string[] = [];
    const quoteBodies: Array<Record<string, unknown>> = [];
    const createBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
      if (url.pathname === `/v1/suites/${FAQ_SUITE_ID}/revisions/${FAQ_REVISION}`) {
        return Response.json({
          suiteId: FAQ_SUITE_ID,
          revisionId: FAQ_REVISION,
          contentHash: FAQ_HASH,
          canonicalDocument: faqPinnedDocument()
        });
      }
      if (url.pathname === "/v1/suites" || url.pathname.endsWith("/revisions/latest")) {
        throw new Error(`must not create or select latest: ${url.pathname}`);
      }
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(billingFixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        quoteBodies.push(body ?? {});
        return Response.json(billingFixtures.fixtures["quote_success_with_balance"]?.response);
      }
      if (url.pathname === "/v1/relay/runs") {
        createBodies.push(body ?? {});
        const request = body ?? {};
        return Response.json({
          protocol_version: "aw-relay/0.3",
          create_request_id: request["create_request_id"],
          create_request_sha256: sha256(canonicalize(request)),
          create_disposition: "created",
          run_id: "run-repro-faq",
          session_id: "session-1",
          packet: { key: "aw-customer-suite", version: "1.0.0", sha256: "a".repeat(64) },
          config_sha256: request["config_sha256"],
          fencing_epoch: 1,
          status: "completed",
          dashboard_url: "http://127.0.0.1:8787/portal/runs/run-repro-faq",
          run_expires_at: "2099-09-06T00:00:00.000Z",
          credit_state: "reserved"
        });
      }
      if (url.pathname === "/v1/relay/runs/run-repro-faq") {
        return Response.json({
          protocol_version: "aw-relay/0.1",
          run_id: "run-repro-faq",
          status: "completed",
          credit_state: "reserved",
          outcome: "passed"
        });
      }
      if (url.pathname === "/v1/comparisons/evaluate") {
        const candidate = String(body?.["candidateRunId"] ?? "");
        const source =
          candidate === "run_orig_faq_status"
            ? policyFixtures.fixtures["blocked_equal_pass_rate"]?.response
            : policyFixtures.fixtures["pass_compatible"]?.response;
        return Response.json({
          ...(source as Record<string, unknown>),
          candidateRunId: candidate
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });

    const inspectIo = capture();
    await inspectInvestigation(
      { file: "investigation.json", cwd, json: true },
      { ...inspectIo, doctor: doctorFor() }
    );
    const inspected = JSON.parse(inspectIo.output().stdout) as { admissionCalls: number; ok: boolean };
    expect(inspected.ok).toBe(true);
    expect(inspected.admissionCalls).toBe(0);
    expect(paths.filter((path) => path.includes("/v1/relay/runs")).length).toBe(0);

    const beforeIo = capture();
    await runReleasePolicyCommand(
      "compare",
      {
        run: "run_orig_faq_status",
        baseline: "88888888-8888-4888-8888-888888888888",
        json: true,
        env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
      },
      {
        ...beforeIo,
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: hostedCloud(fetchMock),
        apiOrigin: () => new URL("http://127.0.0.1:8787")
      }
    );
    // compare reports the regression; only gate turns it into a decision.
    const before = JSON.parse(beforeIo.output().stdout) as {
      assessment?: string;
      decision?: string | null;
      groups?: { new_required_regressions?: number };
    };
    expect(before.assessment).toBe("reported");
    expect(before.decision).toBeNull();
    expect(before.groups?.new_required_regressions).toBeGreaterThan(0);
    expect(createBodies).toHaveLength(0);

    const result = await runTest(
      {
        cwd,
        investigation: "investigation.json",
        maxCredits: "30",
        yes: true,
        stateDirectory: cwd,
        env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
      },
      {
        doctor: doctorFor(),
        isInteractive: () => false,
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: hostedCloud(fetchMock)
      }
    );
    expect(result.binding.run_id).toBe("run-repro-faq");
    const assessment = quoteBodies[0]?.["assessment"] as Record<string, unknown>;
    expect(assessment["suite_id"]).toBe(FAQ_SUITE_ID);
    expect(assessment["suite_revision_id"]).toBe(FAQ_REVISION);
    expect(assessment["suite_content_hash"]).toBe(FAQ_HASH);
    expect(assessment["selected_scenario_ids"]).toEqual([FAQ_CASE]);
    expect(createBodies[0]?.["quote_id"]).toBe("55555555-5555-4555-8555-555555555555");
    expect(paths.some((path) => path === `GET /v1/suites/${FAQ_SUITE_ID}/revisions/${FAQ_REVISION}`)).toBe(true);
    expect(paths.some((path) => path.startsWith("POST /v1/suites"))).toBe(false);
    expect(paths.some((path) => path.includes("/revisions/latest"))).toBe(false);
    expect(paths.filter((path) => path === "POST /v1/relay/runs")).toHaveLength(1);

    const afterIo = capture();
    await runReleasePolicyCommand(
      "compare",
      {
        run: "run-repro-faq",
        baseline: "88888888-8888-4888-8888-888888888888",
        json: true,
        env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
      },
      {
        ...afterIo,
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: hostedCloud(fetchMock),
        apiOrigin: () => new URL("http://127.0.0.1:8787")
      }
    );
    expect(afterIo.output().exitCode).toBe(0);
    expect(paths.filter((path) => path === "POST /v1/relay/runs")).toHaveLength(1);
  });

  it("does not silently replace an unavailable or swapped revision", async () => {
    const cwd = await tempDir("aw-inv-missing-rev-");
    temporaryDirectories.push(cwd);
    await copyInvestigation("response-only.json", cwd, "investigation.json");
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/revisions/latest") || url.pathname === "/v1/suites") {
        throw new Error("must not select latest");
      }
      if (url.pathname.startsWith("/v1/suites/")) {
        return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "missing" } }), {
          status: 404,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.pathname === "/v1/relay/runs" || url.pathname === "/v1/billing/quote") {
        throw new Error("must not quote or create");
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    await expect(
      runEstimate(
        {
          cwd,
          investigation: "investigation.json",
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
        },
        {
          doctor: doctorFor(),
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: hostedCloud(fetchMock)
        }
      )
    ).rejects.toMatchObject({ code: "PINNED_REVISION_UNAVAILABLE" });
  });

  it("refuses a latest revision selector and a hash mismatch", async () => {
    const cwd = await tempDir("aw-inv-latest-");
    temporaryDirectories.push(cwd);
    await cp(
      resolve(projectRoot, "test/fixtures/investigations/latest-revision.json"),
      resolve(cwd, "latest.json")
    );
    await copyInvestigation("response-only.json", cwd, "investigation.json");
    await expect(
      runEstimate(
        {
          cwd,
          investigation: "latest.json",
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
        },
        {
          doctor: doctorFor(),
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: hostedCloud(vi.fn(async () => {
            throw new Error("must not call cloud for latest");
          }))
        }
      )
    ).rejects.toMatchObject({ code: "PINNED_REVISION_UNAVAILABLE" });

    const mismatched = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/v1/suites/${FAQ_SUITE_ID}/revisions/${FAQ_REVISION}`) {
        return Response.json({
          suiteId: FAQ_SUITE_ID,
          revisionId: FAQ_REVISION,
          contentHash: "b".repeat(64),
          canonicalDocument: faqPinnedDocument()
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    await expect(
      runEstimate(
        {
          cwd,
          investigation: "investigation.json",
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
        },
        {
          doctor: doctorFor(),
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: hostedCloud(mismatched)
        }
      )
    ).rejects.toMatchObject({ code: "PINNED_REVISION_HASH_MISMATCH" });
  });

  it("does not reuse a consumed quote when the pin changes after quote", async () => {
    const cwd = await tempDir("aw-inv-swap-");
    temporaryDirectories.push(cwd);
    await copyInvestigation("response-only.json", cwd, "investigation.json");
    let quotes = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === `/v1/suites/${FAQ_SUITE_ID}/revisions/${FAQ_REVISION}`) {
        if (quotes > 0) {
          return Response.json({
            suiteId: FAQ_SUITE_ID,
            revisionId: "rev_other",
            contentHash: FAQ_HASH,
            canonicalDocument: faqPinnedDocument()
          });
        }
        return Response.json({
          suiteId: FAQ_SUITE_ID,
          revisionId: FAQ_REVISION,
          contentHash: FAQ_HASH,
          canonicalDocument: faqPinnedDocument()
        });
      }
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(billingFixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        quotes += 1;
        return Response.json(billingFixtures.fixtures["quote_success_with_balance"]?.response);
      }
      if (url.pathname === "/v1/relay/runs") {
        throw new Error("must not create after pin swap");
      }
      throw new Error(`unexpected ${url.pathname} ${init?.method ?? ""}`);
    });
    await expect(
      runTest(
        {
          cwd,
          investigation: "investigation.json",
          maxCredits: "30",
          yes: true,
          stateDirectory: cwd,
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
        },
        {
          doctor: doctorFor(),
          isInteractive: () => false,
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: hostedCloud(fetchMock)
        }
      )
    ).rejects.toMatchObject({ code: "PINNED_REVISION_UNAVAILABLE" });
    expect(quotes).toBe(1);
  });

  it("blocks missing stateful prerequisites before quote", async () => {
    const cwd = await tempDir("aw-inv-prereq-");
    temporaryDirectories.push(cwd);
    await copyInvestigation("stateful.json", cwd, "investigation.json");
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("must not authenticate or quote");
    });
    await expect(
      runTest(
        {
          cwd,
          investigation: "investigation.json",
          maxCredits: "30",
          yes: true,
          stateDirectory: cwd,
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
        },
        {
          doctor: doctorFor(),
          isInteractive: () => false,
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: hostedCloud(fetchMock)
        }
      )
    ).rejects.toMatchObject({ code: "REPRODUCTION_PREREQUISITES_MISSING" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires --max-credits before a noninteractive investigation reproduction", async () => {
    const cwd = await tempDir("aw-inv-max-credits-");
    temporaryDirectories.push(cwd);
    await copyInvestigation("response-only.json", cwd, "investigation.json");
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("must not authenticate without a finite ceiling");
    });
    await expect(
      runTest(
        {
          cwd,
          investigation: "investigation.json",
          yes: true,
          stateDirectory: cwd,
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
        },
        {
          doctor: doctorFor(),
          isInteractive: () => false,
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: hostedCloud(fetchMock)
        }
      )
    ).rejects.toMatchObject({ code: "MAX_CREDITS_REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reproduces a stateful case only after prepare/observe/cleanup exist", async () => {
    const cwd = await tempDir("aw-inv-stateful-ready-");
    temporaryDirectories.push(cwd);
    await cp(
      resolve(projectRoot, "test/fixtures/investigations/stateful-ready.json"),
      resolve(cwd, "investigation.json")
    );
    const paths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
      if (url.pathname === "/v1/suites/customer.refund.limit/revisions/rev_pinned_refund_1") {
        return Response.json({
          suiteId: "customer.refund.limit",
          revisionId: "rev_pinned_refund_1",
          contentHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          canonicalDocument: refundPinnedDocument()
        });
      }
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(billingFixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        return Response.json(billingFixtures.fixtures["quote_success_with_balance"]?.response);
      }
      if (url.pathname === "/v1/relay/runs") {
        return Response.json({
          protocol_version: "aw-relay/0.3",
          create_request_id: body?.["create_request_id"],
          create_request_sha256: sha256(canonicalize(body ?? {})),
          create_disposition: "created",
          run_id: "run-repro-refund",
          session_id: "session-1",
          packet: { key: "aw-customer-suite", version: "1.0.0", sha256: "a".repeat(64) },
          config_sha256: body?.["config_sha256"],
          fencing_epoch: 1,
          status: "completed",
          dashboard_url: "http://127.0.0.1:8787/portal/runs/run-repro-refund",
          run_expires_at: "2099-09-06T00:00:00.000Z",
          credit_state: "reserved"
        });
      }
      if (url.pathname === "/v1/relay/runs/run-repro-refund") {
        return Response.json({
          protocol_version: "aw-relay/0.1",
          run_id: "run-repro-refund",
          status: "completed",
          credit_state: "reserved",
          outcome: "passed"
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const created = await runTest(
      {
        cwd,
        investigation: "investigation.json",
        maxCredits: "30",
        yes: true,
        stateDirectory: cwd,
        env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
      },
      {
        doctor: doctorFor({ prepare: true, observe: true, cleanup: true }),
        isInteractive: () => false,
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: hostedCloud(fetchMock)
      }
    );
    expect(created.binding.run_id).toBe("run-repro-refund");
    expect(paths.some((path) => path === "POST /v1/suites")).toBe(false);
  });

  it("rejects a cross-workspace investigation before quote", async () => {
    const cwd = await tempDir("aw-inv-cross-");
    temporaryDirectories.push(cwd);
    await copyInvestigation("response-only.json", cwd, "investigation.json");
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/billing/quote" || url.pathname === "/v1/relay/runs") {
        throw new Error("must not quote");
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    await expect(
      runEstimate(
        {
          cwd,
          investigation: "investigation.json",
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
        },
        {
          doctor: doctorFor(),
          accessToken: async () => "token",
          identity: async () => identity("22222222-2222-4222-8222-222222222222"),
          cloud: hostedCloud(fetchMock)
        }
      )
    ).rejects.toMatchObject({ code: "CROSS_WORKSPACE_INVESTIGATION" });
  });

  it("cancels before admission and does not create a run", async () => {
    const cwd = await tempDir("aw-inv-cancel-");
    temporaryDirectories.push(cwd);
    await copyInvestigation("response-only.json", cwd, "investigation.json");
    const paths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      paths.push(`${url.pathname}`);
      if (url.pathname === `/v1/suites/${FAQ_SUITE_ID}/revisions/${FAQ_REVISION}`) {
        return Response.json({
          suiteId: FAQ_SUITE_ID,
          revisionId: FAQ_REVISION,
          contentHash: FAQ_HASH,
          canonicalDocument: faqPinnedDocument()
        });
      }
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(billingFixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        return Response.json(billingFixtures.fixtures["quote_success_with_balance"]?.response);
      }
      if (url.pathname === "/v1/relay/runs") {
        throw new Error("must not create after cancel");
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    await expect(
      runTest(
        {
          cwd,
          investigation: "investigation.json",
          maxCredits: "30",
          stateDirectory: cwd,
          env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
        },
        {
          doctor: doctorFor(),
          isInteractive: () => true,
          confirm: async () => false,
          accessToken: async () => "token",
          identity: async () => identity(),
          cloud: hostedCloud(fetchMock)
        }
      )
    ).rejects.toMatchObject({ code: "SPENDING_CONSENT_DECLINED" });
    expect(paths.includes("/v1/relay/runs")).toBe(false);
  });

  it("fetches an investigation without quoting or creating a run", async () => {
    const cwd = await tempDir("aw-inv-fetch-");
    temporaryDirectories.push(cwd);
    const artifact = JSON.parse(
      await readFile(resolve(projectRoot, "examples/investigations/response-only.json"), "utf8")
    ) as Record<string, unknown>;
    const paths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (
        url.pathname ===
        "/v1/runs/run_orig_faq_status/evaluations/eval_orig_faq_status/attempts/attempt_orig_faq_status/criteria/faq.status-page.required/investigation"
      ) {
        return Response.json(artifact);
      }
      if (url.pathname === "/v1/relay/runs" || url.pathname === "/v1/billing/quote") {
        throw new Error("fetch must not admit");
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const io = capture();
    await fetchInvestigation(
      {
        run: "run_orig_faq_status",
        evaluation: "eval_orig_faq_status",
        attempt: "attempt_orig_faq_status",
        criterion: "faq.status-page.required",
        json: true,
        cwd,
        env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
      },
      {
        ...io,
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: hostedCloud(fetchMock),
        doctor: doctorFor()
      }
    );
    const payload = JSON.parse(io.output().stdout) as { ok: boolean; admissionCalls: number; action: string };
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe("fetch");
    expect(payload.admissionCalls).toBe(0);
    expect(paths.some((path) => path.startsWith("POST /v1/runs/"))).toBe(true);
    expect(paths.some((path) => path.includes("/v1/relay/runs"))).toBe(false);
  });

  it("completes an investigation rerun against an HTML 404 fallback", async () => {
    const cwd = await tempDir("aw-inv-html-");
    temporaryDirectories.push(cwd);
    await copyInvestigation("response-only.json", cwd, "investigation.json");
    const paths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
      if (url.pathname === `/v1/suites/${FAQ_SUITE_ID}/revisions/${FAQ_REVISION}`) {
        return Response.json({
          suiteId: FAQ_SUITE_ID,
          revisionId: FAQ_REVISION,
          contentHash: FAQ_HASH,
          canonicalDocument: faqPinnedDocument()
        });
      }
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(billingFixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        return Response.json(billingFixtures.fixtures["quote_success_with_balance"]?.response);
      }
      if (url.pathname === "/v1/relay/runs") {
        const request = body ?? {};
        return Response.json({
          protocol_version: "aw-relay/0.3",
          create_request_id: request["create_request_id"],
          create_request_sha256: sha256(canonicalize(request)),
          create_disposition: "created",
          run_id: "run-repro-faq",
          session_id: "session-1",
          packet: { key: "aw-customer-suite", version: "1.0.0", sha256: "a".repeat(64) },
          config_sha256: request["config_sha256"],
          fencing_epoch: 1,
          status: "running",
          dashboard_url: "http://127.0.0.1:8787/portal/runs/run-repro-faq",
          run_expires_at: "2099-09-06T00:00:00.000Z",
          credit_state: "reserved"
        });
      }
      const missing = "<!DOCTYPE html><html><body>404: This page could not be found.</body></html>";
      return new Response(missing, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    const result = await runTest(
      {
        cwd,
        investigation: "investigation.json",
        maxCredits: "30",
        yes: true,
        stateDirectory: cwd,
        handleSignals: false,
        env: { AUGMENTWORKS_API_URL: "http://127.0.0.1:8787" }
      },
      {
        doctor: doctorFor(),
        isInteractive: () => false,
        accessToken: async () => "token",
        identity: async () => identity(),
        cloud: hostedCloud(fetchMock),
        runner: () =>
          ({
            run: async () => ({
              protocol_version: "aw-relay/0.1",
              run_id: "run-repro-faq",
              status: "completed",
              credit_state: "reserved",
              outcome: "passed"
            }),
            requestCancellation: async () => {
              throw new Error("investigation rerun must not cancel");
            }
          }) as unknown as RelayRunner
      }
    );
    expect(result.binding.run_id).toBe("run-repro-faq");
    expect(result.run.status).toBe("completed");
    expect(paths.some((path) => path.includes("execution-scope"))).toBe(false);
  });
});
