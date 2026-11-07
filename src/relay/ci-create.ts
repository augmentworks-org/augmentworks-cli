import type { CreateRunResponse, RunStatusResponse } from "../cloud/protocol.js";
import { isTargetExecutionTerminal } from "../cloud/recovery-protocol.js";
import { AwError } from "../errors.js";
import type { CiAdmission } from "./ci-admission.js";
import type { RecoveryContext } from "./recovery.js";
import type { CreateRunIntentRequest } from "./run-intent.js";

function bindingConflict(): AwError {
  return new AwError({
    code: "RUN_BINDING_MISMATCH",
    category: "protocol",
    message: "The relay could not confirm the original CI run. Check the admission before retrying."
  });
}

export async function startAdmittedRun(
  { cloud, intentStore, signal, onNotice }: RecoveryContext,
  request: CreateRunIntentRequest,
  admission: CiAdmission
): Promise<{ binding: CreateRunResponse; resumed: boolean; currentStatus?: RunStatusResponse }> {
  const { intent, archivedRunId } = await intentStore.loadOrCreate(request);
  const lookup = await cloud.lookupCreateIntent(intent.request, signal);
  if (lookup.outcome === "retired_uncreated") {
    if (intent.binding || archivedRunId || admission.runId) throw bindingConflict();
    await intentStore.retirePendingUncreated("retired_uncreated");
    throw new AwError({
      code: "CI_ADMISSION_RETIRED",
      category: "relay",
      message: "The platform retired this CI create request before a run was created."
    });
  }

  // A known run (including one already retired locally) requires positive server
  // evidence before even an exact replay can be sent.
  for (const knownId of [admission.runId, archivedRunId, intent.binding?.run_id]) {
    if (knownId != null && knownId !== lookup.runId) throw bindingConflict();
  }

  // Lookup returns an ID. Replay the original body if a fresh runner needs the
  // full validated relay binding, including its session and fencing epoch.
  let binding = intent.binding;
  if (binding === undefined) {
    try {
      binding = await cloud.createRun(intent.request, signal, { retry: false });
    } catch (error) {
      onNotice?.("To retry this CI run, use the same --ci-admission file, selection and credit ceiling.");
      throw error;
    }
    if (lookup.outcome === "bound" && (binding.create_disposition !== "replayed" || binding.run_id !== lookup.runId)) {
      throw bindingConflict();
    }
  }
  const resumed = lookup.outcome === "bound" || binding.create_disposition === "replayed";
  if (!resumed) return { binding, resumed };

  // The create acknowledgement can describe the original queued state. A replay
  // of a terminal run must not reconnect to the target.
  const currentStatus = await cloud.getRunStatus(binding.run_id, signal);
  if (currentStatus.run_id !== binding.run_id || (archivedRunId && !isTargetExecutionTerminal(currentStatus.status))) {
    throw bindingConflict();
  }
  return { binding, resumed, currentStatus };
}
