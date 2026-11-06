import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseReadToolArgs, projectReadToolResult } from "../index.mjs";

const fixtures = JSON.parse(readFileSync(new URL("../fixtures/read-v1.json", import.meta.url), "utf8"));
const [discovery, report, comparison] = fixtures.cases;

for (const example of fixtures.cases) {
  test(example.name, () => {
    const args = parseReadToolArgs(example.tool, example.args);
    assert.deepEqual(projectReadToolResult(example.tool, args, example.upstream), example.expected);
  });
}

test("each tool requires explicit non-billable upstream results", () => {
  for (const { tool, args, upstream } of fixtures.cases) {
    for (const createsBillableRun of [true, undefined]) {
      assert.throws(() => projectReadToolResult(tool, args, { ...upstream, createsBillableRun }));
    }
  }
});

test("accepts either baseline selector and rejects ambiguous or unrecognized input", () => {
  const { candidate_run_id, baseline_run_id } = comparison.args;
  const baseline_id = discovery.expected.baselines[0].baselineId;
  const byPin = { candidate_run_id, baseline_id };
  assert.deepEqual(projectReadToolResult(comparison.tool, byPin, comparison.upstream), comparison.expected);
  for (const args of [{ candidate_run_id }, { ...byPin, baseline_run_id }, { ...byPin, repository_id: "1" }]) {
    assert.throws(() => parseReadToolArgs(comparison.tool, args));
  }
  assert.throws(() => parseReadToolArgs("start_run", {}));
  assert.throws(() => parseReadToolArgs("get_run_report", { run_id: "../other-tenant" }));
  assert.throws(() => parseReadToolArgs("list_applications", { url: "https://example.test" }));
});

test("mismatched run, baseline and input revisions do not project", () => {
  const { candidate_run_id, baseline_run_id } = comparison.args;
  assert.throws(() => projectReadToolResult(report.tool, { run_id: baseline_run_id }, report.upstream));
  for (const mismatched of [
    { ...comparison.upstream, comparison: { ...comparison.upstream.comparison, candidateRunId: baseline_run_id } },
    { ...comparison.upstream, comparison: { ...comparison.upstream.comparison, baselineRunId: candidate_run_id } },
    { ...comparison.upstream, inputRevisions: { candidateRunId: baseline_run_id, baselineRunId: candidate_run_id } },
  ]) {
    assert.throws(() => projectReadToolResult(comparison.tool, comparison.args, mismatched));
  }
});

test("mixed workspaces are rejected even when the mismatched row would be truncated", () => {
  const app = discovery.upstream.applications[0];
  const mixed = {
    ...discovery.upstream,
    applications: [...Array(50).fill(app), { ...app, workspaceId: comparison.args.candidate_run_id }],
  };
  assert.throws(() => projectReadToolResult(discovery.tool, {}, mixed));
});

test("limits projected failures to 50 while retaining the total count", () => {
  const keys = Array.from({ length: 51 }, (_, index) => `rule-${index}`);
  const result = projectReadToolResult(report.tool, report.args, {
    ...report.upstream, aggregate: { requirementOutcome: "fail", knownRequiredFailures: keys },
    executionStatus: "completed", evaluationStatus: "complete", outcome: "failed", reportReady: true,
  });
  assert.deepEqual(result.knownRequiredFailures, keys.slice(0, 50));
  assert.equal(result.knownRequiredFailureCount, 51);
});

test("removes secret-shaped names, control characters and upstream evidence", () => {
  const app = { ...discovery.upstream.applications[0], applicationName: "aw_api_fixture", environmentName: "stage\none" };
  const apps = projectReadToolResult(discovery.tool, {}, { ...discovery.upstream, applications: [app] });
  assert.equal(apps.applications[0].applicationName, "[redacted]");
  assert.equal(apps.applications[0].environmentName, "stage one");
  const result = projectReadToolResult(report.tool, report.args, {
    ...report.upstream, dashboardUrl: "https://example.test/untrusted",
    aggregate: { knownRequiredFailures: ["aw_api_fixture"] },
  });
  assert.equal(result.dashboardUrl, report.expected.dashboardUrl);
  assert.deepEqual(result.knownRequiredFailures, ["[redacted]"]);
  assert.equal(Object.hasOwn(result, "attempts"), false);
});

test("legacy comparisons without change labels still expose outcome differences", () => {
  const { change, category, ...legacy } = comparison.expected.comparedCases[0];
  const data = { ...comparison.upstream, comparison: { ...comparison.upstream.comparison, comparedCases: [legacy] } };
  const result = projectReadToolResult(comparison.tool, comparison.args, data);
  assert.deepEqual(result.comparedCases, [{ ...legacy, change: null, category: null }]);
});

test("a configured workspace must match every available workspace identity", () => {
  const expectedWorkspaceId = report.expected.workspaceId;
  const other = report.args.run_id;
  assert.deepEqual(projectReadToolResult(report.tool, report.args, report.upstream, { expectedWorkspaceId }), report.expected);
  assert.throws(() => projectReadToolResult(report.tool, report.args, report.upstream, { expectedWorkspaceId: other }));
  assert.throws(() => projectReadToolResult(discovery.tool, {}, discovery.upstream, { expectedWorkspaceId: other }));

  const empty = { ok: true, createsBillableRun: false, applications: [], baselines: [] };
  assert.throws(() => projectReadToolResult(discovery.tool, {}, empty, { expectedWorkspaceId }));
  assert.doesNotThrow(() => projectReadToolResult(discovery.tool, {}, { ...empty, workspaceId: expectedWorkspaceId }, { expectedWorkspaceId }));
  assert.throws(() => projectReadToolResult(comparison.tool, comparison.args, comparison.upstream, { expectedWorkspaceId }));
  const scoped = { ...comparison.upstream, workspaceId: expectedWorkspaceId };
  assert.deepEqual(projectReadToolResult(comparison.tool, comparison.args, scoped, { expectedWorkspaceId }), comparison.expected);
  const conflicting = { ...scoped, comparison: { ...scoped.comparison, workspaceId: other } };
  assert.throws(() => projectReadToolResult(comparison.tool, comparison.args, conflicting, { expectedWorkspaceId }));
});

test("only deployment configuration can choose the portal origin", () => {
  const portalOrigin = "https://portal.example.test";
  const summary = projectReadToolResult(report.tool, report.args, {
    ...report.upstream, dashboardUrl: "https://other.example.test/ignored",
  }, { portalOrigin });
  assert.equal(summary.dashboardUrl, portalOrigin + "/portal/runs/" + report.args.run_id);
  for (const origin of ["http://portal.example.test", "https://user@portal.example.test", "https://portal.example.test/path"]) {
    assert.throws(() => projectReadToolResult(report.tool, report.args, report.upstream, { portalOrigin: origin }));
  }
});
