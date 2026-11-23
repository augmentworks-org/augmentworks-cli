import { EXIT } from "../errors.js";
import {
  BILLING_EVALUATION_STATUSES,
  BILLING_EXECUTION_STATUSES,
  type BillingEvaluationStatus,
  type BillingRunStatus
} from "../billing/protocol.js";

/**
 * Conservative hosted-result classification shared by `test`, `run wait` /
 * `run status`, and `run report`.
 *
 * Exit `0` is only a fully passed, graded, known-coverage result. A completed
 * run with a null outcome or an unrecognized evaluation status never passes.
 * Observation/retrieval success is not grading success. A required-check
 * failure (`outcome` `failed`) is exit 10 even when evaluation is `error`.
 * Exit 12 stays for an evaluator error with no known required failure.
 */

export const HOSTED_RESOLVED_OUTCOMES = ["passed", "failed", "inconclusive", "error"] as const;
export type HostedResolvedOutcome = (typeof HOSTED_RESOLVED_OUTCOMES)[number];

export type HostedRunWork = "in_progress" | "terminal";

export type HostedRunAssessment =
  | "passed"
  | "failed"
  | "incomplete"
  | "evaluator_error"
  | "interrupted"
  | "unsupported"
  | "unknown";

export type HostedCoverageKnowledge = boolean | null | undefined;

/**
 * Grading can still change while the server says `pending` or `partial`.
 *
 * AUG-434: the server reports `partial` only while grading is open, which
 * includes the moment after the last judge job succeeds and before the
 * evaluation snapshot is republished. A finished evaluation whose required
 * checks were inconclusive or not run is reported `complete` with that
 * outcome (AUG-403), so the CLI does not infer an end to grading from
 * judge-job counts.
 */
export function gradingStillPending(evaluationStatus: string | null | undefined): boolean {
  return evaluationStatus === "pending" || evaluationStatus === "partial";
}

export type HostedOutcomeInput = {
  readonly executionStatus: string;
  readonly evaluationStatus?: string | null | undefined;
  readonly outcome?: string | null | undefined;
  /**
   * `true` — coverage is known and reconciled.
   * `false` — coverage is known incomplete.
   * `null` — coverage is genuinely unknown.
   * `undefined` — the surface does not carry coverage (hosted `test` status).
   */
  readonly coverageKnown?: HostedCoverageKnowledge;
};

export type HostedOutcomeClassification = {
  readonly work: HostedRunWork;
  readonly waitTerminal: boolean;
  readonly assessment: HostedRunAssessment;
  readonly exitCode: number;
  readonly deterministicOnly: boolean;
};

export type ReportCoverage = {
  readonly plannedAttempts: number | null;
  readonly completedAttempts: number | null;
  readonly requiredJudgmentsPlanned: number | null;
  readonly requiredJudgmentsComplete: number | null;
};

const TERMINAL_EXECUTION = new Set(["completed", "failed", "cancelled"]);
const KNOWN_EXECUTION = new Set<string>(BILLING_EXECUTION_STATUSES);
const KNOWN_EVALUATION = new Set<string>(BILLING_EVALUATION_STATUSES);

export function isResolvedHostedOutcome(value: string): value is HostedResolvedOutcome {
  return (HOSTED_RESOLVED_OUTCOMES as readonly string[]).includes(value);
}

export function normalizeEvaluationStatus(value: string | null | undefined): string {
  if (value === undefined || value === null || value === "") return "absent";
  return value;
}

function executionWork(executionStatus: string): HostedRunWork | "unknown" {
  if (!KNOWN_EXECUTION.has(executionStatus)) return "unknown";
  if (TERMINAL_EXECUTION.has(executionStatus)) return "terminal";
  return "in_progress";
}

function resolvedOutcome(outcome: string | null | undefined): HostedResolvedOutcome | null | "unknown" {
  if (outcome === undefined || outcome === null || outcome === "") return null;
  if (isResolvedHostedOutcome(outcome)) return outcome;
  return "unknown";
}

/**
 * Coverage knowledge for a report `coverage` object.
 * Null counts are unknown, never treated as zero. Unknown blocks a pass.
 */
export function coverageKnowledge(coverage: ReportCoverage | undefined): HostedCoverageKnowledge {
  if (coverage === undefined) return undefined;
  const planned = coverage.plannedAttempts;
  const completed = coverage.completedAttempts;
  if (planned === null || completed === null) return null;
  if (!Number.isInteger(planned) || planned < 1) return null;
  if (!Number.isInteger(completed) || completed < 0) return null;
  if (completed !== planned) return false;
  const judgmentsPlanned = coverage.requiredJudgmentsPlanned;
  const judgmentsComplete = coverage.requiredJudgmentsComplete;
  if (judgmentsPlanned === null && judgmentsComplete === null) return true;
  if (judgmentsPlanned === null || judgmentsComplete === null) return null;
  if (!Number.isInteger(judgmentsPlanned) || judgmentsPlanned < 0) return null;
  if (!Number.isInteger(judgmentsComplete) || judgmentsComplete < 0) return null;
  if (judgmentsPlanned === 0) return true;
  return judgmentsComplete === judgmentsPlanned;
}

export function billingCoverageKnowledge(
  progress: BillingRunStatus["progress"],
  evaluationStatus: BillingEvaluationStatus
): boolean | null {
  if (progress.plannedAttempts < 1) return null;
  if (progress.completedAttempts !== progress.plannedAttempts) return false;
  if (
    evaluationStatus === "complete" &&
    progress.plannedJudgeJobs > 0 &&
    progress.completedJudgeJobs !== progress.plannedJudgeJobs
  ) {
    return false;
  }
  return true;
}

export function classifyHostedOutcome(input: HostedOutcomeInput): HostedOutcomeClassification {
  const execution = executionWork(input.executionStatus);
  const work: HostedRunWork = execution === "in_progress" ? "in_progress" : "terminal";
  const evaluationStatus = normalizeEvaluationStatus(input.evaluationStatus);
  if (!KNOWN_EVALUATION.has(evaluationStatus)) {
    return {
      work,
      waitTerminal: work === "terminal",
      assessment: "unknown",
      exitCode: EXIT.EVALUATION_INCOMPLETE,
      deterministicOnly: false
    };
  }
  const gradingInProgress = gradingStillPending(evaluationStatus);
  const waitTerminal = work === "terminal" && !gradingInProgress;
  const outcome = resolvedOutcome(input.outcome);
  const deterministicOnly =
    input.executionStatus === "completed" && evaluationStatus === "absent";

  let assessment: HostedRunAssessment;
  let exitCode: number;

  if (execution === "in_progress" || gradingInProgress) {
    assessment = "incomplete";
    exitCode = EXIT.EVALUATION_INCOMPLETE;
  } else if (evaluationStatus === "error") {
    // A known required failure stays a failed assessment. Exit 12 is only
    // an evaluator error when no required check is known to have failed.
    if (outcome === "failed") {
      assessment = "failed";
      exitCode = EXIT.ASSESSMENT_FAILED;
    } else {
      assessment = "evaluator_error";
      exitCode = EXIT.EVALUATION_ERROR;
    }
  } else if (input.executionStatus === "cancelled") {
    assessment = "interrupted";
    exitCode = EXIT.INTERRUPTED;
  } else if (evaluationStatus === "unsupported") {
    assessment = "unsupported";
    exitCode = EXIT.EVALUATION_INCOMPLETE;
  } else if (execution === "unknown") {
    assessment = "unknown";
    exitCode = EXIT.EVALUATION_INCOMPLETE;
  } else if (
    input.executionStatus === "failed" ||
    outcome === "failed" ||
    outcome === "inconclusive" ||
    outcome === "error"
  ) {
    assessment = "failed";
    exitCode = EXIT.ASSESSMENT_FAILED;
  } else if (outcome === "unknown") {
    assessment = "unknown";
    exitCode = EXIT.EVALUATION_INCOMPLETE;
  } else if (
    outcome === "passed" &&
    input.executionStatus === "completed" &&
    (evaluationStatus === "complete" || evaluationStatus === "absent") &&
    input.coverageKnown !== false &&
    input.coverageKnown !== null
  ) {
    assessment = "passed";
    exitCode = EXIT.OK;
  } else {
    assessment = "incomplete";
    exitCode = EXIT.EVALUATION_INCOMPLETE;
  }

  return {
    work,
    waitTerminal,
    assessment,
    exitCode,
    deterministicOnly
  };
}
