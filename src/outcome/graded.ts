import type { CloudClient } from "../cloud/client.js";
import type { RunStatusResponse } from "../cloud/protocol.js";
import { AwError, EXIT } from "../errors.js";
import type { RunReport } from "../report/schema.js";
import {
  classifyHostedOutcome,
  coverageKnowledge,
  judgeJobsFromProgress,
  type HostedOutcomeClassification,
  type JudgeJobProgress
} from "./classify.js";

/**
 * Neither the relay run status nor the billing status says whether grading
 * passed: the relay `outcome` only says the target finished, and billing
 * status has no outcome. The run report carries the graded outcome, so
 * `test` and `run wait` take pass or fail from it once grading settles.
 */
export function classifyRunReport(
  report: RunReport,
  judgeJobs?: JudgeJobProgress | null
): HostedOutcomeClassification {
  const classified = classifyHostedOutcome({
    executionStatus: report.executionStatus,
    evaluationStatus: report.evaluationStatus,
    outcome: report.outcome,
    coverageKnown: coverageKnowledge(report.coverage),
    judgeJobs
  });
  if (classified.exitCode === EXIT.OK && !report.reportReady) {
    return { ...classified, assessment: "incomplete", exitCode: EXIT.EVALUATION_INCOMPLETE };
  }
  return classified;
}

/** Grading is finished, or nothing more will change for this run. */
export function reportSettled(report: RunReport, judgeJobs?: JudgeJobProgress | null): boolean {
  if (report.reportReady) return true;
  const classified = classifyRunReport(report, judgeJobs);
  if (!classified.waitTerminal) return false;
  // A completed run whose grading hasn't been recorded yet is still settling.
  return !(report.executionStatus === "completed" && report.evaluationStatus === "absent");
}

export interface GradedReportWait {
  readonly cloud: CloudClient;
  readonly runId: string;
  readonly workspaceId: string;
  readonly deadline: number;
  readonly now: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Called once, before the first wait. */
  readonly onWaiting?: () => void;
  /**
   * Reads judge-job progress (billing status) for a report that says
   * `partial`. The run report carries no judge-job counts, and an older
   * server keeps a finished, inconclusive evaluation at `partial` (AUG-403).
   * Undefined means progress is unknown, so grading still counts as pending.
   */
  readonly judgeJobs?: () => Promise<JudgeJobProgress | undefined>;
}

/**
 * Polls the run report until grading settles or the deadline passes. Returns
 * the last report read, or undefined when no report could be read.
 */
export async function waitForGradedReport(options: GradedReportWait): Promise<RunReport | undefined> {
  let delay = 1_000;
  let last: RunReport | undefined;
  for (;;) {
    try {
      last = await options.cloud.getRunReportSummary(options.runId, options.signal);
    } catch (error) {
      // A report that can't be read leaves grading pending; a credential or
      // tenant problem, or a cancelled wait, still stops the command.
      if (!(error instanceof AwError) || error.category === "auth" || error.code === "RELAY_REQUEST_CANCELLED") {
        throw error;
      }
      return last;
    }
    if (last.workspaceId !== options.workspaceId) {
      throw new AwError({
        code: "REPORT_WORKSPACE_MISMATCH",
        category: "protocol",
        message: "The run report belongs to a different workspace."
      });
    }
    if (reportSettled(last)) return last;
    if (last.evaluationStatus === "partial" && options.judgeJobs !== undefined) {
      if (reportSettled(last, await options.judgeJobs())) return last;
    }
    const remaining = options.deadline - options.now();
    if (remaining <= 0) return last;
    if (delay === 1_000) options.onWaiting?.();
    await (options.sleep ?? sleepUnlessAborted)(Math.min(delay, remaining), options.signal);
    delay = Math.min(delay * 2, 5_000);
  }
}

/**
 * The relay status with the graded outcome from the run report. Until grading
 * settles it reports grading as pending, so a finished target never reads as
 * a passed assessment.
 */
export function gradedRunStatus(
  run: RunStatusResponse,
  report: RunReport | undefined,
  judgeJobs?: JudgeJobProgress | null
): RunStatusResponse {
  if (report === undefined || !reportSettled(report, judgeJobs)) {
    return { ...run, outcome: null, evaluation_status: "pending" };
  }
  const { evaluation_status: _ignored, ...rest } = run;
  // Only a ready report can say passed; a failure it already shows stands.
  const outcome = report.outcome === "passed" && !report.reportReady ? null : report.outcome;
  return {
    ...rest,
    outcome,
    ...(report.evaluationStatus === "absent" ? {} : { evaluation_status: report.evaluationStatus })
  };
}

/**
 * Judge-job progress for one run from billing status, for surfaces that have
 * no progress of their own (`test`, `run report`). Best effort: a server
 * without billing status, or any read failure, leaves progress unknown.
 * Credential problems and a cancelled wait still stop the command.
 */
export async function readJudgeJobProgress(options: {
  readonly cloud: Pick<CloudClient, "getBillingRunStatus">;
  readonly runId: string;
  readonly workspaceId: string;
  readonly signal?: AbortSignal;
}): Promise<JudgeJobProgress | undefined> {
  try {
    const status = await options.cloud.getBillingRunStatus(options.runId, options.signal);
    if (status.workspaceId !== options.workspaceId || status.runId !== options.runId) {
      return undefined;
    }
    return judgeJobsFromProgress(status.progress);
  } catch (error) {
    if (
      error instanceof AwError &&
      (error.category === "auth" || error.code === "RELAY_REQUEST_CANCELLED")
    ) {
      throw error;
    }
    return undefined;
  }
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  const cancelled = () =>
    new AwError({
      code: "RELAY_REQUEST_CANCELLED",
      category: "relay",
      message: "The wait was cancelled.",
      retryable: true
    });
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
