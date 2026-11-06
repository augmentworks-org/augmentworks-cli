const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const maxItems = 50;
const requirementOutcomes = ["pass", "fail", "inconclusive", "error", "not_run"];
const credential = /(?:aw_(?:api|connector|refresh)_|gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]+/i;
const toolMetadata = {
  list_applications: {
    title: "List applications and pinned baselines",
    description: "Discover application environments and pinned baselines in this workspace. A pin includes its baseline ID and source run ID. Unpinned run history is available in the AugmentWorks dashboard.",
    required: {},
    optional: {},
  },
  get_run_report: {
    title: "Read a hosted run report",
    description: "Get the saved run's execution status, evaluation outcome, coverage, and failed requirement IDs. Pending evaluations can have a null outcome.",
    required: { run_id: "Hosted run UUID" },
    optional: {},
  },
  compare_runs: {
    title: "Compare hosted runs",
    description: "Compare a saved candidate to a pinned baseline or earlier run. Supply exactly one baseline selector. Inspect comparability and coverage before interpreting changed checks.",
    required: { candidate_run_id: "Hosted candidate run UUID" },
    optional: { baseline_id: "Pinned baseline UUID", baseline_run_id: "Earlier hosted run UUID" },
  },
};

function hasOneBaseline(args) {
  return Object.hasOwn(args, "baseline_id") !== Object.hasOwn(args, "baseline_run_id");
}

// The caller provides its SDK's Zod namespace; this package ships no transport or SDK runtime.
export function createReadToolDefinitions(z) {
  const id = z.string().regex(uuid, "Expected a UUID");
  const definitions = {};
  for (const [name, { title, description, required, optional }] of Object.entries(toolMetadata)) {
    const shape = {};
    for (const [key, label] of Object.entries(required)) shape[key] = id.describe(label);
    for (const [key, label] of Object.entries(optional)) shape[key] = id.optional().describe(label);
    let inputSchema = z.strictObject(shape);
    if (name === "compare_runs") {
      inputSchema = inputSchema.refine(hasOneBaseline, "Supply exactly one of baseline_id or baseline_run_id");
    }
    definitions[name] = {
      title, description, inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    };
  }
  return definitions;
}

export function parseReadToolArgs(name, args) {
  if (typeof name !== "string" || !Object.hasOwn(toolMetadata, name)) {
    throw new Error("Unknown AugmentWorks workspace tool.");
  }
  const { required, optional } = toolMetadata[name];
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      !(Object.getPrototypeOf(args) === null || Object.getPrototypeOf(args) === Object.prototype)) {
    throw new Error("Invalid workspace tool arguments. Use only the documented UUID fields.");
  }
  for (const [key, value] of Object.entries(args)) {
    if ((!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) ||
        typeof value !== "string" || !uuid.test(value)) {
      throw new Error("Invalid workspace tool arguments. Use only the documented UUID fields.");
    }
  }
  if (Object.keys(required).some(key => !Object.hasOwn(args, key))) {
    throw new Error(name === "get_run_report" ? "A run_id UUID is required." : "A candidate_run_id UUID is required.");
  }
  if (name === "compare_runs" && !hasOneBaseline(args)) {
    throw new Error("Supply exactly one of baseline_id or baseline_run_id");
  }
  return { ...args };
}

function check(value) {
  if (!value) throw new Error("AugmentWorks returned an unexpected workspace response.");
}

function responseId(value) {
  check(typeof value === "string" && uuid.test(value));
  return value.toLowerCase();
}

function name(value) {
  check(typeof value === "string" && value.length > 0 && value.length <= 200);
  return credential.test(value) ? "[redacted]" : value.replace(/\p{C}/gu, " ");
}

function identifier(value) {
  check(typeof value === "string");
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/.test(value) && !credential.test(value)
    ? value : "[redacted]";
}

function choice(value, allowed) {
  check(allowed.includes(value));
  return value;
}

function count(value) {
  check(Number.isSafeInteger(value) && value >= 0);
  return value;
}

function bounded(items, project) {
  check(Array.isArray(items));
  return items.slice(0, maxItems).map(project);
}

// Check every identity the authorized service returned, including rows hidden by truncation.
// When the transport asks for a bound workspace, an unscoped payload must fail closed.
function workspaceOf(ids, expectedWorkspaceId) {
  const workspaces = new Set(ids.map(responseId));
  check(workspaces.size <= 1);
  const workspaceId = workspaces.values().next().value ?? null;
  if (expectedWorkspaceId !== undefined) {
    check(workspaceId === responseId(expectedWorkspaceId));
  }
  return workspaceId;
}

function suppliedWorkspaceIds(...objects) {
  return objects.filter(obj => obj && Object.hasOwn(obj, "workspaceId")).map(obj => obj.workspaceId);
}

function portalOrigin(value = "https://augmentworks.ai") {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.origin === value) return value;
  } catch {
    // Report a configuration error without including any part of the supplied URL.
  }
  throw new Error("A canonical HTTPS AugmentWorks portal origin is required.");
}

function applications(data, expectedWorkspaceId) {
  check(data.ok === true && Array.isArray(data.applications) && Array.isArray(data.baselines));
  const rowWorkspaces = [...data.applications, ...data.baselines].map(item => item?.workspaceId);
  const workspaceId = workspaceOf([...suppliedWorkspaceIds(data), ...rowWorkspaces], expectedWorkspaceId);
  return {
    workspaceId,
    applicationEnvironmentCount: data.applications.length,
    baselineCount: data.baselines.length,
    applications: bounded(data.applications, item => {
      check(item.schemaVersion === "aw-application-identity/1");
      return {
        applicationId: responseId(item.applicationId), applicationName: name(item.applicationName),
        environmentId: responseId(item.environmentId), environmentName: name(item.environmentName),
      };
    }),
    baselines: bounded(data.baselines, item => {
      check(item.schemaVersion === "aw-baseline/1");
      return {
        baselineId: responseId(item.baselineId), name: name(item.name), runId: responseId(item.runId),
        applicationId: responseId(item.applicationId), environmentId: responseId(item.environmentId),
      };
    }),
    truncated: data.applications.length > maxItems || data.baselines.length > maxItems,
  };
}

function runReport(data, args, options) {
  check(data.schemaVersion === "aw-run-report/1" && responseId(data.runId) === args.run_id.toLowerCase());
  check(typeof data.reportReady === "boolean" && data.coverage && (data.aggregate === null || typeof data.aggregate === "object"));
  const coverage = {};
  for (const field of ["plannedAttempts", "completedAttempts", "requiredJudgmentsPlanned", "requiredJudgmentsComplete"]) {
    const value = data.coverage[field];
    coverage[field] = value === null ? null : count(value);
  }
  const failures = data.aggregate?.knownRequiredFailures;
  return {
    runId: responseId(data.runId), workspaceId: workspaceOf([data.workspaceId], options.expectedWorkspaceId),
    dashboardUrl: portalOrigin(options.portalOrigin) + "/portal/runs/" + responseId(data.runId),
    executionStatus: choice(data.executionStatus, ["queued", "connected", "running", "cancel_requested", "cancelled", "completed", "failed"]),
    evaluationStatus: choice(data.evaluationStatus, ["absent", "pending", "complete", "partial", "error"]),
    outcome: choice(data.outcome, [null, "passed", "failed", "inconclusive", "error"]),
    reportReady: data.reportReady, coverage,
    requirementOutcome: choice(data.aggregate?.requirementOutcome ?? null, [null, ...requirementOutcomes]),
    knownRequiredFailures: failures == null ? null : bounded(failures, identifier),
    knownRequiredFailureCount: failures == null ? null : failures.length,
  };
}

function comparison(data, args, expectedWorkspaceId) {
  check(data.schemaVersion === "aw-semantic-comparison-read/1");
  const cmp = data.comparison;
  check(cmp && cmp.createsBillableRun !== true && responseId(cmp.candidateRunId) === args.candidate_run_id.toLowerCase());
  const baselineRunId = responseId(cmp.baselineRunId);
  workspaceOf(suppliedWorkspaceIds(data, cmp, data.inputRevisions), expectedWorkspaceId);
  check(!args.baseline_run_id || baselineRunId === args.baseline_run_id.toLowerCase());
  check(Array.isArray(cmp.comparedCases) && Array.isArray(cmp.compatibilityReasons));
  if (data.inputRevisions) {
    check(responseId(data.inputRevisions.candidateRunId) === responseId(cmp.candidateRunId));
    check(responseId(data.inputRevisions.baselineRunId) === baselineRunId);
  }
  const cases = cmp.comparedCases.map(item => {
    check(item && typeof item === "object");
    return {
      caseId: identifier(item.caseId), criterionId: identifier(item.criterionId), repetitionIndex: count(item.repetitionIndex),
      requirement: choice(item.requirement, ["required", "advisory"]),
      baselineOutcome: choice(item.baselineOutcome, [null, ...requirementOutcomes]),
      candidateOutcome: choice(item.candidateOutcome, [null, ...requirementOutcomes]),
      change: choice(item.change ?? null, [null, "improved", "result_established", "now_verified", "coverage_differed", "unchanged", "regressed", "not_comparable", "added", "removed", "not_run"]),
      category: choice(item.category ?? null, [null, "new_required_failure", "fixed_required_failure", "persistent_required_failure", "newly_verified", "added_case", "removed_case", "advisory_only_change"]),
    };
  });
  // Earlier evidence records carry outcomes and a category without a change label.
  const changed = cases.filter(item => item.category !== null ||
    (item.change === null ? item.baselineOutcome !== item.candidateOutcome : item.change !== "unchanged"));
  return {
    baselineRunId, candidateRunId: responseId(cmp.candidateRunId),
    comparability: choice(cmp.comparability, ["compatible", "incompatible", "incomplete"]),
    compatibilityReasons: bounded(cmp.compatibilityReasons, identifier),
    coverageChange: choice(cmp.coverageChange, ["none", "added_cases", "removed_cases", "added_and_removed_cases", "repetition_count_changed", "selection_filter_changed"]),
    evaluationStatus: choice(cmp.evaluationStatus, ["pending", "running", "complete", "partial", "error", "cancelled"]),
    candidateRequirementOutcome: choice(cmp.candidateRequirementOutcome ?? null, [null, ...requirementOutcomes]),
    totalCases: cmp.comparedCases.length, changedOrFlaggedCases: changed.length,
    comparedCases: changed.slice(0, maxItems),
    truncated: changed.length > maxItems,
  };
}

export function projectReadToolResult(name, args, data, options = {}) {
  const parsed = parseReadToolArgs(name, args);
  check(data?.createsBillableRun === false);
  switch (name) {
    case "list_applications": return applications(data, options.expectedWorkspaceId);
    case "get_run_report": return runReport(data, parsed, options);
    case "compare_runs": return comparison(data, parsed, options.expectedWorkspaceId);
  }
}
