import { isIP } from "node:net";

import type { RelayCommand } from "../cloud/protocol.js";
import type { OperationKind } from "../errors.js";
import type { ResolvedConfig } from "../config/types.js";
import { isLocalOrPrivateHost } from "../config/resolve.js";
import { canonicalHttpsOrigin } from "../suite/live-target.js";
import { sealDocumentHash } from "./canonical.js";
import { EFFECT_BOUNDARIES, TARGET_BOUNDARY_SCHEMA_VERSION, type EFFECTS } from "./constants.js";
import type { LocalExecutionScope, TargetBoundary } from "./documents.js";
import { realDataError } from "./errors.js";

type Effect = (typeof EFFECTS)[number];

const OPERATION_ORDER = ["prepare", "send", "observe", "cleanup"] as const;

export type AssessedOriginMode = "public_https" | "customer_private";

export function canonicalAssessedOrigin(
  value: string,
  options: { readonly allowPrivate: boolean }
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw realDataError("TARGET_SCOPE_MISMATCH", "Target origin must be an absolute URL.");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw realDataError(
      "TARGET_SCOPE_MISMATCH",
      "Target origin cannot contain credentials, query, or fragment."
    );
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw realDataError("TARGET_SCOPE_MISMATCH", "Target origin cannot contain a path.");
  }
  const hostname = url.hostname.replace(/\.$/u, "").toLowerCase();
  const privateHost = isIP(hostname) !== 0 || isLocalOrPrivateHost(hostname);
  if (privateHost && !options.allowPrivate) {
    throw realDataError(
      "TARGET_SCOPE_MISMATCH",
      "Hosted and browser discovery cannot use loopback, private, or raw IP origins. Register private targets through the local connector mapping only."
    );
  }
  if (!privateHost) {
    return canonicalHttpsOrigin(`https://${hostname}${url.port && url.port !== "443" ? `:${url.port}` : ""}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw realDataError("TARGET_SCOPE_MISMATCH", "Private local targets must use http or https.");
  }
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port = url.port === "" || url.port === defaultPort ? "" : `:${url.port}`;
  return `${url.protocol}//${hostname}${port}`;
}

/** An assessed identity without a scheme is an https origin, as on the server. */
export function assessedIdentityOrigin(
  boundary: TargetBoundary,
  options: { readonly allowPrivate: boolean }
): string {
  const identity = boundary.assessedIdentity.includes("://")
    ? boundary.assessedIdentity
    : `https://${boundary.assessedIdentity}`;
  return canonicalAssessedOrigin(identity, options);
}

/** The method and path each configured operation calls, resolved as the HTTP connector does. */
export function configuredEndpoints(
  resolved: ResolvedConfig
): Array<{ readonly kind: OperationKind; readonly method: string; readonly path: string }> {
  return OPERATION_ORDER.flatMap((kind) => {
    const operation = resolved.config.target.operations[kind];
    if (operation === undefined) return [];
    return [{ kind, method: operation.method, path: new URL(operation.path, resolved.baseUrl).pathname }];
  });
}

/**
 * The rules a scope's boundary sets on augmentworks.yaml, checked before any
 * call: direct HTTP only, the registered origin, every configured operation a
 * registered endpoint, and for informational scopes only send and observe.
 */
export function assertBoundaryMatchesConfig(
  boundary: TargetBoundary,
  resolved: ResolvedConfig,
  options: { readonly allowPrivate?: boolean; readonly effects?: Effect } = {}
): void {
  if (boundary.transport !== "direct_http") {
    throw realDataError(
      "TARGET_SCOPE_MISMATCH",
      `This target is registered with ${boundary.transport} transport, and the CLI can only call direct_http targets. Register it again with direct HTTP in Settings → Targets.`
    );
  }
  const allowPrivate = options.allowPrivate === true;
  const assessed = assessedIdentityOrigin(boundary, { allowPrivate });
  const configured = canonicalAssessedOrigin(resolved.baseUrl.origin, { allowPrivate });
  if (assessed !== configured) {
    throw realDataError(
      "TARGET_SCOPE_MISMATCH",
      `target.base_url in augmentworks.yaml points at ${configured}, but this scope's target is registered at ${assessed}. Set base_url to ${assessed}, or register ${configured} as its own target. A loopback address is transport only and can't stand in for a registered public address.`
    );
  }
  const registered = boundary.endpoints.map((allowed) => `${allowed.method} ${allowed.path}`).join(", ");
  for (const endpoint of configuredEndpoints(resolved)) {
    if (options.effects !== undefined && !operationPermittedByEffects(endpoint.kind, options.effects)) {
      throw realDataError(
        "ACTION_NOT_ALLOWED",
        `augmentworks.yaml configures a ${endpoint.kind} operation, but this scope is informational and allows only send and observe. Remove target.operations.${endpoint.kind}, or use a scope that allows actions.`
      );
    }
    const listed = boundary.endpoints.some(
      (allowed) => allowed.method === endpoint.method && pathsEqual(allowed.path, endpoint.path)
    );
    if (!listed) {
      throw realDataError(
        "TARGET_SCOPE_MISMATCH",
        `The ${endpoint.kind} operation in augmentworks.yaml calls ${endpoint.method} ${endpoint.path}, which isn't a registered endpoint of this target (${registered}). Change the operation to a registered endpoint, or add the endpoint to the target and create a new scope.`
      );
    }
  }
}

/**
 * Local scopes carry only targetBoundaryHash, so the boundary is rebuilt from
 * the configuration and must hash to exactly that value.
 */
export function localTargetBoundary(scope: LocalExecutionScope, resolved: ResolvedConfig): TargetBoundary {
  const assessedIdentity = canonicalAssessedOrigin(resolved.baseUrl.origin, { allowPrivate: true });
  const endpoints = configuredEndpoints(resolved).map((endpoint) => ({
    method: endpoint.method as TargetBoundary["endpoints"][number]["method"],
    path: endpoint.path
  }));
  for (const effectBoundary of EFFECT_BOUNDARIES) {
    const boundary = sealDocumentHash(
      {
        schemaVersion: TARGET_BOUNDARY_SCHEMA_VERSION,
        targetId: scope.targetId,
        revision: scope.targetRevision,
        boundaryHash: "0".repeat(64),
        transport: "direct_http",
        effectBoundary,
        assessedIdentity,
        endpoints
      } satisfies TargetBoundary,
      "boundaryHash"
    );
    if (boundary.boundaryHash === scope.targetBoundaryHash) return boundary;
  }
  const configured = endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).join(", ");
  throw realDataError(
    "TARGET_SCOPE_MISMATCH",
    `augmentworks.yaml (${assessedIdentity}: ${configured}) doesn't match the target boundary this local scope was issued for. Restore the base_url and operations the scope was created with, or issue a new local scope for this configuration.`
  );
}

function pathsEqual(left: string, right: string): boolean {
  const normalize = (value: string) => (value.startsWith("/") ? value : `/${value}`).replace(/\/+$/u, "") || "/";
  return normalize(left) === normalize(right);
}

/** Informational scopes allow only send and observe, as the server does for authorized packets. */
export function operationPermittedByEffects(kind: OperationKind, effects: Effect): boolean {
  return effects !== "informational" || kind === "send" || kind === "observe";
}

export function assertCommandWithinBoundary(command: RelayCommand, effects: Effect): void {
  const kind = command.kind as OperationKind;
  if (!operationPermittedByEffects(kind, effects)) {
    throw realDataError("ACTION_NOT_ALLOWED", `Admitted scope does not permit ${kind} operations.`);
  }
}

export function assertLocalScopeNotRevoked(scope: LocalExecutionScope, revokedIds: ReadonlySet<string>): void {
  if (revokedIds.has(scope.scopeId)) {
    throw realDataError(
      "LOCAL_SCOPE_REVOKED",
      `Local execution scope ${scope.scopeId} was revoked on this machine.`
    );
  }
}

export function assertScopeNotExpired(expiresAt: string, now = Date.now()): void {
  const milliseconds = Date.parse(expiresAt);
  if (!Number.isFinite(milliseconds)) {
    throw realDataError("INVALID_EXECUTION_SCOPE", "Scope expiry is not a valid absolute timestamp.");
  }
  if (milliseconds <= now) {
    throw realDataError("TARGET_AUTHORITY_EXPIRED", `Execution scope expired at ${expiresAt}.`);
  }
}

export function loopbackIsTransportOnly(assessedOrigin: string, transportOrigin: string): boolean {
  try {
    const assessed = new URL(assessedOrigin);
    const transport = new URL(transportOrigin);
    return isLocalOrPrivateHost(transport.hostname) && !isLocalOrPrivateHost(assessed.hostname);
  } catch {
    return false;
  }
}
