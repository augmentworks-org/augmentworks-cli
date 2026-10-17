import { parse } from "yaml";

import { AwError } from "../errors.js";
import type { ScopeBudget } from "./protocol.js";

/** The server's per-run ceilings for a real-data scope (REAL_DATA_LIMITS and PER_RUN_LIMITS). */
export const SCOPE_BUDGET_CEILINGS = {
  maxMessages: 60,
  maxCommands: 512,
  maxRuntimeSeconds: 3_600,
  maxCredits: 10_000
} as const;

const MIN_RUNTIME_SECONDS = 600;
const RUNTIME_SECONDS_PER_MESSAGE = 30;

export interface SuiteWorkload {
  readonly cases: number;
  /** One per turn of each repetition: what the run sends to the agent. */
  readonly messages: number;
  /** One per repetition: what the quote charges a credit for. */
  readonly attempts: number;
  /** Turns plus one possible observe per attempt, as the server's plan estimates commands. */
  readonly commands: number;
  readonly observedCaseIds: readonly string[];
}

/**
 * Counts what one run of the suite needs. It reads only the counts; `test`
 * still validates the whole file before anything is sent.
 */
export function suiteWorkload(source: string): SuiteWorkload {
  let document: unknown;
  try {
    document = parse(source);
  } catch {
    throw budgetError("SUITE_SCOPE_WRITE_FAILED", "The suite file isn't YAML the CLI can read.");
  }
  const cases = isRecord(document) && Array.isArray(document["cases"]) ? document["cases"] : [];
  if (cases.length === 0) {
    throw budgetError("SUITE_SCOPE_WRITE_FAILED", "The suite file has no cases, so there's nothing to size a test scope for.");
  }
  let messages = 0;
  let attempts = 0;
  let commands = 0;
  const observedCaseIds: string[] = [];
  for (const [index, entry] of cases.entries()) {
    const suiteCase = isRecord(entry) ? entry : {};
    const turns = Array.isArray(suiteCase["turns"]) ? Math.max(1, suiteCase["turns"].length) : 1;
    const repetitions = positiveInteger(suiteCase["repetitions"]) ?? 1;
    messages += turns * repetitions;
    attempts += repetitions;
    commands += (turns + 1) * repetitions;
    if (Array.isArray(suiteCase["observations"]) && suiteCase["observations"].length > 0) {
      const caseId = suiteCase["case_id"] ?? suiteCase["caseId"];
      observedCaseIds.push(typeof caseId === "string" ? caseId : `case ${index + 1}`);
    }
  }
  return { cases: cases.length, messages, attempts, commands, observedCaseIds };
}

/**
 * The budget `scope create` proposes: exactly what one run of the suite
 * needs, within the server's ceilings. Real-data scopes check replies only,
 * so a suite that observes application state is refused here, before a
 * scope exists, rather than partway through its first run.
 */
export function sizeScopeBudget(workload: SuiteWorkload): ScopeBudget {
  if (workload.observedCaseIds.length > 0) {
    throw budgetError(
      "ACTION_NOT_ALLOWED",
      `Real-data runs check replies only, and ${workload.observedCaseIds.length === 1 ? "this case declares" : "these cases declare"} observations: ${workload.observedCaseIds.join(", ")}. Remove the observations and their deterministic criteria, then run this again.`
    );
  }
  if (workload.messages > SCOPE_BUDGET_CEILINGS.maxMessages) {
    throw budgetError(
      "EXECUTION_BUDGET_EXHAUSTED",
      `One run of this suite sends ${workload.messages} messages, and a test scope allows at most ${SCOPE_BUDGET_CEILINGS.maxMessages}. Split it into smaller suites, or use fewer turns or repetitions.`
    );
  }
  return {
    maxMessages: workload.messages,
    maxActions: 0,
    maxCommands: Math.min(workload.commands, SCOPE_BUDGET_CEILINGS.maxCommands),
    maxRuntimeSeconds: Math.min(
      SCOPE_BUDGET_CEILINGS.maxRuntimeSeconds,
      Math.max(MIN_RUNTIME_SECONDS, workload.messages * RUNTIME_SECONDS_PER_MESSAGE)
    ),
    maxCredits: Math.min(workload.attempts, SCOPE_BUDGET_CEILINGS.maxCredits)
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function budgetError(code: string, message: string): AwError {
  return new AwError({ code, category: "config", message });
}
