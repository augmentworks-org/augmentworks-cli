import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli.js";
import { nodeSupportWarning } from "./system/node-support.js";

export { createCli, runCli, type CliIo } from "./cli.js";
export {
  CONTROLLED_ACTIONS_PUBLICLY_AVAILABLE,
  runCustomerBoundary,
  retryReceiptDelivery,
  createHostedActionClient,
  ActionIntentLedger
} from "./action-gate/index.js";
export type { CustomerBoundaryResult, ActionPermitService } from "./action-gate/index.js";
export {
  CLI_VERSION,
  CONFIG_VERSION,
  RELAY_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION_V2
} from "./version.js";
export { CLI_RELEASE, HOSTED_COMMANDS, LOCAL_COMMANDS, SOURCE_DEMO_COMMAND } from "./release.js";
export { buildDiscoveryManifest, parseDiscoveryManifest, sourceDiscoveryManifest } from "./discovery.js";

function isDirectInvocation(metaUrl: string, argvEntry: string | undefined): boolean {
  if (argvEntry === undefined) return false;
  const modulePath = fileURLToPath(metaUrl);
  const entryPath = resolve(argvEntry);
  try {
    return realpathSync(modulePath) === realpathSync(entryPath);
  } catch {
    return modulePath === entryPath;
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const nodeWarning = nodeSupportWarning(process.versions.node);
  if (nodeWarning !== null) process.stderr.write(`${nodeWarning}\n`);
  process.exitCode = await runCli(process.argv);
}
