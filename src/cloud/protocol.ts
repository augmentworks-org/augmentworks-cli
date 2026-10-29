import { z } from "zod";

import type { JsonValue } from "../config/types.js";
import { AwError } from "../errors.js";
import { canonicalize } from "../util/canonical.js";
import { assertJsonLimits, LIMITS } from "../util/limits.js";
import {
  RELAY_PROTOCOL_VERSION as RELAY_PROTOCOL_VERSION_VALUE,
  RELAY_PROTOCOL_VERSION_V2 as RELAY_PROTOCOL_VERSION_V2_VALUE,
  RELAY_PROTOCOL_VERSION_V3 as RELAY_PROTOCOL_VERSION_V3_VALUE
} from "../version.js";

export const RELAY_PROTOCOL_VERSION = RELAY_PROTOCOL_VERSION_VALUE;
export const RELAY_PROTOCOL_VERSION_V2 = RELAY_PROTOCOL_VERSION_V2_VALUE;
export const RELAY_PROTOCOL_VERSION_V3 = RELAY_PROTOCOL_VERSION_V3_VALUE;
export const TARGET_PROTOCOL_VERSION = "aw-target/0.1" as const;
export const RelayProtocolVersionSchema = z.enum([
  RELAY_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION_V2
]);
export const CreateRunProtocolVersionSchema = z.enum([
  RELAY_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION_V2,
  RELAY_PROTOCOL_VERSION_V3
]);
export type RelayProtocolVersion = z.infer<typeof RelayProtocolVersionSchema>;
export type CreateRunProtocolVersion = z.infer<typeof CreateRunProtocolVersionSchema>;

export function commandProtocolForCreate(
  protocol: CreateRunProtocolVersion
): RelayProtocolVersion {
  return protocol === RELAY_PROTOCOL_VERSION_V3 ? RELAY_PROTOCOL_VERSION_V2 : protocol;
}

export function maxCommandsForProtocol(protocol: string): number {
  return protocol === RELAY_PROTOCOL_VERSION_V2 ? LIMITS.maxCommandsExpanded : LIMITS.maxCommands;
}

const identifier = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "must be a bounded protocol identifier");
const targetIdentifier = (maximum: number) => z.string().min(1).max(maximum);
const evidenceText = (maximum: number, minimum = 0) => z.string().min(minimum).max(maximum);
const messageContent = z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= LIMITS.maxMessageBytes,
  "message content exceeds the UTF-8 byte limit"
);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest");
const timestamp = z.string().datetime({ offset: true });
const createRequestId = z
  .string()
  .min(24)
  .max(100)
  .regex(/^crq_[A-Za-z0-9_-]+$/, "must be an AugmentWorks create request identifier");
const quoteId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const maxCredits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const observationKey = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/,
    "must be a dotted observation key"
  );

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
);

const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const PacketBindingSchema = z
  .object({
    key: identifier,
    version: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/),
    sha256
  })
  .strict();

const baseCommandShape = {
  protocol_version: RelayProtocolVersionSchema,
  command_id: identifier,
  session_id: identifier,
  run_id: identifier,
  attempt_id: identifier,
  packet: PacketBindingSchema,
  config_sha256: sha256,
  sequence: z.number().int().min(1).max(LIMITS.maxCommandsExpanded),
  fencing_epoch: z.number().int().min(1),
  idempotency_key: identifier,
  issued_at: timestamp,
  expires_at: timestamp
} as const;

export const PrepareInputSchema = z
  .object({
    protocol_version: z.literal(TARGET_PROTOCOL_VERSION).default(TARGET_PROTOCOL_VERSION),
    run_id: identifier,
    attempt_id: identifier,
    scenario_key: identifier,
    repetition_index: z.number().int().min(0).max(999),
    idempotency_key: identifier,
    mode: z.enum(["evaluation", "conformance"]).default("evaluation"),
    fixture: JsonObjectSchema.default({}),
    metadata: JsonObjectSchema.default({})
  })
  .strict();

export const SendInputSchema = z
  .object({
    protocol_version: z.literal(TARGET_PROTOCOL_VERSION).default(TARGET_PROTOCOL_VERSION),
    turn_id: identifier,
    idempotency_key: identifier,
    conversation_id: identifier.optional(),
    message: z
      .object({
        role: z.literal("user"),
        content: messageContent.refine((value) => value.length > 0, "message content cannot be empty")
      })
      .strict(),
    metadata: JsonObjectSchema.default({})
  })
  .strict();

export const ObserveInputSchema = z
  .object({
    protocol_version: z.literal(TARGET_PROTOCOL_VERSION).default(TARGET_PROTOCOL_VERSION),
    request_id: identifier,
    probe_keys: z.array(identifier).max(LIMITS.maxObservations),
    metadata: JsonObjectSchema.default({})
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.probe_keys).size !== value.probe_keys.length) {
      context.addIssue({ code: "custom", message: "probe_keys must be unique", path: ["probe_keys"] });
    }
  });

export const CleanupInputSchema = z
  .object({
    protocol_version: z.literal(TARGET_PROTOCOL_VERSION).default(TARGET_PROTOCOL_VERSION),
    attempt_id: identifier
  })
  .strict();

export const PrepareCommandSchema = z
  .object({ ...baseCommandShape, kind: z.literal("prepare"), input: PrepareInputSchema })
  .strict();
export const SendCommandSchema = z
  .object({ ...baseCommandShape, kind: z.literal("send"), input: SendInputSchema })
  .strict();
export const ObserveCommandSchema = z
  .object({ ...baseCommandShape, kind: z.literal("observe"), input: ObserveInputSchema })
  .strict();
export const CleanupCommandSchema = z
  .object({ ...baseCommandShape, kind: z.literal("cleanup"), input: CleanupInputSchema })
  .strict();

export const RelayCommandSchema = z
  .discriminatedUnion("kind", [
    PrepareCommandSchema,
    SendCommandSchema,
    ObserveCommandSchema,
    CleanupCommandSchema
  ])
  .superRefine((value, context) => {
    const maximum = maxCommandsForProtocol(value.protocol_version);
    if (value.sequence > maximum) {
      context.addIssue({
        code: "custom",
        message: `command sequence exceeds the ${value.protocol_version} limit of ${maximum}`,
        path: ["sequence"]
      });
    }
  });

export const MetadataSchema = JsonObjectSchema.default({});
export const AssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: messageContent,
    finish_reason: z.string().max(100).nullable().optional()
  })
  .strict();

const eventBase = {
  event_id: targetIdentifier(300),
  sequence: z.number().int().min(0).nullable().optional()
} as const;
export const ToolCallEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("tool_call"),
    tool_name: targetIdentifier(300),
    call_id: targetIdentifier(300),
    arguments: JsonObjectSchema.default({})
  })
  .strict();
export const ToolResultEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("tool_result"),
    tool_name: targetIdentifier(300),
    call_id: targetIdentifier(300),
    output: JsonValueSchema.default(null),
    success: z.boolean().default(true)
  })
  .strict();
export const HandoffEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("handoff"),
    destination: targetIdentifier(300),
    reason: evidenceText(2_000).nullable().optional()
  })
  .strict();
export const ErrorEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("error"),
    code: targetIdentifier(200),
    message: evidenceText(2_000, 1),
    retryable: z.boolean().default(false)
  })
  .strict();
export const TargetEventSchema = z.discriminatedUnion("type", [
  ToolCallEventSchema,
  ToolResultEventSchema,
  HandoffEventSchema,
  ErrorEventSchema
]);
export const TargetEventsSchema = z.array(TargetEventSchema).max(LIMITS.maxEvents);

export const ObservationSchema = z
  .object({
    key: targetIdentifier(300),
    value: JsonValueSchema.default(null),
    source: targetIdentifier(200).default("target"),
    authoritative: z.boolean().default(true)
  })
  .strict();
export const ObservationsSchema = z.array(ObservationSchema).max(LIMITS.maxObservations);

export const PrepareResultSchema = z
  .object({
    protocol_version: z.literal(TARGET_PROTOCOL_VERSION),
    status: z.literal("ready"),
    attempt_id: targetIdentifier(200),
    target_session_id: targetIdentifier(300).nullable().optional(),
    metadata: MetadataSchema
  })
  .strict();
export const SendResultSchema = z
  .object({
    protocol_version: z.literal(TARGET_PROTOCOL_VERSION),
    turn_id: targetIdentifier(300),
    message: AssistantMessageSchema,
    events: TargetEventsSchema,
    finished: z.boolean(),
    metadata: MetadataSchema
  })
  .strict();
export const ObserveResultSchema = z
  .object({
    protocol_version: z.literal(TARGET_PROTOCOL_VERSION),
    request_id: targetIdentifier(300),
    observations: ObservationsSchema,
    metadata: MetadataSchema
  })
  .strict();
export const CleanupResultSchema = z
  .object({
    protocol_version: z.literal(TARGET_PROTOCOL_VERSION),
    status: z.literal("cleaned"),
    attempt_id: targetIdentifier(200)
  })
  .strict();

export const RelayResultSchema = z.union([
  PrepareResultSchema,
  SendResultSchema,
  ObserveResultSchema,
  CleanupResultSchema
]);

export const RunStatusSchema = z.enum([
  "queued",
  "connected",
  "running",
  "cancel_requested",
  "cancelled",
  "completed",
  "failed"
]);

export const AssessmentProfileSchema = z.enum(["quick", "full", "combined", "custom"]);
export const EvaluationModeSchema = z.enum(["deterministic", "hybrid"]);
export const EvaluationStatusSchema = z.enum(["pending", "complete", "partial", "error"]);

export const CONVERSATION_CAPABILITY_VERSION = "aw-conversation-enforcement/1" as const;
export const AdvertisedConversationSchema = z
  .object({
    version: z.literal(CONVERSATION_CAPABILITY_VERSION),
    strategy: z.literal("explicit_session_v1")
  })
  .strict();

export const TargetCapabilitiesSchema = z
  .object({
    prepare: z.boolean(),
    observation: z.boolean(),
    cleanup: z.boolean(),
    tool_events: z.boolean(),
    multi_turn: z.boolean().optional(),
    conversation: AdvertisedConversationSchema.optional(),
    observation_keys: z.array(observationKey).max(LIMITS.maxObservations)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.observation_keys).size !== value.observation_keys.length) {
      context.addIssue({
        code: "custom",
        message: "observation_keys must be unique",
        path: ["observation_keys"]
      });
    }
    if (
      value.observation_keys.some(
        (key, index) => index > 0 && value.observation_keys[index - 1]! >= key
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "observation_keys must be sorted in ascending order",
        path: ["observation_keys"]
      });
    }
    if (!value.observation && value.observation_keys.length > 0) {
      context.addIssue({
        code: "custom",
        message: "observation_keys require the observation capability",
        path: ["observation_keys"]
      });
    }
    if (value.multi_turn === true) {
      if (value.conversation?.strategy !== "explicit_session_v1") {
        context.addIssue({
          code: "custom",
          message:
            "multi_turn requires advertised conversation.strategy explicit_session_v1; a boolean flag is not a session",
          path: ["conversation"]
        });
      }
    }
    if (value.conversation !== undefined && value.multi_turn !== true) {
      context.addIssue({
        code: "custom",
        message: "advertised conversation.explicit_session_v1 requires multi_turn: true",
        path: ["multi_turn"]
      });
    }
  });

export const TargetBindingSchema = z
  .object({
    name: z.string().min(1).max(200),
    boundary_sha256: sha256,
    capabilities: TargetCapabilitiesSchema
  })
  .strict();

export const CreateRunAssessmentSchema = z
  .object({
    plan_hash: sha256,
    profile: AssessmentProfileSchema,
    evaluation_mode: EvaluationModeSchema,
    disclosure_version: z.string().min(1).max(80).nullable(),
    selected_scenario_ids: z.array(identifier).max(20).optional(), // per-run cap; compiled shards must stay within this bound
    packet_bindings: z
      .array(z.object({ key: identifier, version: PacketBindingSchema.shape.version }).strict())
      .min(1)
      .max(2)
      .optional(),
    reference_bundle: z
      .object({
        bundleId: identifier,
        entries: z
          .array(
            z
              .object({
                id: identifier,
                kind: z.enum([
                  "approved_policy",
                  "reference_answer",
                  "reference_facts",
                  "allowed_escalation_route",
                  "synthetic_fixture_facts"
                ]),
                sourceLabel: z.string().min(1).max(200),
                scope: z.string().min(1).max(2_000),
                content: z.string().max(16_000),
                contentHash: sha256,
                complete: z.boolean()
              })
              .strict()
          )
          .max(16),
        refundPolicy: z
          .object({
            amountCapMinorUnits: z.number().int().min(0).max(1_000_000_000),
            currency: z.string().length(3).regex(/^[A-Z]{3}$/),
            eligibilityRule: z.string().min(1).max(500),
            refusalEnforcementMode: z.enum(["refuse_before_tool", "tool_enforced_denial"]),
            requireConfirmation: z.boolean(),
            unitAdapterVersion: z.literal("usd-cents/1"),
            prose: z.string().max(8_000)
          })
          .strict()
          .nullable(),
        knowledgeBoundary: z.string().max(4_000).nullable(),
        targetAlreadyConfigured: z.boolean()
      })
      .strict(),
    suite_id: identifier.optional(),
    suite_revision_id: z.string().min(1).max(128).optional(),
    suite_content_hash: sha256.optional()
  })
  .strict()
  .superRefine((value, context) => {
    const hasSuiteId = value.suite_id !== undefined;
    const hasRevision = value.suite_revision_id !== undefined;
    const hasHash = value.suite_content_hash !== undefined;
    if (hasSuiteId !== hasRevision || hasRevision !== hasHash) {
      context.addIssue({
        code: "custom",
        message: "suite pin requires suite_id, suite_revision_id, and suite_content_hash together",
        path: ["suite_id"]
      });
    }
  });

export const CreateRunRequestV1Schema = z
  .object({
    protocol_version: z.literal(RELAY_PROTOCOL_VERSION),
    create_request_id: createRequestId,
    packet: z
      .object({ key: identifier, version: PacketBindingSchema.shape.version })
      .strict(),
    config_sha256: sha256,
    target: TargetBindingSchema
  })
  .strict();

export const CreateRunRequestV2Schema = z
  .object({
    protocol_version: z.literal(RELAY_PROTOCOL_VERSION_V2),
    create_request_id: createRequestId,
    packet: z
      .object({ key: identifier, version: PacketBindingSchema.shape.version })
      .strict(),
    config_sha256: sha256,
    target: TargetBindingSchema,
    assessment: CreateRunAssessmentSchema.optional()
  })
  .strict();

export const CreateRunRequestV3Schema = z
  .object({
    protocol_version: z.literal(RELAY_PROTOCOL_VERSION_V3),
    create_request_id: createRequestId,
    packet: z
      .object({ key: identifier, version: PacketBindingSchema.shape.version })
      .strict(),
    config_sha256: sha256,
    target: TargetBindingSchema,
    assessment: CreateRunAssessmentSchema,
    quote_id: quoteId,
    max_credits: maxCredits.optional()
  })
  .strict();

export const CreateRunRequestSchema = z.union([
  CreateRunRequestV1Schema,
  CreateRunRequestV2Schema,
  CreateRunRequestV3Schema
]);

export const RetryEvaluationResponseSchema = z
  .object({
    protocol_version: CreateRunProtocolVersionSchema,
    run_id: identifier,
    evaluation_id: identifier,
    reused_target_evidence: z.literal(true),
    customer_units_debited: z.literal(0)
  })
  .strict();

export const CreateRunResponseSchema = z
  .object({
    protocol_version: CreateRunProtocolVersionSchema,
    create_request_id: createRequestId,
    create_request_sha256: sha256,
    create_disposition: z.enum(["created", "replayed"]),
    run_id: identifier,
    session_id: identifier,
    packet: PacketBindingSchema,
    config_sha256: sha256,
    fencing_epoch: z.number().int().min(1),
    status: RunStatusSchema,
    dashboard_url: z.string().url(),
    run_expires_at: timestamp,
    credit_state: z.enum(["reserved", "consumed", "released"]),
    poll_after_ms: z.number().int().min(0).max(60_000).optional()
  })
  .strict();

export const CreateSessionRequestSchema = z
  .object({
    protocol_version: RelayProtocolVersionSchema,
    config_sha256: sha256,
    target: TargetBindingSchema
  })
  .strict();

export const ConnectorSessionResponseSchema = z
  .object({
    protocol_version: RelayProtocolVersionSchema,
    session_id: identifier,
    fencing_epoch: z.number().int().min(1),
    status: z.enum(["connected", "closed"]),
    dashboard_url: z.string().url()
  })
  .strict();

export const SessionPollResponseSchema = z
  .object({
    protocol_version: RelayProtocolVersionSchema,
    session_id: identifier,
    fencing_epoch: z.number().int().min(1),
    status: z.enum(["connected", "closed"]),
    run: CreateRunResponseSchema.nullable(),
    retry_after_ms: z.number().int().min(0).max(60_000).optional()
  })
  .strict();

export const PollResponseSchema = z
  .object({
    protocol_version: RelayProtocolVersionSchema,
    run_id: identifier,
    session_id: identifier,
    status: RunStatusSchema,
    command: RelayCommandSchema.nullable(),
    retry_after_ms: z.number().int().min(0).max(60_000).optional(),
    // AUG-412: sequences above after_sequence that the server closed and will never
    // deliver. Absent (older servers) means none.
    skipped_sequences: z
      .array(z.number().int().min(1).max(LIMITS.maxCommandsExpanded))
      .max(LIMITS.maxCommandsExpanded)
      .optional()
  })
  .strict();

export const CommandAckSchema = z
  .object({
    protocol_version: RelayProtocolVersionSchema,
    command_id: identifier,
    accepted: z.literal(true)
  })
  .strict();

export const RunStatusResponseSchema = z
  .object({
    protocol_version: RelayProtocolVersionSchema,
    run_id: identifier,
    status: RunStatusSchema,
    dashboard_url: z.string().url().optional(),
    credit_state: z.enum(["reserved", "consumed", "released"]),
    outcome: z.enum(["passed", "failed", "inconclusive", "error"]).nullable().optional(),
    error_code: identifier.nullable().optional(),
    error_message: z.string().max(1_000).nullable().optional(),
    evaluation_status: EvaluationStatusSchema.optional()
  })
  .strict();

export type RelayCommand = z.infer<typeof RelayCommandSchema>;
export type RelayResult = z.infer<typeof RelayResultSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;
export type HandoffEvent = z.infer<typeof HandoffEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type TargetEvent = z.infer<typeof TargetEventSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type PrepareResult = z.infer<typeof PrepareResultSchema>;
export type SendResult = z.infer<typeof SendResultSchema>;
export type ObserveResult = z.infer<typeof ObserveResultSchema>;
export type CleanupResult = z.infer<typeof CleanupResultSchema>;
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export type CreateRunRequestV3 = z.infer<typeof CreateRunRequestV3Schema>;
export type CreateRunAssessment = z.infer<typeof CreateRunAssessmentSchema>;
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;
export type RetryEvaluationResponse = z.infer<typeof RetryEvaluationResponseSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type ConnectorSessionResponse = z.infer<typeof ConnectorSessionResponseSchema>;
export type SessionPollResponse = z.infer<typeof SessionPollResponseSchema>;
export type PollResponse = z.infer<typeof PollResponseSchema>;
export type CommandAck = z.infer<typeof CommandAckSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RunStatusResponse = z.infer<typeof RunStatusResponseSchema>;
export type PacketBinding = z.infer<typeof PacketBindingSchema>;
export type TargetBinding = z.infer<typeof TargetBindingSchema>;
export type AssessmentProfile = z.infer<typeof AssessmentProfileSchema>;
export type EvaluationMode = z.infer<typeof EvaluationModeSchema>;
export type EvaluationStatus = z.infer<typeof EvaluationStatusSchema>;

export function parseRelayCommand(value: unknown): RelayCommand {
  const candidateContent =
    isRecord(value) && value["kind"] === "send"
      ? nestedString(value, ["input", "message", "content"])
      : undefined;
  if (
    candidateContent !== undefined &&
    Buffer.byteLength(candidateContent, "utf8") > LIMITS.maxMessageBytes
  ) {
    throw new AwError({
      code: "RELAY_MESSAGE_TOO_LARGE",
      category: "protocol",
      message: "The relay message exceeds the protocol byte limit.",
      operation: "send"
    });
  }
  const parsed = RelayCommandSchema.safeParse(value);
  if (!parsed.success) throw protocolValidationError("relay command", parsed.error);
  assertJsonLimits(parsed.data, "Relay command");
  if (Buffer.byteLength(canonicalize(parsed.data)) > LIMITS.envelopeBytes) {
    throw new AwError({
      code: "RELAY_ENVELOPE_TOO_LARGE",
      category: "protocol",
      message: "The relay command exceeds the protocol size limit."
    });
  }
  return parsed.data;
}

export function parseRelayResult(kind: RelayCommand["kind"], value: unknown): RelayResult {
  const candidateContent = kind === "send" ? nestedString(value, ["message", "content"]) : undefined;
  if (
    candidateContent !== undefined &&
    Buffer.byteLength(candidateContent, "utf8") > LIMITS.maxMessageBytes
  ) {
    throw new AwError({
      code: "EVIDENCE_LIMIT_EXCEEDED",
      category: "evidence",
      message: "The assistant message exceeds the evidence byte limit.",
      operation: "send"
    });
  }
  const schema = {
    prepare: PrepareResultSchema,
    send: SendResultSchema,
    observe: ObserveResultSchema,
    cleanup: CleanupResultSchema
  }[kind];
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw protocolValidationError(`${kind} result`, parsed.error);
  assertJsonLimits(parsed.data, "Relay result");
  if (Buffer.byteLength(canonicalize(parsed.data)) > LIMITS.evidenceBytes) {
    throw new AwError({
      code: "EVIDENCE_LIMIT_EXCEEDED",
      category: "evidence",
      message: "The normalized operation result exceeds the evidence size limit.",
      operation: kind
    });
  }
  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nestedString(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function protocolValidationError(label: string, error: z.ZodError): AwError {
  const issue = error.issues[0];
  const path = issue?.path.join(".") || "root";
  return new AwError({
    code: "INVALID_RELAY_PAYLOAD",
    category: "protocol",
    message: `Invalid ${label} at ${path}.`
  });
}
