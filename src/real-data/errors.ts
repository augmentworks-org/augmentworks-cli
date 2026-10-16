import { AwError, type ErrorCategory } from "../errors.js";
import { REAL_DATA_ERROR_CODES, type RealDataErrorCode } from "./constants.js";

const NEVER_RETRY = new Set<RealDataErrorCode>(REAL_DATA_ERROR_CODES);

export function isRealDataErrorCode(code: string): code is RealDataErrorCode {
  return (REAL_DATA_ERROR_CODES as readonly string[]).includes(code);
}

export function realDataErrorCategory(code: RealDataErrorCode): ErrorCategory {
  switch (code) {
    case "TARGET_AUTHORITY_REQUIRED":
    case "TARGET_AUTHORITY_REVOKED":
      return "auth";
    case "INSUFFICIENT_EVIDENCE":
    case "EVIDENCE_REPRESENTATION_MISMATCH":
      return "evidence";
    case "EXECUTION_BUDGET_EXHAUSTED":
    case "EXECUTION_RELEASE_UNAVAILABLE":
    case "ACTION_OUTCOME_INDETERMINATE":
      return "relay";
    default:
      return "config";
  }
}

export function realDataRecoveryCopy(code: RealDataErrorCode, message: string): string {
  if (
    /syntheticOnly|synthetic_only|relabel.*synthetic|flip.*synthetic/iu.test(message)
  ) {
    return message.replace(/syntheticOnly|synthetic_only/gu, "the authorized scope");
  }
  const suffix = recoverySuffix(code, message);
  if (suffix === "" || message.includes(suffix.trim())) return message;
  return `${message}${suffix}`;
}

/**
 * What to do about a real-data error, in the user's terms and naming the
 * command or settings page that fixes it (AUG-366). The message decides which
 * advice applies when one code covers several situations.
 */
export function recoveryAdvice(code: RealDataErrorCode, message: string): string {
  return recoverySuffix(code, withoutRecoverySuffix(message)).trim();
}

/** The server's own words, without the recovery advice the CLI appended to them. */
export function withoutRecoverySuffix(message: string): string {
  for (const suffix of ALL_SUFFIXES) {
    if (message.endsWith(suffix)) return message.slice(0, -suffix.length);
  }
  return message;
}

/** Codes whose advice is written for people setting up and running real-data tests (AUG-366). */
export const PLAIN_RECOVERY_CODES: ReadonlySet<RealDataErrorCode> = new Set<RealDataErrorCode>([
  "TARGET_AUTHORITY_REQUIRED",
  "TARGET_AUTHORITY_EXPIRED",
  "TARGET_AUTHORITY_REVOKED",
  "TARGET_SCOPE_MISMATCH",
  "EXECUTION_BUDGET_EXHAUSTED",
  "EXECUTION_RELEASE_UNAVAILABLE"
]);

const SCOPE_CREATE = "`augmentworks scope create --target <name> --suite <file>`";

const SUFFIX = {
  statementMissing:
    " A workspace owner accepts it once by running `augmentworks target add` in a terminal, or in Settings → Targets.",
  machineKeySetup:
    " Registering a target and creating a scope need a workspace owner's login: unset AUGMENTWORKS_API_KEY and run `augmentworks login`.",
  notVerified: ` Check the target with \`augmentworks target list\`, finish verifying it with \`augmentworks target verify <name>\`, then create a scope with ${SCOPE_CREATE}.`,
  verificationExpired: ` Renew it with \`augmentworks target verify <name>\` (Settings → Targets shows when renewal opens), then create a new scope with ${SCOPE_CREATE}.`,
  challengeExpired: " Run `augmentworks target verify <name>` again to get a new code.",
  localScopeExpired: " The packet can't run after that. Ask whoever issued it for a new local-authorized packet.",
  scopeExpired: ` Create a new one with ${SCOPE_CREATE}. An expired scope can't be reused.`,
  revoked: ` A workspace owner revoked it in Settings → Targets. To test again, verify the target with \`augmentworks target verify <name>\` (or register it again with \`augmentworks target add\`), then create a new scope with ${SCOPE_CREATE}. Past results stay readable with \`augmentworks run report <run-id>\`.`,
  scopeMismatch:
    " `augmentworks target pull <name>` copies the registered address and endpoints into augmentworks.yaml, and `augmentworks target list` shows them.",
  budgetExhausted:
    " The run stopped there and won't retry, because a retry could message your agent again. Each run gets the scope's allowance, so run fewer cases at a time: split the suite with `augmentworks selection compile` and run each part with `augmentworks test --shard <shard-id>`.",
  releaseBusy: " Nothing was sent to your agent. Wait a few minutes and run the same command again.",
  releaseUnavailable:
    " Nothing was sent to your agent. Try again later. Synthetic tests and `augmentworks test --local --packet` still run."
} as const;

const STATIC_SUFFIX: Partial<Record<RealDataErrorCode, string>> = {
  UNSUPPORTED_EXECUTION_SCOPE:
    " Ask the workspace owner to enable aw-execution-scope/1 on this server, or use a local-authorized packet offline. Do not relabel the suite synthetic.",
  INVALID_EXECUTION_SCOPE:
    " The admitted scope must match the frozen aw-execution-scope/1 document. Re-fetch the server snapshot; do not reconstruct authority from YAML.",
  UNSUPPORTED_DATA_POLICY: " This CLI admits aw-data-policy/1 only. Unknown policies fail closed.",
  DATA_POLICY_FORBIDDEN:
    " The selected data policy forbids this content class. Choose an approved policy; do not disable redaction.",
  ACTION_BOUNDARY_REQUIRED:
    " This scope does not permit that operation. Controlled actions are owned by a later integration; do not run cleanup unless the admitted scope allows it.",
  ACTION_NOT_ALLOWED:
    " This scope does not permit that operation. Controlled actions are owned by a later integration; do not run cleanup unless the admitted scope allows it.",
  EXECUTION_SCOPE_STALE:
    " Re-fetch the server-admitted scope for this suite/config/quote/run binding. Do not reuse a stale snapshot.",
  DATA_POLICY_STALE:
    " Fetch the current policy and profile hashes from the admitted scope. Changing either invalidates the previous quote.",
  REDACTION_PROFILE_MISMATCH:
    " Fetch the current policy and profile hashes from the admitted scope. Changing either invalidates the previous quote.",
  QUOTE_SCOPE_MISMATCH:
    " Request a new quote for the current suite revision, target boundary, and scope hash. Do not raise --max-credits to bypass the mismatch.",
  EVIDENCE_REPRESENTATION_MISMATCH:
    " Missing or mismatched evidence is incomplete. Inspect this original run with `augmentworks run report <run-id> --scope authorized-1`. Do not start another billed test to retrieve a report.",
  ACTION_OUTCOME_INDETERMINATE:
    " The send already started without a durable outcome. It is not replayable after timeout, reconnect, or restart.",
  DATA_POLICY_BLOCKED:
    " Content was blocked by the selected policy. The run is not restarted. Preview the minimized payload locally; do not upload raw customer content.",
  INSUFFICIENT_EVIDENCE:
    " The report is incomplete. Wait for grading on this same run (`augmentworks run wait <run-id>`), then `augmentworks run report <run-id>`. Do not re-admit or re-run a charged test to obtain a report.",
  HOSTED_AUTHORITY_INTERCHANGE_FORBIDDEN:
    " Hosted aw-execution-scope/1 and local aw-local-execution-scope/1 cannot be interchanged. Use `augmentworks test --suite` for hosted or `augmentworks test --local --packet` for a local-authorized packet.",
  LOCAL_SCOPE_REVOKED:
    " This local scope was revoked on this machine. Remote revocation is not observed while offline.",
  PRIVACY_SERVICE_UNAVAILABLE:
    " Minimization and personal-content handling require the privacy service. Credential-only redaction remains; other profiles fail closed. Do not upload verbatim customer records."
};

const ALL_SUFFIXES: readonly string[] = [...new Set([...Object.values(SUFFIX), ...Object.values(STATIC_SUFFIX)])]
  // Longest first, so a suffix that ends another is never stripped short.
  .sort((left, right) => right.length - left.length);

function recoverySuffix(code: RealDataErrorCode, message: string): string {
  switch (code) {
    case "TARGET_AUTHORITY_REQUIRED":
      if (/statement/iu.test(message)) return SUFFIX.statementMissing;
      if (/machine key|api key/iu.test(message)) return SUFFIX.machineKeySetup;
      return SUFFIX.notVerified;
    case "TARGET_AUTHORITY_EXPIRED":
      if (/local scope/iu.test(message)) return SUFFIX.localScopeExpired;
      if (/challenge|verification code/iu.test(message)) return SUFFIX.challengeExpired;
      if (/verification|authority/iu.test(message)) return SUFFIX.verificationExpired;
      return SUFFIX.scopeExpired;
    case "TARGET_AUTHORITY_REVOKED":
      return SUFFIX.revoked;
    case "TARGET_SCOPE_MISMATCH":
      // Local scopes aren't registered targets; their messages say what to restore.
      return /local scope/iu.test(message) ? "" : SUFFIX.scopeMismatch;
    case "EXECUTION_BUDGET_EXHAUSTED":
      return SUFFIX.budgetExhausted;
    case "EXECUTION_RELEASE_UNAVAILABLE":
      return /too many|rate limit/iu.test(message) ? SUFFIX.releaseBusy : SUFFIX.releaseUnavailable;
    default:
      return STATIC_SUFFIX[code] ?? "";
  }
}

export function realDataError(
  code: RealDataErrorCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>,
  cause?: unknown
): AwError {
  return new AwError({
    code,
    category: realDataErrorCategory(code),
    message: realDataRecoveryCopy(code, message),
    retryable: false,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause })
  });
}

export function realDataHttpRetryable(
  code: string,
  status: number,
  method: "GET" | "POST" | undefined
): boolean {
  if (!isRealDataErrorCode(code)) {
    return status === 408 || status === 429 || status >= 500;
  }
  if (NEVER_RETRY.has(code) && code !== "EXECUTION_RELEASE_UNAVAILABLE") {
    return false;
  }
  if (code === "EXECUTION_BUDGET_EXHAUSTED") return false;
  if (code === "EXECUTION_RELEASE_UNAVAILABLE") {
    return method === "GET" && status === 503;
  }
  return false;
}
