/** Frozen AW-REAL-DATA-1 revision 1 identifiers. Do not invent successor versions here. */

export const REAL_DATA_CONTRACT_REVISION = 1 as const;
export const REAL_DATA_LOCK_SCHEMA_VERSION = "aw-real-data/1" as const;

export const SOURCE_REPOSITORY = "https://github.com/augmentworks-org/augmentworks.git" as const;
export const SOURCE_COMMIT = "b198906188bab2dac9ae2a1ad539405807e46e1e" as const;
export const SOURCE_SCHEMA_PATH = "docs/contracts/aw-real-data-1.schema.json" as const;
export const SOURCE_FIXTURES_PATH = "docs/contracts/aw-real-data-1.fixtures.json" as const;
export const SOURCE_CHECKSUMS_PATH = "docs/contracts/aw-real-data-1.checksums.json" as const;
export const SOURCE_SPEC_PATH = "docs/contracts/aw-real-data-1.md" as const;

export const EXPECTED_SCHEMA_SHA256 =
  "6a53d04f297eb4db275bb7074bf7705a08137d932be823a3f4087d84cfdf7121" as const;
export const EXPECTED_FIXTURES_SHA256 =
  "26033843d55dcb9b49ccf68fa96f7de9ec34aa6c299e8ab28b605cad37572230" as const;

export const TARGET_AUTHORITY_SCHEMA_VERSION = "aw-target-authority/1" as const;
export const EXECUTION_SCOPE_SCHEMA_VERSION = "aw-execution-scope/1" as const;
export const LOCAL_EXECUTION_SCOPE_SCHEMA_VERSION = "aw-local-execution-scope/1" as const;
export const DATA_POLICY_SCHEMA_VERSION = "aw-data-policy/1" as const;
export const REDACTION_PROFILE_SCHEMA_VERSION = "aw-redaction-profile/1" as const;
export const DATA_HANDLING_RECEIPT_SCHEMA_VERSION = "aw-data-handling-receipt/1" as const;
export const CAPABILITIES_SCHEMA_VERSION = "aw-capabilities/1" as const;
export const EXECUTION_SCOPE_RESPONSE_SCHEMA_VERSION = "aw-execution-scope-response/1" as const;
export const TARGET_BOUNDARY_SCHEMA_VERSION = "aw-target-boundary/1" as const;
export const TARGET_REGISTRATION_SCHEMA_VERSION = "aw-target-registration/1" as const;
export const ACTION_POLICY_SCHEMA_VERSION = "aw-action-policy/1" as const;
export const AUTHORIZED_PACKET_SCHEMA_VERSION = "aw-packet/authorized-1" as const;
export const LOCAL_AUTHORIZED_PACKET_SCHEMA_VERSION = "aw-packet/local-authorized-1" as const;
export const AUTHORIZED_REPORT_SCOPE_SCHEMA_VERSION = "aw-run-report-authorized-scope/1" as const;
export const EXECUTION_SCOPE_BINDING_SCHEMA_VERSION = "aw-execution-scope-binding/1" as const;

export const SUITE_SCHEMA_VERSION_V3 = "aw-suite/3" as const;
export const CUSTOMER_OWNED_SUITE_PACKET_V3 = {
  key: "aw-customer-suite",
  version: "3.0.0"
} as const;

export const AUTHORIZED_REPORT_SCOPE = "authorized-1" as const;
export const LOCAL_VERIFICATION = "customer_declared_local" as const;

export const ENVIRONMENTS = ["development", "staging", "production"] as const;
export const DATA_ORIGINS = ["constructed", "customer_records", "mixed"] as const;
export const DATA_CLASSES = ["public", "business", "personal"] as const;
export const EFFECTS = ["informational", "sandbox_actions", "controlled_actions"] as const;
export const AUTHORIZATION_KINDS = ["owned_target", "written_permission"] as const;
export const VERIFICATION_METHODS = [
  "dns_txt",
  "https_challenge",
  "connector_challenge",
  "reviewed_permission"
] as const;
export const VERIFICATION_STATUSES = ["pending", "verified", "revoked"] as const;
export const CONTENT_HANDLING = ["minimized", "verbatim"] as const;
export const EXTERNAL_SHARING = ["disabled", "reviewed"] as const;
export const PROVIDER_PROCESSING = ["openai_standard"] as const;
export const REDACTION_ACTIONS = ["drop", "mask", "block"] as const;
export const REDACTION_DETECTORS = [
  "field",
  "credential",
  "email",
  "phone",
  "exact_local_secret"
] as const;
export const RECEIPT_OUTCOMES = ["accepted", "transformed", "blocked", "insufficient_evidence"] as const;
export const SCOPE_AVAILABILITY = ["ready", "revoked", "expired", "release_unavailable"] as const;
export const TRANSPORT_TYPES = ["direct_http", "browser_bridge"] as const;
export const ALLOWED_OPERATIONS = ["prepare", "send", "observe", "cleanup"] as const;
export const EVIDENCE_STATUSES = [
  "available",
  "partially_redacted",
  "unavailable",
  "expired",
  "purged"
] as const;
export const ACTION_EVIDENCE_STATUSES = [
  "not_applicable",
  "reported",
  "verified_receipts",
  "indeterminate"
] as const;

export const CAPABILITIES_PATH = "/v1/capabilities" as const;
export const EXECUTION_SCOPE_PATH_TEMPLATE = "/v1/execution-scopes/{scopeId}" as const;

export const ORDINARY_CEILINGS = {
  maxCasesPerRun: 20,
  maxExecutions: 60,
  maxCommands: 512,
  maxTurnsPerCase: 3,
  maxRepetitions: 3,
  inventoryCases: 48
} as const;

export const PRODUCTION_SCOPE_DEFAULTS = {
  maxMessages: 3,
  maxActions: 0,
  maxCommands: 60,
  maxRuntimeSeconds: 600,
  maxCredits: 6
} as const;

export const REAL_DATA_ERROR_CODES = [
  "UNSUPPORTED_EXECUTION_SCOPE",
  "INVALID_EXECUTION_SCOPE",
  "UNSUPPORTED_DATA_POLICY",
  "TARGET_AUTHORITY_REQUIRED",
  "TARGET_AUTHORITY_REVOKED",
  "TARGET_AUTHORITY_EXPIRED",
  "TARGET_SCOPE_MISMATCH",
  "DATA_POLICY_FORBIDDEN",
  "ACTION_BOUNDARY_REQUIRED",
  "ACTION_NOT_ALLOWED",
  "EXECUTION_SCOPE_STALE",
  "DATA_POLICY_STALE",
  "REDACTION_PROFILE_MISMATCH",
  "QUOTE_SCOPE_MISMATCH",
  "EVIDENCE_REPRESENTATION_MISMATCH",
  "ACTION_OUTCOME_INDETERMINATE",
  "DATA_POLICY_BLOCKED",
  "INSUFFICIENT_EVIDENCE",
  "EXECUTION_BUDGET_EXHAUSTED",
  "EXECUTION_RELEASE_UNAVAILABLE",
  "HOSTED_AUTHORITY_INTERCHANGE_FORBIDDEN",
  "LOCAL_SCOPE_REVOKED",
  "PRIVACY_SERVICE_UNAVAILABLE"
] as const;

export type RealDataErrorCode = (typeof REAL_DATA_ERROR_CODES)[number];

export const AUDIT_METADATA_KEYS = [
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
  "actorId",
  "actor",
  "audit",
  "serverIssuedAt",
  "correlationId",
  "requestId"
] as const;
