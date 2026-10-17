import type { JsonValue } from "../config/types.js";
import type { AssessmentReferencePayload } from "../assessment/bundle.js";
import type { SafeRelayFailure } from "../cloud/client.js";
import type { RelayResult } from "../cloud/protocol.js";
import { parseRelayResult } from "../cloud/protocol.js";
import type { OperationKind } from "../errors.js";
import { representationHash } from "./hash.js";
import { inspectOutbound, sealDataHandlingReceipt } from "./transform.js";
import { evaluateRetainedEvidence } from "./evidence.js";
import { dataPolicyError } from "./errors.js";
import type {
  DataHandlingReceipt,
  DataPolicyContext,
  InspectOutboundResult,
  RetainedEvidenceEvaluation
} from "./types.js";

export const DATA_POLICY_BLOCKED_FAILURE: SafeRelayFailure = {
  code: "DATA_POLICY_BLOCKED",
  safe_message: "The target response was blocked by the data policy. Evidence is unavailable.",
  retryable: false
};

export const INSUFFICIENT_EVIDENCE_FAILURE: SafeRelayFailure = {
  code: "INSUFFICIENT_EVIDENCE",
  safe_message: "Masking removed the decisive fact from the retained representation.",
  retryable: false
};

export function projectOutboundDocument(
  document: unknown,
  context: DataPolicyContext
): InspectOutboundResult {
  return inspectOutbound(document, context.policy, context.profile, context.localSecrets);
}

export type RelayIngressPath =
  | "relay.answer"
  | "relay.tool_arguments"
  | "relay.tool_result"
  | "relay.observation";

export interface RelayContentPart {
  readonly path: RelayIngressPath;
  /** The ingress document the profile runs on: { path, content }. */
  readonly document: JsonValue;
}

/**
 * Splits a relay result into the documents the server's ingress inspects.
 * Redaction profiles are written for those documents ({ path, content }, as
 * the default profile's /path and /content allowlist expects), so the CLI
 * applies the profile to each content part, not to the whole envelope.
 * Envelope fields (protocol_version, turn_id, request_id, finished) pass
 * through. assemble puts each part's retained content back; a part whose
 * content was dropped is left out.
 */
export function relayContentParts(
  kind: OperationKind,
  result: unknown
): {
  readonly parts: readonly RelayContentPart[];
  readonly assemble: (representations: readonly JsonValue[]) => unknown;
} {
  const wrap = (path: RelayIngressPath, content: unknown): RelayContentPart => ({
    path,
    document: { path, content: content as JsonValue }
  });
  if (!isObject(result) || (kind !== "send" && kind !== "observe")) {
    return {
      parts: [wrap(wholeResultIngressPath(kind), result)],
      assemble: ([representation]) => retainedContent(representation)
    };
  }
  const keys: string[] = [];
  const parts: RelayContentPart[] = [];
  const events = Array.isArray(result["events"]) ? result["events"] : undefined;
  for (const [key, value] of Object.entries(result)) {
    if (key === "message") parts.push(wrap("relay.answer", value));
    else if (key === "observations") parts.push(wrap("relay.observation", value));
    else if (key === "metadata") parts.push(wrap("relay.answer", value));
    else continue;
    keys.push(key);
  }
  for (const event of events ?? []) parts.push(wrap(eventIngressPath(event), event));
  return {
    parts,
    assemble: (representations) => {
      const assembled: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result)) {
        const index = keys.indexOf(key);
        if (index >= 0) {
          const content = retainedContent(representations[index]);
          if (content !== undefined) assembled[key] = content;
          else if (key === "metadata") assembled[key] = {};
        } else if (key === "events" && events !== undefined) {
          assembled[key] = representations
            .slice(keys.length)
            .map(retainedContent)
            .filter((content) => content !== undefined);
        } else {
          assembled[key] = value;
        }
      }
      return assembled;
    }
  };
}

/** inspectOutbound for a relay result, one ingress document per content part. */
export function inspectRelayResult(
  kind: OperationKind,
  result: unknown,
  context: DataPolicyContext
): InspectOutboundResult {
  const { parts, assemble } = relayContentParts(kind, result);
  const inspected = parts.map((part) =>
    inspectOutbound(part.document, context.policy, context.profile, context.localSecrets)
  );
  const representation = assemble(inspected.map((entry) => entry.representation)) as JsonValue;
  const counts = inspected.reduce(
    (total, entry) => ({
      dropped: total.dropped + entry.receipt.counts.dropped,
      masked: total.masked + entry.receipt.counts.masked,
      blocked: total.blocked + entry.receipt.counts.blocked
    }),
    { dropped: 0, masked: 0, blocked: 0 }
  );
  return {
    representation,
    receipt: sealDataHandlingReceipt({
      policy: context.policy,
      profile: context.profile,
      representation,
      counts
    }),
    blockedPaths: inspected.flatMap((entry) => entry.blockedPaths)
  };
}

function wholeResultIngressPath(kind: OperationKind): RelayIngressPath {
  if (kind === "prepare") return "relay.tool_arguments";
  if (kind === "cleanup") return "relay.tool_result";
  return kind === "observe" ? "relay.observation" : "relay.answer";
}

function eventIngressPath(event: unknown): RelayIngressPath {
  const type = isObject(event) ? event["type"] : undefined;
  if (type === "tool_call") return "relay.tool_arguments";
  if (type === "tool_result") return "relay.tool_result";
  return "relay.answer";
}

function retainedContent(representation: JsonValue | undefined): JsonValue | undefined {
  return isObject(representation) ? representation["content"] : undefined;
}

export function projectRelayResult(
  kind: OperationKind,
  result: RelayResult,
  context: DataPolicyContext,
  expectedFacts: readonly string[] = []
): {
  readonly disposition: "completed" | "blocked" | "insufficient_evidence";
  readonly result?: RelayResult;
  readonly failure?: SafeRelayFailure;
  readonly receipt: DataHandlingReceipt;
  readonly evidence: RetainedEvidenceEvaluation;
} {
  const inspected = inspectRelayResult(kind, result, context);
  const evidence = evaluateRetainedEvidence(inspected.representation, expectedFacts);
  if (inspected.receipt.outcome === "blocked" || inspected.blockedPaths.length > 0) {
    return {
      disposition: "blocked",
      failure: DATA_POLICY_BLOCKED_FAILURE,
      receipt: { ...inspected.receipt, outcome: "blocked" },
      evidence
    };
  }
  if (!evidence.ok) {
    return {
      disposition: "insufficient_evidence",
      failure: INSUFFICIENT_EVIDENCE_FAILURE,
      receipt: { ...inspected.receipt, outcome: "insufficient_evidence" },
      evidence
    };
  }
  try {
    const typed = parseRelayResult(kind, inspected.representation);
    return {
      disposition: "completed",
      result: typed,
      receipt: inspected.receipt,
      evidence
    };
  } catch {
    return {
      disposition: "blocked",
      failure: DATA_POLICY_BLOCKED_FAILURE,
      receipt: { ...inspected.receipt, outcome: "blocked" },
      evidence
    };
  }
}

export function projectJsonDocument(
  document: JsonValue,
  context: DataPolicyContext
): InspectOutboundResult {
  return inspectOutbound(document, context.policy, context.profile, context.localSecrets);
}

export function projectAssessmentReferencePayload(
  payload: AssessmentReferencePayload,
  context: DataPolicyContext
): AssessmentReferencePayload {
  const inspected = inspectOutbound(
    {
      bundleId: payload.bundleId,
      entries: payload.entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        sourceLabel: entry.sourceLabel,
        scope: entry.scope,
        content: entry.content,
        complete: entry.complete
      })),
      refundPolicy: payload.refundPolicy,
      knowledgeBoundary: payload.knowledgeBoundary,
      targetAlreadyConfigured: payload.targetAlreadyConfigured
    },
    context.policy,
    context.profile,
    context.localSecrets
  );
  if (inspected.receipt.outcome === "blocked") {
    throw dataPolicyError(
      "DATA_POLICY_BLOCKED",
      "Assessment reference content was blocked by the data policy before upload."
    );
  }
  const representation = inspected.representation;
  if (!isObject(representation) || !Array.isArray(representation["entries"])) {
    throw dataPolicyError(
      "DATA_POLICY_BLOCKED",
      "Assessment reference content could not be projected into a retained representation."
    );
  }
  const entries = representation["entries"].map((raw, index) => {
    const original = payload.entries[index];
    if (original === undefined || !isObject(raw) || typeof raw["content"] !== "string") {
      throw dataPolicyError(
        "DATA_POLICY_BLOCKED",
        "Assessment reference content could not be projected into a retained representation."
      );
    }
    const content = raw["content"];
    return {
      ...original,
      content,
      contentHash: representationHash(content),
      complete: original.complete && content.length > 0 && !content.includes("[REDACTED:")
    };
  });
  return { ...payload, entries };
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
