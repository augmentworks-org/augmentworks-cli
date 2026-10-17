import { Buffer } from "node:buffer";

import type {
  AugmentWorksConfig,
  Diagnostic,
  JsonValue,
  OperationResponseMap
} from "../config/types.js";
import { AwError, type OperationKind } from "../errors.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import { LIMITS } from "../util/limits.js";
import { redactSecrets, selectResponse } from "./mapping.js";
import {
  normalizeConnectorResult,
  omittedMappedResponseReason,
  shouldOmitMappedResponseField
} from "./normalize.js";
import type { ConnectorExecutionContext, ConnectorResult } from "./types.js";
import {
  effectivePolicySummary,
  inspectOutbound,
  inspectRelayResult,
  type DataHandlingReceipt,
  type DataPolicy,
  type EffectivePolicySummary,
  type RedactionProfile
} from "../data-policy/index.js";
import { maskJsonForDisplay } from "../data-policy/detectors.js";

export const MAPPING_PREVIEW_SCHEMA_VERSION = "AW-MAPPING-PREVIEW-1" as const;

export const MAPPING_PREVIEW_DISCLAIMER =
  "This preview applies the production mapping, allowlist, redaction, and evidence limits to the supplied fixture only. It does not call the target, AugmentWorks, or a model, consumes no credits, and does not guarantee that future responses are secret-free.";

const DISPLAY_PREVIEW_CHARS = 240;
const SYNTHETIC_TURN_ID = "preview_turn";
const SYNTHETIC_ATTEMPT_ID = "preview_attempt";
const SYNTHETIC_REQUEST_ID = "preview_request";

const KNOWN_SEND_ROOT_FIELDS = [
  "protocol_version",
  "turn_id",
  "message",
  "content",
  "finish_reason",
  "events",
  "tool_events",
  "finished",
  "metadata"
] as const;

const KNOWN_PREPARE_ROOT_FIELDS = [
  "protocol_version",
  "status",
  "attempt_id",
  "target_session_id",
  "metadata"
] as const;

const KNOWN_OBSERVE_ROOT_FIELDS = ["protocol_version", "request_id", "observations", "metadata"] as const;

export type MappingPreviewValueKind = "string" | "number" | "boolean" | "null" | "array" | "object";

export interface MappingPreviewExtractedField {
  readonly field: string;
  readonly selector: string;
  readonly path: string;
  readonly value_kind: MappingPreviewValueKind;
  readonly bytes: number;
  readonly redacted: boolean;
  readonly display_truncated: boolean;
  readonly preview: string;
}

export interface MappingPreviewMissingField {
  readonly field: string;
  readonly selector: string;
  readonly path: string;
  readonly code: string;
}

export interface MappingPreviewOmittedField {
  readonly field: string;
  readonly selector: string;
  readonly path: string;
  readonly reason: string;
}

export interface MappingPreviewRedaction {
  readonly field: string;
  readonly path: string;
  readonly preview: string;
}

export interface MappingPreviewTruncation {
  readonly field: string;
  readonly path: string;
  readonly decision: "rejected";
  readonly limit_bytes: number;
  readonly actual_bytes: number;
  readonly code: string;
  readonly message: string;
}

export interface MappingPreviewEvidence {
  readonly protocol_version: "aw-target/0.1";
  readonly canonical: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly result: ConnectorResult;
}

export interface MappingPreviewRequest {
  readonly config: AugmentWorksConfig;
  readonly operation: OperationKind;
  readonly response?: JsonValue;
  readonly secrets?: readonly string[];
  readonly probeKeys?: readonly string[];
  readonly configPath?: string;
  readonly fixturePath?: string;
  readonly policy?: DataPolicy;
  readonly profile?: RedactionProfile;
}

export interface MappingPreviewPrivacy {
  readonly hosted_real_data_release: "unavailable";
  readonly effective: EffectivePolicySummary;
  readonly receipt: DataHandlingReceipt;
  readonly retained_field_count: number;
  readonly blocked_paths: readonly { readonly path: string; readonly action: string; readonly ruleId: string }[];
  readonly missing_facts: readonly string[];
  readonly limits: {
    readonly max_document_bytes: number;
    readonly max_text_chars: number;
  };
}

export interface MappingPreviewReport {
  readonly schema_version: typeof MAPPING_PREVIEW_SCHEMA_VERSION;
  readonly ok: boolean;
  readonly offline: true;
  readonly credits_consumed: 0;
  readonly operation: OperationKind;
  readonly config_path: string | null;
  readonly fixture_path: string | null;
  readonly extracted: readonly MappingPreviewExtractedField[];
  readonly missing: readonly MappingPreviewMissingField[];
  readonly omitted: readonly MappingPreviewOmittedField[];
  readonly redacted: readonly MappingPreviewRedaction[];
  readonly truncation: readonly MappingPreviewTruncation[];
  readonly diagnostics: readonly Diagnostic[];
  readonly evidence: MappingPreviewEvidence | null;
  readonly privacy?: MappingPreviewPrivacy | null;
  readonly disclaimer: typeof MAPPING_PREVIEW_DISCLAIMER;
}

interface FieldInspection {
  extracted: MappingPreviewExtractedField[];
  missing: MappingPreviewMissingField[];
  omitted: MappingPreviewOmittedField[];
  redacted: MappingPreviewRedaction[];
  truncation: MappingPreviewTruncation[];
  diagnostics: Diagnostic[];
  selected: Map<string, JsonValue>;
  mappingFailed: boolean;
}

export function previewMapping(request: MappingPreviewRequest): MappingPreviewReport {
  const secrets = [...new Set((request.secrets ?? []).filter((secret) => secret.length > 0))];
  const diagnostics: Diagnostic[] = [];
  const operation = request.config.target.operations[request.operation];
  if (operation === undefined) {
    diagnostics.push({
      level: "error",
      code: "CONNECTOR_OPERATION_NOT_CONFIGURED",
      message: `The ${request.operation} operation is not configured.`,
      path: `target.operations.${request.operation}`
    });
    return finalizeReport(request, emptyInspection(), diagnostics, null);
  }

  const allowToolEvents = request.config.telemetry?.allow_tool_events === true;
  const allowedObservations = new Set(request.config.telemetry?.allow_observations ?? []);
  const omitOptions = { allowToolEvents, allowedObservations };
  const probeKeys = resolveProbeKeys(request, allowedObservations, diagnostics);
  const inspection =
    operation.response === undefined
      ? inspectRootFields(request.operation, request.response, omitOptions, secrets, diagnostics)
      : inspectMappedFields(
          request.operation,
          request.response,
          operation.response,
          omitOptions,
          secrets
        );

  if (request.operation === "send" && !sendHasContent(inspection.selected)) {
    const alreadyMissing = inspection.missing.some((item) => item.field === "content" || item.field === "message");
    if (!alreadyMissing) {
      inspection.diagnostics.push({
        level: "error",
        code: "REQUIRED_FIELD_MISSING",
        message:
          "Send evidence requires assistant content. Map target.operations.send.response.content (or message) to a string in the fixture.",
        path: "target.operations.send.response.content"
      });
      inspection.missing.push({
        field: "content",
        selector: operation.response?.["content"] ?? operation.response?.["message"] ?? "$.content",
        path: "target.operations.send.response.content",
        code: "REQUIRED_FIELD_MISSING"
      });
    }
  }

  if (request.operation === "observe" && allowedObservations.size > 0 && operation.response !== undefined) {
    const mappedAllowed = Object.keys(operation.response).filter(
      (field) => !shouldOmitMappedResponseField("observe", field, omitOptions)
    );
    if (
      mappedAllowed.length > 0 &&
      mappedAllowed.every((field) => inspection.missing.some((item) => item.field === field))
    ) {
      inspection.diagnostics.push({
        level: "error",
        code: "REQUIRED_FIELD_MISSING",
        message: "Observe evidence has no allowlisted mapped fields in this fixture.",
        path: "target.operations.observe.response"
      });
    }
  }

  diagnostics.push(...inspection.diagnostics);
  const blocked =
    inspection.mappingFailed ||
    inspection.missing.length > 0 ||
    inspection.truncation.length > 0 ||
    diagnostics.some((item) => item.level === "error");

  let evidence: MappingPreviewEvidence | null = null;
  if (!blocked) {
    try {
      evidence = serializeEvidence(request, inspection.selected, probeKeys, secrets);
    } catch (error) {
      if (error instanceof AwError) {
        diagnostics.push({
          level: "error",
          code: error.code,
          message: error.message,
          ...(error.operation === undefined
            ? {}
            : { path: `target.operations.${error.operation}` })
        });
      } else {
        diagnostics.push({
          level: "error",
          code: "MAPPING_PREVIEW_FAILED",
          message: "The fixture could not be projected through the production evidence pipeline."
        });
      }
    }
  }

  let privacy: MappingPreviewPrivacy | null = null;
  if (request.policy !== undefined && request.profile !== undefined) {
    try {
      const privacyResult = applyPrivacyPreview(request, inspection, evidence, diagnostics);
      privacy = privacyResult.privacy;
      evidence = privacyResult.evidence;
    } catch (error) {
      if (error instanceof AwError) {
        diagnostics.push({
          level: "error",
          code: error.code,
          message: error.message
        });
        evidence = null;
      } else {
        diagnostics.push({
          level: "error",
          code: "DATA_POLICY_BLOCKED",
          message: "The data policy could not be applied to this fixture."
        });
        evidence = null;
      }
    }
  }

  return finalizeReport(request, inspection, diagnostics, evidence, privacy);
}

export function isMappingPreviewOperation(value: string): value is OperationKind {
  return value === "prepare" || value === "send" || value === "observe" || value === "cleanup";
}

function inspectMappedFields(
  kind: OperationKind,
  response: JsonValue | undefined,
  responseMap: OperationResponseMap,
  omitOptions: {
    readonly allowToolEvents: boolean;
    readonly allowedObservations: ReadonlySet<string>;
  },
  secrets: readonly string[]
): FieldInspection {
  const inspection = emptyInspection();
  if (response === undefined) {
    inspection.mappingFailed = true;
    inspection.diagnostics.push({
      level: "error",
      code: "TARGET_RESPONSE_REQUIRED",
      message: "The configured response mapping requires a JSON response fixture.",
      path: `target.operations.${kind}.response`
    });
    return inspection;
  }

  const entries = Object.entries(responseMap).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [field, selector] of entries) {
    const path = `target.operations.${kind}.response.${field}`;
    if (shouldOmitMappedResponseField(kind, field, omitOptions)) {
      inspection.omitted.push({
        field,
        selector,
        path,
        reason: omittedMappedResponseReason(kind, field, omitOptions)
      });
      continue;
    }
    try {
      recordSelectedField(inspection, field, selector, path, selectResponse(response, selector), secrets);
    } catch (error) {
      inspection.mappingFailed = true;
      recordSelectionError(inspection, field, selector, path, error);
    }
  }
  return inspection;
}

function inspectRootFields(
  kind: OperationKind,
  response: JsonValue | undefined,
  omitOptions: {
    readonly allowToolEvents: boolean;
    readonly allowedObservations: ReadonlySet<string>;
  },
  secrets: readonly string[],
  diagnostics: Diagnostic[]
): FieldInspection {
  const inspection = emptyInspection();
  if (kind === "cleanup") {
    return inspection;
  }
  if (response === undefined) {
    if (kind === "prepare") return inspection;
    inspection.mappingFailed = true;
    diagnostics.push({
      level: "error",
      code: "TARGET_RESPONSE_EMPTY",
      message: "A JSON response fixture is required for this operation.",
      path: `target.operations.${kind}`
    });
    return inspection;
  }
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    inspection.mappingFailed = true;
    diagnostics.push({
      level: "error",
      code: "INVALID_TARGET_RESPONSE",
      message: `${kind} response must be a JSON object.`,
      path: `target.operations.${kind}`
    });
    return inspection;
  }

  const fields =
    kind === "send" ? KNOWN_SEND_ROOT_FIELDS : kind === "prepare" ? KNOWN_PREPARE_ROOT_FIELDS : KNOWN_OBSERVE_ROOT_FIELDS;
  for (const field of fields) {
    if (!Object.hasOwn(response, field)) continue;
    const path = `target.operations.${kind}.response.${field}`;
    const selector = `$.${field}`;
    if (shouldOmitMappedResponseField(kind, field, omitOptions)) {
      inspection.omitted.push({
        field,
        selector,
        path,
        reason: omittedMappedResponseReason(kind, field, omitOptions)
      });
      continue;
    }
    try {
      recordSelectedField(inspection, field, selector, path, selectResponse(response, selector), secrets);
    } catch (error) {
      inspection.mappingFailed = true;
      recordSelectionError(inspection, field, selector, path, error);
    }
  }
  return inspection;
}

function recordSelectedField(
  inspection: FieldInspection,
  field: string,
  selector: string,
  path: string,
  selected: JsonValue,
  secrets: readonly string[]
): void {
  const redactedValue = redactSecrets(selected, secrets);
  const redacted = canonicalize(selected) !== canonicalize(redactedValue);
  const display = displayPreview(redactedValue);
  const extracted: MappingPreviewExtractedField = {
    field,
    selector,
    path,
    value_kind: jsonKind(redactedValue),
    bytes: Buffer.byteLength(canonicalize(redactedValue), "utf8"),
    redacted,
    display_truncated: display.truncated,
    preview: display.text
  };
  inspection.extracted.push(extracted);
  inspection.selected.set(field, selected);
  if (redacted) {
    inspection.redacted.push({ field, path, preview: display.text });
  }
  const limit = contentLimit(field, selected);
  if (limit !== undefined && limit.actual_bytes > limit.limit_bytes) {
    inspection.truncation.push({
      field,
      path,
      decision: "rejected",
      limit_bytes: limit.limit_bytes,
      actual_bytes: limit.actual_bytes,
      code: "TARGET_MESSAGE_TOO_LARGE",
      message: `Assistant content is ${String(limit.actual_bytes)} bytes and exceeds the ${String(limit.limit_bytes)}-byte evidence limit.`
    });
    inspection.diagnostics.push({
      level: "error",
      code: "TARGET_MESSAGE_TOO_LARGE",
      message: `Assistant content is ${String(limit.actual_bytes)} bytes and exceeds the ${String(limit.limit_bytes)}-byte evidence limit.`,
      path
    });
  }
}

function recordSelectionError(
  inspection: FieldInspection,
  field: string,
  selector: string,
  path: string,
  error: unknown
): void {
  if (error instanceof AwError) {
    const location = selectorLocation(error, selector);
    inspection.diagnostics.push({
      level: "error",
      code: error.code,
      message: location,
      path
    });
    if (error.code === "MAPPING_VALUE_MISSING" || error.code === "REQUIRED_FIELD_MISSING") {
      inspection.missing.push({ field, selector, path, code: error.code });
    }
    return;
  }
  inspection.diagnostics.push({
    level: "error",
    code: "MAPPING_PREVIEW_FAILED",
    message: "The response mapping could not be applied to the fixture.",
    path
  });
}

function selectorLocation(error: AwError, selector: string): string {
  const offset = error.details?.["offset"];
  if (typeof offset === "number") {
    return `${error.message} Selector ${JSON.stringify(selector)}.`;
  }
  return error.message;
}

function serializeEvidence(
  request: MappingPreviewRequest,
  selected: ReadonlyMap<string, JsonValue>,
  probeKeys: readonly string[],
  secrets: readonly string[]
): MappingPreviewEvidence {
  const turnId = usableIdentifier(selected.get("turn_id"), SYNTHETIC_TURN_ID);
  const attemptId = usableIdentifier(selected.get("attempt_id"), SYNTHETIC_ATTEMPT_ID);
  const requestId = usableIdentifier(selected.get("request_id"), SYNTHETIC_REQUEST_ID);
  const context: ConnectorExecutionContext = {
    commandId: "preview_command",
    idempotencyKey: "preview_idempotency",
    turnId,
    attemptId,
    requestId
  };
  const input = previewInput(request.operation, { turnId, attemptId, requestId, probeKeys });
  const result = normalizeConnectorResult({
    kind: request.operation,
    input,
    context,
    response: request.response,
    responseMap: request.config.target.operations[request.operation]?.response,
    allowToolEvents: request.config.telemetry?.allow_tool_events === true,
    allowedObservations: new Set(
      request.operation === "observe" && probeKeys.length > 0
        ? probeKeys
        : (request.config.telemetry?.allow_observations ?? [])
    ),
    secrets
  });
  const canonical = canonicalize(result);
  return {
    protocol_version: "aw-target/0.1",
    canonical,
    sha256: sha256(canonical),
    bytes: Buffer.byteLength(canonical, "utf8"),
    result
  };
}

function previewInput(
  kind: OperationKind,
  ids: {
    readonly turnId: string;
    readonly attemptId: string;
    readonly requestId: string;
    readonly probeKeys: readonly string[];
  }
): Record<string, JsonValue> {
  switch (kind) {
    case "send":
      return { turn_id: ids.turnId };
    case "observe":
      return {
        request_id: ids.requestId,
        probe_keys: [...ids.probeKeys]
      };
    case "prepare":
    case "cleanup":
      return { attempt_id: ids.attemptId };
  }
}

function resolveProbeKeys(
  request: MappingPreviewRequest,
  allowedObservations: ReadonlySet<string>,
  diagnostics: Diagnostic[]
): string[] {
  if (request.operation !== "observe") return [];
  const requested = request.probeKeys === undefined ? [...allowedObservations] : [...request.probeKeys];
  const unique = [...new Set(requested)];
  const allowed: string[] = [];
  for (const key of unique) {
    if (allowedObservations.has(key)) {
      allowed.push(key);
      continue;
    }
    diagnostics.push({
      level: "error",
      code: "OBSERVATION_NOT_ALLOWED",
      message: "The preview requested an observation outside the local telemetry allowlist.",
      path: "telemetry.allow_observations"
    });
  }
  return allowed;
}

function sendHasContent(selected: ReadonlyMap<string, JsonValue>): boolean {
  const content = selected.get("content");
  if (typeof content === "string") return true;
  const message = selected.get("message");
  if (message !== null && typeof message === "object" && !Array.isArray(message)) {
    return typeof message["content"] === "string";
  }
  return false;
}

function contentLimit(
  field: string,
  selected: JsonValue
): { readonly limit_bytes: number; readonly actual_bytes: number } | undefined {
  if (field === "content" && typeof selected === "string") {
    return { limit_bytes: LIMITS.maxMessageBytes, actual_bytes: Buffer.byteLength(selected, "utf8") };
  }
  if (field === "message" && selected !== null && typeof selected === "object" && !Array.isArray(selected)) {
    const content = selected["content"];
    if (typeof content === "string") {
      return { limit_bytes: LIMITS.maxMessageBytes, actual_bytes: Buffer.byteLength(content, "utf8") };
    }
  }
  return undefined;
}

function usableIdentifier(value: JsonValue | undefined, fallback: string): string {
  if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value) && value.length <= 300) {
    return value;
  }
  return fallback;
}

function jsonKind(value: JsonValue): MappingPreviewValueKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "object";
}

function displayPreview(value: JsonValue): { text: string; truncated: boolean } {
  if (typeof value === "string") return boundDisplay(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return { text: JSON.stringify(value), truncated: false };
  }
  return boundDisplay(canonicalize(value));
}

function boundDisplay(text: string): { text: string; truncated: boolean } {
  const characters = [...text];
  if (characters.length <= DISPLAY_PREVIEW_CHARS) return { text, truncated: false };
  const omitted = characters.length - DISPLAY_PREVIEW_CHARS;
  return {
    text: `${characters.slice(0, DISPLAY_PREVIEW_CHARS).join("")}…[TRUNCATED ${String(omitted)} chars]`,
    truncated: true
  };
}

function emptyInspection(): FieldInspection {
  return {
    extracted: [],
    missing: [],
    omitted: [],
    redacted: [],
    truncation: [],
    diagnostics: [],
    selected: new Map(),
    mappingFailed: false
  };
}

function applyPrivacyPreview(
  request: MappingPreviewRequest,
  inspection: FieldInspection,
  evidence: MappingPreviewEvidence | null,
  diagnostics: Diagnostic[]
): { privacy: MappingPreviewPrivacy; evidence: MappingPreviewEvidence | null } {
  const policy = request.policy!;
  const profile = request.profile!;
  const secrets = [...new Set((request.secrets ?? []).filter((secret) => secret.length > 0))];
  const detectors = new Set<"field" | "credential" | "email" | "phone" | "exact_local_secret">([
    "credential",
    "exact_local_secret"
  ]);
  for (const rule of profile.rules) detectors.add(rule.detector);
  for (const [index, field] of inspection.extracted.entries()) {
    const selected = inspection.selected.get(field.field);
    if (selected === undefined) continue;
    const sanitized = maskJsonForDisplay(selected, secrets, detectors) as JsonValue;
    const display = displayPreview(sanitized);
    inspection.extracted[index] = {
      ...field,
      preview: display.text,
      display_truncated: display.truncated,
      redacted: field.redacted || canonicalize(selected) !== canonicalize(sanitized),
      bytes: Buffer.byteLength(canonicalize(sanitized), "utf8")
    };
  }
  for (const [index, field] of inspection.redacted.entries()) {
    const extracted = inspection.extracted.find((item) => item.field === field.field);
    if (extracted !== undefined) {
      inspection.redacted[index] = { ...field, preview: extracted.preview };
    }
  }
  const document = (evidence?.result ?? request.response ?? {}) as JsonValue;
  const inspected =
    evidence?.result === undefined
      ? inspectOutbound(document, policy, profile, secrets)
      : inspectRelayResult(request.operation, evidence.result, { policy, profile, localSecrets: secrets });
  const privacy: MappingPreviewPrivacy = {
    hosted_real_data_release: "unavailable",
    effective: effectivePolicySummary(policy, profile),
    receipt: inspected.receipt,
    retained_field_count:
      document !== null && typeof document === "object" && !Array.isArray(inspected.representation)
        ? Object.keys(inspected.representation as object).length
        : 0,
    blocked_paths: inspected.blockedPaths.map((item) => ({
      path: item.path,
      action: item.action,
      ruleId: item.ruleId
    })),
    missing_facts: [],
    limits: {
      max_document_bytes: profile.maxDocumentBytes,
      max_text_chars: profile.maxTextChars
    }
  };
  if (inspected.receipt.outcome === "blocked" || inspected.blockedPaths.length > 0) {
    diagnostics.push({
      level: "error",
      code: "DATA_POLICY_BLOCKED",
      message: "The fixture is blocked by the data policy. No target or hosted request was made."
    });
    return { privacy, evidence: null };
  }
  if (evidence === null) return { privacy, evidence: null };
  const canonical = canonicalize(inspected.representation);
  return {
    privacy,
    evidence: {
      protocol_version: evidence.protocol_version,
      canonical,
      sha256: sha256(canonical),
      bytes: Buffer.byteLength(canonical, "utf8"),
      result: inspected.representation as ConnectorResult
    }
  };
}

function finalizeReport(
  request: MappingPreviewRequest,
  inspection: FieldInspection,
  diagnostics: readonly Diagnostic[],
  evidence: MappingPreviewEvidence | null,
  privacy: MappingPreviewPrivacy | null = null
): MappingPreviewReport {
  const uniqueDiagnostics = dedupeDiagnostics(diagnostics);
  const ok = evidence !== null && !uniqueDiagnostics.some((item) => item.level === "error");
  return {
    schema_version: MAPPING_PREVIEW_SCHEMA_VERSION,
    ok,
    offline: true,
    credits_consumed: 0,
    operation: request.operation,
    config_path: request.configPath ?? null,
    fixture_path: request.fixturePath ?? null,
    extracted: inspection.extracted,
    missing: inspection.missing,
    omitted: inspection.omitted,
    redacted: inspection.redacted,
    truncation: inspection.truncation,
    diagnostics: uniqueDiagnostics,
    evidence,
    privacy,
    disclaimer: MAPPING_PREVIEW_DISCLAIMER
  };
}

function dedupeDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];
  for (const item of diagnostics) {
    const key = `${item.level}:${item.code}:${item.path ?? ""}:${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
