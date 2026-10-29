import { AwError } from "../errors.js";
import { classifyBillingRunStatus } from "../billing/classify.js";
import { gradingStillPending, judgeJobsFromProgress } from "../outcome/classify.js";
import type { BillingRunStatus } from "../billing/protocol.js";
import { capabilityIsAvailable, STATUS_V1 } from "../billing/protocol.js";
import { statusUnsupportedError } from "../billing/errors.js";
import { assertStatusCapability, assertStatusWorkspace } from "../billing/validate.js";
import type { HostedAuthSession } from "../commands/hosted-auth.js";

const DEFAULT_WAIT_MS = 15 * 60 * 1000;
const MAX_POLLS = 120;

export function parseTimeoutMs(raw: string | undefined): number {
  const value = raw === undefined ? DEFAULT_WAIT_MS : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3_600_000) {
    throw new AwError({
      code: "INVALID_TIMEOUT",
      category: "config",
      message: "--timeout-ms must be an integer between 1 and 3600000."
    });
  }
  return value;
}

export async function waitForOriginalRun(options: {
  readonly session: HostedAuthSession;
  readonly runId: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<BillingRunStatus> {
  await assertStatusAvailable(options.session, options.signal);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepWithSignal;
  const deadline = now() + options.timeoutMs;
  let delay = 1_000;
  let last: BillingRunStatus | undefined;
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    last = await readRunStatus(options.session, options.runId, options.signal);
    if (classifyBillingRunStatus(last).waitTerminal) return last;
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw waitIncompleteError(options.runId, last);
    }
    const jitter = Math.floor(delay * 0.2 * Math.random());
    await sleep(Math.min(delay + jitter, remaining), options.signal);
    delay = Math.min(delay * 2, 5_000);
  }
  throw waitIncompleteError(options.runId, last);
}

async function assertStatusAvailable(session: HostedAuthSession, signal?: AbortSignal): Promise<void> {
  let capabilities;
  try {
    capabilities =
      signal === undefined
        ? await session.cloud.getBillingCapabilities()
        : await session.cloud.getBillingCapabilities(signal);
  } catch (error) {
    if (error instanceof AwError && error.code === "USAGE_UNSUPPORTED") {
      throw statusUnsupportedError(error.details);
    }
    throw error;
  }
  if (!capabilityIsAvailable(capabilities.capabilities, STATUS_V1)) {
    throw statusUnsupportedError();
  }
  assertStatusCapability(capabilities.capabilities);
}

async function readRunStatus(
  session: HostedAuthSession,
  runId: string,
  signal?: AbortSignal
): Promise<BillingRunStatus> {
  const status =
    signal === undefined
      ? await session.cloud.getBillingRunStatus(runId)
      : await session.cloud.getBillingRunStatus(runId, signal);
  assertStatusWorkspace(status, session.identity.workspaceId);
  return status;
}

function waitIncompleteError(runId: string, status: BillingRunStatus | undefined): AwError {
  const gradingPending =
    status !== undefined &&
    gradingStillPending(status.evaluationStatus, judgeJobsFromProgress(status.progress));
  const reason = gradingPending
    ? "Grading is still pending"
    : "The original run is still in progress";
  return new AwError({
    code: "EVALUATION_INCOMPLETE",
    category: "relay",
    message: `${reason} on original run ${runId}. Evidence remains saved. Retry: augmentworks run wait ${runId}. Do not start another billed assessment, substitute a newer run, or auto-promote a baseline.`
  });
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(
        new AwError({
          code: "RELAY_REQUEST_CANCELLED",
          category: "relay",
          message: "The wait was cancelled.",
          retryable: true
        })
      );
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new AwError({
          code: "RELAY_REQUEST_CANCELLED",
          category: "relay",
          message: "The wait was cancelled.",
          retryable: true
        })
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
