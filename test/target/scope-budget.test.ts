import { describe, expect, it } from "vitest";

import { AwError } from "../../src/errors.js";
import { SCOPE_BUDGET_CEILINGS, sizeScopeBudget, suiteWorkload } from "../../src/target/scope-budget.js";

function suite(cases: string): string {
  return `schema_version: aw-suite/3\nsuite_id: sizing\ncases:\n${cases}`;
}

function singleTurnCases(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `  - case_id: c${index}\n    turns:\n      - content: Question ${index}?\n`
  ).join("");
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof AwError ? error.code : undefined;
  }
  return undefined;
}

describe("scope budget sizing (AUG-388)", () => {
  it("sizes a 20-case single-turn suite to exactly one run of it", () => {
    const workload = suiteWorkload(suite(singleTurnCases(20)));
    expect(workload).toMatchObject({ cases: 20, messages: 20, attempts: 20, commands: 40 });
    expect(sizeScopeBudget(workload)).toEqual({
      maxMessages: 20,
      maxActions: 0,
      maxCommands: 40,
      maxRuntimeSeconds: 600,
      maxCredits: 20
    });
  });

  it("counts every turn of every repetition", () => {
    const workload = suiteWorkload(
      suite(
        [
          "  - case_id: multi",
          "    repetitions: 3",
          "    turns:",
          "      - content: First?",
          "      - content: Then?",
          "  - case_id: single",
          "    turns:",
          "      - content: Once?",
          ""
        ].join("\n")
      )
    );
    expect(workload).toMatchObject({ messages: 7, attempts: 4, commands: 11 });
    expect(sizeScopeBudget(workload)).toMatchObject({ maxMessages: 7, maxCredits: 4, maxCommands: 11 });
  });

  it("refuses observe checks before a scope exists, since real-data runs check replies only", () => {
    const workload = suiteWorkload(
      suite("  - case_id: refund.state\n    turns:\n      - content: Refund?\n    observations:\n      - key: policy.window_days\n")
    );
    expect(workload.observedCaseIds).toEqual(["refund.state"]);
    expect(codeOf(() => sizeScopeBudget(workload))).toBe("ACTION_NOT_ALLOWED");
  });

  it("refuses a suite whose one run needs more messages than any scope allows", () => {
    const cases = Array.from(
      { length: 21 },
      (_, index) =>
        `  - case_id: c${index}\n    repetitions: 3\n    turns:\n      - content: A?\n`
    ).join("");
    const workload = suiteWorkload(suite(cases));
    expect(workload.messages).toBeGreaterThan(SCOPE_BUDGET_CEILINGS.maxMessages);
    expect(codeOf(() => sizeScopeBudget(workload))).toBe("EXECUTION_BUDGET_EXHAUSTED");
  });

  it("gives longer suites more time, within the ceiling", () => {
    const workload = suiteWorkload(
      suite(
        Array.from({ length: 20 }, (_, index) => `  - case_id: c${index}\n    repetitions: 3\n    turns:\n      - content: A?\n`).join("")
      )
    );
    expect(sizeScopeBudget(workload)).toMatchObject({ maxMessages: 60, maxRuntimeSeconds: 1800, maxCredits: 60 });
  });

  it("refuses a suite with no cases", () => {
    expect(codeOf(() => suiteWorkload("schema_version: aw-suite/3\nsuite_id: empty\n"))).toBe("SUITE_SCOPE_WRITE_FAILED");
  });
});
