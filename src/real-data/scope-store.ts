import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getStateDirectory } from "../relay/state-dir.js";
import {
  parseExecutionScopeBinding,
  type ExecutionScopeBinding,
  type ExecutionScope,
  type LocalExecutionScope,
  type DataPolicy,
  type RedactionProfile,
  type TargetBoundary
} from "./documents.js";
import { realDataError } from "./errors.js";
import { EXECUTION_SCOPE_BINDING_SCHEMA_VERSION } from "./constants.js";

export async function persistExecutionScopeBinding(
  binding: ExecutionScopeBinding,
  options: { readonly stateDirectory?: string; readonly env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  const directory = join(scopeRoot(options), "execution-scopes");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${safeSegment(binding.runId)}.json`);
  await writeFile(path, `${JSON.stringify(binding, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function loadExecutionScopeBinding(
  runId: string,
  options: { readonly stateDirectory?: string; readonly env?: NodeJS.ProcessEnv } = {}
): Promise<ExecutionScopeBinding | undefined> {
  const path = join(scopeRoot(options), "execution-scopes", `${safeSegment(runId)}.json`);
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parseExecutionScopeBinding(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof Error && "code" in error && typeof (error as { code: unknown }).code === "string") {
      throw error;
    }
    throw realDataError("EXECUTION_SCOPE_STALE", `Could not read persisted execution scope for run ${runId}.`, undefined, error);
  }
}

export function assertBindingMatches(options: {
  readonly binding: ExecutionScopeBinding;
  readonly runId: string;
  readonly configSha256: string;
  readonly workspaceId?: string;
  readonly quoteId?: string;
  readonly suiteId?: string;
  readonly contentHash?: string;
}): void {
  const { binding } = options;
  if (binding.runId !== options.runId) {
    throw realDataError("QUOTE_SCOPE_MISMATCH", "Persisted execution scope is bound to a different run.");
  }
  if (binding.configSha256 !== options.configSha256) {
    throw realDataError(
      "TARGET_SCOPE_MISMATCH",
      "augmentworks.yaml no longer matches the target this run's scope was created for."
    );
  }
  if (options.workspaceId !== undefined && binding.workspaceId !== undefined && binding.workspaceId !== options.workspaceId) {
    throw realDataError("TARGET_SCOPE_MISMATCH", "This run's scope belongs to a different workspace than the one you're logged in to.");
  }
  if (options.quoteId !== undefined && binding.quoteId !== undefined && binding.quoteId !== options.quoteId) {
    throw realDataError("QUOTE_SCOPE_MISMATCH", "Persisted execution scope does not match the quoted admission.");
  }
  if (options.suiteId !== undefined && binding.suiteId !== undefined && binding.suiteId !== options.suiteId) {
    throw realDataError("QUOTE_SCOPE_MISMATCH", "Persisted execution scope does not match the admitted suite.");
  }
  if (
    options.contentHash !== undefined &&
    binding.contentHash !== undefined &&
    binding.contentHash !== options.contentHash
  ) {
    throw realDataError("QUOTE_SCOPE_MISMATCH", "Persisted execution scope does not match the admitted content hash.");
  }
}

export function hostedBinding(options: {
  readonly runId: string;
  readonly configSha256: string;
  readonly workspaceId: string;
  readonly scope: ExecutionScope;
  readonly quoteId?: string;
  readonly suiteId?: string;
  readonly suiteRevisionId?: string;
  readonly contentHash?: string;
  readonly dataPolicy?: DataPolicy;
  readonly redactionProfile?: RedactionProfile;
  readonly boundary?: TargetBoundary;
  /** The target authority was verified by connector challenge. */
  readonly allowPrivate?: boolean;
}): ExecutionScopeBinding {
  return {
    schemaVersion: EXECUTION_SCOPE_BINDING_SCHEMA_VERSION,
    bindingKind: "hosted",
    runId: options.runId,
    ...(options.quoteId === undefined ? {} : { quoteId: options.quoteId }),
    ...(options.suiteId === undefined ? {} : { suiteId: options.suiteId }),
    ...(options.suiteRevisionId === undefined ? {} : { suiteRevisionId: options.suiteRevisionId }),
    ...(options.contentHash === undefined ? {} : { contentHash: options.contentHash }),
    configSha256: options.configSha256,
    targetBoundaryHash: options.scope.targetBoundaryHash,
    workspaceId: options.workspaceId,
    scopeId: options.scope.scopeId,
    scopeRevision: options.scope.revision,
    scopeHash: options.scope.scopeHash,
    packetOverlay: "aw-packet/authorized-1",
    admitted: options.scope,
    ...(options.dataPolicy === undefined ? {} : { dataPolicy: options.dataPolicy }),
    ...(options.redactionProfile === undefined ? {} : { redactionProfile: options.redactionProfile }),
    ...(options.boundary === undefined ? {} : { targetBoundary: options.boundary }),
    // Written only when true, so public-target bindings stay readable by 0.4.0.
    ...(options.allowPrivate === true ? { allowPrivate: true } : {}),
    availability: "ready",
    fetchedAt: new Date().toISOString().replace(/\.\d+Z$/u, "Z")
  };
}

export function localBinding(options: {
  readonly runId: string;
  readonly configSha256: string;
  readonly scope: LocalExecutionScope;
  readonly dataPolicy?: DataPolicy;
  readonly redactionProfile?: RedactionProfile;
  /** The boundary rebuilt from augmentworks.yaml that matched the scope's hash. */
  readonly boundary?: TargetBoundary;
}): ExecutionScopeBinding {
  return {
    schemaVersion: EXECUTION_SCOPE_BINDING_SCHEMA_VERSION,
    bindingKind: "local",
    runId: options.runId,
    configSha256: options.configSha256,
    targetBoundaryHash: options.scope.targetBoundaryHash,
    scopeId: options.scope.scopeId,
    scopeRevision: options.scope.revision,
    scopeHash: options.scope.scopeHash,
    packetOverlay: "aw-packet/local-authorized-1",
    admitted: options.scope,
    ...(options.dataPolicy === undefined ? {} : { dataPolicy: options.dataPolicy }),
    ...(options.redactionProfile === undefined ? {} : { redactionProfile: options.redactionProfile }),
    ...(options.boundary === undefined ? {} : { targetBoundary: options.boundary }),
    availability: "ready",
    fetchedAt: new Date().toISOString().replace(/\.\d+Z$/u, "Z")
  };
}

function scopeRoot(options: { readonly stateDirectory?: string; readonly env?: NodeJS.ProcessEnv }): string {
  return options.stateDirectory ?? getStateDirectory(options.env);
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 180);
}
