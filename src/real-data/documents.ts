import { z } from "zod";

import { canonicalize, sha256 } from "../util/canonical.js";
import { canonicalDocumentHash } from "./canonical.js";
import {
  ACTION_EVIDENCE_STATUSES,
  ACTION_POLICY_SCHEMA_VERSION,
  AUTHORIZATION_KINDS,
  AUTHORIZED_PACKET_SCHEMA_VERSION,
  AUTHORIZED_REPORT_SCOPE_SCHEMA_VERSION,
  CAPABILITIES_SCHEMA_VERSION,
  CONTENT_HANDLING,
  CONTROLLED_ACTIONS_UNAVAILABLE_REASON,
  DATA_CLASSES,
  DATA_HANDLING_RECEIPT_SCHEMA_VERSION,
  DATA_ORIGINS,
  DATA_POLICY_SCHEMA_VERSION,
  EFFECT_BOUNDARIES,
  EFFECTS,
  ENDPOINT_METHODS,
  ENVIRONMENTS,
  EVIDENCE_STATUSES,
  EXECUTION_SCOPE_BINDING_SCHEMA_VERSION,
  EXECUTION_SCOPE_RESPONSE_SCHEMA_VERSION,
  EXECUTION_SCOPE_SCHEMA_VERSION,
  EXTERNAL_SHARING,
  LOCAL_AUTHORIZED_PACKET_SCHEMA_VERSION,
  LOCAL_EXECUTION_SCOPE_SCHEMA_VERSION,
  LOCAL_VERIFICATION,
  PROVIDER_PROCESSING,
  REAL_DATA_CONTRACT_REVISION,
  RECEIPT_OUTCOMES,
  REDACTION_ACTIONS,
  REDACTION_DETECTORS,
  REDACTION_PROFILE_SCHEMA_VERSION,
  SCOPE_AVAILABILITY,
  TARGET_AUTHORITY_SCHEMA_VERSION,
  TARGET_BOUNDARY_SCHEMA_VERSION,
  TRANSPORT_TYPES,
  VERIFICATION_METHODS,
  VERIFICATION_STATUSES
} from "./constants.js";
import { realDataError } from "./errors.js";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const UTC_Z_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export const UuidSchema = z.string().regex(UUID_PATTERN, "must be a UUID");
export const Sha256Schema = z.string().regex(SHA256_PATTERN, "must be a lowercase SHA-256 digest");
export const UtcZSchema = z.string().regex(UTC_Z_PATTERN, "must be a UTC Z timestamp");
export const PositiveIntSchema = z.number().int().positive();
export const NonNegativeIntSchema = z.number().int().min(0);

const permissionRef = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);

const jsonPointerSelector = z
  .string()
  .min(1)
  .max(300)
  .regex(/^\/(?:[A-Za-z0-9_.-]+|\*)(?:\/(?:[A-Za-z0-9_.-]+|\*))*$/, "must be a frozen JSON Pointer subset");

export const BudgetSchema = z
  .object({
    maxMessages: PositiveIntSchema.max(512),
    maxActions: NonNegativeIntSchema.max(512),
    maxCommands: PositiveIntSchema.max(512),
    maxRuntimeSeconds: PositiveIntSchema.max(86_400),
    maxCredits: NonNegativeIntSchema.max(Number.MAX_SAFE_INTEGER)
  })
  .strict();

export type ExecutionBudget = z.infer<typeof BudgetSchema>;

export const PolicyIdentitySchema = z
  .object({
    id: UuidSchema,
    revision: PositiveIntSchema,
    hash: Sha256Schema
  })
  .strict();

export const ActionPolicyIdentitySchema = z
  .object({
    id: UuidSchema,
    revision: PositiveIntSchema,
    hash: Sha256Schema,
    receiverId: UuidSchema
  })
  .strict();

export const TargetAuthoritySchema = z
  .object({
    schemaVersion: z.literal(TARGET_AUTHORITY_SCHEMA_VERSION),
    authorityId: UuidSchema,
    revision: PositiveIntSchema,
    authorityHash: Sha256Schema,
    workspaceId: UuidSchema,
    targetId: UuidSchema,
    targetRevision: PositiveIntSchema,
    targetBoundaryHash: Sha256Schema,
    authorizationKind: z.enum(AUTHORIZATION_KINDS),
    permissionRef,
    effectsAllowed: z.array(z.enum(EFFECTS)).min(1).max(3),
    verificationMethod: z.enum(VERIFICATION_METHODS),
    verificationStatus: z.enum(VERIFICATION_STATUSES),
    expiresAt: UtcZSchema
  })
  .strict();

export type TargetAuthority = z.infer<typeof TargetAuthoritySchema>;

export const ExecutionScopeSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_SCOPE_SCHEMA_VERSION),
    scopeId: UuidSchema,
    revision: PositiveIntSchema,
    scopeHash: Sha256Schema,
    workspaceId: UuidSchema,
    targetId: UuidSchema,
    targetRevision: PositiveIntSchema,
    targetBoundaryHash: Sha256Schema,
    environment: z.enum(ENVIRONMENTS),
    dataOrigin: z.enum(DATA_ORIGINS),
    effects: z.enum(EFFECTS),
    authority: PolicyIdentitySchema,
    dataPolicy: PolicyIdentitySchema,
    actionPolicy: ActionPolicyIdentitySchema.nullable(),
    budget: BudgetSchema,
    expiresAt: UtcZSchema
  })
  .strict();

export type ExecutionScope = z.infer<typeof ExecutionScopeSchema>;

export const SuiteExecutionScopeRefSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_SCOPE_SCHEMA_VERSION),
    scopeId: UuidSchema,
    revision: PositiveIntSchema.optional(),
    scopeHash: Sha256Schema.optional()
  })
  .strict();

export type SuiteExecutionScopeRef = z.infer<typeof SuiteExecutionScopeRefSchema>;

export const DataPolicySchema = z
  .object({
    schemaVersion: z.literal(DATA_POLICY_SCHEMA_VERSION),
    policyId: UuidSchema,
    revision: PositiveIntSchema,
    policyHash: Sha256Schema,
    dataClass: z.enum(DATA_CLASSES),
    contentHandling: z.enum(CONTENT_HANDLING),
    redactionProfileId: UuidSchema,
    redactionProfileHash: Sha256Schema,
    retentionDays: PositiveIntSchema.max(3650),
    externalSharing: z.enum(EXTERNAL_SHARING),
    providerProcessing: z.enum(PROVIDER_PROCESSING)
  })
  .strict();

export type DataPolicy = z.infer<typeof DataPolicySchema>;

export const RedactionRuleSchema = z
  .object({
    id: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    selector: jsonPointerSelector,
    action: z.enum(REDACTION_ACTIONS),
    detector: z.enum(REDACTION_DETECTORS)
  })
  .strict();

export const RedactionProfileSchema = z
  .object({
    schemaVersion: z.literal(REDACTION_PROFILE_SCHEMA_VERSION),
    profileId: UuidSchema,
    revision: PositiveIntSchema,
    profileHash: Sha256Schema,
    allowedContentFields: z.array(z.string().min(1).max(120)).max(64),
    rules: z.array(RedactionRuleSchema).max(64),
    maxDocumentBytes: PositiveIntSchema.max(1_048_576),
    maxTextChars: PositiveIntSchema.max(1_048_576)
  })
  .strict();

export type RedactionProfile = z.infer<typeof RedactionProfileSchema>;

export const DataHandlingReceiptSchema = z
  .object({
    schemaVersion: z.literal(DATA_HANDLING_RECEIPT_SCHEMA_VERSION),
    policyId: UuidSchema,
    policyHash: Sha256Schema,
    profileHash: Sha256Schema,
    representationHash: Sha256Schema,
    outcome: z.enum(RECEIPT_OUTCOMES),
    counts: z
      .object({
        dropped: NonNegativeIntSchema,
        masked: NonNegativeIntSchema,
        blocked: NonNegativeIntSchema
      })
      .strict(),
    processor: z.enum(["cli", "server"]),
    processorVersion: z.string().min(1).max(80)
  })
  .strict();

export type DataHandlingReceipt = z.infer<typeof DataHandlingReceiptSchema>;

export const TargetEndpointSchema = z
  .object({
    method: z.enum(ENDPOINT_METHODS),
    path: z.string().min(1).max(300)
  })
  .strict();

export const TargetBoundarySchema = z
  .object({
    schemaVersion: z.literal(TARGET_BOUNDARY_SCHEMA_VERSION),
    targetId: UuidSchema,
    revision: PositiveIntSchema,
    boundaryHash: Sha256Schema,
    transport: z.enum(TRANSPORT_TYPES),
    effectBoundary: z.enum(EFFECT_BOUNDARIES),
    assessedIdentity: z.string().min(1).max(253),
    endpoints: z.array(TargetEndpointSchema).max(32)
  })
  .strict();

export type TargetBoundary = z.infer<typeof TargetBoundarySchema>;

export const LocalAuthorityIdentitySchema = z
  .object({
    id: UuidSchema,
    revision: PositiveIntSchema,
    hash: Sha256Schema,
    verification: z.literal(LOCAL_VERIFICATION)
  })
  .strict();

export const LocalExecutionScopeSchema = z
  .object({
    schemaVersion: z.literal(LOCAL_EXECUTION_SCOPE_SCHEMA_VERSION),
    scopeId: UuidSchema,
    revision: PositiveIntSchema,
    scopeHash: Sha256Schema,
    targetId: UuidSchema,
    targetRevision: PositiveIntSchema,
    targetBoundaryHash: Sha256Schema,
    environment: z.enum(ENVIRONMENTS),
    dataOrigin: z.enum(DATA_ORIGINS),
    effects: z.enum(EFFECTS),
    authority: LocalAuthorityIdentitySchema,
    dataPolicy: PolicyIdentitySchema,
    actionPolicy: ActionPolicyIdentitySchema.nullable(),
    budget: BudgetSchema,
    expiresAt: UtcZSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.prototype.hasOwnProperty.call(value, "workspaceId")) {
      context.addIssue({
        code: "custom",
        message: "local execution scope cannot include workspaceId",
        path: ["workspaceId"]
      });
    }
  });

export type LocalExecutionScope = z.infer<typeof LocalExecutionScopeSchema>;

export const ActionPolicySchema = z
  .object({
    schemaVersion: z.literal(ACTION_POLICY_SCHEMA_VERSION),
    policyId: UuidSchema,
    revision: PositiveIntSchema,
    policyHash: Sha256Schema,
    receiverId: UuidSchema,
    allowedActions: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            resourceIds: z.array(z.string().min(1).max(200)).max(32),
            maxCalls: PositiveIntSchema,
            amountLimit: z
              .object({
                currency: z.string().min(3).max(8),
                maxMinorUnits: NonNegativeIntSchema
              })
              .strict()
              .nullable(),
            argumentSchemaHash: Sha256Schema
          })
          .strict()
      )
      .max(32),
    maxTotalActions: PositiveIntSchema,
    expiresAt: UtcZSchema
  })
  .strict();

export type ActionPolicy = z.infer<typeof ActionPolicySchema>;

export const CapabilitiesSchema = z
  .object({
    schemaVersion: z.literal(CAPABILITIES_SCHEMA_VERSION),
    contractRevision: z.literal(REAL_DATA_CONTRACT_REVISION),
    runtimeEnforced: z.literal(true),
    releaseEnabled: z.literal(true),
    executionScopes: z.array(z.string()),
    suiteSchemas: z.array(z.string()),
    packetSchemas: z.array(z.string()),
    reportScopes: z.array(z.string()),
    dataPolicies: z.array(z.string()),
    supportedEffects: z.array(z.enum(EFFECTS)),
    enabledEffects: z.array(z.enum(EFFECTS)),
    controlledActions: z
      .object({
        available: z.literal(false),
        reason: z.literal(CONTROLLED_ACTIONS_UNAVAILABLE_REASON)
      })
      .strict()
  })
  .strict();

/**
 * A parsed aw-capabilities/1 document, or the CLI's disabled stand-in for a
 * server that has no /v1/capabilities route. Only the stand-in is ever false.
 */
export type RealDataCapabilities = Omit<
  z.infer<typeof CapabilitiesSchema>,
  "runtimeEnforced" | "releaseEnabled"
> & {
  readonly runtimeEnforced: boolean;
  readonly releaseEnabled: boolean;
};

export const ExecutionScopeResponseSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_SCOPE_RESPONSE_SCHEMA_VERSION),
    scope: ExecutionScopeSchema,
    authority: TargetAuthoritySchema,
    dataPolicy: DataPolicySchema,
    redactionProfile: RedactionProfileSchema,
    actionPolicy: ActionPolicySchema.nullable(),
    targetBoundary: TargetBoundarySchema,
    availability: z.enum(SCOPE_AVAILABILITY)
  })
  .strict();

export type ExecutionScopeResponse = z.infer<typeof ExecutionScopeResponseSchema>;

export const AuthorizedReportSchema = z
  .object({
    schemaVersion: z.literal(AUTHORIZED_REPORT_SCOPE_SCHEMA_VERSION),
    workspaceId: UuidSchema,
    runId: z.string().min(1).max(300),
    scopeHash: Sha256Schema,
    environment: z.enum(ENVIRONMENTS),
    dataOrigin: z.enum(DATA_ORIGINS),
    dataClass: z.enum(DATA_CLASSES),
    effects: z.enum(EFFECTS),
    targetId: UuidSchema,
    targetBoundaryHash: Sha256Schema,
    policyHash: Sha256Schema,
    profileHash: Sha256Schema,
    actualCounts: z
      .object({
        messages: NonNegativeIntSchema,
        commands: NonNegativeIntSchema,
        actions: NonNegativeIntSchema
      })
      .strict(),
    evidenceStatus: z.enum(EVIDENCE_STATUSES),
    actionEvidenceStatus: z.enum(ACTION_EVIDENCE_STATUSES),
    representationHashes: z.array(Sha256Schema).max(32),
    limitations: z.array(z.string().min(1).max(500)).max(32),
    v1ReportUnchanged: z.literal(true),
    independentlyVerifiedBusinessState: z.literal(false)
  })
  .strict();

export type AuthorizedReport = z.infer<typeof AuthorizedReportSchema>;

export const ExecutionScopeBindingSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_SCOPE_BINDING_SCHEMA_VERSION),
    bindingKind: z.enum(["hosted", "local"]),
    runId: z.string().min(1).max(300),
    quoteId: z.string().min(1).max(128).optional(),
    suiteId: z.string().min(1).max(300).optional(),
    suiteRevisionId: z.string().min(1).max(128).optional(),
    contentHash: Sha256Schema.optional(),
    configSha256: Sha256Schema,
    targetBoundaryHash: Sha256Schema,
    workspaceId: UuidSchema.optional(),
    scopeId: UuidSchema,
    scopeRevision: PositiveIntSchema,
    scopeHash: Sha256Schema,
    packetOverlay: z.enum([AUTHORIZED_PACKET_SCHEMA_VERSION, LOCAL_AUTHORIZED_PACKET_SCHEMA_VERSION]),
    admitted: z.union([ExecutionScopeSchema, LocalExecutionScopeSchema]),
    dataPolicy: DataPolicySchema.optional(),
    redactionProfile: RedactionProfileSchema.optional(),
    /** The admitted boundary: the server's for hosted, the one rebuilt from augmentworks.yaml for local. */
    targetBoundary: TargetBoundarySchema.optional(),
    availability: z.enum(SCOPE_AVAILABILITY),
    fetchedAt: UtcZSchema
  })
  .strict();

export type ExecutionScopeBinding = z.infer<typeof ExecutionScopeBindingSchema>;

function parseOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: Parameters<typeof realDataError>[0],
  label: string
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw realDataError(
      code,
      `${label} is not a complete ${label.includes("scope") ? "execution-scope" : "real-data"} document (${parsed.error.issues[0]?.message ?? "invalid"}).`
    );
  }
  return parsed.data;
}

export function parseTargetAuthority(value: unknown): TargetAuthority {
  const document = parseOrThrow(TargetAuthoritySchema, value, "INVALID_EXECUTION_SCOPE", "Target authority");
  assertHash(document, "authorityHash", "INVALID_EXECUTION_SCOPE", "authorityHash");
  return document;
}

export function parseExecutionScope(value: unknown): ExecutionScope {
  const document = parseOrThrow(ExecutionScopeSchema, value, "INVALID_EXECUTION_SCOPE", "Execution scope");
  assertHash(document, "scopeHash", "INVALID_EXECUTION_SCOPE", "scopeHash");
  return document;
}

export function parseLocalExecutionScope(value: unknown): LocalExecutionScope {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const version = record["schemaVersion"] ?? record["schema_version"];
    if (version === EXECUTION_SCOPE_SCHEMA_VERSION) {
      throw realDataError(
        "HOSTED_AUTHORITY_INTERCHANGE_FORBIDDEN",
        "A hosted aw-execution-scope/1 document cannot authorize local execution."
      );
    }
    if ("workspaceId" in record && record["workspaceId"] !== undefined) {
      throw realDataError(
        "HOSTED_AUTHORITY_INTERCHANGE_FORBIDDEN",
        "Local execution scope cannot carry a workspaceId or hosted authority."
      );
    }
  }
  const document = parseOrThrow(
    LocalExecutionScopeSchema,
    value,
    "INVALID_EXECUTION_SCOPE",
    "Local execution scope"
  );
  assertHash(document, "scopeHash", "INVALID_EXECUTION_SCOPE", "scopeHash");
  return document;
}

export function parseTargetBoundary(value: unknown): TargetBoundary {
  const document = parseOrThrow(TargetBoundarySchema, value, "TARGET_SCOPE_MISMATCH", "Target boundary");
  assertHash(document, "boundaryHash", "TARGET_SCOPE_MISMATCH", "boundaryHash");
  return document;
}

export function parseDataPolicy(value: unknown): DataPolicy {
  const document = parseOrThrow(DataPolicySchema, value, "UNSUPPORTED_DATA_POLICY", "Data policy");
  assertHash(document, "policyHash", "UNSUPPORTED_DATA_POLICY", "policyHash");
  return document;
}

export function parseRedactionProfile(value: unknown): RedactionProfile {
  const document = parseOrThrow(
    RedactionProfileSchema,
    value,
    "REDACTION_PROFILE_MISMATCH",
    "Redaction profile"
  );
  assertHash(document, "profileHash", "REDACTION_PROFILE_MISMATCH", "profileHash");
  return document;
}

export function parseCapabilities(value: unknown): RealDataCapabilities {
  const parsed = CapabilitiesSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
    throw realDataError(
      "UNSUPPORTED_EXECUTION_SCOPE",
      `The server's /v1/capabilities response is not a valid aw-capabilities/1 document (${issue?.message ?? "invalid"}${where}). This CLI can't tell whether real-data runs are available there.`
    );
  }
  return parsed.data;
}

export function parseExecutionScopeResponse(value: unknown): ExecutionScopeResponse {
  const document = parseOrThrow(
    ExecutionScopeResponseSchema,
    value,
    "INVALID_EXECUTION_SCOPE",
    "Execution scope response"
  );
  assertHash(document.scope, "scopeHash", "INVALID_EXECUTION_SCOPE", "scopeHash");
  assertHash(document.authority, "authorityHash", "INVALID_EXECUTION_SCOPE", "authorityHash");
  assertHash(document.dataPolicy, "policyHash", "UNSUPPORTED_DATA_POLICY", "policyHash");
  assertHash(document.redactionProfile, "profileHash", "REDACTION_PROFILE_MISMATCH", "profileHash");
  if (document.scope.authority.hash !== document.authority.authorityHash) {
    throw realDataError("INVALID_EXECUTION_SCOPE", "Admitted authority hash does not match the scope binding.");
  }
  if (document.scope.dataPolicy.hash !== document.dataPolicy.policyHash) {
    throw realDataError("DATA_POLICY_STALE", "Admitted data-policy hash does not match the scope binding.");
  }
  assertHash(document.targetBoundary, "boundaryHash", "TARGET_SCOPE_MISMATCH", "boundaryHash");
  if (document.scope.targetBoundaryHash !== document.targetBoundary.boundaryHash) {
    throw realDataError("TARGET_SCOPE_MISMATCH", "Admitted target boundary hash does not match the scope binding.");
  }
  if (
    document.targetBoundary.targetId !== document.scope.targetId ||
    document.targetBoundary.revision !== document.scope.targetRevision
  ) {
    throw realDataError(
      "TARGET_SCOPE_MISMATCH",
      "Admitted target boundary is for a different target or target revision than the scope."
    );
  }
  if (document.actionPolicy !== null) {
    assertHash(document.actionPolicy, "policyHash", "ACTION_BOUNDARY_REQUIRED", "actionPolicyHash");
  }
  return document;
}

export function parseAuthorizedReport(value: unknown): AuthorizedReport {
  return parseOrThrow(AuthorizedReportSchema, value, "EVIDENCE_REPRESENTATION_MISMATCH", "Authorized report");
}

export function parseExecutionScopeBinding(value: unknown): ExecutionScopeBinding {
  return parseOrThrow(ExecutionScopeBindingSchema, value, "EXECUTION_SCOPE_STALE", "Persisted execution-scope binding");
}

export function assertKnownSchemaVersion(version: string, admitted: readonly string[], label: string): void {
  if (!admitted.includes(version)) {
    throw realDataError(
      "UNSUPPORTED_EXECUTION_SCOPE",
      `Unsupported ${label} version "${version}". Unknown versions fail closed and are never downgraded to synthetic.`
    );
  }
}

export function assertHash(
  document: Record<string, unknown>,
  field: string,
  code: Parameters<typeof realDataError>[0],
  label: string
): void {
  const declared = document[field];
  if (typeof declared !== "string" || !SHA256_PATTERN.test(declared)) {
    throw realDataError(code, `${label} is missing or not a SHA-256 digest.`);
  }
  const actual = canonicalDocumentHash(document, field);
  if (actual !== declared) {
    throw realDataError(code, `${label} does not match the canonical document.`);
  }
}

export function representationHash(value: unknown): string {
  return sha256(canonicalize(value));
}

export function looksLikeLocalAuthorizedPacket(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const version = record["schemaVersion"] ?? record["schema_version"];
  return version === LOCAL_AUTHORIZED_PACKET_SCHEMA_VERSION;
}

export function looksLikeHostedAuthorizedPacket(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const version = record["schemaVersion"] ?? record["schema_version"];
  return version === AUTHORIZED_PACKET_SCHEMA_VERSION;
}

export function looksLikeLocalExecutionScope(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const version = record["schemaVersion"] ?? record["schema_version"];
  return version === LOCAL_EXECUTION_SCOPE_SCHEMA_VERSION;
}

export function looksLikeHostedExecutionScope(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const version = record["schemaVersion"] ?? record["schema_version"];
  return version === EXECUTION_SCOPE_SCHEMA_VERSION;
}

export function looksLikeExecutionScopeResponse(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const version = record["schemaVersion"] ?? record["schema_version"];
  return version === EXECUTION_SCOPE_RESPONSE_SCHEMA_VERSION;
}
