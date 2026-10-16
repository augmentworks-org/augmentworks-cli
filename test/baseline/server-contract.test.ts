import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyComparison, classifyReleasePolicy } from "../../src/baseline/classify.js";
import {
  CreateBaselineRequestSchema,
  normalizePromoteResponse,
  normalizeReleasePolicyDocument,
  PromoteBaselineRequestSchema
} from "../../src/baseline/protocol.js";
import { EXIT } from "../../src/errors.js";

// Server-produced documents vendored from main `docs/contracts/aw-feature-v1.fixtures.json`.
const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const producer = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-feature-v1.producer.fixtures.json"), "utf8")
) as { fixtures: Record<string, { valid: boolean; document: Record<string, unknown> }> };

function producerDocument(name: string): Record<string, unknown> {
  const entry = producer.fixtures[name];
  if (entry === undefined || !entry.valid) throw new Error(`missing valid producer fixture ${name}`);
  return structuredClone(entry.document);
}

// The shape of main `POST /v1/release-gates/evaluate` (`ReleaseGateReadEnvelope`).
function gateEnvelope(document: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: "aw-release-gate-read/1",
    createsBillableRun: false,
    document,
    comparison: { comparedCases: [] },
    inputRevisions: { baselineId: document["baselineId"], promotionRevision: 1 }
  };
}

function classifyEnvelope(document: Record<string, unknown>) {
  const normalized = normalizeReleasePolicyDocument(gateEnvelope(document), {
    candidateRunId: String(document["candidateRunId"]),
    baselineId: String(document["baselineId"])
  });
  return { normalized, classification: classifyReleasePolicy(normalized) };
}

describe("release gate against the server's documents", () => {
  it.each([
    ["release_changed_build_compatible", "passed", EXIT.OK],
    ["release_added_cases", "passed", EXIT.OK],
    ["release_incompatible_rubric", "incompatible", EXIT.CONFIG],
    ["release_removed_cases", "incomplete", EXIT.EVALUATION_INCOMPLETE],
    ["release_partial_not_pass", "incomplete", EXIT.EVALUATION_INCOMPLETE]
  ] as const)("%s reads the server decision", (name, assessment, exitCode) => {
    const document = producerDocument(name);
    const { normalized, classification } = classifyEnvelope(document);
    expect(normalized.decision).toBe(document["decision"]);
    expect(normalized.evaluationStatus).toBe(document["evaluationStatus"]);
    expect(normalized.candidateEvaluationId).toBe(document["candidateEvaluationId"]);
    expect(classification.assessment).toBe(assessment);
    expect(classification.exitCode).toBe(exitCode);
    expect(classification.reasonCodes).not.toContain("unknown_evaluation_state");
  });

  it("blocks a new required failure and counts it as a regression", () => {
    const document = producerDocument("release_changed_build_compatible");
    document["decision"] = "block";
    document["comparedCases"] = [
      {
        caseId: "returns-window",
        criterionId: "returns-window/facts",
        repetitionIndex: 0,
        requirement: "required",
        baselineOutcome: "pass",
        candidateOutcome: "fail",
        category: "new_required_failure"
      }
    ];
    const { normalized, classification } = classifyEnvelope(document);
    expect(classification.assessment).toBe("blocked");
    expect(classification.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    expect(normalized.groups.new_required_regressions).toHaveLength(1);
  });

  it("keeps an existing required failure in persistent failures without blocking", () => {
    const { normalized, classification } = classifyEnvelope(
      producerDocument("release_changed_build_compatible")
    );
    expect(normalized.groups.persistent_failures).toHaveLength(1);
    expect(classification.exitCode).toBe(EXIT.OK);
  });

  it.each(["running", "cancelled"])("treats evaluation status %s as not finished", (status) => {
    const document = producerDocument("release_partial_not_pass");
    document["evaluationStatus"] = status;
    const { classification } = classifyEnvelope(document);
    expect(classification.assessment).toBe("incomplete");
    expect(classification.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("accepts the null commit the server sends when no build was given", () => {
    const document = producerDocument("release_changed_build_compatible");
    document["candidateBuild"] = { label: "candidate", gitCommit: null, createdAt: "2026-10-15T12:00:00Z" };
    expect(classifyEnvelope(document).classification.exitCode).toBe(EXIT.OK);
  });
});

describe("compare against the server's comparison (AUG-384)", () => {
  // The shape of main `POST /v1/comparisons/evaluate` (`ComparisonReadEnvelope`).
  function comparisonEnvelope(document: Record<string, unknown>): Record<string, unknown> {
    return {
      schemaVersion: "aw-semantic-comparison-read/1",
      createsBillableRun: false,
      policyVersion: "aw-release-policy/1",
      comparison: {
        baselineRunId: "33333333-3333-4333-8333-333333333333",
        candidateRunId: document["candidateRunId"],
        baselineEvaluationId: "44444444-4444-4444-8444-444444444444",
        candidateEvaluationId: document["candidateEvaluationId"],
        baselineEvaluationRevision: 2,
        candidateEvaluationRevision: document["candidateEvaluationRevision"],
        baselineSnapshotHash: null,
        candidateSnapshotHash: null,
        comparability: document["comparability"],
        compatibilityReasons: document["compatibilityReasons"],
        coverageChange: document["coverageChange"],
        evaluationStatus: document["evaluationStatus"],
        comparedCases: document["comparedCases"],
        limitationReasons: [],
        createsBillableRun: false
      },
      inputRevisions: {
        baselineRunId: "33333333-3333-4333-8333-333333333333",
        candidateRunId: document["candidateRunId"],
        baselineEvaluationId: "44444444-4444-4444-8444-444444444444",
        candidateEvaluationId: document["candidateEvaluationId"],
        baselineEvaluationRevision: 2,
        candidateEvaluationRevision: document["candidateEvaluationRevision"],
        baselineSnapshotHash: null,
        candidateSnapshotHash: null
      }
    };
  }

  it("reports a new required failure without deciding the release", () => {
    const document = producerDocument("release_changed_build_compatible");
    document["comparedCases"] = [
      {
        caseId: "returns-window",
        criterionId: "returns-window/facts",
        repetitionIndex: 0,
        requirement: "required",
        baselineOutcome: "pass",
        candidateOutcome: "fail",
        change: "regressed",
        category: "new_required_failure"
      }
    ];
    const normalized = normalizeReleasePolicyDocument(comparisonEnvelope(document), {
      candidateRunId: String(document["candidateRunId"]),
      baselineId: String(document["baselineId"])
    });
    const classification = classifyComparison(normalized);
    expect(classification.assessment).toBe("reported");
    expect(classification.exitCode).toBe(EXIT.OK);
    expect(normalized.groups.new_required_regressions).toHaveLength(1);
    expect(normalized.baseline.runId).toBe("33333333-3333-4333-8333-333333333333");
    expect(normalized.baseline.evaluationRevision).toBe(2);
  });

  it("still says when grading hasn't finished", () => {
    const document = producerDocument("release_partial_not_pass");
    const normalized = normalizeReleasePolicyDocument(comparisonEnvelope(document), {
      candidateRunId: String(document["candidateRunId"]),
      baselineId: String(document["baselineId"])
    });
    expect(classifyComparison(normalized).exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });
});

describe("gate coverage and baseline revisions (AUG-384)", () => {
  it("passes when only an advisory case was removed", () => {
    const document = producerDocument("release_changed_build_compatible");
    document["coverageChange"] = "removed_cases";
    document["comparedCases"] = [
      {
        caseId: "tone",
        criterionId: "tone/style",
        repetitionIndex: 0,
        requirement: "advisory",
        baselineOutcome: "pass",
        candidateOutcome: null,
        category: "removed_case"
      }
    ];
    expect(classifyEnvelope(document).classification.exitCode).toBe(EXIT.OK);
  });

  it("reads the baseline's promotion revision from inputRevisions", () => {
    const { normalized } = classifyEnvelope(producerDocument("release_changed_build_compatible"));
    expect(normalized.baseline.promotionRevision).toBe(1);
  });
});

describe("baseline requests and responses against the server's contract", () => {
  const runId = "22222222-2222-4222-8222-222222222222";

  it("promote sends runId and a revision of at least 1", () => {
    const base = { schemaVersion: "aw-release-policy/1", packageVersion: "aw-feature/1" } as const;
    expect(PromoteBaselineRequestSchema.safeParse({ ...base, runId, expectedPromotionRevision: 1 }).success).toBe(
      true
    );
    expect(
      PromoteBaselineRequestSchema.safeParse({ ...base, candidateRunId: runId, expectedPromotionRevision: 1 })
        .success
    ).toBe(false);
    expect(PromoteBaselineRequestSchema.safeParse({ ...base, runId, expectedPromotionRevision: 0 }).success).toBe(
      false
    );
  });

  it("create sends the fields the server requires", () => {
    expect(
      CreateBaselineRequestSchema.safeParse({
        schemaVersion: "aw-release-policy/1",
        packageVersion: "aw-feature/1",
        name: "main",
        applicationName: "support-bot",
        environmentName: "production",
        runId
      }).success
    ).toBe(true);
  });

  it("reads the saved baseline from the server's record envelope", () => {
    const record = producerDocument("baseline_record");
    const result = normalizePromoteResponse({ ok: true, record, createsBillableRun: false });
    expect(result.baselineId).toBe(record["baselineId"]);
    expect(result.runId).toBe(record["runId"]);
    expect(result.promotionRevision).toBe(record["promotionRevision"]);
    expect(result.createsBillableRun).toBe(false);
  });
});
