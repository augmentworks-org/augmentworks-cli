export const FEATURE_PACKAGE_VERSION = "aw-feature/1" as const;
export const FEATURE_ERROR_SCHEMA_VERSION = "aw-feature-error/1" as const;
export const RELEASE_POLICY_SCHEMA_VERSION = "aw-release-policy/1" as const;
export const COMPARISON_SCHEMA_VERSION = "aw-comparison/1" as const;
export const BASELINE_DOCUMENT_KIND = "baseline_pin" as const;

export const RELEASE_DECISIONS = ["pass", "block", "incomplete", "incompatible"] as const;
export type ReleaseDecision = (typeof RELEASE_DECISIONS)[number];

export const COMPARABILITY_STATES = ["compatible", "incompatible", "incomplete"] as const;
export type ComparabilityState = (typeof COMPARABILITY_STATES)[number];

// The last five are the server's values (main
// `src/lib/feature-contracts/constants.ts`, `COVERAGE_CHANGE_REASONS`).
export const COVERAGE_CHANGES = [
  "none",
  "added",
  "removed",
  "rescheduled",
  "missing_required",
  "unknown",
  "added_cases",
  "removed_cases",
  "added_and_removed_cases",
  "repetition_count_changed",
  "selection_filter_changed"
] as const;
export type CoverageChange = (typeof COVERAGE_CHANGES)[number];

export const EVALUATION_STATUSES = [
  "complete",
  "pending",
  "running",
  "partial",
  "error",
  "cancelled",
  "absent",
  "unsupported",
  "unknown"
] as const;
export type PolicyEvaluationStatus = (typeof EVALUATION_STATUSES)[number];

export const COMPARISON_CHANGE_GROUPS = [
  "new_required_regressions",
  "fixes",
  "persistent_failures",
  "newly_verified",
  "coverage_changes",
  "incompatible_scope",
  "unresolved"
] as const;
export type ComparisonChangeGroup = (typeof COMPARISON_CHANGE_GROUPS)[number];

export const EXISTING_FAILURE_POLICIES = ["report_do_not_block"] as const;
export type ExistingFailurePolicy = (typeof EXISTING_FAILURE_POLICIES)[number];

export const STABLE_REASON_CODES = [
  "new_required_regression",
  "evaluation_pending",
  "evaluation_incomplete",
  "evaluator_error",
  "missing_required_coverage",
  "incompatible_scope",
  "missing_baseline",
  "unsupported_decision",
  "unknown_evaluation_state",
  "creates_billable_run",
  "promotion_conflict",
  "promotion_forbidden",
  "ambiguous_identity"
] as const;
export type StableReasonCode = (typeof STABLE_REASON_CODES)[number];

export const BASELINE_PROMOTE_ACTION = "baseline:promote" as const;
export const BASELINE_CREATE_ACTION = "baseline:create" as const;

export const RELEASE_POLICY_PATHS = {
  applications: "/v1/applications",
  baselines: "/v1/baselines",
  baselinePromote: "/v1/baselines/{baselineId}/promote",
  comparisonEvaluate: "/v1/comparisons/evaluate",
  releaseGateEvaluate: "/v1/release-gates/evaluate"
} as const;

export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/;
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
