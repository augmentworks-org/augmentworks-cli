import { describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { hostedExitCode } from "../../src/commands/test.js";
import {
  classifyHostedOutcome,
  coverageKnowledge,
  gradingStillPending,
  judgeJobsDone,
  judgeJobsFromProgress
} from "../../src/outcome/classify.js";
import type { RunStatusResponse } from "../../src/cloud/protocol.js";

function runStatus(overrides: Partial<RunStatusResponse> = {}): RunStatusResponse {
  return {
    protocol_version: "aw-relay/0.2",
    run_id: "run-1",
    status: "completed",
    credit_state: "consumed",
    outcome: "passed",
    ...overrides
  };
}

describe("shared hosted outcome classification", () => {
  it("never treats a completed run with a null outcome as a pass", () => {
    expect(hostedExitCode(runStatus({ outcome: null }))).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(
      classifyHostedOutcome({
        executionStatus: "completed",
        evaluationStatus: "complete",
        outcome: null
      }).exitCode
    ).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("never treats an unrecognized evaluation status as a pass", () => {
    const classified = classifyHostedOutcome({
      executionStatus: "completed",
      evaluationStatus: "time_travel",
      outcome: "passed"
    });
    expect(classified.assessment).toBe("unknown");
    expect(classified.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("returns 0 only for passed, graded, known-coverage results", () => {
    expect(
      classifyHostedOutcome({
        executionStatus: "completed",
        evaluationStatus: "complete",
        outcome: "passed",
        coverageKnown: true
      }).exitCode
    ).toBe(EXIT.OK);
    expect(
      classifyHostedOutcome({
        executionStatus: "completed",
        evaluationStatus: "complete",
        outcome: "passed",
        coverageKnown: null
      }).exitCode
    ).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(
      classifyHostedOutcome({
        executionStatus: "completed",
        evaluationStatus: "complete",
        outcome: "passed",
        coverageKnown: false
      }).exitCode
    ).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("keeps assessed failure at exit 10 even when coverage is incomplete", () => {
    expect(
      classifyHostedOutcome({
        executionStatus: "completed",
        evaluationStatus: "complete",
        outcome: "failed",
        coverageKnown: false
      }).exitCode
    ).toBe(EXIT.ASSESSMENT_FAILED);
  });

  it("classifies every known grading and cleanup-adjacent hosted state conservatively", () => {
    const cases: Array<{
      name: string;
      input: Parameters<typeof classifyHostedOutcome>[0];
      exitCode: number;
      assessment: string;
    }> = [
      {
        name: "queued absent",
        input: { executionStatus: "queued", evaluationStatus: "absent", outcome: null },
        exitCode: EXIT.EVALUATION_INCOMPLETE,
        assessment: "incomplete"
      },
      {
        name: "running absent",
        input: { executionStatus: "running", evaluationStatus: "absent", outcome: null },
        exitCode: EXIT.EVALUATION_INCOMPLETE,
        assessment: "incomplete"
      },
      {
        name: "completed pending",
        input: { executionStatus: "completed", evaluationStatus: "pending", outcome: "passed" },
        exitCode: EXIT.EVALUATION_INCOMPLETE,
        assessment: "incomplete"
      },
      {
        name: "completed partial",
        input: { executionStatus: "completed", evaluationStatus: "partial", outcome: "passed" },
        exitCode: EXIT.EVALUATION_INCOMPLETE,
        assessment: "incomplete"
      },
      {
        name: "completed error",
        input: { executionStatus: "completed", evaluationStatus: "error", outcome: "passed" },
        exitCode: EXIT.EVALUATION_ERROR,
        assessment: "evaluator_error"
      },
      {
        name: "completed unsupported",
        input: { executionStatus: "completed", evaluationStatus: "unsupported", outcome: "passed" },
        exitCode: EXIT.EVALUATION_INCOMPLETE,
        assessment: "unsupported"
      },
      {
        name: "completed unknown evaluation",
        input: { executionStatus: "completed", evaluationStatus: "time_travel", outcome: "passed" },
        exitCode: EXIT.EVALUATION_INCOMPLETE,
        assessment: "unknown"
      },
      {
        name: "completed unknown outcome",
        input: { executionStatus: "completed", evaluationStatus: "complete", outcome: "mystery" },
        exitCode: EXIT.EVALUATION_INCOMPLETE,
        assessment: "unknown"
      },
      {
        name: "completed inconclusive",
        input: { executionStatus: "completed", evaluationStatus: "complete", outcome: "inconclusive" },
        exitCode: EXIT.ASSESSMENT_FAILED,
        assessment: "failed"
      },
      {
        name: "execution failed",
        input: { executionStatus: "failed", evaluationStatus: "absent", outcome: null },
        exitCode: EXIT.ASSESSMENT_FAILED,
        assessment: "failed"
      },
      {
        name: "cancelled",
        input: { executionStatus: "cancelled", evaluationStatus: "absent", outcome: null },
        exitCode: EXIT.INTERRUPTED,
        assessment: "interrupted"
      },
      {
        name: "cancelled plus evaluator error",
        input: { executionStatus: "cancelled", evaluationStatus: "error", outcome: null },
        exitCode: EXIT.EVALUATION_ERROR,
        assessment: "evaluator_error"
      },
      {
        name: "unknown execution",
        input: { executionStatus: "exploded", evaluationStatus: "absent", outcome: "passed" },
        exitCode: EXIT.EVALUATION_INCOMPLETE,
        assessment: "unknown"
      }
    ];
    for (const row of cases) {
      const classified = classifyHostedOutcome(row.input);
      expect(classified.exitCode, row.name).toBe(row.exitCode);
      expect(classified.assessment, row.name).toBe(row.assessment);
      expect(classified.exitCode, row.name).not.toBe(EXIT.OK);
    }
  });

  it("treats unknown report coverage counts as unknown, never zero", () => {
    expect(
      coverageKnowledge({
        plannedAttempts: null,
        completedAttempts: null,
        requiredJudgmentsPlanned: null,
        requiredJudgmentsComplete: null
      })
    ).toBeNull();
  });
});

describe("partial grading with judge-job progress (AUG-403)", () => {
  it("keeps waiting while judge jobs remain or progress is unknown", () => {
    for (const judgeJobs of [undefined, null, { planned: 4, completed: 3 }]) {
      const classified = classifyHostedOutcome({
        executionStatus: "completed",
        evaluationStatus: "partial",
        outcome: "failed",
        judgeJobs
      });
      expect(classified.waitTerminal).toBe(false);
      expect(classified.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    }
  });

  it("finishes with exit 10 once every judge job is done, whatever the outcome", () => {
    for (const outcome of ["passed", "failed", "inconclusive", null]) {
      const classified = classifyHostedOutcome({
        executionStatus: "completed",
        evaluationStatus: "partial",
        outcome,
        coverageKnown: true,
        judgeJobs: { planned: 3, completed: 3 }
      });
      expect(classified.waitTerminal).toBe(true);
      expect(classified.assessment).toBe("failed");
      expect(classified.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    }
  });

  it("keeps interrupted and evaluator-error exits ahead of a finished partial", () => {
    expect(
      classifyHostedOutcome({
        executionStatus: "cancelled",
        evaluationStatus: "partial",
        outcome: null,
        judgeJobs: { planned: 1, completed: 1 }
      }).exitCode
    ).toBe(EXIT.INTERRUPTED);
  });

  it("reads judge-job progress conservatively", () => {
    expect(judgeJobsDone({ planned: 0, completed: 0 })).toBe(true);
    expect(judgeJobsDone({ planned: 2, completed: 1 })).toBe(false);
    expect(judgeJobsDone({ planned: Number.NaN, completed: 1 })).toBe(false);
    expect(judgeJobsDone(undefined)).toBe(false);
    expect(gradingStillPending("pending", { planned: 1, completed: 1 })).toBe(true);
    expect(gradingStillPending("partial", { planned: 1, completed: 1 })).toBe(false);
    expect(gradingStillPending("complete")).toBe(false);
    expect(
      judgeJobsFromProgress({ plannedJudgeJobs: 4, completedJudgeJobs: 2 })
    ).toEqual({ planned: 4, completed: 2 });
  });

  it("gives the hosted test exit 10 for a finished partial", () => {
    const run = runStatus({ evaluation_status: "partial", outcome: "failed" });
    expect(hostedExitCode(run)).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(hostedExitCode(run, { planned: 2, completed: 2 })).toBe(EXIT.ASSESSMENT_FAILED);
  });
});
