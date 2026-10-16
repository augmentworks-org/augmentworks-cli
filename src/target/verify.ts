import { randomUUID } from "node:crypto";
import { Resolver } from "node:dns/promises";

import type { CloudClient } from "../cloud/client.js";
import type { ResolvedConfig } from "../config/types.js";
import { runConnectionProbe, type ConnectionProbeReport } from "../connector/connection-probe.js";
import { AwError, sanitizeTerminal } from "../errors.js";
import { canonicalAssessedOrigin } from "../real-data/boundary.js";
import { withoutRecoverySuffix } from "../real-data/errors.js";
import { shellWord } from "./common.js";
import type {
  StoredTarget,
  TargetChallenge,
  TargetDetail,
  TargetEnvironment,
  VerificationMethod,
  VerifyTargetRequest,
  VerifyTargetResponse
} from "./protocol.js";

export const WELL_KNOWN_PATH = "/.well-known/augmentworks-target";
export const TXT_NAME_PREFIX = "_augmentworks-target.";
const BODY_PREFIX = "augmentworks-target=";
const MAX_BODY_BYTES = 4_096;
const LOCAL_CHECK_TIMEOUT_MS = 5_000;

/** How often the CLI looks for the published code itself. */
export const LOCAL_CHECK_INTERVAL_MS = 15_000;
/**
 * The server allows a handful of verification attempts per owner per ten
 * minutes. So the CLI asks it at the start, as soon as its own check first sees
 * the code, and then no more often than this. Without a sighting it still asks
 * now and then, in case this machine can't see what the server can.
 */
export const SERVER_RETRY_AFTER_SIGHTING_MS = 3 * 60_000;
export const SERVER_RETRY_UNSEEN_MS = 6 * 60_000;
export const DEFAULT_VERIFY_TIMEOUT_MS = 30 * 60_000;

export interface PublishedCheck {
  readonly found: boolean;
  /** Why it wasn't found, in a few words. */
  readonly reason?: string;
}

export interface VerifyWaitDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly resolveTxt?: (name: string) => Promise<string[]>;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly probe?: (resolved: ResolvedConfig, signal?: AbortSignal) => Promise<ConnectionProbeReport>;
  readonly newId?: () => string;
}

/** The value checks accept, as the server's: the bare code, or `augmentworks-target=<code>`. */
export function publishedValueMatches(nonce: string, observed: string): boolean {
  const trimmed = observed.trim();
  const prefixed = `${BODY_PREFIX}${nonce}`;
  return (
    trimmed === nonce ||
    trimmed === prefixed ||
    trimmed.split(/\r?\n/u)[0]?.trim() === prefixed ||
    trimmed.includes(prefixed)
  );
}

export function hostOf(assessedIdentity: string): string {
  const url = new URL(assessedIdentity.includes("://") ? assessedIdentity : `https://${assessedIdentity}`);
  return url.hostname.replace(/^\[|\]$/gu, "");
}

export function originOf(assessedIdentity: string): string {
  return new URL(assessedIdentity.includes("://") ? assessedIdentity : `https://${assessedIdentity}`).origin;
}

async function checkWellKnown(
  assessedIdentity: string,
  nonce: string,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal
): Promise<PublishedCheck> {
  const url = new URL(WELL_KNOWN_PATH, originOf(assessedIdentity));
  const timeout = AbortSignal.timeout(LOCAL_CHECK_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "text/plain, */*;q=0.1" },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    });
  } catch {
    if (signal?.aborted === true) throw cancelled();
    return { found: false, reason: `${url.href} didn't answer` };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return { found: false, reason: `${url.href} answered HTTP ${response.status}` };
  }
  const text = (await response.text()).slice(0, MAX_BODY_BYTES);
  return publishedValueMatches(nonce, text)
    ? { found: true }
    : { found: false, reason: `${url.href} doesn't serve the code yet` };
}

async function checkTxt(
  assessedIdentity: string,
  nonce: string,
  resolveTxt: (name: string) => Promise<string[]>
): Promise<PublishedCheck> {
  const name = `${TXT_NAME_PREFIX}${hostOf(assessedIdentity)}`;
  let records: string[];
  try {
    records = await resolveTxt(name);
  } catch {
    return { found: false, reason: `no TXT record at ${name} yet` };
  }
  return records.some((record) => publishedValueMatches(nonce, record))
    ? { found: true }
    : { found: false, reason: `the TXT record at ${name} doesn't hold the code yet` };
}

async function defaultResolveTxt(name: string): Promise<string[]> {
  const records = await new Resolver().resolveTxt(name);
  return records.map((parts) => parts.join(""));
}

function cancelled(): AwError {
  return new AwError({
    code: "RELAY_REQUEST_CANCELLED",
    category: "relay",
    message: "The wait was cancelled.",
    retryable: true
  });
}

export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Finds the one live target with this name, in `environment` when given. */
export function selectTarget(
  targets: readonly StoredTarget[],
  name: string,
  environment: TargetEnvironment | undefined
): StoredTarget {
  const named = targets.filter((target) => target.name === name && target.status !== "revoked");
  const matching = environment === undefined ? named : named.filter((target) => target.environment === environment);
  if (matching.length === 1) return matching[0]!;
  if (matching.length === 0) {
    const where = environment === undefined ? "" : ` in ${environment}`;
    const revoked = targets.some((target) => target.name === name && target.status === "revoked");
    throw new AwError({
      code: "TARGET_NOT_FOUND",
      category: "config",
      message: revoked
        ? `${sanitizeTerminal(name)} was revoked. Add it again with \`augmentworks target add\`.`
        : `This workspace has no target named ${sanitizeTerminal(name)}${where}. Add it with \`augmentworks target add\`, or run \`augmentworks target list\` to see the names.`
    });
  }
  const environments = matching.map((target) => target.environment).join(", ");
  throw new AwError({
    code: "TARGET_AMBIGUOUS",
    category: "config",
    message: `${sanitizeTerminal(name)} is registered in more than one environment (${environments}). Pass --env to pick one.`
  });
}

export interface VerifyTargetOptions {
  readonly cloud: CloudClient;
  readonly workspaceId: string;
  readonly detail: TargetDetail;
  readonly requestedMethod?: "https" | "dns";
  readonly clientRef?: string;
  /** augmentworks.yaml, needed only to confirm a private address from this machine. */
  readonly loadConfig: () => Promise<ResolvedConfig>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly report: (line: string) => void;
}

export interface VerifyTargetOutcome {
  readonly target: StoredTarget;
  readonly method: VerificationMethod;
  readonly alreadyVerified: boolean;
  readonly expiresAt: string;
  readonly ownerStatement: boolean;
}

/**
 * Answers the target's open challenge. Public addresses wait until the
 * published code is seen, private ones are confirmed from this machine, and a
 * client's agent records the written permission.
 */
export async function verifyTarget(
  options: VerifyTargetOptions,
  dependencies: VerifyWaitDependencies = {}
): Promise<VerifyTargetOutcome> {
  const { detail } = options;
  const target = detail.target;
  const method = target.verificationMethod;
  assertRequestedMethod(target, options.requestedMethod);
  if (target.status === "verified" && detail.challenge === null) {
    return { target, method, alreadyVerified: true, expiresAt: detail.authority.expiresAt, ownerStatement: false };
  }
  const challenge = detail.challenge ?? (await reissueChallenge(options, dependencies));
  const request: VerifyTargetRequest = { nonce: challenge.nonce, expectedRevision: target.currentRevision };

  if (method === "reviewed_permission") {
    const clientRef = options.clientRef?.trim();
    const response = await options.cloud.verifyTarget(
      options.workspaceId,
      target.targetId,
      {
        ...request,
        permissionAttestation:
          clientRef === undefined || clientRef === ""
            ? { kind: "owner_written_permission" }
            : { kind: "agency_written_permission", representedClientRef: clientRef }
      },
      options.signal
    );
    return outcome(target, method, response, false);
  }

  if (method === "connector_challenge") {
    const resolved = await options.loadConfig();
    const configured = canonicalAssessedOrigin(resolved.baseUrl.origin, { allowPrivate: true });
    const registered = canonicalAssessedOrigin(originOf(target.assessedIdentity), { allowPrivate: true });
    if (configured !== registered) {
      throw new AwError({
        code: "TARGET_SCOPE_MISMATCH",
        category: "config",
        message: `augmentworks.yaml points at ${configured}, but ${sanitizeTerminal(target.name)} is registered at ${registered}. Confirm it with the configuration that reaches ${registered}.`
      });
    }
    options.report(`Checking that this machine reaches ${registered}. This doesn't use credits.`);
    const report = await (dependencies.probe ?? defaultProbe)(resolved, options.signal);
    if (!report.ok) {
      const reason = report.corrective_action ?? report.diagnostics.find((item) => item.level === "error")?.message;
      throw new AwError({
        code: "TARGET_UNREACHABLE",
        category: "target",
        message: `This machine couldn't reach the agent at ${registered}, so nothing was recorded.${reason === undefined ? "" : ` ${sanitizeTerminal(reason)}`} Run \`augmentworks probe --yes\` for details.`
      });
    }
    const response = await options.cloud.verifyTarget(
      options.workspaceId,
      target.targetId,
      { ...request, connectorAttestation: true },
      options.signal
    );
    return outcome(target, method, response, true);
  }

  return await waitForPublishedCode(options, challenge, request, dependencies);
}

async function waitForPublishedCode(
  options: VerifyTargetOptions,
  challenge: TargetChallenge,
  request: VerifyTargetRequest,
  dependencies: VerifyWaitDependencies
): Promise<VerifyTargetOutcome> {
  const target = options.detail.target;
  const method = target.verificationMethod;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? sleepUnlessAborted;
  const host = hostOf(target.assessedIdentity);
  if (method === "dns_txt") {
    options.report(
      `Add a TXT record named ${TXT_NAME_PREFIX}${host} with this value:\n\n  ${challenge.nonce}\n`
    );
  } else {
    options.report(
      `Serve this exact value at ${originOf(target.assessedIdentity)}${WELL_KNOWN_PATH}:\n\n  ${challenge.nonce}\n`
    );
  }
  options.report(
    `The code expires at ${challenge.expiresAt}. Checking every ${LOCAL_CHECK_INTERVAL_MS / 1000} seconds. Press Ctrl+C to stop; running this again keeps the same code.`
  );
  const deadline = Math.min(now() + options.timeoutMs, Date.parse(challenge.expiresAt));
  let lastServerAttempt = Number.NEGATIVE_INFINITY;
  let lastReason: string | undefined;
  let sighted = false;
  for (;;) {
    const check =
      method === "dns_txt"
        ? await checkTxt(target.assessedIdentity, challenge.nonce, dependencies.resolveTxt ?? defaultResolveTxt)
        : await checkWellKnown(
            target.assessedIdentity,
            challenge.nonce,
            dependencies.fetch ?? globalThis.fetch,
            options.signal
          );
    const sinceServer = now() - lastServerAttempt;
    // The first sighting goes to the server at once; after that, retries are spaced out.
    const firstSighting = check.found && !sighted;
    if (check.found) sighted = true;
    const askServer =
      firstSighting ||
      (check.found ? sinceServer >= SERVER_RETRY_AFTER_SIGHTING_MS : sinceServer >= SERVER_RETRY_UNSEEN_MS);
    if (askServer) {
      lastServerAttempt = now();
      try {
        const response = await options.cloud.verifyTarget(options.workspaceId, target.targetId, request, options.signal);
        return outcome(target, method, response, false);
      } catch (error) {
        if (!stillWaiting(error)) throw error;
        const reason = withoutRecoverySuffix((error as AwError).message);
        if (reason !== lastReason) options.report(`Not verified yet: ${sanitizeTerminal(reason)}`);
        lastReason = reason;
      }
    } else if (!check.found && check.reason !== lastReason) {
      options.report(`Not published yet: ${sanitizeTerminal(check.reason ?? "the code isn't there")}.`);
      lastReason = check.reason;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      const expired = now() >= Date.parse(challenge.expiresAt);
      throw new AwError({
        code: "TARGET_VERIFY_TIMEOUT",
        category: "target",
        message: expired
          ? `The code expired before it was seen. Run \`augmentworks target verify ${shellWord(target.name)}\` again for a new one.`
          : `Stopped waiting after ${Math.round(options.timeoutMs / 60_000)} minutes. The code stays valid until ${challenge.expiresAt}; run \`augmentworks target verify ${shellWord(target.name)}\` again to keep checking.`
      });
    }
    await sleep(Math.min(LOCAL_CHECK_INTERVAL_MS, remaining), options.signal);
  }
}

/** A failure that publishing the code, or waiting for DNS, can still fix. */
function stillWaiting(error: unknown): boolean {
  return (
    error instanceof AwError &&
    error.code === "TARGET_AUTHORITY_REQUIRED" &&
    /fetched|couldn't fetch|TXT record|resolve/iu.test(error.message)
  );
}

function assertRequestedMethod(target: StoredTarget, requested: "https" | "dns" | undefined): void {
  if (requested === undefined) return;
  const wanted: VerificationMethod = requested === "dns" ? "dns_txt" : "https_challenge";
  if (target.verificationMethod === wanted) return;
  const registered: Record<VerificationMethod, string> = {
    https_challenge: "an HTTPS file",
    dns_txt: "a DNS TXT record",
    connector_challenge: "a check from this machine, because its address is private",
    reviewed_permission: "the client's written permission"
  };
  throw new AwError({
    code: "TARGET_METHOD_UNAVAILABLE",
    category: "config",
    message: `${sanitizeTerminal(target.name)} was added to be verified by ${registered[target.verificationMethod]}, and its open code is for that. Run it without --method, or remove the target in the portal and add it again with \`augmentworks target add --method ${requested}\`.`
  });
}

/** An expired or used code: register the same boundary again for a new one. */
async function reissueChallenge(
  options: VerifyTargetOptions,
  dependencies: VerifyWaitDependencies
): Promise<TargetChallenge> {
  const target = options.detail.target;
  if (target.transport !== "direct_http" || target.effectBoundary !== "no_tools") {
    throw new AwError({
      code: "TARGET_CHALLENGE_UNAVAILABLE",
      category: "config",
      message: `${sanitizeTerminal(target.name)} has no open code, and it was added in the portal with settings the CLI doesn't manage. Open a new code from Settings → Targets.`
    });
  }
  const registration = await options.cloud.registerTarget(
    options.workspaceId,
    {
      targetId: target.targetId,
      name: target.name,
      environment: target.environment,
      transport: "direct_http",
      targetBoundaryHash: target.currentBoundaryHash,
      effectBoundary: "no_tools",
      authorizationKind: target.authorizationKind,
      permissionRef: target.permissionRef,
      verificationMethod: target.verificationMethod,
      assessedIdentity: target.assessedIdentity,
      endpoints: options.detail.endpoints
    },
    (dependencies.newId ?? randomUUID)(),
    options.signal
  );
  options.report("The previous code expired, so this is a new one.");
  return registration.challenge;
}

function outcome(
  target: StoredTarget,
  method: VerificationMethod,
  response: VerifyTargetResponse,
  ownerStatement: boolean
): VerifyTargetOutcome {
  return { target, method, alreadyVerified: false, expiresAt: response.authority.expiresAt, ownerStatement };
}

async function defaultProbe(resolved: ResolvedConfig, signal?: AbortSignal): Promise<ConnectionProbeReport> {
  return await runConnectionProbe({ resolved, execute: true, ...(signal === undefined ? {} : { signal }) });
}
