import type { ResolvedConfig } from "../config/types.js";
import { AwError } from "../errors.js";
import type { AnyLocalPacketManifest, PacketAssertion, PacketManifest } from "./types.js";
import { isLocalAuthorizedPacket } from "./types.js";
import {
  assertBoundaryMatchesConfig,
  localTargetBoundary,
  operationPermittedByEffects
} from "../real-data/boundary.js";
import { realDataError } from "../real-data/errors.js";

export interface LocalPacketCompatibilityIssue {
  readonly code:
    | "PREPARE_REQUIRED"
    | "OBSERVATION_REQUIRED"
    | "CLEANUP_REQUIRED"
    | "TOOL_EVENTS_REQUIRED"
    | "OBSERVATION_NOT_ALLOWED"
    | "MULTI_TURN_REQUIRED";
  readonly message: string;
  readonly path: string;
}

export interface LocalPacketCompatibilityReport {
  readonly ok: boolean;
  readonly issues: readonly LocalPacketCompatibilityIssue[];
  readonly requiredObservationKeys: readonly string[];
}

export function inspectLocalPacketCompatibility(
  packet: AnyLocalPacketManifest,
  resolved: ResolvedConfig
): LocalPacketCompatibilityReport {
  const issues: LocalPacketCompatibilityIssue[] = [];
  const needsPrepare = packet.scenarios.some(
    (scenario) => Object.keys(scenario.fixture).length > 0
  );
  const requiredObservationKeys = [
    ...new Set(packet.scenarios.flatMap((scenario) => scenario.observation_keys))
  ].sort();
  const needsObservation =
    packet.required_capabilities.observation || requiredObservationKeys.length > 0;
  const needsCleanup = packet.required_capabilities.cleanup || needsPrepare;
  const needsToolEvents =
    packet.required_capabilities.tool_events ||
    packet.scenarios.some((scenario) => scenario.assertions.some(assertionUsesEvents));

  if (needsPrepare && !resolved.capabilities.prepare) {
    issues.push({
      code: "PREPARE_REQUIRED",
      message: "The packet contains synthetic fixtures, but target.operations.prepare is not configured.",
      path: "target.operations.prepare"
    });
  }
  if (needsObservation && !resolved.capabilities.observation) {
    issues.push({
      code: "OBSERVATION_REQUIRED",
      message: "The packet requires state observation, but target.operations.observe is not configured.",
      path: "target.operations.observe"
    });
  }
  if (needsCleanup && !resolved.capabilities.cleanup) {
    issues.push({
      code: "CLEANUP_REQUIRED",
      message: "The packet requires synthetic cleanup, but target.operations.cleanup is not configured.",
      path: "target.operations.cleanup"
    });
  }
  if (needsToolEvents && !resolved.capabilities.tool_events) {
    issues.push({
      code: "TOOL_EVENTS_REQUIRED",
      message:
        "The packet uses structured target-event assertions, but tool-event evidence is not mapped and allowlisted.",
      path: "telemetry.allow_tool_events"
    });
  }
  if (packet.required_capabilities.multi_turn && !resolved.conversation.multiTurn) {
    issues.push({
      code: "MULTI_TURN_REQUIRED",
      message:
        "The packet requires multi-turn conversation, but target.conversation.strategy is not explicit_session_v1 with $input.conversation_id mapped on send.",
      path: "target.conversation.strategy"
    });
  }

  const allowed = new Set(resolved.config.telemetry?.allow_observations ?? []);
  for (const key of requiredObservationKeys) {
    if (allowed.has(key)) continue;
    issues.push({
      code: "OBSERVATION_NOT_ALLOWED",
      message: `The packet requests observation ${key}, which is not in telemetry.allow_observations.`,
      path: "telemetry.allow_observations"
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    requiredObservationKeys
  };
}

export function assertLocalPacketCompatible(
  packet: AnyLocalPacketManifest,
  resolved: ResolvedConfig
): void {
  if (isLocalAuthorizedPacket(packet)) {
    const boundary = localTargetBoundary(packet.execution_scope, resolved);
    assertBoundaryMatchesConfig(boundary, resolved, { allowPrivate: true });
    if (
      packet.required_capabilities.cleanup &&
      !operationPermittedByEffects("cleanup", packet.execution_scope.effects)
    ) {
      throw realDataError(
        "ACTION_NOT_ALLOWED",
        "Local authorized packets cannot enable cleanup unless the local scope allows that operation."
      );
    }
  }
  const report = inspectLocalPacketCompatibility(packet, resolved);
  if (report.ok) return;
  const first = report.issues[0];
  throw new AwError({
    code: "LOCAL_PACKET_INCOMPATIBLE",
    category: "config",
    message:
      first === undefined
        ? "The local packet is not compatible with the configured target."
        : `${first.message} (${report.issues.length} compatibility issue${report.issues.length === 1 ? "" : "s"} found.)`,
    details: {
      issue_count: report.issues.length,
      first_issue: first?.code ?? "UNKNOWN",
      first_path: first?.path ?? "unknown"
    }
  });
}

function assertionUsesEvents(assertion: PacketAssertion): boolean {
  return (
    assertion.kind === "tool_called" ||
    assertion.kind === "tool_not_called" ||
    assertion.kind === "tool_result" ||
    assertion.kind === "handoff_occurred" ||
    assertion.kind === "no_error_events"
  );
}
