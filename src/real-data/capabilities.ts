import {
  AUTHORIZED_PACKET_SCHEMA_VERSION,
  AUTHORIZED_REPORT_SCOPE,
  CAPABILITIES_PATH,
  CONTROLLED_ACTIONS_UNAVAILABLE_REASON,
  DATA_POLICY_SCHEMA_VERSION,
  EXECUTION_SCOPE_SCHEMA_VERSION,
  REAL_DATA_CONTRACT_REVISION,
  SUITE_SCHEMA_VERSION_V3
} from "./constants.js";
import type { RealDataCapabilities } from "./documents.js";
import { realDataError } from "./errors.js";

/** Used only when the server has no /v1/capabilities route (404). */
export const DISABLED_REAL_DATA_CAPABILITIES: RealDataCapabilities = {
  schemaVersion: "aw-capabilities/1",
  contractRevision: REAL_DATA_CONTRACT_REVISION,
  executionScopes: [],
  suiteSchemas: ["aw-suite/1", "aw-suite/2"],
  packetSchemas: ["aw-packet/0.1", "aw-packet/live-informational-1"],
  reportScopes: [],
  dataPolicies: [],
  supportedEffects: [],
  enabledEffects: [],
  controlledActions: { available: false, reason: CONTROLLED_ACTIONS_UNAVAILABLE_REASON },
  runtimeEnforced: false,
  releaseEnabled: false
};

export function capabilitiesReleaseEnabled(capabilities: RealDataCapabilities): boolean {
  return capabilities.releaseEnabled === true && capabilities.runtimeEnforced === true;
}

export function capabilitiesAdvertiseAuthorized(capabilities: RealDataCapabilities): boolean {
  return (
    capabilities.executionScopes.includes(EXECUTION_SCOPE_SCHEMA_VERSION) &&
    capabilities.suiteSchemas.includes(SUITE_SCHEMA_VERSION_V3) &&
    capabilities.packetSchemas.includes(AUTHORIZED_PACKET_SCHEMA_VERSION) &&
    capabilities.dataPolicies.includes(DATA_POLICY_SCHEMA_VERSION)
  );
}

export function assertAuthorizedCapabilities(capabilities: RealDataCapabilities): void {
  if (!capabilitiesAdvertiseAuthorized(capabilities)) {
    throw realDataError(
      "UNSUPPORTED_EXECUTION_SCOPE",
      "This server does not advertise aw-execution-scope/1, aw-suite/3, and aw-packet/authorized-1."
    );
  }
}

export function assertHostedRealDataRelease(capabilities: RealDataCapabilities): void {
  assertAuthorizedCapabilities(capabilities);
  if (!capabilitiesReleaseEnabled(capabilities)) {
    throw realDataError(
      "EXECUTION_RELEASE_UNAVAILABLE",
      "AugmentWorks isn't accepting real-data tests right now."
    );
  }
}

export function assertAuthorizedReportScope(capabilities: RealDataCapabilities): void {
  if (!capabilities.reportScopes.includes(AUTHORIZED_REPORT_SCOPE)) {
    throw realDataError(
      "UNSUPPORTED_EXECUTION_SCOPE",
      "This server does not advertise the authorized-1 report overlay."
    );
  }
}

export { CAPABILITIES_PATH };
