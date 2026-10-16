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
