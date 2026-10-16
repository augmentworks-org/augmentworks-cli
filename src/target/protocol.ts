import { createHash } from "node:crypto";

import { z } from "zod";

import { AwError } from "../errors.js";
import { TARGET_REGISTRATION_SCHEMA_VERSION } from "../real-data/constants.js";

export const REAL_DATA_STATEMENT_SCHEMA_VERSION = "aw-real-data-statement/1" as const;

/** Server limits for a target registration (AUG-358 contract). */
export const TARGET_LIMITS = {
  maxNameChars: 200,
  maxPermissionRefChars: 80,
  maxEndpoints: 32,
  maxEndpointPathChars: 300
} as const;

export const PERMISSION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export const TARGET_ENVIRONMENTS = ["development", "staging", "production"] as const;
export type TargetEnvironment = (typeof TARGET_ENVIRONMENTS)[number];

export type VerificationMethod = "dns_txt" | "https_challenge" | "connector_challenge" | "reviewed_permission";

export function workspaceTargetsPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/execution-targets`;
}

export function realDataStatementPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/real-data-statement`;
}

export function portalTargetsUrl(apiOrigin: URL): string {
  return new URL("/portal/settings/targets", apiOrigin).toString();
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/u);

const RealDataStatementSchema = z.object({
  schemaVersion: z.literal(REAL_DATA_STATEMENT_SCHEMA_VERSION),
  version: z.number().int().positive(),
  text: z.string().min(1).max(4_000),
  hash: Sha256,
  accepted: z.boolean(),
  acceptedAt: z.string().nullable()
});

export type RealDataStatement = z.infer<typeof RealDataStatementSchema>;

/**
 * The workspace real-data statement. Its hash must be the sha256 of the exact
 * text shown, or the CLI would be accepting words it didn't display.
 */
export function parseRealDataStatement(value: unknown): RealDataStatement {
  const parsed = RealDataStatementSchema.safeParse(value);
  if (!parsed.success) {
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "AugmentWorks returned a real-data statement that does not match aw-real-data-statement/1."
    });
  }
  const computed = createHash("sha256").update(parsed.data.text, "utf8").digest("hex");
  if (computed !== parsed.data.hash) {
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "The real-data statement's hash doesn't match its text, so the CLI won't show or accept it."
    });
  }
  return parsed.data;
}

const TargetRegistrationSchema = z
  .object({
    schemaVersion: z.literal(TARGET_REGISTRATION_SCHEMA_VERSION),
    targetId: z.string().uuid(),
    targetRevision: z.number().int().positive(),
    status: z.literal("pending"),
    challenge: z
      .object({
        method: z.enum(["dns_txt", "https_challenge", "connector_challenge", "reviewed_permission"]),
        nonce: z.string().min(1).max(512),
        expiresAt: z.string().min(20).max(40)
      })
      .strict()
  })
  .strict();

export type TargetRegistration = z.infer<typeof TargetRegistrationSchema>;

export function parseTargetRegistration(value: unknown): TargetRegistration {
  const parsed = TargetRegistrationSchema.safeParse(value);
  if (!parsed.success) {
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "AugmentWorks returned a target registration that does not match aw-target-registration/1."
    });
  }
  return parsed.data;
}

export interface RegisterTargetRequest {
  readonly targetId: string;
  readonly name: string;
  readonly environment: TargetEnvironment;
  readonly transport: "direct_http";
  readonly targetBoundaryHash: string;
  readonly effectBoundary: "no_tools";
  readonly authorizationKind: "owned_target" | "written_permission";
  readonly permissionRef: string;
  readonly verificationMethod: VerificationMethod;
  readonly assessedIdentity: string;
  readonly endpoints: ReadonlyArray<{ readonly method: string; readonly path: string }>;
  readonly attestation?: { readonly statementVersion: number; readonly statementHash: string };
}

export function targetDetailPath(workspaceId: string, targetId: string): string {
  return `${workspaceTargetsPath(workspaceId)}/${encodeURIComponent(targetId)}`;
}

export function targetVerifyPath(workspaceId: string, targetId: string): string {
  return `${targetDetailPath(workspaceId, targetId)}/verify`;
}

const VERIFICATION_METHODS = ["dns_txt", "https_challenge", "connector_challenge", "reviewed_permission"] as const;

const StoredTargetSchema = z
  .object({
    targetId: z.string().uuid(),
    name: z.string().min(1).max(TARGET_LIMITS.maxNameChars),
    environment: z.enum(TARGET_ENVIRONMENTS),
    transport: z.enum(["direct_http", "browser_bridge"]),
    effectBoundary: z.enum(["no_tools", "read_only_enforced", "action_gateway"]),
    assessedIdentity: z.string().min(1).max(253),
    authorizationKind: z.enum(["owned_target", "written_permission"]),
    permissionRef: z.string().min(1).max(TARGET_LIMITS.maxPermissionRefChars),
    verificationMethod: z.enum(VERIFICATION_METHODS),
    status: z.enum(["pending", "verified", "revoked"]),
    currentRevision: z.number().int().positive(),
    currentBoundaryHash: Sha256
  })
  .passthrough();

export type StoredTarget = z.infer<typeof StoredTargetSchema>;

export function parseTargetList(value: unknown): StoredTarget[] {
  const parsed = z.array(StoredTargetSchema).max(500).safeParse(value);
  if (!parsed.success) {
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "AugmentWorks returned a target list the CLI can't read."
    });
  }
  return parsed.data;
}

const ChallengeSchema = z
  .object({
    method: z.enum(VERIFICATION_METHODS),
    nonce: z.string().min(1).max(512),
    expiresAt: z.string().min(20).max(40)
  })
  .strict();

export type TargetChallenge = z.infer<typeof ChallengeSchema>;

const TargetDetailSchema = z
  .object({
    schemaVersion: z.literal("aw-target-detail/1"),
    target: StoredTargetSchema,
    endpoints: z
      .array(
        z.object({ method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]), path: z.string().min(1) }).strict()
      )
      .max(TARGET_LIMITS.maxEndpoints),
    authority: z
      .object({
        authorityId: z.string().uuid(),
        revision: z.number().int().positive(),
        verificationStatus: z.string().min(1),
        expiresAt: z.string().min(20).max(40),
        renewalOpensAt: z.string().min(20).max(40)
      })
      .passthrough(),
    challenge: ChallengeSchema.nullable()
  })
  .passthrough();

export type TargetDetail = z.infer<typeof TargetDetailSchema>;

export function parseTargetDetail(value: unknown, targetId: string): TargetDetail {
  const parsed = TargetDetailSchema.safeParse(value);
  if (!parsed.success || parsed.data.target.targetId !== targetId) {
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "AugmentWorks returned target details that don't match aw-target-detail/1 for this target."
    });
  }
  return parsed.data;
}

export interface VerifyTargetRequest {
  readonly nonce: string;
  readonly expectedRevision: number;
  readonly connectorAttestation?: true;
  readonly permissionAttestation?: {
    readonly kind: "owner_written_permission" | "agency_written_permission";
    readonly representedClientRef?: string;
  };
}

const VerifyResponseSchema = z
  .object({
    targetId: z.string().uuid(),
    authority: z
      .object({
        verificationStatus: z.string().min(1),
        expiresAt: z.string().min(20).max(40)
      })
      .passthrough()
  })
  .passthrough();

export type VerifyTargetResponse = z.infer<typeof VerifyResponseSchema>;

export function parseVerifyResponse(value: unknown, targetId: string): VerifyTargetResponse {
  const parsed = VerifyResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.targetId !== targetId) {
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "AugmentWorks returned a verification result for a different target, or one the CLI can't read."
    });
  }
  return parsed.data;
}
