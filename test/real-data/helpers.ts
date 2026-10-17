import { readFileSync } from "node:fs";

import { sealDocumentHash } from "../../src/real-data/canonical.js";
import type {
  DataPolicy,
  ExecutionScope,
  ExecutionScopeResponse,
  LocalExecutionScope,
  RealDataCapabilities,
  RedactionProfile,
  TargetAuthority,
  TargetBoundary
} from "../../src/real-data/documents.js";

/** The vendored server contract. Test documents start from its fixtures so they can't drift from it. */
export const CONTRACT = JSON.parse(
  readFileSync(new URL("../../contracts/aw-real-data-1.fixtures.json", import.meta.url), "utf8")
) as {
  readonly fixtures: Record<string, { readonly valid: boolean; readonly document: unknown; readonly expectedCode?: string }>;
  readonly http: Record<string, { readonly status: number; readonly response: unknown }>;
};

export function contractFixture<T>(name: string): T {
  const fixture = CONTRACT.fixtures[name];
  if (fixture === undefined) throw new Error(`missing contract fixture ${name}`);
  return structuredClone(fixture.document) as T;
}

export function contractResponse<T>(name: string): T {
  const exchange = CONTRACT.http[name];
  if (exchange === undefined) throw new Error(`missing contract HTTP fixture ${name}`);
  return structuredClone(exchange.response) as T;
}

export const UUID_A = "11111111-1111-4111-8111-111111111111";
export const UUID_B = "22222222-2222-4222-8222-222222222222";
export const UUID_C = "33333333-3333-4333-8333-333333333333";
export const UUID_D = "44444444-4444-4444-8444-444444444444";
export const UUID_E = "55555555-5555-4555-8555-555555555555";
export const UUID_F = "66666666-6666-4666-8666-666666666666";

export const FUTURE = "2099-12-31T23:59:59Z";

/** The workspace the contract's hosted fixtures belong to. */
export const WORKSPACE_ID = contractFixture<TargetAuthority>("target_authority_verified").workspaceId;

export function sealedBoundary(overrides: Partial<TargetBoundary> = {}): TargetBoundary {
  return sealDocumentHash(
    { ...contractFixture<TargetBoundary>("target_boundary"), ...overrides },
    "boundaryHash"
  );
}

/** The contract's verified authority, re-bound to the boundary and moved past the fixture's expiry. */
export function sealedAuthority(boundary: TargetBoundary): TargetAuthority {
  return sealDocumentHash(
    {
      ...contractFixture<TargetAuthority>("target_authority_verified"),
      targetId: boundary.targetId,
      targetRevision: boundary.revision,
      targetBoundaryHash: boundary.boundaryHash,
      expiresAt: FUTURE
    },
    "authorityHash"
  );
}

export function sealedPolicy(): DataPolicy {
  return sealDocumentHash(
    {
      schemaVersion: "aw-data-policy/1",
      policyId: UUID_D,
      revision: 1,
      policyHash: "0".repeat(64),
      dataClass: "public",
      contentHandling: "minimized",
      redactionProfileId: UUID_E,
      redactionProfileHash: "0".repeat(64),
      retentionDays: 30,
      externalSharing: "disabled",
      providerProcessing: "openai_standard"
    },
    "policyHash"
  );
}

export function sealedProfile(policy: DataPolicy): RedactionProfile {
  return sealDocumentHash(
    {
      schemaVersion: "aw-redaction-profile/1" as const,
      profileId: policy.redactionProfileId,
      revision: 1,
      profileHash: "0".repeat(64),
      allowedContentFields: ["/answer"],
      rules: [
        { id: "credentials", selector: "/authorization", action: "drop" as const, detector: "credential" as const }
      ],
      maxDocumentBytes: 65_536,
      maxTextChars: 8_000
    },
    "profileHash"
  );
}

export function publicCredentialPolicy(): { policy: DataPolicy; profile: RedactionProfile } {
  const profileDraft = {
    schemaVersion: "aw-redaction-profile/1" as const,
    profileId: UUID_E,
    revision: 1,
    profileHash: "0".repeat(64),
    allowedContentFields: ["/answer"],
    rules: [
      { id: "credentials", selector: "/authorization", action: "drop" as const, detector: "credential" as const }
    ],
    maxDocumentBytes: 65_536,
    maxTextChars: 8_000
  };
  const profile = sealDocumentHash(profileDraft, "profileHash");
  const policy = sealDocumentHash(
    {
      schemaVersion: "aw-data-policy/1" as const,
      policyId: UUID_D,
      revision: 1,
      policyHash: "0".repeat(64),
      dataClass: "public" as const,
      contentHandling: "minimized" as const,
      redactionProfileId: profile.profileId,
      redactionProfileHash: profile.profileHash,
      retentionDays: 30,
      externalSharing: "disabled" as const,
      providerProcessing: "openai_standard" as const
    },
    "policyHash"
  );
  return { policy, profile };
}

export function sealedScope(
  boundary: TargetBoundary,
  authority: TargetAuthority,
  policy: DataPolicy
): ExecutionScope {
  return sealDocumentHash(
    {
      ...contractFixture<ExecutionScope>("execution_scope_production_public"),
      workspaceId: authority.workspaceId,
      targetId: boundary.targetId,
      targetRevision: boundary.revision,
      targetBoundaryHash: boundary.boundaryHash,
      authority: { id: authority.authorityId, revision: authority.revision, hash: authority.authorityHash },
      dataPolicy: { id: policy.policyId, revision: policy.revision, hash: policy.policyHash },
      expiresAt: FUTURE
    },
    "scopeHash"
  );
}

/**
 * The contract's get_scope response, with a credential-only policy so the
 * fail-closed default privacy service accepts it, and a far-off expiry.
 */
export function hostedScopeResponse(): ExecutionScopeResponse {
  const { policy, profile } = publicCredentialOnlyPolicy();
  const boundary = sealedBoundary();
  const authority = sealedAuthority(boundary);
  const scope = sealedScope(boundary, authority, policy);
  return {
    ...contractResponse<ExecutionScopeResponse>("get_scope"),
    scope,
    authority,
    dataPolicy: policy,
    redactionProfile: profile,
    targetBoundary: boundary
  };
}

/** Credential-only profile so the fail-closed default privacy service can accept public content. */
export function publicCredentialOnlyPolicy(): { policy: DataPolicy; profile: RedactionProfile } {
  const profile = sealDocumentHash(
    {
      schemaVersion: "aw-redaction-profile/1" as const,
      profileId: UUID_E,
      revision: 1,
      profileHash: "0".repeat(64),
      allowedContentFields: ["/answer"],
      rules: [{ id: "credentials", selector: "/token", action: "drop" as const, detector: "credential" as const }],
      maxDocumentBytes: 65_536,
      maxTextChars: 8_000
    },
    "profileHash"
  );
  const policy = sealDocumentHash(
    {
      schemaVersion: "aw-data-policy/1" as const,
      policyId: UUID_D,
      revision: 1,
      policyHash: "0".repeat(64),
      dataClass: "public" as const,
      contentHandling: "verbatim" as const,
      redactionProfileId: profile.profileId,
      redactionProfileHash: profile.profileHash,
      retentionDays: 30,
      externalSharing: "disabled" as const,
      providerProcessing: "openai_standard" as const
    },
    "policyHash"
  );
  return { policy, profile };
}

export function canaryRedactionPolicy(
  options: {
    readonly dataClass?: DataPolicy["dataClass"];
    readonly contentHandling?: DataPolicy["contentHandling"];
  } = {}
): { policy: DataPolicy; profile: RedactionProfile } {
  const profile = sealDocumentHash(
    {
      schemaVersion: "aw-redaction-profile/1" as const,
      profileId: UUID_E,
      revision: 1,
      profileHash: "0".repeat(64),
      allowedContentFields: [],
      rules: [
        // Relay replies reach the profile as the ingress document { path, content: message }.
        { id: "mask-email-message", selector: "/content/content", action: "mask" as const, detector: "email" as const },
        { id: "mask-phone-message", selector: "/content/content", action: "mask" as const, detector: "phone" as const },
        {
          id: "mask-email-assistant",
          selector: "/attempts/*/turns/*/assistant_content",
          action: "mask" as const,
          detector: "email" as const
        },
        {
          id: "mask-phone-assistant",
          selector: "/attempts/*/turns/*/assistant_content",
          action: "mask" as const,
          detector: "phone" as const
        }
      ],
      maxDocumentBytes: 65_536,
      maxTextChars: 8_000
    },
    "profileHash"
  );
  const policy = sealDocumentHash(
    {
      schemaVersion: "aw-data-policy/1" as const,
      policyId: UUID_D,
      revision: 1,
      policyHash: "0".repeat(64),
      dataClass: options.dataClass ?? "business",
      contentHandling: options.contentHandling ?? "minimized",
      redactionProfileId: profile.profileId,
      redactionProfileHash: profile.profileHash,
      retentionDays: 30,
      externalSharing: "disabled" as const,
      providerProcessing: "openai_standard" as const
    },
    "policyHash"
  );
  return { policy, profile };
}

/**
 * The server's default redaction profile (augmentworks default-profile.ts): it
 * keeps /path and /content of each ingress document and masks /content.
 */
export function serverDefaultRedactionPolicy(): { policy: DataPolicy; profile: RedactionProfile } {
  const profile = sealDocumentHash(
    {
      schemaVersion: "aw-redaction-profile/1" as const,
      profileId: UUID_E,
      revision: 1,
      profileHash: "0".repeat(64),
      allowedContentFields: ["/path", "/content"],
      rules: [
        { id: "mask-credential-content", selector: "/content", action: "mask" as const, detector: "credential" as const },
        { id: "mask-email-content", selector: "/content", action: "mask" as const, detector: "email" as const },
        { id: "mask-phone-content", selector: "/content", action: "mask" as const, detector: "phone" as const },
        {
          id: "mask-local-secret-content",
          selector: "/content",
          action: "mask" as const,
          detector: "exact_local_secret" as const
        },
        { id: "drop-internal-notes", selector: "/internalNotes", action: "drop" as const, detector: "field" as const }
      ],
      maxDocumentBytes: 65_536,
      maxTextChars: 8_000
    },
    "profileHash"
  );
  const policy = sealDocumentHash(
    {
      schemaVersion: "aw-data-policy/1" as const,
      policyId: UUID_D,
      revision: 1,
      policyHash: "0".repeat(64),
      dataClass: "business" as const,
      contentHandling: "minimized" as const,
      redactionProfileId: profile.profileId,
      redactionProfileHash: profile.profileHash,
      retentionDays: 30,
      externalSharing: "disabled" as const,
      providerProcessing: "openai_standard" as const
    },
    "policyHash"
  );
  return { policy, profile };
}

/** The contract's local scope, bound to the boundary and policy, for customer records. */
export function sealedLocalScope(boundary: TargetBoundary, policy: DataPolicy): LocalExecutionScope {
  return sealDocumentHash(
    {
      ...contractFixture<LocalExecutionScope>("execution_scope_local"),
      targetId: boundary.targetId,
      targetRevision: boundary.revision,
      targetBoundaryHash: boundary.boundaryHash,
      dataOrigin: "customer_records",
      dataPolicy: { id: policy.policyId, revision: policy.revision, hash: policy.policyHash },
      expiresAt: FUTURE
    },
    "scopeHash"
  );
}

export const ENABLED_CAPABILITIES = contractResponse<RealDataCapabilities>("get_capabilities");

/** Not a document the server can send: the CLI's own view of a server that hasn't released real data. */
export const ADVERTISED_DISABLED_CAPABILITIES: RealDataCapabilities = {
  ...ENABLED_CAPABILITIES,
  runtimeEnforced: false,
  releaseEnabled: false
};

export function localAuthorizedPacketManifest(
  overrides: {
    readonly boundary?: TargetBoundary;
    readonly cleanup?: boolean;
    readonly maxMessages?: number;
    readonly policy?: DataPolicy;
    readonly profile?: RedactionProfile;
  } = {}
) {
  const { policy, profile } = overrides.policy && overrides.profile
    ? { policy: overrides.policy, profile: overrides.profile }
    : publicCredentialOnlyPolicy();
  const boundary =
    overrides.boundary ??
    sealedBoundary({
      assessedIdentity: "http://127.0.0.1:8000",
      endpoints: [{ method: "POST" as const, path: "/send" }]
    });
  const scope = sealedLocalScope(boundary, policy);
  const budget = {
    ...scope.budget,
    ...(overrides.maxMessages === undefined ? {} : { maxMessages: overrides.maxMessages })
  };
  const scoped =
    overrides.maxMessages === undefined
      ? scope
      : sealDocumentHash({ ...scope, budget, scopeHash: "0".repeat(64) }, "scopeHash");
  return {
    schema_version: "aw-packet/local-authorized-1" as const,
    packet_id: "local-authorized",
    version: "1.0.0",
    name: "Local authorized packet",
    description: "Customer-declared local real-data packet. No AugmentWorks network calls.",
    domain: "records",
    synthetic_only: false as const,
    execution_scope: scoped,
    data_policy: policy,
    redaction_profile: profile,
    required_capabilities: {
      multi_turn: false,
      observation: false,
      tool_events: false,
      cleanup: overrides.cleanup === true
    },
    scenarios: [
      {
        key: "local-authorized.hours",
        name: "Hours",
        category: "records",
        severity: "medium" as const,
        description: "Ask weekday hours against the local target.",
        expected_behavior: "State weekday hours.",
        fixture: {},
        turns: [{ content: "What are your weekday support hours?" }],
        observation_keys: [] as string[],
        assertions: [
          {
            kind: "assistant_contains" as const,
            key: "hours",
            description: "Mentions weekday hours.",
            value: "9"
          }
        ],
        repetitions: 1,
        pass_threshold: 1
      }
    ]
  };
}
