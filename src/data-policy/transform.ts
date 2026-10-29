import { Buffer } from "node:buffer";

import type { JsonValue } from "../config/types.js";
import { CLI_VERSION } from "../version.js";
import {
  detectorMatches,
  isProtectedStructuralValue,
  isSensitiveKey,
  isStructuralKey,
  maskString,
  STRING_LEAF_DETECTORS
} from "./detectors.js";
import { dataPolicyError } from "./errors.js";
import { representationHash } from "./hash.js";
import {
  comparePointersDeepestFirst,
  deleteAtPointer,
  escapeSegment,
  expandSelector,
  formatPointer,
  getAtPointer,
  isPlainObject,
  isPrefixPointer,
  parentPointer,
  setAtPointer,
  assertSafeSegment
} from "./pointers.js";
import {
  assertFreshPolicy,
  assertFreshProfile,
  assertJsonDocument,
  assertPolicyProfileBinding
} from "./schema.js";
import {
  PLACEHOLDERS,
  type ApplyRedactionProfileResult,
  type BlockedPath,
  type DataHandlingCounts,
  type DataHandlingOutcome,
  type DataHandlingReceipt,
  type DataPolicy,
  type InspectOutboundResult,
  type RedactionAction,
  type RedactionDetector,
  type RedactionProfile,
  type RedactionRule
} from "./types.js";

const ACTION_RANK: Record<RedactionAction, number> = {
  block: 3,
  drop: 2,
  mask: 1
};

/**
 * Detectors whose profile rules still apply under `verbatim` content handling
 * (AUG-417). Mirrors the server's rule selection in
 * augmentworks src/lib/data-policy/contract.ts `applyRedactionProfile`:
 * verbatim keeps permitted customer content (email, phone, fields) and only
 * credential and exact-local-secret rules run; minimized runs every rule.
 * Keep the two identical.
 */
export const VERBATIM_RULE_DETECTORS: ReadonlySet<RedactionDetector> = new Set([
  "credential",
  "exact_local_secret"
]);

/** The profile rules that apply under the policy's content handling. */
export function activeRedactionRules(
  profile: Pick<RedactionProfile, "rules">,
  policy: Pick<DataPolicy, "contentHandling">
): readonly RedactionRule[] {
  if (policy.contentHandling === "verbatim") {
    return profile.rules.filter((rule) => VERBATIM_RULE_DETECTORS.has(rule.detector));
  }
  return profile.rules;
}

interface PlannedAction {
  path: string;
  action: RedactionAction;
  ruleId: string;
  detector: RedactionDetector;
  detectors: Set<RedactionDetector>;
}

export function applyRedactionProfile(
  input: unknown,
  profile: RedactionProfile,
  policy: DataPolicy,
  secrets: readonly string[]
): ApplyRedactionProfileResult {
  assertFreshPolicy(policy);
  assertFreshProfile(profile);
  assertPolicyProfileBinding(policy, profile);
  assertJsonDocument(input, "outbound document");
  const localSecrets = [...new Set(secrets.filter((secret) => secret.length > 0))];
  assertDocumentBounds(input, profile);

  let representation = cloneJson(input);
  const planned = new Map<string, PlannedAction>();
  collectImplicitActions(representation, localSecrets, planned);
  collectRuleActions(representation, activeRedactionRules(profile, policy), localSecrets, planned);
  if (policy.contentHandling === "minimized") {
    collectAllowlistDrops(representation, profile, planned);
  }

  const applied = applyPlannedActions(representation, planned, localSecrets);
  representation = applied.representation;
  return {
    representation,
    counts: applied.counts,
    blockedPaths: applied.blockedPaths,
    maskedPaths: applied.maskedPaths,
    droppedPaths: applied.droppedPaths
  };
}

export function sealDataHandlingReceipt(options: {
  readonly policy: DataPolicy;
  readonly profile: RedactionProfile;
  readonly representation: JsonValue;
  readonly counts: DataHandlingCounts;
  readonly processor?: "cli" | "server";
  readonly processorVersion?: string;
  readonly outcome?: DataHandlingOutcome;
}): DataHandlingReceipt {
  const { counts } = options;
  const outcome =
    options.outcome ??
    (counts.blocked > 0 ? "blocked" : counts.dropped + counts.masked > 0 ? "transformed" : "accepted");
  return {
    schemaVersion: "aw-data-handling-receipt/1",
    policyId: options.policy.policyId,
    policyHash: options.policy.policyHash,
    profileHash: options.profile.profileHash,
    representationHash: representationHash(options.representation),
    outcome,
    counts: {
      dropped: counts.dropped,
      masked: counts.masked,
      blocked: counts.blocked
    },
    processor: options.processor ?? "cli",
    processorVersion: options.processorVersion ?? CLI_VERSION
  };
}

export function inspectOutbound(
  document: unknown,
  policy: DataPolicy,
  profile: RedactionProfile,
  localSecrets: readonly string[]
): InspectOutboundResult {
  const applied = applyRedactionProfile(document, profile, policy, localSecrets);
  const receipt = sealDataHandlingReceipt({
    policy,
    profile,
    representation: applied.representation,
    counts: applied.counts
  });
  return {
    representation: applied.representation,
    receipt,
    blockedPaths: applied.blockedPaths
  };
}

function assertDocumentBounds(input: JsonValue, profile: RedactionProfile): void {
  const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  if (bytes > profile.maxDocumentBytes) {
    throw dataPolicyError(
      "DATA_POLICY_BLOCKED",
      "The outbound document exceeds the redaction profile size limit."
    );
  }
  walkStrings(input, (text) => {
    if ([...text].length > profile.maxTextChars) {
      throw dataPolicyError(
        "DATA_POLICY_BLOCKED",
        "The outbound document contains a string that exceeds the redaction profile text limit."
      );
    }
  });
}

function collectImplicitActions(
  document: JsonValue,
  secrets: readonly string[],
  planned: Map<string, PlannedAction>
): void {
  walkNodes(document, [], "", (path, key, value) => {
    if (isSensitiveKey(key) && !isProtectedStructuralValue(key, value)) {
      mergeAction(planned, {
        path,
        action: "mask",
        ruleId: "implicit:credential",
        detector: "credential"
      });
      return;
    }
    if (typeof value !== "string" || isProtectedStructuralValue(key, value)) return;
    const detectors = new Set<RedactionDetector>(["credential", "exact_local_secret"]);
    const masked = maskString(value, key, secrets, detectors);
    if (!masked.changed) return;
    const detector: RedactionDetector = secrets.some((secret) => secret.length > 0 && value.includes(secret))
      ? "exact_local_secret"
      : "credential";
    mergeAction(planned, {
      path,
      action: "mask",
      ruleId: detector === "exact_local_secret" ? "implicit:exact_local_secret" : "implicit:credential",
      detector
    });
  });
}

function collectRuleActions(
  document: JsonValue,
  rules: readonly RedactionRule[],
  secrets: readonly string[],
  planned: Map<string, PlannedAction>
): void {
  for (const rule of rules) {
    const pointers = expandSelector(rule.selector, document);
    for (const pointer of pointers) {
      const selected = pointer === "" ? document : getAtPointer(document, pointer);
      // Email and phone rules reach every string leaf under the selected node
      // (AUG-400): a relay reply is { role, content }, not a string.
      const targets = STRING_LEAF_DETECTORS.has(rule.detector)
        ? stringLeaves(pointer, selected)
        : [{ path: pointer, value: selected }];
      for (const { path, value } of targets) {
        const key = leafKey(path);
        if (!detectorMatches(rule.detector, key, value, secrets)) continue;
        if (isProtectedStructuralValue(key, value) && rule.detector !== "field") continue;
        mergeAction(planned, {
          path,
          action: rule.action,
          ruleId: rule.id,
          detector: rule.detector
        });
      }
    }
  }
}

function collectAllowlistDrops(
  document: JsonValue,
  profile: RedactionProfile,
  planned: Map<string, PlannedAction>
): void {
  if (profile.allowedContentFields.length === 0) return;
  const allowed = new Set<string>();
  for (const selector of profile.allowedContentFields) {
    for (const path of expandSelector(selector, document)) allowed.add(path);
  }
  walkNodes(document, [], "", (path, key) => {
    if (path === "") return;
    if (isStructuralKey(key)) return;
    if (isAllowedPath(path, allowed)) return;
    mergeAction(planned, {
      path,
      action: "drop",
      ruleId: "allowlist:minimized",
      detector: "field"
    });
  });
}

function applyPlannedActions(
  document: JsonValue,
  planned: Map<string, PlannedAction>,
  secrets: readonly string[]
): {
  representation: JsonValue;
  counts: DataHandlingCounts;
  blockedPaths: BlockedPath[];
  maskedPaths: string[];
  droppedPaths: string[];
} {
  const actions = [...planned.values()].sort((left, right) => comparePointersDeepestFirst(left.path, right.path));
  const blockedPaths: BlockedPath[] = [];
  const maskedPaths: string[] = [];
  const droppedPaths: string[] = [];
  let representation = document;
  const removed = new Set<string>();

  for (const action of actions) {
    if ([...removed].some((prefix) => isPrefixPointer(prefix, action.path))) continue;
    const key = leafKey(action.path);
    const current = action.path === "" ? representation : getAtPointer(representation, action.path);
    if (current === undefined) continue;

    if (action.action === "block") {
      representation = deleteAtPointer(representation, action.path);
      removed.add(action.path);
      blockedPaths.push({ path: action.path, action: "block", ruleId: action.ruleId });
      continue;
    }
    if (action.action === "drop") {
      representation = deleteAtPointer(representation, action.path);
      removed.add(action.path);
      droppedPaths.push(action.path);
      continue;
    }

    const replacement = maskValue(current, key, action, secrets);
    representation = setAtPointer(representation, action.path, replacement);
    maskedPaths.push(action.path);
  }

  return {
    representation,
    counts: {
      dropped: droppedPaths.length,
      masked: maskedPaths.length,
      blocked: blockedPaths.length
    },
    blockedPaths,
    maskedPaths,
    droppedPaths
  };
}

function maskValue(
  value: unknown,
  key: string,
  action: PlannedAction,
  secrets: readonly string[]
): JsonValue {
  if (typeof value === "string") {
    if (action.detectors.has("field") && action.detectors.size === 1) return PLACEHOLDERS.field;
    const detectors = new Set<RedactionDetector>(action.detectors);
    if (detectors.has("credential") || detectors.has("exact_local_secret")) {
      detectors.add("credential");
      detectors.add("exact_local_secret");
    }
    if (action.detectors.has("field") && detectors.size === 1) {
      return PLACEHOLDERS.field;
    }
    const masked = maskString(value, key, secrets, detectors);
    if (masked.changed) return masked.text;
    if (action.detectors.has("field")) return PLACEHOLDERS.field;
    return placeholderFor(action.detector);
  }
  return placeholderFor(action.detector);
}

function placeholderFor(detector: RedactionDetector): string {
  switch (detector) {
    case "credential":
      return PLACEHOLDERS.credential;
    case "email":
      return PLACEHOLDERS.email;
    case "phone":
      return PLACEHOLDERS.phone;
    case "exact_local_secret":
      return PLACEHOLDERS.exact_local_secret;
    case "field":
      return PLACEHOLDERS.field;
  }
}

function mergeAction(
  planned: Map<string, PlannedAction>,
  next: {
    readonly path: string;
    readonly action: RedactionAction;
    readonly ruleId: string;
    readonly detector: RedactionDetector;
  }
): void {
  const incoming: PlannedAction = {
    ...next,
    detectors: new Set([next.detector])
  };
  const existing = planned.get(next.path);
  if (existing === undefined) {
    planned.set(next.path, incoming);
    return;
  }
  if (ACTION_RANK[incoming.action] > ACTION_RANK[existing.action]) {
    planned.set(next.path, {
      ...incoming,
      detectors: new Set([...existing.detectors, ...incoming.detectors])
    });
    return;
  }
  if (incoming.action === existing.action) {
    for (const detector of incoming.detectors) existing.detectors.add(detector);
  }
}

function isAllowedPath(path: string, allowed: ReadonlySet<string>): boolean {
  for (const candidate of allowed) {
    if (candidate === path || isPrefixPointer(candidate, path) || isPrefixPointer(path, candidate)) {
      return true;
    }
  }
  return false;
}

function leafKey(pointer: string): string {
  const parent = parentPointer(pointer);
  return parent?.leaf ?? "";
}

function walkNodes(
  node: JsonValue,
  prefix: readonly string[],
  key: string,
  visit: (path: string, key: string, value: JsonValue) => void
): void {
  visit(formatPointer(prefix), key, node);
  if (Array.isArray(node)) {
    node.forEach((child, index) => {
      walkNodes(child as JsonValue, [...prefix, String(index)], key, visit);
    });
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [childKey, child] of Object.entries(node)) {
    assertSafeSegment(childKey, "document key");
    walkNodes(child as JsonValue, [...prefix, childKey], childKey, visit);
  }
}

function stringLeaves(pointer: string, node: unknown): Array<{ path: string; value: string }> {
  if (typeof node === "string") return [{ path: pointer, value: node }];
  const leaves: Array<{ path: string; value: string }> = [];
  if (Array.isArray(node)) {
    node.forEach((child, index) => {
      leaves.push(...stringLeaves(`${pointer}/${index}`, child));
    });
  } else if (isPlainObject(node)) {
    for (const [childKey, child] of Object.entries(node)) {
      leaves.push(...stringLeaves(`${pointer}/${escapeSegment(childKey)}`, child));
    }
  }
  return leaves;
}

function walkStrings(node: JsonValue, visit: (text: string) => void): void {
  if (typeof node === "string") {
    visit(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walkStrings(child as JsonValue, visit);
    return;
  }
  if (!isPlainObject(node)) return;
  for (const child of Object.values(node)) walkStrings(child as JsonValue, visit);
}

function cloneJson(value: JsonValue, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) {
    throw dataPolicyError("INVALID_DATA_POLICY", "The outbound document contains a cycle.");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const copy = value.map((child) => cloneJson(child as JsonValue, seen));
    seen.delete(value);
    return copy;
  }
  const copy: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    assertSafeSegment(key, "document key");
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cloneJson(child as JsonValue, seen)
    });
  }
  seen.delete(value);
  return copy;
}

export function effectivePolicySummary(
  policy: DataPolicy,
  profile: RedactionProfile
): {
  readonly dataClass: DataPolicy["dataClass"];
  readonly contentHandling: DataPolicy["contentHandling"];
  readonly retentionDays: number;
  readonly externalSharing: DataPolicy["externalSharing"];
  readonly providerProcessing: DataPolicy["providerProcessing"];
  readonly profileId: string;
  readonly policyId: string;
  readonly revision: number;
} {
  assertPolicyProfileBinding(policy, profile);
  return {
    dataClass: policy.dataClass,
    contentHandling: policy.contentHandling,
    retentionDays: policy.retentionDays,
    externalSharing: policy.externalSharing,
    providerProcessing: policy.providerProcessing,
    profileId: profile.profileId,
    policyId: policy.policyId,
    revision: policy.revision
  };
}
