import { z } from "zod";

import { AwError } from "../errors.js";
import {
  COMPARABILITY_STATES,
  COMPARISON_CHANGE_GROUPS,
  COMPARISON_SCHEMA_VERSION,
  COVERAGE_CHANGES,
  EVALUATION_STATUSES,
  EXISTING_FAILURE_POLICIES,
  FEATURE_PACKAGE_VERSION,
  IDENTIFIER_PATTERN,
  RELEASE_DECISIONS,
  RELEASE_POLICY_SCHEMA_VERSION,
  SHA256_HEX_PATTERN,
  type ComparabilityState,
  type ComparisonChangeGroup,
  type CoverageChange,
  type ExistingFailurePolicy,
  type PolicyEvaluationStatus,
  type ReleaseDecision
} from "./schema.js";

const identifier = z.string().min(1).max(300).regex(IDENTIFIER_PATTERN);
const sha256Hex = z.string().regex(SHA256_HEX_PATTERN);
const revision = z.number().int().min(0).max(1_000_000);

export const EvaluateReleaseRequestSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_POLICY_SCHEMA_VERSION),
    packageVersion: z.literal(FEATURE_PACKAGE_VERSION),
    candidateRunId: identifier,
    baselineId: identifier
  })
  .strict();

export type EvaluateReleaseRequest = z.infer<typeof EvaluateReleaseRequestSchema>;

export const EvaluateComparisonRequestSchema = z
  .object({
    schemaVersion: z.literal(COMPARISON_SCHEMA_VERSION),
    packageVersion: z.literal(FEATURE_PACKAGE_VERSION),
    candidateRunId: identifier,
    baselineId: identifier
  })
  .strict();

export type EvaluateComparisonRequest = z.infer<typeof EvaluateComparisonRequestSchema>;

// The server's promote route reads `runId` and a revision of 1 or more
// (main `src/lib/baselines/http.ts`, `parsePromoteBody`).
export const PromoteBaselineRequestSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_POLICY_SCHEMA_VERSION),
    packageVersion: z.literal(FEATURE_PACKAGE_VERSION),
    runId: identifier,
    expectedPromotionRevision: revision.min(1)
  })
  .strict();

export type PromoteBaselineRequest = z.infer<typeof PromoteBaselineRequestSchema>;

// Mirrors main `src/lib/baselines/http.ts` `parseCreateBody`.
export const CreateBaselineRequestSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_POLICY_SCHEMA_VERSION),
    packageVersion: z.literal(FEATURE_PACKAGE_VERSION),
    name: z.string().trim().min(1).max(200),
    applicationName: z.string().trim().min(1).max(200),
    environmentName: z.string().trim().min(1).max(80),
    runId: identifier
  })
  .strict();

export type CreateBaselineRequest = z.infer<typeof CreateBaselineRequestSchema>;

const buildSchema = z
  .object({
    label: z.string().min(1).max(200).optional(),
    gitCommit: z.string().min(1).max(64).optional(),
    createdAt: z.string().min(1).max(64).optional()
  })
  .passthrough();

const selectedBaselineSchema = z
  .object({
    baselineId: identifier.optional(),
    name: z.string().min(1).max(200).optional(),
    applicationId: identifier.optional(),
    applicationName: z.string().min(1).max(200).optional(),
    environmentId: identifier.optional(),
    environmentName: z.string().min(1).max(200).optional(),
    suiteId: z.string().min(1).max(300).optional(),
    suiteRevisionId: identifier.optional(),
    runId: identifier.optional(),
    evaluationId: identifier.optional(),
    evaluationRevision: revision.optional(),
    snapshotHash: sha256Hex.optional(),
    semanticRevisionHash: sha256Hex.optional(),
    promotionRevision: revision.optional(),
    promotedByPrincipalKind: z.string().min(1).max(40).optional(),
    build: buildSchema.optional()
  })
  .passthrough();

const comparisonRowSchema = z
  .object({
    caseId: z.string().min(1).max(300).optional(),
    criterionId: z.string().min(1).max(300).optional(),
    repetitionIndex: z.number().int().min(0).max(20).optional(),
    requirement: z.string().min(1).max(40).optional(),
    category: z.string().min(1).max(80).nullable().optional(),
    change: z.string().min(1).max(80).optional(),
    baselineOutcome: z.string().min(1).max(40).nullable().optional(),
    candidateOutcome: z.string().min(1).max(40).nullable().optional(),
    group: z.string().min(1).max(80).optional(),
    unresolved: z.boolean().optional()
  })
  .passthrough();

const groupsSchema = z
  .object({
    new_required_regressions: z.array(comparisonRowSchema).max(200).optional(),
    fixes: z.array(comparisonRowSchema).max(200).optional(),
    persistent_failures: z.array(comparisonRowSchema).max(200).optional(),
    newly_verified: z.array(comparisonRowSchema).max(200).optional(),
    coverage_changes: z.array(comparisonRowSchema).max(200).optional(),
    incompatible_scope: z.array(comparisonRowSchema).max(200).optional(),
    unresolved: z.array(comparisonRowSchema).max(200).optional()
  })
  .passthrough();

const gateSchema = z
  .object({
    decision: z.string().min(1).max(40).optional(),
    headline: z.string().min(1).max(300).optional(),
    summary: z.string().min(1).max(800).optional(),
    reasons: z.array(z.string().min(1).max(500)).max(32).optional(),
    reasonCodes: z.array(z.string().min(1).max(80)).max(32).optional(),
    comparability: z.string().min(1).max(40).optional(),
    coverageChange: z.string().min(1).max(40).optional(),
    evaluationStatus: z.string().min(1).max(40).optional()
  })
  .passthrough();

export const ReleasePolicyDocumentSchema = z
  .object({
    schemaVersion: z.string().min(1).max(80).optional(),
    packageVersion: z.string().min(1).max(80).optional(),
    documentKind: z.string().min(1).max(80).optional(),
    policyVersion: z.string().min(1).max(80).optional(),
    existingFailurePolicy: z.string().min(1).max(80).optional(),
    createsBillableRun: z.boolean().optional(),
    workspaceId: identifier.optional(),
    candidateRunId: identifier.optional(),
    candidateEvaluationId: identifier.optional(),
    candidateEvaluationRevision: revision.optional(),
    candidateSnapshotHash: sha256Hex.optional(),
    candidateBuild: buildSchema.optional(),
    selectedBaselineId: identifier.optional(),
    baselineId: identifier.optional(),
    selectedBaseline: selectedBaselineSchema.optional(),
    decision: z.string().min(1).max(40).optional(),
    comparability: z.string().min(1).max(40).optional(),
    coverageChange: z.string().min(1).max(40).optional(),
    evaluationStatus: z.string().min(1).max(40).optional(),
    reasons: z.array(z.string().min(1).max(500)).max(32).optional(),
    reasonCodes: z.array(z.string().min(1).max(80)).max(32).optional(),
    gate: gateSchema.optional(),
    groups: groupsSchema.optional(),
    rows: z.array(comparisonRowSchema).max(400).optional(),
    limitations: z.array(z.string().min(1).max(500)).max(16).optional(),
    aggregateNote: z.string().min(1).max(800).optional(),
    portalUrl: z.string().min(1).max(2_048).optional(),
    promotion: z.unknown().optional()
  })
  .passthrough();

export type ReleasePolicyDocument = z.infer<typeof ReleasePolicyDocumentSchema>;

export const PromoteBaselineResponseSchema = z
  .object({
    schemaVersion: z.string().min(1).max(80).optional(),
    packageVersion: z.string().min(1).max(80).optional(),
    createsBillableRun: z.boolean().optional(),
    baselineId: identifier.optional(),
    promotionRevision: revision.optional(),
    runId: identifier.optional(),
    candidateRunId: identifier.optional(),
    evaluationId: identifier.optional(),
    evaluationRevision: revision.optional(),
    snapshotHash: sha256Hex.optional(),
    semanticRevisionHash: sha256Hex.optional()
  })
  .passthrough();

export type PromoteBaselineResponse = z.infer<typeof PromoteBaselineResponseSchema>;

export const ApplicationsResponseSchema = z
  .object({
    schemaVersion: z.string().min(1).max(80).optional(),
    createsBillableRun: z.boolean().optional(),
    applications: z.array(z.unknown()).max(200).optional(),
    baselines: z.array(z.unknown()).max(200).optional()
  })
  .passthrough();

export type ApplicationsResponse = z.infer<typeof ApplicationsResponseSchema>;

export interface NormalizedBaselinePin {
  readonly baselineId: string;
  readonly runId: string | undefined;
  readonly evaluationId: string | undefined;
  readonly evaluationRevision: number | undefined;
  readonly snapshotHash: string | undefined;
  readonly semanticRevisionHash: string | undefined;
  readonly promotionRevision: number | undefined;
  readonly name: string | undefined;
  readonly applicationName: string | undefined;
  readonly environmentName: string | undefined;
  readonly suiteId: string | undefined;
  readonly suiteRevisionId: string | undefined;
}

export interface NormalizedReleasePolicy {
  readonly schemaVersion: string;
  readonly packageVersion: string;
  readonly policyVersion: string;
  readonly existingFailurePolicy: ExistingFailurePolicy | string;
  readonly createsBillableRun: boolean;
  readonly workspaceId: string | undefined;
  readonly candidateRunId: string;
  readonly candidateEvaluationId: string | undefined;
  readonly candidateEvaluationRevision: number | undefined;
  readonly candidateSnapshotHash: string | undefined;
  readonly baselineId: string;
  readonly baseline: NormalizedBaselinePin;
  readonly decision: ReleaseDecision | string;
  readonly comparability: ComparabilityState | string;
  readonly coverageChange: CoverageChange | string;
  readonly evaluationStatus: PolicyEvaluationStatus | string;
  readonly reasons: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly groups: Readonly<Record<ComparisonChangeGroup, readonly unknown[]>>;
  readonly limitations: readonly string[];
  readonly aggregateNote: string | undefined;
  readonly portalUrl: string | undefined;
  readonly raw: ReleasePolicyDocument;
}

export function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function numberField(record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function booleanField(record: Record<string, unknown> | undefined, ...keys: string[]): boolean | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function stringArray(record: Record<string, unknown> | undefined, ...keys: string[]): string[] {
  if (record === undefined) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      return value.filter((entry) => entry.trim() !== "");
    }
  }
  return [];
}

export function normalizeReleasePolicyDocument(
  value: unknown,
  expected: { readonly candidateRunId: string; readonly baselineId: string }
): NormalizedReleasePolicy {
  const parsed = ReleasePolicyDocumentSchema.safeParse(normalizePolicyIdentity(value));
  if (!parsed.success) {
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "AugmentWorks returned an invalid release-policy document."
    });
  }
  const record = parsed.data as Record<string, unknown>;
  const gate = normalizeRecord(record["gate"]);
  const selected = normalizeRecord(record["selectedBaseline"]);
  const candidateRunId =
    stringField(record, "candidateRunId", "candidate_run_id") ?? expected.candidateRunId;
  const baselineId =
    stringField(record, "selectedBaselineId", "baselineId", "baseline_id") ??
    stringField(selected, "baselineId", "baseline_id") ??
    expected.baselineId;
  if (candidateRunId !== expected.candidateRunId) {
    throw new AwError({
      code: "RELEASE_IDENTITY_MISMATCH",
      category: "protocol",
      message: "AugmentWorks returned a comparison for a different candidate run."
    });
  }
  if (baselineId !== expected.baselineId) {
    throw new AwError({
      code: "RELEASE_IDENTITY_MISMATCH",
      category: "protocol",
      message: "AugmentWorks returned a comparison for a different baseline pin."
    });
  }
  const decision =
    stringField(record, "decision") ?? stringField(gate, "decision") ?? "unknown";
  const comparability =
    stringField(record, "comparability") ?? stringField(gate, "comparability") ?? "unknown";
  const coverageChange =
    stringField(record, "coverageChange", "coverage_change") ??
    stringField(gate, "coverageChange", "coverage_change") ??
    "unknown";
  const evaluationStatus =
    stringField(record, "evaluationStatus", "evaluation_status") ??
    stringField(gate, "evaluationStatus", "evaluation_status") ??
    "unknown";
  const groupsRecord = normalizeRecord(record["groups"]) ?? {};
  const groups = Object.fromEntries(
    COMPARISON_CHANGE_GROUPS.map((group) => {
      const rows = groupsRecord[group];
      return [group, Array.isArray(rows) ? rows : []];
    })
  ) as unknown as Record<ComparisonChangeGroup, readonly unknown[]>;
  const createsBillableRun = booleanField(record, "createsBillableRun", "creates_billable_run") ?? false;
  return {
    schemaVersion:
      stringField(record, "schemaVersion", "schema_version") ?? RELEASE_POLICY_SCHEMA_VERSION,
    packageVersion:
      stringField(record, "packageVersion", "package_version") ?? FEATURE_PACKAGE_VERSION,
    policyVersion:
      stringField(record, "policyVersion", "policy_version") ?? RELEASE_POLICY_SCHEMA_VERSION,
    existingFailurePolicy:
      stringField(record, "existingFailurePolicy", "existing_failure_policy") ??
      EXISTING_FAILURE_POLICIES[0],
    createsBillableRun,
    workspaceId: stringField(record, "workspaceId", "workspace_id"),
    candidateRunId,
    candidateEvaluationId: stringField(
      record,
      "candidateEvaluationId",
      "candidate_evaluation_id"
    ),
    candidateEvaluationRevision: numberField(
      record,
      "candidateEvaluationRevision",
      "candidate_evaluation_revision"
    ),
    candidateSnapshotHash: stringField(
      record,
      "candidateSnapshotHash",
      "candidate_snapshot_hash"
    ),
    baselineId,
    baseline: {
      baselineId,
      runId: stringField(selected, "runId", "run_id"),
      evaluationId: stringField(selected, "evaluationId", "evaluation_id"),
      evaluationRevision: numberField(selected, "evaluationRevision", "evaluation_revision"),
      snapshotHash: stringField(selected, "snapshotHash", "snapshot_hash"),
      semanticRevisionHash: stringField(
        selected,
        "semanticRevisionHash",
        "semantic_revision_hash"
      ),
      promotionRevision: numberField(selected, "promotionRevision", "promotion_revision"),
      name: stringField(selected, "name"),
      applicationName: stringField(selected, "applicationName", "application_name"),
      environmentName: stringField(selected, "environmentName", "environment_name"),
      suiteId: stringField(selected, "suiteId", "suite_id"),
      suiteRevisionId: stringField(selected, "suiteRevisionId", "suite_revision_id")
    },
    decision,
    comparability,
    coverageChange,
    evaluationStatus,
    reasons: uniqueStrings([
      ...stringArray(record, "reasons"),
      ...stringArray(gate, "reasons")
    ]),
    reasonCodes: uniqueStrings([
      ...stringArray(record, "reasonCodes", "reason_codes"),
      ...stringArray(gate, "reasonCodes", "reason_codes")
    ]),
    groups,
    limitations: stringArray(record, "limitations"),
    aggregateNote: stringField(record, "aggregateNote", "aggregate_note"),
    portalUrl: stringField(record, "portalUrl", "portal_url"),
    raw: parsed.data
  };
}

export function normalizePolicyIdentity(value: unknown): unknown {
  const record = normalizeRecord(value);
  if (record === undefined) return value;
  const selected = normalizeRecord(record["selectedBaseline"] ?? record["selected_baseline"]);
  return {
    ...record,
    schemaVersion: record["schemaVersion"] ?? record["schema_version"],
    packageVersion: record["packageVersion"] ?? record["package_version"],
    policyVersion: record["policyVersion"] ?? record["policy_version"],
    existingFailurePolicy: record["existingFailurePolicy"] ?? record["existing_failure_policy"],
    createsBillableRun: record["createsBillableRun"] ?? record["creates_billable_run"],
    workspaceId: record["workspaceId"] ?? record["workspace_id"],
    candidateRunId: record["candidateRunId"] ?? record["candidate_run_id"],
    candidateEvaluationId: record["candidateEvaluationId"] ?? record["candidate_evaluation_id"],
    candidateEvaluationRevision:
      record["candidateEvaluationRevision"] ?? record["candidate_evaluation_revision"],
    candidateSnapshotHash: record["candidateSnapshotHash"] ?? record["candidate_snapshot_hash"],
    selectedBaselineId:
      record["selectedBaselineId"] ??
      record["selected_baseline_id"] ??
      record["baselineId"] ??
      record["baseline_id"],
    coverageChange: record["coverageChange"] ?? record["coverage_change"],
    evaluationStatus: record["evaluationStatus"] ?? record["evaluation_status"],
    reasonCodes: record["reasonCodes"] ?? record["reason_codes"],
    selectedBaseline: selected === undefined ? record["selectedBaseline"] : selected,
    portalUrl: record["portalUrl"] ?? record["portal_url"]
  };
}

export function normalizePromoteResponse(value: unknown): PromoteBaselineResponse {
  const envelope = normalizeRecord(value) ?? {};
  // Create and promote answer `{ ok, record, createsBillableRun }`, where
  // `record` is the saved baseline (main `src/lib/baselines/service.ts`).
  const saved = normalizeRecord(envelope["record"]);
  const record =
    saved === undefined
      ? envelope
      : {
          ...saved,
          createsBillableRun: envelope["createsBillableRun"] ?? envelope["creates_billable_run"]
        };
  const normalized = {
    ...record,
    schemaVersion: record["schemaVersion"] ?? record["schema_version"],
    packageVersion: record["packageVersion"] ?? record["package_version"],
    createsBillableRun: record["createsBillableRun"] ?? record["creates_billable_run"],
    baselineId: record["baselineId"] ?? record["baseline_id"],
    promotionRevision: record["promotionRevision"] ?? record["promotion_revision"],
    runId: record["runId"] ?? record["run_id"] ?? record["candidateRunId"] ?? record["candidate_run_id"],
    candidateRunId: record["candidateRunId"] ?? record["candidate_run_id"],
    evaluationId: record["evaluationId"] ?? record["evaluation_id"],
    evaluationRevision: record["evaluationRevision"] ?? record["evaluation_revision"],
    snapshotHash: record["snapshotHash"] ?? record["snapshot_hash"],
    semanticRevisionHash: record["semanticRevisionHash"] ?? record["semantic_revision_hash"]
  };
  const parsed = PromoteBaselineResponseSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "AugmentWorks returned an invalid baseline promotion result."
    });
  }
  return parsed.data;
}

export function isReleaseDecision(value: string): value is ReleaseDecision {
  return (RELEASE_DECISIONS as readonly string[]).includes(value);
}

export function isComparabilityState(value: string): value is ComparabilityState {
  return (COMPARABILITY_STATES as readonly string[]).includes(value);
}

export function isCoverageChange(value: string): value is CoverageChange {
  return (COVERAGE_CHANGES as readonly string[]).includes(value);
}

export function isPolicyEvaluationStatus(value: string): value is PolicyEvaluationStatus {
  return (EVALUATION_STATUSES as readonly string[]).includes(value);
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
