import type { CloudClient } from "../cloud/client.js";
import type { CreateRunResponse } from "../cloud/protocol.js";
import type { ResolvedConfig } from "../config/types.js";
import { targetBoundarySha256 } from "../config/boundary.js";
import { CUSTOMER_OWNED_SUITE_PACKET_V3, isAuthorizedCustomerSuite, type CustomerSuite } from "../suite/schema.js";
import { assertHostedRealDataRelease } from "./capabilities.js";
import {
  authorizedDispatchPolicy,
  liveDispatchPolicyFromSuite,
  type DispatchPolicy
} from "./policy.js";
import {
  parseLocalExecutionScope,
  SuiteExecutionScopeRefSchema,
  type ExecutionScopeResponse,
  type LocalExecutionScope,
  type SuiteExecutionScopeRef,
  type TargetBoundary
} from "./documents.js";
import { EXECUTION_SCOPE_SCHEMA_VERSION } from "./constants.js";
import { realDataError } from "./errors.js";
import { assertBoundaryMatchesConfig, assertScopeNotExpired, localTargetBoundary } from "./boundary.js";
import {
  hostedBinding,
  persistExecutionScopeBinding,
  loadExecutionScopeBinding,
  assertBindingMatches
} from "./scope-store.js";

export async function assertHostedScopeUsable(
  response: ExecutionScopeResponse,
  options: {
    readonly cloud: CloudClient;
    readonly workspaceId: string;
    readonly resolved?: ResolvedConfig;
    readonly signal?: AbortSignal;
    readonly now?: number;
    readonly revision?: number;
    readonly scopeHash?: string;
  }
): Promise<void> {
  const capabilities = await options.cloud.getRealDataCapabilities(options.signal);
  assertHostedRealDataRelease(capabilities);
  if (response.scope.workspaceId !== options.workspaceId) {
    throw realDataError(
      "TARGET_SCOPE_MISMATCH",
      "The admitted execution scope belongs to a different workspace."
    );
  }
  if (options.revision !== undefined && response.scope.revision !== options.revision) {
    throw realDataError("EXECUTION_SCOPE_STALE", "The admitted scope revision does not match the suite binding.");
  }
  if (options.scopeHash !== undefined && response.scope.scopeHash !== options.scopeHash) {
    throw realDataError("EXECUTION_SCOPE_STALE", "The admitted scope hash does not match the suite binding.");
  }
  if (response.availability === "revoked") {
    throw realDataError("TARGET_AUTHORITY_REVOKED", "The admitted execution scope is revoked.");
  }
  if (response.availability === "expired") {
    throw realDataError("TARGET_AUTHORITY_EXPIRED", "The admitted execution scope is expired.");
  }
  if (response.availability === "release_unavailable") {
    throw realDataError(
      "EXECUTION_RELEASE_UNAVAILABLE",
      "The server advertised this scope but hosted real-data execution is not released."
    );
  }
  if (response.availability !== "ready") {
    throw realDataError("INVALID_EXECUTION_SCOPE", `Execution scope availability is ${response.availability}.`);
  }
  if (response.authority.verificationStatus !== "verified") {
    throw realDataError(
      "TARGET_AUTHORITY_REQUIRED",
      "The accompanying authority document is not server-verified. JSON verificationStatus cannot grant access."
    );
  }
  assertScopeNotExpired(response.scope.expiresAt, options.now ?? Date.now());
  assertScopeNotExpired(response.authority.expiresAt, options.now ?? Date.now());
  if (options.resolved !== undefined) {
    assertBoundaryMatchesConfig(response.targetBoundary, options.resolved);
  }
}

export async function requireHostedAuthorizedScope(
  cloud: CloudClient,
  ref: SuiteExecutionScopeRef,
  options: {
    readonly workspaceId: string;
    readonly resolved?: ResolvedConfig;
    readonly signal?: AbortSignal;
    readonly now?: number;
  }
): Promise<ExecutionScopeResponse> {
  const response = await cloud.getExecutionScope(ref.scopeId, options.signal);
  await assertHostedScopeUsable(response, {
    cloud,
    workspaceId: options.workspaceId,
    ...(options.resolved === undefined ? {} : { resolved: options.resolved }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(ref.revision === undefined ? {} : { revision: ref.revision }),
    ...(ref.scopeHash === undefined ? {} : { scopeHash: ref.scopeHash })
  });
  return response;
}

export function dispatchPolicyFromHostedScope(response: ExecutionScopeResponse): DispatchPolicy {
  return authorizedDispatchPolicy({
    scope: response.scope,
    boundary: response.targetBoundary,
    dataPolicy: response.dataPolicy,
    redactionProfile: response.redactionProfile
  });
}

export function dispatchPolicyFromCustomerSuite(suite: CustomerSuite): DispatchPolicy | undefined {
  return liveDispatchPolicyFromSuite(suite);
}

export async function persistHostedScopeForRun(options: {
  readonly runId: string;
  readonly configSha256: string;
  readonly workspaceId: string;
  readonly response: ExecutionScopeResponse;
  readonly quoteId?: string;
  readonly suiteId?: string;
  readonly suiteRevisionId?: string;
  readonly contentHash?: string;
  readonly stateDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<void> {
  await persistExecutionScopeBinding(
    hostedBinding({
      runId: options.runId,
      configSha256: options.configSha256,
      workspaceId: options.workspaceId,
      scope: options.response.scope,
      dataPolicy: options.response.dataPolicy,
      redactionProfile: options.response.redactionProfile,
      ...(options.quoteId === undefined ? {} : { quoteId: options.quoteId }),
      ...(options.suiteId === undefined ? {} : { suiteId: options.suiteId }),
      ...(options.suiteRevisionId === undefined ? {} : { suiteRevisionId: options.suiteRevisionId }),
      ...(options.contentHash === undefined ? {} : { contentHash: options.contentHash })
    }),
    { ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }), ...(options.env === undefined ? {} : { env: options.env }) }
  );
}

export async function loadPersistedDispatchPolicy(options: {
  readonly runId: string;
  readonly configSha256: string;
  readonly workspaceId?: string;
  readonly resolved?: ResolvedConfig;
  readonly stateDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<DispatchPolicy | undefined> {
  const binding = await loadExecutionScopeBinding(options.runId, {
    ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }),
    ...(options.env === undefined ? {} : { env: options.env })
  });
  if (binding === undefined) return undefined;
  assertBindingMatches({
    binding,
    runId: options.runId,
    configSha256: options.configSha256,
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId })
  });
  if (binding.bindingKind === "local") {
    const scope = parseLocalExecutionScope(binding.admitted);
    return authorizedDispatchPolicy({
      scope,
      boundary: persistedLocalBoundary(scope, options.resolved),
      ...(binding.dataPolicy === undefined ? {} : { dataPolicy: binding.dataPolicy }),
      ...(binding.redactionProfile === undefined ? {} : { redactionProfile: binding.redactionProfile })
    });
  }
  if (options.resolved !== undefined && binding.bindingKind === "hosted") {
    // Boundary enforcement uses current config vs persisted hash.
    if (targetBoundarySha256(options.resolved) !== binding.targetBoundaryHash) {
      throw realDataError(
        "TARGET_SCOPE_MISMATCH",
        "Current target configuration does not match the persisted admitted boundary."
      );
    }
  }
  return undefined;
}

function persistedLocalBoundary(
  scope: LocalExecutionScope,
  resolved: ResolvedConfig | undefined
): TargetBoundary {
  if (resolved === undefined) {
    throw realDataError(
      "TARGET_SCOPE_MISMATCH",
      "A local scope's target boundary is rebuilt from augmentworks.yaml. Run this from the original configuration."
    );
  }
  return localTargetBoundary(scope, resolved);
}

export function suiteNeedsHostedScope(suite: CustomerSuite): boolean {
  return isAuthorizedCustomerSuite(suite);
}

export function executionScopeRefFromNativeDocument(document: unknown): SuiteExecutionScopeRef | undefined {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return undefined;
  const record = document as Record<string, unknown>;
  const overlay = record["packetOverlay"] ?? record["packet_overlay"];
  const schemaVersion = record["schemaVersion"] ?? record["schema_version"];
  if (overlay !== "aw-packet/authorized-1" && schemaVersion !== "aw-customer-suite/3") {
    return undefined;
  }
  const parsed = SuiteExecutionScopeRefSchema.safeParse(
    record["executionScope"] ?? record["execution_scope"]
  );
  return parsed.success ? parsed.data : undefined;
}

export function packetRequiresHostedScope(packet: { readonly key: string; readonly version: string }): boolean {
  return packet.key === CUSTOMER_OWNED_SUITE_PACKET_V3.key && packet.version === CUSTOMER_OWNED_SUITE_PACKET_V3.version;
}

export async function resolveDispatchPolicyForBinding(options: {
  readonly cloud: CloudClient;
  readonly binding: CreateRunResponse;
  readonly workspaceId: string;
  readonly resolved?: ResolvedConfig;
  readonly stateDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}): Promise<DispatchPolicy | undefined> {
  const storeOptions = {
    ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }),
    ...(options.env === undefined ? {} : { env: options.env })
  };
  const persisted = await loadExecutionScopeBinding(options.binding.run_id, storeOptions);
  if (persisted !== undefined) {
    assertBindingMatches({
      binding: persisted,
      runId: options.binding.run_id,
      configSha256: options.binding.config_sha256,
      workspaceId: options.workspaceId
    });
    if (persisted.bindingKind === "local") {
      const scope = parseLocalExecutionScope(persisted.admitted);
      return authorizedDispatchPolicy({
        scope,
        boundary: persistedLocalBoundary(scope, options.resolved),
        ...(persisted.dataPolicy === undefined ? {} : { dataPolicy: persisted.dataPolicy }),
        ...(persisted.redactionProfile === undefined ? {} : { redactionProfile: persisted.redactionProfile })
      });
    }
    const response = await requireHostedAuthorizedScope(
      options.cloud,
      {
        schemaVersion: EXECUTION_SCOPE_SCHEMA_VERSION,
        scopeId: persisted.scopeId,
        revision: persisted.scopeRevision,
        scopeHash: persisted.scopeHash
      },
      {
        workspaceId: options.workspaceId,
        ...(options.resolved === undefined ? {} : { resolved: options.resolved }),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      }
    );
    await persistHostedScopeForRun({
      runId: options.binding.run_id,
      configSha256: options.binding.config_sha256,
      workspaceId: options.workspaceId,
      response,
      ...(persisted.quoteId === undefined ? {} : { quoteId: persisted.quoteId }),
      ...(persisted.suiteId === undefined ? {} : { suiteId: persisted.suiteId }),
      ...(persisted.suiteRevisionId === undefined ? {} : { suiteRevisionId: persisted.suiteRevisionId }),
      ...(persisted.contentHash === undefined ? {} : { contentHash: persisted.contentHash }),
      ...storeOptions
    });
    return dispatchPolicyFromHostedScope(response);
  }

  if (!packetRequiresHostedScope(options.binding.packet)) {
    return undefined;
  }

  const fromRun = await options.cloud.getRunExecutionScope(options.binding.run_id, options.signal);
  if (fromRun !== undefined) {
    await assertHostedScopeUsable(fromRun, {
      cloud: options.cloud,
      workspaceId: options.workspaceId,
      ...(options.resolved === undefined ? {} : { resolved: options.resolved }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    await persistHostedScopeForRun({
      runId: options.binding.run_id,
      configSha256: options.binding.config_sha256,
      workspaceId: options.workspaceId,
      response: fromRun,
      ...storeOptions
    });
    return dispatchPolicyFromHostedScope(fromRun);
  }

  throw realDataError(
    "INVALID_EXECUTION_SCOPE",
    "This authorized run has no persisted or server-admitted execution scope. Re-admit from the original suite, assessment, or manifest; do not reconstruct authority from YAML."
  );
}
