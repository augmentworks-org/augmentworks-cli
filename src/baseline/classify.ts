import { EXIT } from "../errors.js";
import type { NormalizedReleasePolicy } from "./protocol.js";
import { isCoverageChange, isReleaseDecision } from "./protocol.js";
import type { StableReasonCode } from "./schema.js";

export type ReleaseAssessment =
  | "passed"
  | "blocked"
  | "incomplete"
  | "evaluator_error"
  | "incompatible"
  | "unsupported"
  | "unknown"
  | "reported";

export interface ReleaseClassification {
  readonly observation: "succeeded";
  readonly assessment: ReleaseAssessment;
  readonly exitCode: number;
  readonly reasonCodes: readonly string[];
}

export function classifyReleasePolicy(document: NormalizedReleasePolicy): ReleaseClassification {
  if (document.createsBillableRun) {
    return {
      observation: "succeeded",
      assessment: "unsupported",
      exitCode: EXIT.RELAY,
      reasonCodes: unique(["creates_billable_run", ...document.reasonCodes])
    };
  }

  const derived = deriveReasonCodes(document);
  const reasonCodes = unique([...document.reasonCodes, ...derived]);
  const evaluation = document.evaluationStatus;
  const decision = document.decision;
  const comparability = document.comparability;

  if (evaluation === "error" || reasonCodes.includes("evaluator_error")) {
    return {
      observation: "succeeded",
      assessment: "evaluator_error",
      exitCode: EXIT.EVALUATION_ERROR,
      reasonCodes: unique(["evaluator_error", ...reasonCodes])
    };
  }

  if (
    evaluation === "pending" ||
    evaluation === "running" ||
    evaluation === "partial" ||
    evaluation === "cancelled" ||
    evaluation === "absent" ||
    reasonCodes.includes("evaluation_pending")
  ) {
    return {
      observation: "succeeded",
      assessment: "incomplete",
      exitCode: EXIT.EVALUATION_INCOMPLETE,
      reasonCodes: unique(["evaluation_pending", ...reasonCodes])
    };
  }

  if (
    evaluation === "unsupported" ||
    evaluation === "unknown" ||
    !isKnownEvaluation(evaluation)
  ) {
    return {
      observation: "succeeded",
      assessment: "unsupported",
      exitCode: EXIT.EVALUATION_INCOMPLETE,
      reasonCodes: unique(["unknown_evaluation_state", ...reasonCodes])
    };
  }

  if (comparability === "incompatible" || decision === "incompatible") {
    return {
      observation: "succeeded",
      assessment: "incompatible",
      exitCode: EXIT.CONFIG,
      reasonCodes: unique(["incompatible_scope", ...reasonCodes])
    };
  }

  if (
    comparability === "incomplete" ||
    decision === "incomplete" ||
    reasonCodes.includes("missing_required_coverage") ||
    reasonCodes.includes("evaluation_incomplete") ||
    document.coverageChange === "missing_required" ||
    document.coverageChange === "unknown" ||
    !isCoverageChange(document.coverageChange)
  ) {
    return {
      observation: "succeeded",
      assessment: "incomplete",
      exitCode: EXIT.EVALUATION_INCOMPLETE,
      reasonCodes: unique(["evaluation_incomplete", ...reasonCodes])
    };
  }

  if (!isReleaseDecision(decision)) {
    return {
      observation: "succeeded",
      assessment: "unknown",
      exitCode: EXIT.EVALUATION_INCOMPLETE,
      reasonCodes: unique(["unsupported_decision", ...reasonCodes])
    };
  }

  if (decision === "block" || groupSize(document, "new_required_regressions") > 0) {
    return {
      observation: "succeeded",
      assessment: "blocked",
      exitCode: EXIT.ASSESSMENT_FAILED,
      reasonCodes: unique(["new_required_regression", ...reasonCodes])
    };
  }

  if (decision !== "pass" || comparability !== "compatible" || evaluation !== "complete") {
    return {
      observation: "succeeded",
      assessment: "unknown",
      exitCode: EXIT.EVALUATION_INCOMPLETE,
      reasonCodes: unique(["unsupported_decision", ...reasonCodes])
    };
  }

  return {
    observation: "succeeded",
    assessment: "passed",
    exitCode: EXIT.OK,
    reasonCodes
  };
}

/**
 * `compare` reports what changed between two graded runs. Only `gate` turns a
 * comparison into a release decision, so a regression here is not a failure.
 */
export function classifyComparison(document: NormalizedReleasePolicy): ReleaseClassification {
  const policy = classifyReleasePolicy(document);
  if (
    policy.assessment === "unsupported" ||
    policy.assessment === "evaluator_error" ||
    policy.assessment === "incompatible" ||
    (policy.assessment === "incomplete" && policy.reasonCodes.includes("evaluation_pending"))
  ) {
    return policy;
  }
  return {
    observation: "succeeded",
    assessment: "reported",
    exitCode: EXIT.OK,
    reasonCodes: unique([...document.reasonCodes, ...deriveReasonCodes(document)])
  };
}

function deriveReasonCodes(document: NormalizedReleasePolicy): StableReasonCode[] {
  const codes: StableReasonCode[] = [];
  if (groupSize(document, "new_required_regressions") > 0) codes.push("new_required_regression");
  if (groupSize(document, "incompatible_scope") > 0) codes.push("incompatible_scope");
  if (groupSize(document, "unresolved") > 0) codes.push("evaluation_incomplete");
  // The server's removed_cases also covers advisory cases, so only a removed
  // required case counts as missing coverage.
  if (
    document.coverageChange === "removed" ||
    document.coverageChange === "missing_required" ||
    document.groups.coverage_changes.some(isRemovedRequiredCase)
  ) {
    codes.push("missing_required_coverage");
  }
  if (
    document.evaluationStatus === "pending" ||
    document.evaluationStatus === "running" ||
    document.evaluationStatus === "partial" ||
    document.evaluationStatus === "cancelled"
  ) {
    codes.push("evaluation_pending");
  }
  if (document.evaluationStatus === "error") codes.push("evaluator_error");
  if (document.decision === "incompatible" || document.comparability === "incompatible") {
    codes.push("incompatible_scope");
  }
  return codes;
}

function groupSize(document: NormalizedReleasePolicy, group: "new_required_regressions" | "incompatible_scope" | "unresolved"): number {
  return document.groups[group]?.length ?? 0;
}

function isRemovedRequiredCase(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  return record["category"] === "removed_case" && record["requirement"] === "required";
}

function isKnownEvaluation(value: string): boolean {
  return (
    value === "complete" ||
    value === "pending" ||
    value === "running" ||
    value === "partial" ||
    value === "cancelled" ||
    value === "error" ||
    value === "absent" ||
    value === "unsupported"
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
