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
  parseTargetBoundary,
  SuiteExecutionScopeRefSchema,
  type ExecutionScopeBinding,
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
      "This suite's test scope belongs to a different workspace than the one you're logged in to."
    );
  }
  if (options.revision !== undefined && response.scope.revision !== options.revision) {
    throw realDataError("EXECUTION_SCOPE_STALE", "The admitted scope revision does not match the suite binding.");
  }
  if (options.scopeHash !== undefined && response.scope.scopeHash !== options.scopeHash) {
    throw realDataError("EXECUTION_SCOPE_STALE", "The admitted scope hash does not match the suite binding.");
  }
  if (response.availability === "revoked") {
    throw realDataError("TARGET_AUTHORITY_REVOKED", "This suite's test scope was revoked, so nothing was sent to your agent.");
  }
  if (response.availability === "expired") {
    throw realDataError("TARGET_AUTHORITY_EXPIRED", "This suite's test scope has expired, so nothing was sent to your agent.");
  }
  if (response.availability === "release_unavailable") {
    throw realDataError(
      "EXECUTION_RELEASE_UNAVAILABLE",
      "AugmentWorks isn't accepting real-data tests for this scope right now."
    );
  }
  if (response.availability !== "ready") {
    throw realDataError("INVALID_EXECUTION_SCOPE", `Execution scope availability is ${response.availability}.`);
  }
  if (response.authority.verificationStatus !== "verified") {
    throw realDataError(
      "TARGET_AUTHORITY_REQUIRED",
      "This suite's target isn't verified yet, so it can't run real-data tests."
    );
  }
  assertScopeNotExpired(response.scope.expiresAt, options.now ?? Date.now());
  assertScopeNotExpired(response.authority.expiresAt, options.now ?? Date.now(), "This target's verification");
  if (options.resolved !== undefined) {
    assertBoundaryMatchesConfig(response.targetBoundary, options.resolved, {
      effects: response.scope.effects
    });
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
      boundary: options.response.targetBoundary,
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
      boundary: persistedLocalBoundary(binding, scope, options.resolved),
      ...(binding.dataPolicy === undefined ? {} : { dataPolicy: binding.dataPolicy }),
      ...(binding.redactionProfile === undefined ? {} : { redactionProfile: binding.redactionProfile })
    });
  }
  if (options.resolved !== undefined && binding.bindingKind === "hosted") {
    if (binding.targetBoundary !== undefined) {
      assertBoundaryMatchesConfig(storedBoundary(binding), options.resolved, {
        effects: binding.admitted.effects
      });
    } else if (targetBoundarySha256(options.resolved) !== binding.targetBoundaryHash) {
      // Bindings written before the boundary was stored compare the config hash.
      throw realDataError(
        "TARGET_SCOPE_MISMATCH",
        "augmentworks.yaml no longer matches the target this run was started against."
      );
    }
  }
  return undefined;
}

/** The persisted boundary, checked against the hash the admitted scope names. */
function storedBoundary(binding: ExecutionScopeBinding): TargetBoundary {
  const boundary = parseTargetBoundary(binding.targetBoundary);
  if (boundary.boundaryHash !== binding.targetBoundaryHash) {
    throw realDataError(
      "TARGET_SCOPE_MISMATCH",
      "The saved target boundary for this run doesn't match its execution scope. Start a new run instead of resuming this one."
    );
  }
  return boundary;
}

function persistedLocalBoundary(
  binding: ExecutionScopeBinding,
  scope: LocalExecutionScope,
  resolved: ResolvedConfig | undefined
): TargetBoundary {
  if (binding.targetBoundary !== undefined) {
    const boundary = storedBoundary(binding);
    if (resolved !== undefined) {
      assertBoundaryMatchesConfig(boundary, resolved, { allowPrivate: true, effects: scope.effects });
    }
    return boundary;
  }
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
        boundary: persistedLocalBoundary(persisted, scope, options.resolved),
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
