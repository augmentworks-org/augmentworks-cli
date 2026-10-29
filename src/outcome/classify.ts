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
 * Observation/retrieval success is not grading success.
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
 * Judge-job progress from billing status (`progress.plannedJudgeJobs` and
 * `progress.completedJudgeJobs`). AUG-403: older servers leave a finished
 * evaluation at `partial` when a required check is inconclusive, so the CLI
 * needs these counts to tell "still grading" from "grading ended".
 */
export type JudgeJobProgress = {
  readonly planned: number;
  readonly completed: number;
};

export function judgeJobsFromProgress(
  progress: { readonly plannedJudgeJobs: number; readonly completedJudgeJobs: number } | undefined
): JudgeJobProgress | undefined {
  if (progress === undefined) return undefined;
  return { planned: progress.plannedJudgeJobs, completed: progress.completedJudgeJobs };
}

/** Every planned judge job finished. Unknown or malformed counts are not done. */
export function judgeJobsDone(judgeJobs: JudgeJobProgress | null | undefined): boolean {
  if (judgeJobs === undefined || judgeJobs === null) return false;
  const { planned, completed } = judgeJobs;
  if (!Number.isInteger(planned) || !Number.isInteger(completed)) return false;
  if (planned < 0 || completed < 0) return false;
  return completed >= planned;
}

/**
 * Grading can still change: `pending`, or `partial` while judge jobs remain.
 * A `partial` evaluation whose judge jobs are all done has finished grading.
 */
export function gradingStillPending(
  evaluationStatus: string | null | undefined,
  judgeJobs?: JudgeJobProgress | null
): boolean {
  if (evaluationStatus === "pending") return true;
  return evaluationStatus === "partial" && !judgeJobsDone(judgeJobs);
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
  /**
   * Judge-job progress when the surface has it. Only consulted for a
   * `partial` evaluation: with every judge job done it is finished, and never
   * a pass (exit 10).
   */
  readonly judgeJobs?: JudgeJobProgress | null | undefined;
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
  const gradingInProgress = gradingStillPending(evaluationStatus, input.judgeJobs);
  // AUG-403: partial with nothing left to grade. Coverage stayed incomplete
  // or inconclusive, so it is a finished, non-passing assessment.
  const finishedPartial = evaluationStatus === "partial" && !gradingInProgress;
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
    assessment = "evaluator_error";
    exitCode = EXIT.EVALUATION_ERROR;
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
    outcome === "error" ||
    finishedPartial
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
