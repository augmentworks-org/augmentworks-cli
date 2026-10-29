import {
  billingCoverageKnowledge,
  classifyHostedOutcome,
  isResolvedHostedOutcome,
  judgeJobsFromProgress,
  type HostedRunAssessment,
  type HostedRunWork
} from "../outcome/classify.js";
import { isBillingExecutionStatus, type BillingRunStatus } from "./protocol.js";

/**
 * Outcome values the relay contract treats as resolved assessments.
 * The billing status schema leaves `outcome` unconstrained; unknown strings
 * are observable but never a release pass.
 */
export const BILLING_RESOLVED_OUTCOMES = ["passed", "failed", "inconclusive", "error"] as const;

export type BillingResolvedOutcome = (typeof BILLING_RESOLVED_OUTCOMES)[number];

export type BillingRunWork = HostedRunWork;

export type BillingRunAssessment = HostedRunAssessment;

/**
 * One explicit classification for a successfully parsed billing status.
 *
 * `observation: "succeeded"` means the HTTP query parsed. That is not a
 * release pass. `run status --json` keeps `ok: true` for observation so
 * operators can inspect an unfinished run; `exit_code` and `assessment`
 * are the gate. `run wait` continues while `waitTerminal` is false.
 *
 * Combinations (execution × evaluation × outcome → wait / assessment / exit):
 *
 * | execution | evaluation | outcome | wait | assessment | exit |
 * | --- | --- | --- | --- | --- | --- |
 * | queued/connected/running/cancel_requested | absent | null | continue | incomplete | 11 |
 * | running | absent | 0/N attempts, null | continue | incomplete | 11 |
 * | completed | absent | passed | terminal | passed (deterministic-only, known coverage) | 0 |
 * | completed | absent | failed/inconclusive/error | terminal | failed | 10 |
 * | completed | absent | null/unknown | terminal | incomplete/unknown | 11 |
 * | completed | pending, or partial with judge jobs left | any | continue | incomplete | 11 |
 * | completed | partial, every judge job done | any | terminal | failed (inconclusive) | 10 |
 * | completed | complete | passed | terminal | passed | 0 |
 * | completed | complete | failed/inconclusive/error | terminal | failed | 10 |
 * | completed | complete | null/unknown | terminal | incomplete/unknown | 11 |
 * | completed | error | any | terminal | evaluator_error | 12 |
 * | completed | unsupported | any | terminal | unsupported | 11 |
 * | failed | not pending/partial | any | terminal | failed | 10 |
 * | cancelled | not pending/partial | any | terminal | interrupted | 130 |
 * | failed/cancelled | error | any | terminal | evaluator_error | 12 |
 * | unknown | not pending/partial | any | terminal | unknown | 11 |
 *
 * Ambiguous contract combinations never silently pass. Evaluation `error`
 * takes precedence over execution failure so exit 12 stays distinct from 10.
 * Exit 0 additionally requires known reconciled coverage when progress is present.
 */
export type BillingRunClassification = {
  readonly observation: "succeeded";
  readonly work: BillingRunWork;
  readonly waitTerminal: boolean;
  readonly assessment: BillingRunAssessment;
  readonly exitCode: number;
  readonly deterministicOnly: boolean;
};

export function isKnownBillingExecutionStatus(value: string): boolean {
  return isBillingExecutionStatus(value);
}

export function isResolvedBillingOutcome(value: string): value is BillingResolvedOutcome {
  return isResolvedHostedOutcome(value);
}

export function classifyBillingRunStatus(status: BillingRunStatus): BillingRunClassification {
  const classified = classifyHostedOutcome({
    executionStatus: status.executionStatus,
    evaluationStatus: status.evaluationStatus,
    outcome: status.outcome ?? null,
    coverageKnown: billingCoverageKnowledge(status.progress, status.evaluationStatus),
    judgeJobs: judgeJobsFromProgress(status.progress)
  });
  return {
    observation: "succeeded",
    ...classified
  };
}
