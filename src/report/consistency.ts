import type { CriterionDetail, ExportDiagnostic, RunReport } from "./schema.js";

/**
 * aw-report-consistency/1
 *
 * Consumer-only check at the assembled hosted-report boundary. It does not
 * rewrite report or criterion evidence, and it does not read attempt
 * execution outcomes, cleanup state, or relay pass/fail as semantic grades.
 *
 * Required-judgment counters are compared only in the missing-evidence
 * direction: a known counter that exceeds the distinct required judgments
 * actually retrieved is a mismatch. A smaller counter than the retrieved
 * required set is not treated as hidden evidence. The legacy multi-page
 * export can retrieve an additional required-flagged detail beyond
 * `requiredJudgments*`; that remains a coherent pass.
 */
export const AW_REPORT_CONSISTENCY_CONTRACT = "aw-report-consistency/1" as const;

export const REPORT_EVIDENCE_CONTRADICTION = "REPORT_EVIDENCE_CONTRADICTION" as const;
export const REPORT_COVERAGE_MISMATCH = "REPORT_COVERAGE_MISMATCH" as const;

const COMPLETED_SEMANTIC_VERDICTS = new Set<CriterionDetail["verdict"]>(["pass", "fail"]);

export function reportConsistencyDiagnostics(input: {
  readonly report: RunReport;
  readonly criteria: readonly CriterionDetail[];
  /** True only after a bound evaluation's criterion reads finished. */
  readonly judgmentsComparable: boolean;
}): ExportDiagnostic[] {
  const diagnostics: ExportDiagnostic[] = [];
  if (coverageMismatches(input)) {
    diagnostics.push({
      code: REPORT_COVERAGE_MISMATCH,
      message: boundedMessage(
        `Retrieved attempts or required judgments do not match hosted coverage. This export cannot be used as a passing release check. Retry: augmentworks run report ${input.report.runId} --json. Do not start another billed assessment.`
      ),
      retryable: true
    });
  }
  if (claimedPassContradictsRequiredEvidence(input.report, input.criteria)) {
    diagnostics.push({
      code: REPORT_EVIDENCE_CONTRADICTION,
      message: boundedMessage(
        `Retrieved required judgment evidence contradicts the claimed pass. This export cannot be used as a passing release check. Retry: augmentworks run report ${input.report.runId} --json. Do not start another billed assessment.`
      ),
      retryable: true
    });
  }
  return diagnostics;
}

export function reportConsistencyRecoveryText(
  diagnostics: readonly { readonly code: string }[]
): string | undefined {
  const inconsistent = diagnostics.some(
    (item) =>
      item.code === REPORT_EVIDENCE_CONTRADICTION || item.code === REPORT_COVERAGE_MISMATCH
  );
  if (!inconsistent) return undefined;
  return "Retrieved evidence is internally inconsistent and cannot be used as a passing release check. Retry the same report read or contact support. Do not start another billed assessment.";
}

function coverageMismatches(input: {
  readonly report: RunReport;
  readonly criteria: readonly CriterionDetail[];
  readonly judgmentsComparable: boolean;
}): boolean {
  const attemptIds = new Set(input.report.attempts.map((attempt) => attempt.attemptId));
  const completedAttempts = knownCount(input.report.coverage.completedAttempts);
  if (completedAttempts !== undefined && completedAttempts !== attemptIds.size) return true;
  if (!input.judgmentsComparable) return false;
  const required = distinctRequired(input.criteria);
  const completedRequired = required.filter((item) =>
    COMPLETED_SEMANTIC_VERDICTS.has(item.verdict)
  ).length;
  const judgmentsPlanned = knownCount(input.report.coverage.requiredJudgmentsPlanned);
  const judgmentsComplete = knownCount(input.report.coverage.requiredJudgmentsComplete);
  if (judgmentsComplete !== undefined && judgmentsComplete > completedRequired) return true;
  if (
    judgmentsPlanned !== undefined &&
    judgmentsComplete !== undefined &&
    judgmentsPlanned === judgmentsComplete &&
    judgmentsPlanned > required.length
  ) {
    return true;
  }
  return false;
}

function claimedPassContradictsRequiredEvidence(
  report: RunReport,
  criteria: readonly CriterionDetail[]
): boolean {
  if (report.outcome !== "passed") return false;
  if (criteria.some((item) => item.required && item.verdict === "fail")) return true;
  const aggregateFailed = knownAggregateFailed(report.aggregate);
  return aggregateFailed !== undefined && aggregateFailed > 0;
}

function distinctRequired(criteria: readonly CriterionDetail[]): CriterionDetail[] {
  const seen = new Set<string>();
  const required: CriterionDetail[] = [];
  for (const item of criteria) {
    if (!item.required) continue;
    const key = `${item.attemptId}:${item.criterionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    required.push(item);
  }
  return required;
}

function knownCount(value: number | null): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000) {
    return undefined;
  }
  return value;
}

function knownAggregateFailed(aggregate: unknown): number | undefined {
  if (aggregate === null || typeof aggregate !== "object" || Array.isArray(aggregate)) {
    return undefined;
  }
  if (!Object.hasOwn(aggregate, "failed")) return undefined;
  const record = aggregate as Record<string, unknown>;
  const value = record["failed"];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function boundedMessage(message: string): string {
  return message.length <= 500 ? message : message.slice(0, 500);
}
