import { sanitizeTerminal } from "../errors.js";
import type { NormalizedApplications } from "./applications.js";
import { classifyReleasePolicy, type ReleaseClassification } from "./classify.js";
import type { NormalizedReleasePolicy, PromoteBaselineResponse } from "./protocol.js";
import { RELEASE_POLICY_SCHEMA_VERSION } from "./schema.js";

export function releasePolicySuccessJson(
  document: NormalizedReleasePolicy,
  classification: ReleaseClassification,
  extras: {
    readonly command: "compare" | "gate";
    readonly portalUrl: string;
  }
): string {
  return `${JSON.stringify({
    ok: true,
    observation: classification.observation,
    assessment: classification.assessment,
    exit_code: classification.exitCode,
    schemaVersion: document.schemaVersion,
    packageVersion: document.packageVersion,
    policyVersion: document.policyVersion,
    existingFailurePolicy: document.existingFailurePolicy,
    createsBillableRun: document.createsBillableRun,
    command: extras.command,
    candidateRunId: document.candidateRunId,
    candidateEvaluationId: document.candidateEvaluationId ?? null,
    candidateEvaluationRevision: document.candidateEvaluationRevision ?? null,
    candidateSnapshotHash: document.candidateSnapshotHash ?? null,
    baselineId: document.baselineId,
    baselineRunId: document.baseline.runId ?? null,
    baselineEvaluationId: document.baseline.evaluationId ?? null,
    baselineEvaluationRevision: document.baseline.evaluationRevision ?? null,
    baselineSnapshotHash: document.baseline.snapshotHash ?? null,
    baselineSemanticRevisionHash: document.baseline.semanticRevisionHash ?? null,
    baselinePromotionRevision: document.baseline.promotionRevision ?? null,
    decision: document.decision,
    comparability: document.comparability,
    coverageChange: document.coverageChange,
    evaluationStatus: document.evaluationStatus,
    reasonCodes: classification.reasonCodes,
    reasons: document.reasons,
    groups: {
      new_required_regressions: document.groups.new_required_regressions.length,
      fixes: document.groups.fixes.length,
      persistent_failures: document.groups.persistent_failures.length,
      newly_verified: document.groups.newly_verified.length,
      coverage_changes: document.groups.coverage_changes.length,
      incompatible_scope: document.groups.incompatible_scope.length,
      unresolved: document.groups.unresolved.length
    },
    limitations: document.limitations,
    aggregateNote: document.aggregateNote ?? null,
    portalUrl: extras.portalUrl
  })}\n`;
}

export function formatReleasePolicyHuman(
  document: NormalizedReleasePolicy,
  classification: ReleaseClassification,
  extras: {
    readonly command: "compare" | "gate";
    readonly portalUrl: string;
  }
): string {
  const lines: string[] = [];
  lines.push(`Command: ${extras.command}`);
  lines.push(`Decision: ${sanitizeTerminal(document.decision)} (${classification.assessment})`);
  lines.push(`Policy: ${sanitizeTerminal(document.policyVersion)}`);
  lines.push(`Comparability: ${sanitizeTerminal(document.comparability)}`);
  lines.push(`Evaluation: ${sanitizeTerminal(document.evaluationStatus)}`);
  lines.push(`Candidate run: ${sanitizeTerminal(document.candidateRunId)}`);
  if (document.candidateEvaluationRevision !== undefined) {
    lines.push(`Candidate evaluation revision: ${String(document.candidateEvaluationRevision)}`);
  }
  if (document.candidateSnapshotHash !== undefined) {
    lines.push(`Candidate snapshot: ${sanitizeTerminal(document.candidateSnapshotHash)}`);
  }
  lines.push(`Baseline: ${sanitizeTerminal(document.baselineId)}`);
  if (document.baseline.evaluationRevision !== undefined) {
    lines.push(`Baseline evaluation revision: ${String(document.baseline.evaluationRevision)}`);
  }
  if (document.baseline.snapshotHash !== undefined) {
    lines.push(`Baseline snapshot: ${sanitizeTerminal(document.baseline.snapshotHash)}`);
  }
  if (document.baseline.promotionRevision !== undefined) {
    lines.push(`Baseline promotion revision: ${String(document.baseline.promotionRevision)}`);
  }
  lines.push(
    `Required regressions: ${String(document.groups.new_required_regressions.length)}  fixes: ${String(document.groups.fixes.length)}  unresolved: ${String(document.groups.unresolved.length)}`
  );
  if (document.aggregateNote !== undefined) {
    lines.push(sanitizeTerminal(document.aggregateNote));
  }
  if (classification.reasonCodes.length > 0) {
    lines.push(`Reason codes: ${classification.reasonCodes.map((code) => sanitizeTerminal(code)).join(", ")}`);
  }
  for (const reason of document.reasons) {
    lines.push(`- ${sanitizeTerminal(reason)}`);
  }
  lines.push(`Creates billable run: ${document.createsBillableRun ? "yes" : "no"}`);
  lines.push(`This command does not start a test, reserve credits, or call the target.`);
  lines.push(`Portal: ${sanitizeTerminal(extras.portalUrl)}`);
  if (classification.exitCode !== 0) {
    lines.push(
      `This snapshot is a successful comparison query, not a passing release. Exit ${String(classification.exitCode)}.`
    );
    lines.push(
      `Re-query the original run: augmentworks run wait ${sanitizeTerminal(document.candidateRunId)}`
    );
    lines.push(
      `Then: augmentworks gate --run ${sanitizeTerminal(document.candidateRunId)} --baseline ${sanitizeTerminal(document.baselineId)}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function promotionSuccessJson(
  result: PromoteBaselineResponse,
  assessment: "promoted" | "created" = "promoted"
): string {
  return `${JSON.stringify({
    ok: true,
    observation: "succeeded",
    assessment,
    exit_code: 0,
    schemaVersion: result.schemaVersion ?? RELEASE_POLICY_SCHEMA_VERSION,
    createsBillableRun: result.createsBillableRun ?? false,
    baselineId: result.baselineId ?? null,
    promotionRevision: result.promotionRevision ?? null,
    runId: result.runId ?? result.candidateRunId ?? null,
    evaluationId: result.evaluationId ?? null,
    evaluationRevision: result.evaluationRevision ?? null,
    snapshotHash: result.snapshotHash ?? null
  })}\n`;
}

export function formatPromotionHuman(result: PromoteBaselineResponse): string {
  const baseline = result.baselineId === undefined ? "baseline" : sanitizeTerminal(result.baselineId);
  const revision =
    result.promotionRevision === undefined ? "" : ` (promotion revision ${String(result.promotionRevision)})`;
  return `Promoted ${baseline}${revision}. This did not start a test or consume credits.\n`;
}

export function formatCreatedHuman(result: PromoteBaselineResponse): string {
  const baseline = result.baselineId === undefined ? "a baseline" : sanitizeTerminal(result.baselineId);
  const lines = [`Created baseline ${baseline}. This did not start a test or consume credits.`];
  if (result.baselineId !== undefined && result.promotionRevision !== undefined) {
    lines.push(
      `Gate later runs with: augmentworks gate --run <run-id> --baseline ${baseline}`,
      `Promote a newer run with: augmentworks baseline promote --run <run-id> --baseline ${baseline} --expected-revision ${String(result.promotionRevision)}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function portalCompareUrl(apiOrigin: URL, runId: string, baselineId: string): string {
  const url = new URL("/portal/compare", apiOrigin);
  url.searchParams.set("runId", runId);
  url.searchParams.set("baselineId", baselineId);
  return url.toString();
}

export function portalBaselinesUrl(apiOrigin: URL): string {
  return new URL("/portal/baselines", apiOrigin).toString();
}

export function releasePolicyStderrHint(
  document: NormalizedReleasePolicy,
  classification: ReleaseClassification
): string {
  if (classification.exitCode === 0) return "";
  const runId = sanitizeTerminal(document.candidateRunId);
  const baselineId = sanitizeTerminal(document.baselineId);
  return [
    `This snapshot is a successful comparison query, not a passing release. Exit ${String(classification.exitCode)}.`,
    `Re-query the original run: augmentworks run wait ${runId}`,
    `Then: augmentworks gate --run ${runId} --baseline ${baselineId}`,
    "Do not start another billed assessment, substitute a newer run, or auto-promote a baseline."
  ].join("\n") + "\n";
}

export function applicationsSuccessJson(
  document: NormalizedApplications,
  portalUrl: string
): string {
  return `${JSON.stringify({
    ok: true,
    observation: "succeeded",
    assessment: "listed",
    exit_code: 0,
    schemaVersion: document.schemaVersion ?? RELEASE_POLICY_SCHEMA_VERSION,
    createsBillableRun: document.createsBillableRun,
    command: "baseline.status",
    applicationCount: document.applications.length,
    baselineCount: document.baselines.length,
    applications: document.applications,
    baselines: document.baselines,
    portalUrl
  })}\n`;
}

export function formatApplicationsHuman(document: NormalizedApplications, portalUrl: string): string {
  const lines = [
    "Command: baseline status",
    `Applications: ${String(document.applications.length)}`,
    `Listed baselines: ${String(document.baselines.length)}`,
    "Creates billable run: no",
    "This command does not start a test, reserve credits, or call the target.",
    "It does not select or promote a pin.",
    `Portal: ${sanitizeTerminal(portalUrl)}`
  ];
  return `${lines.join("\n")}\n`;
}

export function observationFailureJson(error: {
  readonly code: string;
  readonly toSafeJSON: () => Record<string, unknown>;
}, exitCode: number): string {
  return `${JSON.stringify({
    ok: false,
    ...error.toSafeJSON(),
    exit_code: exitCode
  })}\n`;
}

export function classifyOrThrow(document: NormalizedReleasePolicy): ReleaseClassification {
  return classifyReleasePolicy(document);
}
