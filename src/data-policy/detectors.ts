import { isSensitiveKey, SecretRedactor } from "../system/redact.js";
import { PLACEHOLDERS, type RedactionDetector } from "./types.js";

export { isSensitiveKey };

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;

/**
 * International phone pattern (AUG-400). The server's `PHONE_PATTERN_SOURCE`
 * (augmentworks src/lib/data-policy/contract.ts) carries the same source so
 * both sides mask the same text. Keep them identical.
 *
 * - 10 to 15 digits (E.164 allows at most 15), optionally led by `+` and/or
 *   `(`, with at most two of space, `.`, `-`, `(`, `)` or NBSP between digits.
 * - Never starts inside a word or number, or right after `word.`/`word-`, so
 *   UUID segments and `call_0123456789` style identifiers are left alone.
 * - Never starts on a date (`2026-10-18`, `18.10.2026`), so dates followed by
 *   a time are not joined into a phone-length run.
 */
export const PHONE_PATTERN_SOURCE = String.raw`(?<![\w+]|\w[.\-])(?!\d{4}[.\-]\d{1,2}[.\-]\d{1,2}(?!\d)|\d{1,2}[.\-]\d{1,2}[.\-]\d{4}(?!\d))\+?\(?\d(?:[ .\-()\u00A0]{0,2}\d){9,14}(?!\w)`;
const PHONE_PATTERN = new RegExp(PHONE_PATTERN_SOURCE, "gu");

/** Detectors whose rules mask only the matched text in every string leaf. */
export const STRING_LEAF_DETECTORS: ReadonlySet<RedactionDetector> = new Set(["email", "phone"]);
const QUERY_SECRET_KEYS = /^(?:access[_-]?token|api[_-]?key|auth|password|secret|token|key)$/iu;

export const PROTOCOL_ENUMS = new Set([
  "ready",
  "cleaned",
  "assistant",
  "user",
  "system",
  "passed",
  "failed",
  "error",
  "inconclusive",
  "completed",
  "outcome_indeterminate",
  "aw-target/0.1",
  "aw-relay/0.1",
  "aw-relay/0.2",
  "aw-relay/0.3",
  "AW-LOCAL-RESULT-1",
  "aw-data-policy/1",
  "aw-redaction-profile/1",
  "aw-data-handling-receipt/1",
  "stop",
  "length",
  "tool_call",
  "tool_result",
  "handoff",
  "error_event"
]);

export const STRUCTURAL_KEYS = new Set([
  "protocol_version",
  "schema_version",
  "schemaVersion",
  "turn_id",
  "attempt_id",
  "request_id",
  "command_id",
  "run_id",
  "session_id",
  "status",
  "role",
  "finished",
  "disposition",
  "kind",
  "event",
  "result_sha256",
  "config_sha256",
  "request_sha256",
  "sequence",
  "fencing_epoch",
  "journal_version",
  "execution_mode",
  "executor",
  "verification",
  "signature",
  "platform_received",
  "customer_executed",
  "augmentworks_verified",
  "signed",
  "managed_review",
  "uploaded",
  "cloud_contacted",
  "outcome",
  "cli_version",
  "scorer_version",
  "trust_label",
  "finish_reason"
]);

export function isStructuralKey(key: string): boolean {
  return STRUCTURAL_KEYS.has(key) || key.endsWith("_sha256") || /Hash$/u.test(key);
}

export function isProtectedStructuralValue(key: string, value: unknown): boolean {
  if (!isStructuralKey(key)) return false;
  if (typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value !== "string") return false;
  return PROTOCOL_ENUMS.has(value) || /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);
}

export function detectorMatches(
  detector: RedactionDetector,
  key: string,
  value: unknown,
  secrets: readonly string[]
): boolean {
  switch (detector) {
    case "field":
      return true;
    case "credential":
      return isSensitiveKey(key) || valueContainsCredential(value, secrets);
    case "email":
      return typeof value === "string" && regexTest(EMAIL_PATTERN, value);
    case "phone":
      return typeof value === "string" && regexTest(PHONE_PATTERN, value);
    case "exact_local_secret":
      return typeof value === "string" && secrets.some((secret) => secret.length > 0 && value.includes(secret));
  }
}

export function maskJsonForDisplay(
  value: unknown,
  secrets: readonly string[],
  detectors: ReadonlySet<RedactionDetector>
): unknown {
  if (typeof value === "string") {
    return maskString(value, "", secrets, detectors).text;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((child) => maskJsonForDisplay(child, secrets, detectors));
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: isSensitiveKey(key)
        ? PLACEHOLDERS.credential
        : maskJsonForDisplay(child, secrets, detectors)
    });
  }
  return result;
}

export function maskString(
  value: string,
  key: string,
  secrets: readonly string[],
  detectors: ReadonlySet<RedactionDetector>
): { text: string; changed: boolean } {
  if (isProtectedStructuralValue(key, value)) {
    return { text: value, changed: false };
  }
  let text = value;
  if (detectors.has("credential") || detectors.has("exact_local_secret") || detectors.has("email") || detectors.has("phone")) {
    text = maskUrlSecrets(text, secrets, detectors);
  }
  if (detectors.has("exact_local_secret")) {
    const usable = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
      (left, right) => right.length - left.length
    );
    for (const secret of usable) {
      if (isProtectedStructuralValue(key, secret)) continue;
      if (text.includes(secret)) {
        text = text.split(secret).join(PLACEHOLDERS.exact_local_secret);
      }
    }
  }
  if (detectors.has("email")) {
    text = text.replace(EMAIL_PATTERN, PLACEHOLDERS.email);
  }
  if (detectors.has("phone")) {
    text = text.replace(PHONE_PATTERN, PLACEHOLDERS.phone);
  }
  if (detectors.has("credential")) {
    text = new SecretRedactor(secrets).redact(text);
    if (text.includes("[REDACTED]") && !text.includes(PLACEHOLDERS.credential)) {
      text = text.replaceAll("[REDACTED]", PLACEHOLDERS.credential);
    }
  }
  return { text, changed: text !== value };
}

function valueContainsCredential(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value !== "string") return false;
  if (secrets.some((secret) => secret.length > 0 && value.includes(secret))) return true;
  const redacted = new SecretRedactor(secrets).redact(value);
  return redacted !== value;
}

function maskUrlSecrets(
  value: string,
  secrets: readonly string[],
  detectors: ReadonlySet<RedactionDetector>
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    parsed.username = "";
    parsed.password = "";
  }
  const params = parsed.searchParams;
  const keys = [...params.keys()];
  for (const queryKey of keys) {
    const current = params.getAll(queryKey);
    params.delete(queryKey);
    for (const item of current) {
      let next = item;
      if (QUERY_SECRET_KEYS.test(queryKey) || isSensitiveKey(queryKey)) {
        next = PLACEHOLDERS.credential;
      }
      next = next.replace(EMAIL_PATTERN, PLACEHOLDERS.email);
      next = next.replace(PHONE_PATTERN, PLACEHOLDERS.phone);
      for (const secret of secrets) {
        if (secret.length > 0 && next.includes(secret)) {
          next = next.split(secret).join(PLACEHOLDERS.exact_local_secret);
        }
      }
      params.append(queryKey, next);
    }
  }
  return parsed.toString();
}

function regexTest(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}
