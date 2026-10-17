import { z } from "zod";

export const RUN_REPORT_SCHEMA_VERSION = "aw-run-report/1" as const;
export const RUN_REPORT_EXPORT_SCHEMA_VERSION = "aw-run-report-export/1" as const;
export const RUN_REPORT_LIVE_SCOPE_SCHEMA_VERSION = "aw-run-report-live-scope/1" as const;
export const LIVE_INFORMATIONAL_REPORT_SCOPE = "live-informational" as const;
export const AUTHORIZED_REPORT_SCOPE = "authorized-1" as const;
export const RUN_REPORT_AUTHORIZED_SCOPE_SCHEMA_VERSION = "aw-run-report-authorized-scope/1" as const;
export const CRITERION_DETAIL_SCHEMA_VERSION = "aw-criterion-detail-read/1" as const;

export const REPORT_PATH_TEMPLATE = "/v1/relay/runs/{runId}/report";
export const CRITERION_PATH_TEMPLATE =
  "/v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria";
export const CRITERION_API_ALIAS_TEMPLATE =
  "/api/v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria";

export const REPORT_PAGE_DEFAULT = 20;
export const REPORT_PAGE_MAX = 60;
export const REPORT_PAGE_BYTES_MAX = 512 * 1024;
export const CRITERION_PAGE_DEFAULT = 8;
export const CRITERION_PAGE_MAX = 16;
export const REPORT_RETRY_BUDGET_MS = 20_000;
export const REPORT_RETRY_MAX_ATTEMPTS = 4;
export const REPORT_RETRY_AFTER_CAP_MS = 5_000;
export const REPORT_MAX_PAGES = 64;
export const CRITERION_MAX_PAGES = 256;

const identifier = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const boundedUrl = z.string().url().max(2_048);

export const ReportExecutionStatusSchema = z.enum([
  "queued",
  "connected",
  "running",
  "cancel_requested",
  "cancelled",
  "completed",
  "failed"
]);

export const ReportOutcomeSchema = z.enum(["passed", "failed", "inconclusive", "error"]).nullable();

export const ReportEvaluationStatusSchema = z.enum([
  "absent",
  "pending",
  "complete",
  "partial",
  "error"
]);

export const AttemptExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
  "not_started"
]);

export const AttemptCleanupStateSchema = z.enum([
  "not_required",
  "pending",
  "completed",
  "failed",
  "not_attempted"
]);

export const AttemptOutcomeSchema = z
  .enum(["pass", "fail", "error", "not_run", "uncertain"])
  .nullable();

export const MappedAvailabilitySchema = z.enum(["available", "redacted", "missing", "purged"]);

export const EvaluationBindingSchema = z
  .object({
    evaluationId: identifier,
    evaluationRevision: z.number().int().min(0).max(1_000_000),
    snapshotHash: sha256,
    executionResultHash: sha256.nullable(),
    assessmentPlanHash: sha256.nullable(),
    referenceBundleHash: sha256.nullable(),
    graderConfigHash: sha256.nullable()
  })
  .strict();

export const CoverageSchema = z
  .object({
    plannedAttempts: z.number().int().min(0).max(10_000).nullable(),
    completedAttempts: z.number().int().min(0).max(10_000).nullable(),
    requiredJudgmentsPlanned: z.number().int().min(0).max(10_000).nullable(),
    requiredJudgmentsComplete: z.number().int().min(0).max(10_000).nullable()
  })
  .strict();

export const MappedResponseSchema = z
  .object({
    availability: MappedAvailabilitySchema,
    text: z.string().max(64 * 1024).nullable(),
    sha256: sha256.nullable(),
    truncated: z.boolean(),
    turnId: identifier.nullable(),
    evidenceId: identifier.nullable()
  })
  .strict();

export const RetentionSchema = z
  .object({
    retainUntil: timestamp.nullable(),
    policyVersion: z.string().min(1).max(200).nullable(),
    purgedAt: timestamp.nullable(),
    contentAvailable: z.boolean()
  })
  .strict();

export const ReportPageSchema = z
  .object({
    nextCursor: z.string().min(1).max(4_096).nullable(),
    hasMore: z.boolean(),
    totalAttempts: z.number().int().min(0).max(10_000).nullable()
  })
  .strict();

export const ReportAttemptSchema = z
  .object({
    attemptId: identifier,
    scenarioId: identifier,
    repetitionIndex: z.number().int().min(0).max(999),
    attemptNumber: z.number().int().min(1).max(1_000),
    executionStatus: AttemptExecutionStatusSchema,
    cleanupState: AttemptCleanupStateSchema,
    criterionIndexUrl: boundedUrl.nullable(),
    mappedResponse: MappedResponseSchema,
    outcome: AttemptOutcomeSchema
  })
  .strict();

export const RunReportSchema = z
  .object({
    schemaVersion: z.literal(RUN_REPORT_SCHEMA_VERSION),
    runId: identifier,
    workspaceId: identifier,
    dashboardUrl: boundedUrl,
    asOf: timestamp,
    executionStatus: ReportExecutionStatusSchema,
    outcome: ReportOutcomeSchema,
    creditState: z.enum(["reserved", "consumed", "released"]),
    evaluationStatus: ReportEvaluationStatusSchema,
    evaluationBinding: EvaluationBindingSchema.nullable(),
    aggregate: z.unknown().nullable(),
    coverage: CoverageSchema,
    attempts: z.array(ReportAttemptSchema).max(REPORT_PAGE_MAX),
    retention: RetentionSchema,
    reportReady: z.boolean(),
    page: ReportPageSchema,
    createsBillableRun: z.literal(false)
  })
  .strict();

export const ReportErrorSchema = z
  .object({
    schemaVersion: z.literal(RUN_REPORT_SCHEMA_VERSION),
    error: z
      .object({
        code: z.string().min(1).max(80),
        message: z.string().min(1).max(500),
        retryable: z.boolean()
      })
      .strict()
  })
  .strict();

export const CriterionVerdictSchema = z.enum([
  "pass",
  "fail",
  "error",
  "not_judged",
  "uncertain"
]);

export const CriterionEvidenceSchema = z
  .object({
    availability: MappedAvailabilitySchema,
    text: z.string().max(64 * 1024).nullable(),
    sha256: sha256.nullable(),
    truncated: z.boolean()
  })
  .strict();

export const CriterionIndexItemSchema = z
  .object({
    criterionId: identifier,
    criterionKey: identifier.optional(),
    required: z.boolean(),
    verdict: CriterionVerdictSchema,
    detailUrl: boundedUrl.nullable(),
    evidence: CriterionEvidenceSchema.optional()
  })
  .passthrough();

export const CriterionIndexSchema = z
  .object({
    schemaVersion: z.literal(CRITERION_DETAIL_SCHEMA_VERSION),
    runId: identifier,
    workspaceId: identifier.optional(),
    evaluationId: identifier,
    evaluationRevision: z.number().int().min(0).max(1_000_000),
    snapshotHash: sha256,
    attemptId: identifier,
    criteria: z.array(CriterionIndexItemSchema).max(CRITERION_PAGE_MAX),
    page: z
      .object({
        nextCursor: z.string().min(1).max(4_096).nullable(),
        hasMore: z.boolean(),
        totalCriteria: z.number().int().min(0).max(10_000).nullable()
      })
      .strict()
  })
  .passthrough();

export const CriterionDetailSchema = z
  .object({
    schemaVersion: z.literal(CRITERION_DETAIL_SCHEMA_VERSION),
    runId: identifier,
    workspaceId: identifier.optional(),
    evaluationId: identifier,
    evaluationRevision: z.number().int().min(0).max(1_000_000),
    snapshotHash: sha256,
    attemptId: identifier,
    criterionId: identifier,
    criterionKey: identifier.optional(),
    required: z.boolean(),
    verdict: CriterionVerdictSchema,
    evidence: CriterionEvidenceSchema
  })
  .passthrough();

export const ExportDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
    retryable: z.boolean().optional()
  })
  .strict();

export const RunReportExportSchema = z
  .object({
    schemaVersion: z.literal(RUN_REPORT_EXPORT_SCHEMA_VERSION),
    retrieved: z.boolean(),
    complete: z.boolean(),
    report: RunReportSchema.optional(),
    criteria: z.array(z.record(z.string(), z.unknown())).optional(),
    diagnostics: z.array(ExportDiagnosticSchema),
    error: z
      .object({
        code: z.string().min(1).max(80),
        message: z.string().min(1).max(500),
        retryable: z.boolean(),
        httpStatus: z.number().int().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export type RunReport = z.infer<typeof RunReportSchema>;
export type RunReportAttempt = z.infer<typeof ReportAttemptSchema>;
export type EvaluationBinding = z.infer<typeof EvaluationBindingSchema>;
export type MappedResponse = z.infer<typeof MappedResponseSchema>;
export type CriterionIndex = z.infer<typeof CriterionIndexSchema>;
export type CriterionDetail = z.infer<typeof CriterionDetailSchema>;
export type ExportDiagnostic = z.infer<typeof ExportDiagnosticSchema>;
export type RunReportExport = z.infer<typeof RunReportExportSchema>;
export type ReportErrorEnvelope = z.infer<typeof ReportErrorSchema>;

export const LiveInformationalReportSchema = z
  .object({
    schemaVersion: z.literal(RUN_REPORT_LIVE_SCOPE_SCHEMA_VERSION),
    runId: identifier,
    workspaceId: identifier,
    asOf: timestamp,
    executionMode: z.literal("informational"),
    assessmentKind: z.literal("bounded_informational_assessment"),
    approvedOrigin: z.string().min(8).max(2_048),
    authorizationKind: z.enum(["owned_target", "written_permission"]),
    authorizationRef: z.string().min(1).max(200),
    authorizationHash: sha256,
    liveTargetHash: sha256,
    suiteId: identifier,
    suiteRevisionId: identifier,
    suiteContentHash: sha256,
    packetOverlay: z.literal("aw-packet/live-informational-1"),
    packetHash: sha256.nullable(),
    allowedMessages: z.number().int().min(1).max(3),
    dispatchedMessages: z.number().int().min(0).max(3),
    indeterminateSends: z.number().int().min(0).max(3),
    completedSends: z.number().int().min(0).max(3),
    expiresAt: z.string().min(1).max(64),
    createsBillableRun: z.literal(false)
  })
  .strict();

export const LiveInformationalReportErrorSchema = z
  .object({
    schemaVersion: z.literal(RUN_REPORT_LIVE_SCOPE_SCHEMA_VERSION),
    error: z
      .object({
        code: z.string().min(1).max(80),
        message: z.string().min(1).max(500),
        retryable: z.boolean()
      })
      .strict()
  })
  .strict();

export type LiveInformationalReport = z.infer<typeof LiveInformationalReportSchema>;
export type LiveInformationalReportError = z.infer<typeof LiveInformationalReportErrorSchema>;

export const AuthorizedReportOverlaySchema = z
  .object({
    schemaVersion: z.literal(RUN_REPORT_AUTHORIZED_SCOPE_SCHEMA_VERSION),
    workspaceId: identifier,
    runId: identifier,
    scopeHash: sha256,
    environment: z.enum(["development", "staging", "production"]),
    dataOrigin: z.enum(["constructed", "customer_records", "mixed"]),
    dataClass: z.enum(["public", "business", "personal"]),
    effects: z.enum(["informational", "sandbox_actions", "controlled_actions"]),
    targetId: identifier,
    targetBoundaryHash: sha256,
    policyHash: sha256,
    profileHash: sha256,
    expectedCoverage: z
      .object({
        messages: z.number().int().min(0),
        commands: z.number().int().min(0),
        actions: z.number().int().min(0)
      })
      .strict()
      .optional(),
    actualCounts: z
      .object({
        messages: z.number().int().min(0),
        commands: z.number().int().min(0),
        actions: z.number().int().min(0)
      })
      .strict(),
    evidenceStatus: z.enum(["available", "partially_redacted", "unavailable", "expired", "purged"]),
    actionEvidenceStatus: z.enum(["not_applicable", "reported", "verified_receipts", "indeterminate"]),
    representationHashes: z.array(sha256).max(32),
    limitations: z.array(z.string().min(1).max(500)).max(32),
    v1ReportUnchanged: z.literal(true),
    independentlyVerifiedBusinessState: z.literal(false)
  })
  .strict();

export const AuthorizedReportOverlayErrorSchema = z
  .object({
    schemaVersion: z.literal(RUN_REPORT_AUTHORIZED_SCOPE_SCHEMA_VERSION),
    error: z
      .object({
        code: z.string().min(1).max(80),
        message: z.string().min(1).max(500),
        retryable: z.boolean()
      })
      .strict()
  })
  .strict();

export type AuthorizedReportOverlay = z.infer<typeof AuthorizedReportOverlaySchema>;

export function reportPath(runId: string): string {
  return `/v1/relay/runs/${encodeURIComponent(runId)}/report`;
}

export function liveInformationalReportPath(runId: string): string {
  return `${reportPath(runId)}?scope=${LIVE_INFORMATIONAL_REPORT_SCOPE}`;
}

export function authorizedReportPath(runId: string): string {
  return `${reportPath(runId)}?scope=${AUTHORIZED_REPORT_SCOPE}`;
}
