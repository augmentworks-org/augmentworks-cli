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
  const suffix = recoverySuffix(code);
  if (suffix === "" || message.includes(suffix.trim())) return message;
  return `${message}${suffix}`;
}

/** The server's own words, without the recovery advice the CLI appended to them. */
export function withoutRecoverySuffix(message: string): string {
  for (const code of REAL_DATA_ERROR_CODES) {
    const suffix = recoverySuffix(code);
    if (suffix !== "" && message.endsWith(suffix)) return message.slice(0, -suffix.length);
  }
  return message;
}

function recoverySuffix(code: RealDataErrorCode): string {
  switch (code) {
    case "UNSUPPORTED_EXECUTION_SCOPE":
      return " Ask the workspace owner to enable aw-execution-scope/1 on this server, or use a local-authorized packet offline. Do not relabel the suite synthetic.";
    case "INVALID_EXECUTION_SCOPE":
      return " The admitted scope must match the frozen aw-execution-scope/1 document. Re-fetch the server snapshot; do not reconstruct authority from YAML.";
    case "UNSUPPORTED_DATA_POLICY":
      return " This CLI admits aw-data-policy/1 only. Unknown policies fail closed.";
    case "TARGET_AUTHORITY_REQUIRED":
      return " Register and verify the target in the workspace, then fetch a new execution scope. `augmentworks doctor` checks login; it does not grant authority.";
    case "TARGET_AUTHORITY_REVOKED":
      return " The target authority was revoked. Obtain a new verified authority and a new quote. Existing evidence remains readable.";
    case "TARGET_AUTHORITY_EXPIRED":
      return " Obtain a renewed authority and a new quote. Do not reuse the expired scope.";
    case "TARGET_SCOPE_MISMATCH":
      return " The configured origin, method, path, and allowed operations must match the admitted boundary exactly. Manual redirects only; loopback is transport, never the assessed target.";
    case "DATA_POLICY_FORBIDDEN":
      return " The selected data policy forbids this content class. Choose an approved policy; do not disable redaction.";
    case "ACTION_BOUNDARY_REQUIRED":
    case "ACTION_NOT_ALLOWED":
      return " This scope does not permit that operation. Controlled actions are owned by a later integration; do not run cleanup unless the admitted scope allows it.";
    case "EXECUTION_SCOPE_STALE":
      return " Re-fetch the server-admitted scope for this suite/config/quote/run binding. Do not reuse a stale snapshot.";
    case "DATA_POLICY_STALE":
    case "REDACTION_PROFILE_MISMATCH":
      return " Fetch the current policy and profile hashes from the admitted scope. Changing either invalidates the previous quote.";
    case "QUOTE_SCOPE_MISMATCH":
      return " Request a new quote for the current suite revision, target boundary, and scope hash. Do not raise --max-credits to bypass the mismatch.";
    case "EVIDENCE_REPRESENTATION_MISMATCH":
      return " Missing or mismatched evidence is incomplete. Inspect this original run with `augmentworks run report <run-id> --scope authorized-1`. Do not start another billed test to retrieve a report.";
    case "ACTION_OUTCOME_INDETERMINATE":
      return " The send already started without a durable outcome. It is not replayable after timeout, reconnect, or restart.";
    case "DATA_POLICY_BLOCKED":
      return " Content was blocked by the selected policy. The run is not restarted. Preview the minimized payload locally; do not upload raw customer content.";
    case "INSUFFICIENT_EVIDENCE":
      return " The report is incomplete. Wait for grading on this same run (`augmentworks run wait <run-id>`), then `augmentworks run report <run-id>`. Do not re-admit or re-run a charged test to obtain a report.";
    case "EXECUTION_BUDGET_EXHAUSTED":
      return " The finite operation allowance is exhausted, including indeterminate sends. This is not retryable. Raise the admitted budget only with a new quoted scope; never pass implicit --yes.";
    case "EXECUTION_RELEASE_UNAVAILABLE":
      return " Hosted real-data execution is implemented but release-disabled until backend and privacy integration are verified. Local authorized packets still run offline. `augmentworks suite preflight` does not contact the target.";
    case "HOSTED_AUTHORITY_INTERCHANGE_FORBIDDEN":
      return " Hosted aw-execution-scope/1 and local aw-local-execution-scope/1 cannot be interchanged. Use `augmentworks test --suite` for hosted or `augmentworks test --local --packet` for a local-authorized packet.";
    case "LOCAL_SCOPE_REVOKED":
      return " This local scope was revoked on this machine. Remote revocation is not observed while offline.";
    case "PRIVACY_SERVICE_UNAVAILABLE":
      return " Minimization and personal-content handling require the privacy service. Credential-only redaction remains; other profiles fail closed. Do not upload verbatim customer records.";
    default:
      return "";
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
