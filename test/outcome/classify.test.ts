import { describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { hostedExitCode } from "../../src/commands/test.js";
import {
  classifyHostedOutcome,
  coverageKnowledge,
  gradingStillPending
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

  it("keeps a required failure at exit 10 when the evaluator also errored", () => {
    for (const executionStatus of ["completed", "failed", "cancelled", "exploded"]) {
      const classified = classifyHostedOutcome({
        executionStatus,
        evaluationStatus: "error",
        outcome: "failed",
        coverageKnown: false
      });
      expect(classified.assessment, executionStatus).toBe("failed");
      expect(classified.exitCode, executionStatus).toBe(EXIT.ASSESSMENT_FAILED);
      expect(classified.waitTerminal, executionStatus).toBe(true);
    }
    for (const outcome of [null, "passed", "inconclusive", "error", "mystery"]) {
      const classified = classifyHostedOutcome({
        executionStatus: "completed",
        evaluationStatus: "error",
        outcome
      });
      expect(classified.assessment, String(outcome)).toBe("evaluator_error");
      expect(classified.exitCode, String(outcome)).toBe(EXIT.EVALUATION_ERROR);
    }
    const stillRunning = classifyHostedOutcome({
      executionStatus: "running",
      evaluationStatus: "error",
      outcome: "failed"
    });
    expect(stillRunning.assessment).toBe("incomplete");
    expect(stillRunning.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(stillRunning.waitTerminal).toBe(false);
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
        name: "completed error with a required failure",
        input: { executionStatus: "completed", evaluationStatus: "error", outcome: "failed" },
        exitCode: EXIT.ASSESSMENT_FAILED,
        assessment: "failed"
      },
      {
        name: "completed error with an inconclusive outcome",
        input: { executionStatus: "completed", evaluationStatus: "error", outcome: "inconclusive" },
        exitCode: EXIT.EVALUATION_ERROR,
        assessment: "evaluator_error"
      },
      {
        name: "completed error with an error outcome",
        input: { executionStatus: "completed", evaluationStatus: "error", outcome: "error" },
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
        name: "cancelled evaluator error with a required failure",
        input: { executionStatus: "cancelled", evaluationStatus: "error", outcome: "failed" },
        exitCode: EXIT.ASSESSMENT_FAILED,
        assessment: "failed"
      },
      {
        name: "failed execution plus evaluator error without a required failure",
        input: { executionStatus: "failed", evaluationStatus: "error", outcome: null },
        exitCode: EXIT.EVALUATION_ERROR,
        assessment: "evaluator_error"
      },
      {
        name: "failed execution plus evaluator error with a required failure",
        input: { executionStatus: "failed", evaluationStatus: "error", outcome: "failed" },
        exitCode: EXIT.ASSESSMENT_FAILED,
        assessment: "failed"
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

describe("partial grading is still grading (AUG-434)", () => {
  it("keeps waiting on partial whatever the outcome, without a pass or a failure", () => {
    for (const outcome of ["passed", "failed", "inconclusive", "error", null]) {
      const classified = classifyHostedOutcome({
        executionStatus: "completed",
        evaluationStatus: "partial",
        outcome,
        coverageKnown: true
      });
      expect(classified.waitTerminal, String(outcome)).toBe(false);
      expect(classified.assessment, String(outcome)).toBe("incomplete");
      expect(classified.exitCode, String(outcome)).toBe(EXIT.EVALUATION_INCOMPLETE);
    }
  });

  it("exits 10 once the server reports a finished inconclusive evaluation as complete (AUG-403)", () => {
    for (const outcome of ["inconclusive", "failed"]) {
      const classified = classifyHostedOutcome({
        executionStatus: "completed",
        evaluationStatus: "complete",
        outcome,
        coverageKnown: true
      });
      expect(classified.waitTerminal).toBe(true);
      expect(classified.assessment).toBe("failed");
      expect(classified.exitCode).toBe(EXIT.ASSESSMENT_FAILED);
    }
  });

  it("treats only pending and partial as grading still to come", () => {
    expect(gradingStillPending("pending")).toBe(true);
    expect(gradingStillPending("partial")).toBe(true);
    for (const status of ["complete", "error", "absent", "unsupported", null, undefined]) {
      expect(gradingStillPending(status)).toBe(false);
    }
  });

  it("gives the hosted test exit 11 on partial and 0 once the pass is complete", () => {
    expect(hostedExitCode(runStatus({ evaluation_status: "partial", outcome: "passed" }))).toBe(
      EXIT.EVALUATION_INCOMPLETE
    );
    expect(hostedExitCode(runStatus({ evaluation_status: "partial", outcome: "failed" }))).toBe(
      EXIT.EVALUATION_INCOMPLETE
    );
    expect(hostedExitCode(runStatus({ evaluation_status: "complete", outcome: "passed" }))).toBe(EXIT.OK);
  });
});
