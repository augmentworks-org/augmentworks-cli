import { Buffer } from "node:buffer";

import type { JsonValue, OperationResponseMap } from "../config/types.js";
import type { OperationKind } from "../errors.js";
import { AwError } from "../errors.js";
import {
  ObservationsSchema,
  TargetEventsSchema,
  parseRelayResult
} from "../cloud/protocol.js";
import { LIMITS } from "../util/limits.js";
import { redactSecrets, selectResponse } from "./mapping.js";
import { inspectRelayResult, dataPolicyError, type DataPolicyContext } from "../data-policy/index.js";
import type {
  CleanupConnectorResult,
  ConnectorExecutionContext,
  ConnectorResult,
  Observation,
  ObserveConnectorResult,
  PrepareConnectorResult,
  SendConnectorResult,
  TargetEvent
} from "./types.js";

export const RESERVED_OBSERVE_FIELDS = new Set([
  "protocol_version",
  "request_id",
  "observations",
  "metadata"
]);

export function shouldOmitMappedResponseField(
  kind: OperationKind,
  field: string,
  options: {
    readonly allowToolEvents: boolean;
    readonly allowedObservations: ReadonlySet<string>;
  }
): boolean {
  if (field === "metadata") return true;
  if (kind === "send" && !options.allowToolEvents && (field === "events" || field === "tool_events")) {
    return true;
  }
  return kind === "observe" && !RESERVED_OBSERVE_FIELDS.has(field) && !options.allowedObservations.has(field);
}

export function omittedMappedResponseReason(
  kind: OperationKind,
  field: string,
  options: {
    readonly allowToolEvents: boolean;
    readonly allowedObservations: ReadonlySet<string>;
  }
): string {
  if (field === "metadata") {
    return "Target response metadata is not uploaded; this mapping is ignored.";
  }
  if (kind === "send" && (field === "events" || field === "tool_events") && !options.allowToolEvents) {
    return "telemetry.allow_tool_events is not true, so structured events will not leave this machine.";
  }
  if (kind === "observe" && !RESERVED_OBSERVE_FIELDS.has(field) && !options.allowedObservations.has(field)) {
    return `${field} is not in telemetry.allow_observations and will be discarded.`;
  }
  return "This mapped field is omitted from evidence.";
}

export function normalizeConnectorResult(options: {
  kind: OperationKind;
  input: unknown;
  context: ConnectorExecutionContext;
  response: JsonValue | undefined;
  responseMap: OperationResponseMap | undefined;
  allowToolEvents: boolean;
  allowedObservations: ReadonlySet<string>;
  secrets: readonly string[];
  dataPolicy?: DataPolicyContext;
}): ConnectorResult {
  const mapped = applyResponseMap(options.response, options.responseMap, (field) =>
    shouldOmitMappedResponseField(options.kind, field, {
      allowToolEvents: options.allowToolEvents,
      allowedObservations: options.allowedObservations
    })
  );
  let result: ConnectorResult;
  switch (options.kind) {
    case "prepare":
      result = normalizePrepare(mapped, options.input, options.context);
      break;
    case "send":
      result = normalizeSend(mapped, options.input, options.context, options.allowToolEvents);
      break;
    case "observe":
      result = normalizeObserve(
        mapped,
        options.input,
        options.context,
        options.allowedObservations,
        options.responseMap
      );
      break;
    case "cleanup":
      result = normalizeCleanup(options.input, options.context);
      break;
  }
  const redacted = redactSecrets(result, options.secrets);
  const projected =
    options.dataPolicy === undefined
      ? redacted
      : projectNormalizedResult(options.kind, redacted, options.dataPolicy);
  return parseRelayResult(options.kind, projected) as ConnectorResult;
}

function projectNormalizedResult(
  kind: OperationKind,
  result: ConnectorResult,
  context: DataPolicyContext
): ConnectorResult {
  const inspected = inspectRelayResult(kind, result, context);
  if (inspected.receipt.outcome === "blocked" || inspected.blockedPaths.length > 0) {
    throw dataPolicyError("DATA_POLICY_BLOCKED", "The target response was blocked by the data policy.");
  }
  return inspected.representation as ConnectorResult;
}

function applyResponseMap(
  response: JsonValue | undefined,
  responseMap: OperationResponseMap | undefined,
  omit: (field: string) => boolean
): JsonValue | undefined {
  if (responseMap === undefined) return response;
  if (response === undefined) {
    throw protocolError("TARGET_RESPONSE_REQUIRED", "The configured response mapping requires a JSON response.");
  }
  const mapped: Record<string, JsonValue> = {};
  for (const [field, selector] of Object.entries(responseMap)) {
    if (omit(field)) continue;
    if (field === "__proto__" || field === "prototype" || field === "constructor") {
      throw protocolError("UNSAFE_RESPONSE_FIELD", "Response mapping contains a forbidden field name.");
    }
    Object.defineProperty(mapped, field, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: selectResponse(response, selector)
    });
  }
  return mapped;
}

function normalizePrepare(
  response: JsonValue | undefined,
  input: unknown,
  context: ConnectorExecutionContext
): PrepareConnectorResult {
  const object = response === undefined ? {} : requireObject(response, "prepare response");
  checkProtocolVersion(object);
  if (object["status"] !== undefined && object["status"] !== "ready") {
    throw protocolError("INVALID_PREPARE_RESPONSE", "Prepare response status must be \"ready\".");
  }
  const expectedAttempt = correlation(input, context.attemptId, "attempt_id");
  const responseAttempt = optionalString(object["attempt_id"], "attempt_id", 200) ?? expectedAttempt;
  if (responseAttempt !== expectedAttempt) {
    throw protocolError("CORRELATION_MISMATCH", "Prepare response returned a different attempt_id.");
  }
  const targetSession = optionalNullableString(object["target_session_id"], "target_session_id", 300);
  return {
    protocol_version: "aw-target/0.1",
    status: "ready",
    attempt_id: expectedAttempt,
    ...(targetSession === undefined ? {} : { target_session_id: targetSession }),
    metadata: {}
  };
}

function normalizeSend(
  response: JsonValue | undefined,
  input: unknown,
  context: ConnectorExecutionContext,
  allowToolEvents: boolean
): SendConnectorResult {
  const object = requireObject(response, "send response");
  checkProtocolVersion(object);
  const expectedTurn = correlation(input, context.turnId, "turn_id");
  const responseTurn = optionalString(object["turn_id"], "turn_id", 300) ?? expectedTurn;
  if (responseTurn !== expectedTurn) {
    throw protocolError("CORRELATION_MISMATCH", "Send response returned a different turn_id.");
  }

  const messageValue = object["message"];
  let contentValue = object["content"];
  let finishReasonValue = object["finish_reason"];
  if (messageValue !== undefined) {
    const message = requireObject(messageValue, "assistant message");
    rejectUnknownKeys(message, new Set(["role", "content", "finish_reason"]), "assistant message");
    if (message["role"] !== undefined && message["role"] !== "assistant") {
      throw protocolError("INVALID_SEND_RESPONSE", "Assistant message role must be \"assistant\".");
    }
    contentValue = message["content"];
    finishReasonValue = message["finish_reason"];
  }
  const content = requiredContent(contentValue);
  if (Buffer.byteLength(content, "utf8") > LIMITS.maxMessageBytes) {
    throw protocolError("TARGET_MESSAGE_TOO_LARGE", "Assistant content exceeds the evidence size limit.");
  }
  const finishReason = optionalNullableString(finishReasonValue, "finish_reason", 100);

  const rawEvents = object["events"] ?? object["tool_events"] ?? [];
  let events: TargetEvent[] = [];
  if (allowToolEvents) {
    const parsed = TargetEventsSchema.safeParse(rawEvents);
    if (!parsed.success) {
      throw protocolError("INVALID_TARGET_EVENTS", "Send response contains invalid structured events.");
    }
    events = parsed.data as TargetEvent[];
  }
  const finished = object["finished"] === undefined ? false : requiredBoolean(object["finished"], "finished");
  return {
    protocol_version: "aw-target/0.1",
    turn_id: expectedTurn,
    message: {
      role: "assistant",
      content,
      ...(finishReason === undefined ? {} : { finish_reason: finishReason })
    },
    events,
    finished,
    metadata: {}
  };
}

function normalizeObserve(
  response: JsonValue | undefined,
  input: unknown,
  context: ConnectorExecutionContext,
  allowed: ReadonlySet<string>,
  responseMap: OperationResponseMap | undefined
): ObserveConnectorResult {
  const object = requireObject(response, "observe response");
  checkProtocolVersion(object);
  const expectedRequest = correlation(input, context.requestId, "request_id");
  const responseRequest = optionalString(object["request_id"], "request_id", 300) ?? expectedRequest;
  if (responseRequest !== expectedRequest) {
    throw protocolError("CORRELATION_MISMATCH", "Observe response returned a different request_id.");
  }

  let rawObservations: unknown;
  if (object["observations"] !== undefined) {
    rawObservations = object["observations"];
  } else if (responseMap !== undefined) {
    rawObservations = Object.entries(object)
      .filter(([key]) => !RESERVED_OBSERVE_FIELDS.has(key) && allowed.has(key))
      .map(([key, value]) => ({ key, value, source: "target", authoritative: true }));
  } else {
    throw protocolError("INVALID_OBSERVE_RESPONSE", "Observe response must contain observations.");
  }

  let observations: Observation[] = [];
  if (allowed.size > 0) {
    const parsed = ObservationsSchema.safeParse(rawObservations);
    if (!parsed.success) {
      throw protocolError("INVALID_OBSERVATIONS", "Observe response contains invalid observations.");
    }
    const seen = new Set<string>();
    observations = parsed.data.filter((observation) => {
      if (!allowed.has(observation.key)) return false;
      if (seen.has(observation.key)) {
        throw protocolError("DUPLICATE_OBSERVATION", "Observe response contains a duplicate observation key.");
      }
      seen.add(observation.key);
      return true;
    }) as Observation[];
  }
  return {
    protocol_version: "aw-target/0.1",
    request_id: expectedRequest,
    observations,
    metadata: {}
  };
}

function normalizeCleanup(input: unknown, context: ConnectorExecutionContext): CleanupConnectorResult {
  return {
    protocol_version: "aw-target/0.1",
    status: "cleaned",
    attempt_id: correlation(input, context.attemptId, "attempt_id")
  };
}

function checkProtocolVersion(object: Readonly<Record<string, JsonValue>>): void {
  const version = object["protocol_version"];
  if (version !== undefined && version !== "aw-target/0.1") {
    throw protocolError("PROTOCOL_VERSION_MISMATCH", "Target response uses an unsupported protocol version.");
  }
}

function correlation(input: unknown, contextValue: string | undefined, key: string): string {
  const object = requireObject(input, "operation input");
  const inputValue = optionalString(object[key], key, key === "attempt_id" ? 200 : 300);
  if (contextValue !== undefined && inputValue !== undefined && contextValue !== inputValue) {
    throw protocolError("CORRELATION_MISMATCH", `Command context and input disagree on ${key}.`);
  }
  return requiredString(contextValue ?? inputValue, key, key === "attempt_id" ? 200 : 300);
}

function requireObject(value: unknown, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("INVALID_TARGET_RESPONSE", `${label} must be a JSON object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw protocolError("INVALID_TARGET_RESPONSE", `${label} must be a plain JSON object.`);
  }
  return value as Record<string, JsonValue>;
}

function rejectUnknownKeys(
  object: Readonly<Record<string, JsonValue>>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    throw protocolError("INVALID_TARGET_RESPONSE", `${label} contains unsupported fields.`);
  }
}

function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw protocolError("INVALID_TARGET_RESPONSE", `${label} must be a non-empty string.`);
  }
  return value;
}

function requiredContent(value: unknown): string {
  if (typeof value !== "string") {
    throw protocolError("INVALID_TARGET_RESPONSE", "assistant content must be a string.");
  }
  return value;
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label, max);
}

function optionalNullableString(
  value: unknown,
  label: string,
  max: number
): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requiredString(value, label, max);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw protocolError("INVALID_TARGET_RESPONSE", `${label} must be a boolean.`);
  }
  return value;
}

function protocolError(code: string, message: string): AwError {
  return new AwError({ code, category: "protocol", message });
}
