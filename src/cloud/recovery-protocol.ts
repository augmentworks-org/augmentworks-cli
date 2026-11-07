import { z } from "zod";

import { AwError } from "../errors.js";
import {
  CreateRunResponseSchema,
  RunStatusResponseSchema,
  type CreateRunRequest,
  type CreateRunResponse,
  type RunStatusResponse
} from "./protocol.js";

export const RUN_INTENT_RECONCILE_PROTOCOL_VERSION = "aw-run-intent-reconcile/0.1" as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest");
const createRequestId = z
  .string()
  .min(24)
  .max(100)
  .regex(/^crq_[A-Za-z0-9_-]+$/, "must be an AugmentWorks create request identifier");
const identifier = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "must be a bounded protocol identifier");
const tenantIdentifier = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const errorCode = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Z][A-Z0-9_]{0,79}$/);
const errorMessage = z.string().min(1).max(500);

// The deployed relay lookup returns a run reference. A create replay supplies the
// complete binding needed to start or resume a connector session.
const lookupIdentity = {
  protocol_version: z.literal("aw-relay-recovery/0.1"),
  create_request_id: createRequestId,
  create_request_sha256: sha256
};
export const CreateIntentLookupSchema = z.discriminatedUnion("outcome", [
  z.object({
    ...lookupIdentity,
    outcome: z.literal("bound"),
    run_id: z.string().uuid(),
    next_action: z.literal("inspect_or_resume_existing_run"),
    dashboard_url: z.string().url()
  }).strict(),
  z.object({
    ...lookupIdentity,
    outcome: z.literal("unknown"),
    run_id: z.null(),
    next_action: z.literal("preserve_local_intent_and_retry"),
    dashboard_url: z.null()
  }).strict(),
  z.object({
    ...lookupIdentity,
    outcome: z.literal("retired_uncreated"),
    run_id: z.null(),
    next_action: z.literal("retire_local_pending_intent"),
    dashboard_url: z.null()
  }).strict()
]);

export const ReconcileRunIntentRequestSchema = z
  .object({
    protocol_version: z.literal(RUN_INTENT_RECONCILE_PROTOCOL_VERSION),
    create_request_id: createRequestId,
    create_request_sha256: sha256,
    workspace_id: tenantIdentifier,
    connector_id: tenantIdentifier,
    run_id: identifier.optional(),
    retire_if_uncreated: z.boolean()
  })
  .strict();

const boundOutcomeSchema = z
  .object({
    protocol_version: z.literal(RUN_INTENT_RECONCILE_PROTOCOL_VERSION),
    outcome: z.literal("bound"),
    create_request_id: createRequestId,
    create_request_sha256: sha256,
    binding: CreateRunResponseSchema,
    run: RunStatusResponseSchema.optional(),
    target_execution: z.enum(["active", "terminal"]),
    evaluation: z.enum(["pending", "complete", "not_applicable"]).optional(),
    cleanup: z.enum(["complete", "outstanding", "unknown"]).optional()
  })
  .strict();

const rejectedUncreatedOutcomeSchema = z
  .object({
    protocol_version: z.literal(RUN_INTENT_RECONCILE_PROTOCOL_VERSION),
    outcome: z.literal("rejected_uncreated"),
    create_request_id: createRequestId,
    create_request_sha256: sha256,
    rejection: z
      .object({
        code: errorCode,
        message: errorMessage
      })
      .strict()
  })
  .strict();

const retiredUncreatedOutcomeSchema = z
  .object({
    protocol_version: z.literal(RUN_INTENT_RECONCILE_PROTOCOL_VERSION),
    outcome: z.literal("retired_uncreated"),
    create_request_id: createRequestId,
    create_request_sha256: sha256
  })
  .strict();

const unknownOutcomeSchema = z
  .object({
    protocol_version: z.literal(RUN_INTENT_RECONCILE_PROTOCOL_VERSION),
    outcome: z.literal("unknown"),
    create_request_id: createRequestId,
    create_request_sha256: sha256,
    reason: z.enum(["in_flight", "incomplete_evidence", "unavailable"])
  })
  .strict();

export const ReconcileRunIntentResponseSchema = z.discriminatedUnion("outcome", [
  boundOutcomeSchema,
  rejectedUncreatedOutcomeSchema,
  retiredUncreatedOutcomeSchema,
  unknownOutcomeSchema
]);

export type ReconcileRunIntentRequest = z.infer<typeof ReconcileRunIntentRequestSchema>;
export type ReconcileRunIntentResponse = z.infer<typeof ReconcileRunIntentResponseSchema>;
export type ReconcileBoundOutcome = z.infer<typeof boundOutcomeSchema>;

const typedCreateRejectionErrorSchema = z
  .object({
    code: errorCode,
    message: errorMessage,
    create_disposition: z.literal("rejected_uncreated"),
    create_request_id: createRequestId,
    create_request_sha256: sha256
  })
  .passthrough();

export function readTypedCreateRejection(
  value: unknown,
  request: CreateRunRequest,
  requestSha256: string
): { code: string; message: string } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parsed = typedCreateRejectionErrorSchema.safeParse(
    (value as Record<string, unknown>)["error"]
  );
  if (!parsed.success) return undefined;
  if (
    parsed.data.create_request_id !== request.create_request_id ||
    parsed.data.create_request_sha256 !== requestSha256
  ) {
    return undefined;
  }
  return {
    code: parsed.data.code,
    message: parsed.data.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
  };
}

export function isTargetExecutionTerminal(
  status: CreateRunResponse["status"] | RunStatusResponse["status"]
): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function reconcileIdentityMismatch(
  response: ReconcileRunIntentResponse,
  request: ReconcileRunIntentRequest
): boolean {
  return (
    response.create_request_id !== request.create_request_id ||
    response.create_request_sha256 !== request.create_request_sha256
  );
}

export function recoveryUnsupportedError(cause?: unknown): AwError {
  return new AwError({
    code: "RECOVERY_UNSUPPORTED",
    category: "protocol",
    message:
      "This AugmentWorks server does not support run-intent reconciliation. Keep the local assessment state and upgrade the hosted service before using recover --retire on an unbound create.",
    cause
  });
}
