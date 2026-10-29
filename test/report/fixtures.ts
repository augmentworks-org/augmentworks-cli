import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesPath = resolve(fileURLToPath(new URL("../../contracts/aw-run-report-v1.fixtures.json", import.meta.url)));

export type ReportFixtureFile = {
  readonly identities: Record<string, Record<string, unknown>>;
  readonly fixtures: Record<
    string,
    { readonly status: number; readonly headers?: Record<string, string>; readonly response: unknown }
  >;
};

export const REPORT_FIXTURES = JSON.parse(readFileSync(fixturesPath, "utf8")) as ReportFixtureFile;
export const REPORT_RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const CANONICAL_ORIGIN = "https://augmentworks.ai";
export const FIXTURE_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

export function mutatedFixtureResponse(
  name: string,
  origin: string,
  mutate: (body: Record<string, unknown>) => void
): { status: number; headers?: Record<string, string>; body: unknown } {
  const fixture = fixtureResponse(name, origin);
  const body = cloneJson(asRecord(fixture.body));
  mutate(body);
  return { ...fixture, body };
}

export function rewriteOrigin(value: unknown, origin: string): unknown {
  if (typeof value === "string") return value.split(CANONICAL_ORIGIN).join(origin);
  if (Array.isArray(value)) return value.map((item) => rewriteOrigin(item, origin));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        rewriteOrigin(child, origin)
      ])
    );
  }
  return value;
}

export function fixtureResponse(name: string, origin: string): { status: number; headers?: Record<string, string>; body: unknown } {
  const entry = REPORT_FIXTURES.fixtures[name];
  if (entry === undefined) throw new Error(`missing fixture ${name}`);
  return {
    status: entry.status,
    ...(entry.headers === undefined ? {} : { headers: entry.headers }),
    body: rewriteOrigin(entry.response, origin)
  };
}

export function fixtureIdentity(name: string): Record<string, unknown> {
  const identity = REPORT_FIXTURES.identities[name];
  if (identity === undefined) throw new Error(`missing identity ${name}`);
  return identity;
}

export const TIMED_OUT_ATTEMPT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REPORT_FIXTURE_RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPORT_FIXTURE_EVALUATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The judge's inconclusive (uncertain) verdict on a timed-out attempt that never replied. */
export function timedOutCriterionIndex(origin: string): Record<string, unknown> {
  return mutatedFixtureResponse("criterion_index_r01_fail", origin, (body) => {
    body["attemptId"] = TIMED_OUT_ATTEMPT_ID;
    body["criteria"] = [
      {
        criterionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        criterionKey: "response-quality/0.1.0/R01/facts",
        required: true,
        verdict: "uncertain",
        detailUrl: null,
        evidence: { availability: "missing", text: null, sha256: null, truncated: false }
      }
    ];
  }).body as Record<string, unknown>;
}

/**
 * AUG-403 reproduction: `report_required_fail` plus a second attempt that
 * timed out. It got no reply and no judgment, so the report is not ready and
 * the evaluation either completed (fixed server) or stayed `partial` with no
 * judge job left (older server).
 */
export function timedOutAttemptReport(
  origin: string,
  evaluationStatus: "complete" | "partial",
  // The hosted server reports a timed-out send as completed and uncertain.
  shape: { executionStatus: string; outcome: string; runOutcome?: string; graded?: boolean } = {
    executionStatus: "failed",
    outcome: "error"
  }
): Record<string, unknown> {
  return mutatedFixtureResponse("report_required_fail", origin, (body) => {
    const attempts = body["attempts"] as Record<string, unknown>[];
    attempts.push({
      attemptId: TIMED_OUT_ATTEMPT_ID,
      scenarioId: "response-quality/0.1.0/R01",
      repetitionIndex: 1,
      attemptNumber: 1,
      executionStatus: shape.executionStatus,
      cleanupState: "not_required",
      // The hosted server grades a timed-out attempt, so it has criteria.
      criterionIndexUrl:
        shape.graded === true
          ? `${origin}/v1/runs/${REPORT_FIXTURE_RUN_ID}/evaluations/${REPORT_FIXTURE_EVALUATION_ID}/attempts/${TIMED_OUT_ATTEMPT_ID}/criteria`
          : null,
      mappedResponse: {
        availability: "missing",
        text: null,
        sha256: null,
        truncated: false,
        turnId: null,
        evidenceId: null
      },
      outcome: shape.outcome
    });
    body["evaluationStatus"] = evaluationStatus;
    if (shape.runOutcome !== undefined) body["outcome"] = shape.runOutcome;
    body["aggregate"] = { passed: 0, failed: 1, error: 1 };
    body["coverage"] = {
      plannedAttempts: 2,
      completedAttempts: 2,
      requiredJudgmentsPlanned: 2,
      // The hosted server counts the judge's verdict on a timed-out attempt
      // as a completed judgment, even when it is inconclusive.
      requiredJudgmentsComplete: shape.graded === true ? 2 : 1
    };
    body["reportReady"] = false;
    body["page"] = { nextCursor: null, hasMore: false, totalAttempts: 2 };
  }).body as Record<string, unknown>;
}
