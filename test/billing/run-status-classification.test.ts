import { describe, expect, it } from "vitest";

import {
  classifyBillingRunStatus,
  type BillingRunAssessment,
  type BillingRunWork
} from "../../src/billing/classify.js";
import { parseBillingRunStatusResponse } from "../../src/billing/validate.js";
import type { BillingEvaluationStatus, BillingRunStatus } from "../../src/billing/protocol.js";
import { billingStatusExitCode, isWaitTerminal } from "../../src/commands/run.js";
import { EXIT } from "../../src/errors.js";
import { formatRunStatusHuman, runStatusSuccessJson } from "../../src/billing/format.js";

const RUN_ID = "66666666-6666-4666-8666-666666666666";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

function status(overrides: {
  readonly executionStatus: string;
  readonly evaluationStatus: BillingEvaluationStatus;
  readonly outcome?: string | null;
  readonly completedAttempts?: number;
  readonly plannedAttempts?: number;
  readonly completedJudgeJobs?: number;
  readonly plannedJudgeJobs?: number;
}): BillingRunStatus {
  return {
    schemaVersion: "aw-billing/1",
    runId: RUN_ID,
    workspaceId: WORKSPACE,
    originalRunId: RUN_ID,
    executionStatus: overrides.executionStatus,
    evaluationStatus: overrides.evaluationStatus,
    credit: {
      reservedUnits: 0,
      consumedUnits: 0,
      releasedUnits: 0,
      compensatedUnits: 0
    },
    progress: {
      completedAttempts: overrides.completedAttempts ?? 0,
      plannedAttempts: overrides.plannedAttempts ?? 10,
      completedJudgeJobs: overrides.completedJudgeJobs ?? 0,
      plannedJudgeJobs: overrides.plannedJudgeJobs ?? 0
    },
    savedEvidence: false,
    retryEligible: false,
    retryReason: null,
    nextActions: ["inspect"],
    dashboardUrl: `https://augmentworks.ai/portal/runs/${RUN_ID}`,
    asOf: "2026-09-06T17:20:00.000Z",
    ...(overrides.outcome === undefined ? {} : { outcome: overrides.outcome })
  };
}

type Case = {
  readonly name: string;
  readonly status: BillingRunStatus;
  readonly waitTerminal: boolean;
  readonly work: BillingRunWork;
  readonly assessment: BillingRunAssessment;
  readonly exitCode: number;
  readonly deterministicOnly?: boolean;
};

const cases: readonly Case[] = [
  {
    name: "running/absent/0-of-10/null-outcome reproduction",
    status: status({
      executionStatus: "running",
      evaluationStatus: "absent",
      outcome: null,
      completedAttempts: 0,
      plannedAttempts: 10
    }),
    waitTerminal: false,
    work: "in_progress",
    assessment: "incomplete",
    exitCode: EXIT.EVALUATION_INCOMPLETE
  },
  {
    name: "queued/absent continues wait",
    status: status({ executionStatus: "queued", evaluationStatus: "absent", outcome: null }),
    waitTerminal: false,
    work: "in_progress",
    assessment: "incomplete",
    exitCode: EXIT.EVALUATION_INCOMPLETE
  },
  {
    name: "connected/absent continues wait",
    status: status({ executionStatus: "connected", evaluationStatus: "absent", outcome: null }),
    waitTerminal: false,
    work: "in_progress",
    assessment: "incomplete",
    exitCode: EXIT.EVALUATION_INCOMPLETE
  },
  {
    name: "cancel_requested/absent continues wait",
    status: status({
      executionStatus: "cancel_requested",
      evaluationStatus: "absent",
      outcome: null
    }),
    waitTerminal: false,
    work: "in_progress",
    assessment: "incomplete",
    exitCode: EXIT.EVALUATION_INCOMPLETE
  },
  {
    name: "complete deterministic-only success",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "absent",
      outcome: "passed",
      completedAttempts: 10,
      plannedAttempts: 10
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "passed",
    exitCode: EXIT.OK,
    deterministicOnly: true
  },
  {
    name: "deterministic-only failed outcome",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "absent",
      outcome: "failed",
      completedAttempts: 10,
      plannedAttempts: 10
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "failed",
    exitCode: EXIT.ASSESSMENT_FAILED,
    deterministicOnly: true
  },
  {
    name: "deterministic-only null outcome is not a pass",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "absent",
      outcome: null,
      completedAttempts: 10,
      plannedAttempts: 10
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "incomplete",
    exitCode: EXIT.EVALUATION_INCOMPLETE,
    deterministicOnly: true
  },
  {
    name: "pending grading after completed execution",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "pending",
      completedAttempts: 10,
      plannedAttempts: 10,
      completedJudgeJobs: 1,
      plannedJudgeJobs: 4
    }),
    waitTerminal: false,
    work: "terminal",
    assessment: "incomplete",
    exitCode: EXIT.EVALUATION_INCOMPLETE
  },
  {
    name: "partial grading after completed execution",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "partial",
      outcome: null,
      completedAttempts: 10,
      plannedAttempts: 10,
      completedJudgeJobs: 2,
      plannedJudgeJobs: 4
    }),
    waitTerminal: false,
    work: "terminal",
    assessment: "incomplete",
    exitCode: EXIT.EVALUATION_INCOMPLETE
  },
  {
    name: "partial with every judge job done is finished, never a pass (AUG-403)",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "partial",
      outcome: "passed",
      completedAttempts: 4,
      plannedAttempts: 4,
      completedJudgeJobs: 3,
      plannedJudgeJobs: 3
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "failed",
    exitCode: EXIT.ASSESSMENT_FAILED
  },
  {
    name: "partial with no judge jobs planned is finished (AUG-403)",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "partial",
      outcome: null,
      completedAttempts: 4,
      plannedAttempts: 4,
      completedJudgeJobs: 0,
      plannedJudgeJobs: 0
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "failed",
    exitCode: EXIT.ASSESSMENT_FAILED
  },
  {
    name: "complete hybrid success",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "complete",
      outcome: "passed",
      completedAttempts: 10,
      plannedAttempts: 10,
      completedJudgeJobs: 4,
      plannedJudgeJobs: 4
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "passed",
    exitCode: EXIT.OK
  },
  {
    name: "complete hybrid failed",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "complete",
      outcome: "failed"
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "failed",
    exitCode: EXIT.ASSESSMENT_FAILED
  },
  {
    name: "complete evaluation with null outcome is not a pass",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "complete",
      outcome: null
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "incomplete",
    exitCode: EXIT.EVALUATION_INCOMPLETE
  },
  {
    name: "complete evaluation with inconclusive outcome",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "complete",
      outcome: "inconclusive"
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "failed",
    exitCode: EXIT.ASSESSMENT_FAILED
  },
  {
    name: "evaluator error",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "error"
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "evaluator_error",
    exitCode: EXIT.EVALUATION_ERROR
  },
  {
    name: "unsupported evaluation is never a pass",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "unsupported",
      outcome: "passed"
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "unsupported",
    exitCode: EXIT.EVALUATION_INCOMPLETE
  },
  {
    name: "failed execution with null outcome",
    status: status({
      executionStatus: "failed",
      evaluationStatus: "absent",
      outcome: null
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "failed",
    exitCode: EXIT.ASSESSMENT_FAILED
  },
  {
    name: "cancelled execution",
    status: status({
      executionStatus: "cancelled",
      evaluationStatus: "absent",
      outcome: null
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "interrupted",
    exitCode: EXIT.INTERRUPTED
  },
  {
    name: "evaluator error takes precedence over failed execution",
    status: status({
      executionStatus: "failed",
      evaluationStatus: "error"
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "evaluator_error",
    exitCode: EXIT.EVALUATION_ERROR
  },
  {
    name: "unknown execution status is observable but not a pass",
    status: status({
      executionStatus: "time_travel",
      evaluationStatus: "absent",
      outcome: "passed"
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "unknown",
    exitCode: EXIT.EVALUATION_INCOMPLETE
  },
  {
    name: "unknown outcome is not a pass",
    status: status({
      executionStatus: "completed",
      evaluationStatus: "complete",
      outcome: "florb"
    }),
    waitTerminal: true,
    work: "terminal",
    assessment: "unknown",
    exitCode: EXIT.EVALUATION_INCOMPLETE
  },
  {
    name: "running execution with complete passed evaluation is not a pass",
    status: status({
      executionStatus: "running",
      evaluationStatus: "complete",
      outcome: "passed"
    }),
    waitTerminal: false,
    work: "in_progress",
    assessment: "incomplete",
    exitCode: EXIT.EVALUATION_INCOMPLETE
  }
];

describe("billing run status classification", () => {
  it.each(cases)("$name", (entry) => {
    const classified = classifyBillingRunStatus(entry.status);
    expect(classified.observation).toBe("succeeded");
    expect(classified.waitTerminal).toBe(entry.waitTerminal);
    expect(classified.work).toBe(entry.work);
    expect(classified.assessment).toBe(entry.assessment);
    expect(classified.exitCode).toBe(entry.exitCode);
    expect(isWaitTerminal(entry.status)).toBe(entry.waitTerminal);
    expect(billingStatusExitCode(entry.status)).toBe(entry.exitCode);
    if (entry.deterministicOnly !== undefined) {
      expect(classified.deterministicOnly).toBe(entry.deterministicOnly);
    }
  });

  it("parses the running/absent reproduction without treating query success as a pass", () => {
    const parsed = parseBillingRunStatusResponse(
      status({
        executionStatus: "running",
        evaluationStatus: "absent",
        outcome: null,
        completedAttempts: 0,
        plannedAttempts: 10
      })
    );
    const classified = classifyBillingRunStatus(parsed);
    expect(classified.waitTerminal).toBe(false);
    expect(classified.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    const json = JSON.parse(runStatusSuccessJson(parsed)) as {
      ok: boolean;
      observation: string;
      assessment: string;
      exit_code: number;
      originalRunId: string;
    };
    expect(json.ok).toBe(true);
    expect(json.observation).toBe("succeeded");
    expect(json.assessment).toBe("incomplete");
    expect(json.exit_code).toBe(11);
    expect(json.originalRunId).toBe(RUN_ID);
    const human = formatRunStatusHuman(parsed);
    expect(human).toContain("successful status query, not a passing release assessment");
    expect(human).toContain(`augmentworks run wait ${RUN_ID}`);
    expect(human).not.toContain("Re-run the same test command");
  });

  it("parses unknown execution status for observation without failing closed as a pass", () => {
    const parsed = parseBillingRunStatusResponse(
      status({
        executionStatus: "time_travel",
        evaluationStatus: "absent",
        outcome: "passed"
      })
    );
    expect(parsed.executionStatus).toBe("time_travel");
    expect(classifyBillingRunStatus(parsed).assessment).toBe("unknown");
    expect(billingStatusExitCode(parsed)).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("does not mark a readable report expired because retainUntil is in the past", () => {
    const parsed = parseBillingRunStatusResponse({
      ...status({
        executionStatus: "completed",
        evaluationStatus: "complete",
        outcome: "passed",
        completedAttempts: 10,
        plannedAttempts: 10,
        completedJudgeJobs: 10,
        plannedJudgeJobs: 10
      }),
      retentionPolicyVersion: "aw-retention/pack-90d-v1",
      retainUntil: "2020-01-01T00:00:00.000Z"
    });
    const classified = classifyBillingRunStatus(parsed);
    expect(classified.assessment).toBe("passed");
    expect(classified.exitCode).toBe(EXIT.OK);
    const human = formatRunStatusHuman(parsed);
    expect(human).toContain("2020-01-01T00:00:00.000Z");
    expect(human).toContain("does not decide deletion from the local clock");
    expect(human).not.toMatch(/locally expired|deleted by this CLI/i);
  });

  it("prints a server-supplied expired-result reason and timestamps without a local clock check", () => {
    const parsed = parseBillingRunStatusResponse({
      ...status({
        executionStatus: "completed",
        evaluationStatus: "unsupported",
        outcome: null,
        completedAttempts: 10,
        plannedAttempts: 10
      }),
      retryEligible: false,
      retryReason: "Result expired under retention at 2026-01-01T00:00:00.000Z",
      nextActions: ["none"],
      retentionPolicyVersion: "aw-retention/pack-90d-v1",
      retainUntil: "2026-01-01T00:00:00.000Z"
    });
    expect(classifyBillingRunStatus(parsed).assessment).toBe("unsupported");
    const human = formatRunStatusHuman(parsed);
    expect(human).toContain("Result expired under retention at 2026-01-01T00:00:00.000Z");
    expect(human).toContain("2026-01-01T00:00:00.000Z");
    expect(human).toContain("does not decide deletion from the local clock");
    const json = JSON.parse(runStatusSuccessJson(parsed)) as {
      retainUntil: string;
      retentionPolicyVersion: string;
      retryReason: string;
      assessment: string;
    };
    expect(json.retainUntil).toBe("2026-01-01T00:00:00.000Z");
    expect(json.retentionPolicyVersion).toBe("aw-retention/pack-90d-v1");
    expect(json.retryReason).toContain("expired");
    expect(json.assessment).toBe("unsupported");
  });
});
