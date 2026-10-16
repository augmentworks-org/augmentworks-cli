import { isTypedRejectedUncreated } from "../cloud/client.js";
import type { CloudClient } from "../cloud/client.js";
import {
  isTargetExecutionTerminal,
  RUN_INTENT_RECONCILE_PROTOCOL_VERSION,
  type ReconcileRunIntentResponse
} from "../cloud/recovery-protocol.js";
import type { CreateRunResponse, RunStatusResponse } from "../cloud/protocol.js";
import type { ResolvedConfig } from "../config/types.js";
import { targetBoundarySha256 } from "../config/boundary.js";
import type { HttpConnector } from "../connector/http.js";
import { AwError } from "../errors.js";
import { inspectRelayJournal } from "./journal.js";
import {
  intentRequestMatches,
  type CreateRunIntentRequest,
  type RunIntent,
  type RunIntentStore,
  type RunIntentTenantBinding
} from "./run-intent.js";
import { RelayRunner, type RelayProgressEvent } from "./runner.js";
import { packetRequiresHostedScope, resolveDispatchPolicyForBinding } from "../real-data/hosted.js";
import { loadExecutionScopeBinding } from "../real-data/scope-store.js";

export type RecoveryAction = "inspect" | "retire" | "resume" | "cancel";

export type RecoveryOutcomeKind =
  | "idle"
  | "bound"
  | "rejected_uncreated"
  | "retired_uncreated"
  | "unknown"
  | "active_conflict"
  | "cleanup_outstanding"
  | "resumed"
  | "cancelled"
  | "terminal";

export interface RecoveryReport {
  readonly outcome: RecoveryOutcomeKind;
  readonly next_action: string;
  readonly run_id: string | null;
  readonly create_request_id: string | null;
  readonly status: string | null;
  readonly target_execution: "active" | "terminal" | null;
  readonly evaluation: "pending" | "complete" | "not_applicable" | "unknown" | null;
  readonly recovery_unsupported: boolean;
  readonly original_error: { readonly code: string; readonly message: string } | null;
}

export type CreatePreparation =
  | { readonly kind: "create_new" }
  | { readonly kind: "replay_pending"; readonly intent: RunIntent }
  | { readonly kind: "resume_bound"; readonly intent: RunIntent; readonly binding: CreateRunResponse }
  | { readonly kind: "start_after_terminal" };

export interface RecoveryContext {
  readonly cloud: CloudClient;
  readonly intentStore: RunIntentStore;
  readonly tenant: RunIntentTenantBinding;
  readonly stateDirectory: string;
  readonly signal?: AbortSignal;
}

export interface ExecutionRecoveryContext extends RecoveryContext {
  readonly connector?: HttpConnector;
  readonly runner?: (options: ConstructorParameters<typeof RelayRunner>[0]) => RelayRunner;
  readonly onProgress?: (event: RelayProgressEvent) => void;
  readonly expectedRequest?: CreateRunIntentRequest;
  readonly resolvedConfig?: ResolvedConfig;
}

export function recoveryReportJson(report: RecoveryReport): string {
  return `${JSON.stringify({
    outcome: report.outcome,
    next_action: report.next_action,
    run_id: report.run_id,
    create_request_id: report.create_request_id,
    status: report.status,
    target_execution: report.target_execution,
    evaluation: report.evaluation,
    recovery_unsupported: report.recovery_unsupported,
    original_error: report.original_error
  })}\n`;
}

export async function inspectRecovery(context: RecoveryContext): Promise<RecoveryReport> {
  const intent = context.intentStore.intent;
  if (intent === undefined) {
    return idleReport("No active local assessment. You can start a new hosted test.");
  }
  if (intent.phase === "pending_create") {
    const reconciled = await reconcileIntent(context, intent, false);
    return reportFromReconcile(intent, reconciled, "inspect");
  }
  return await inspectBoundIntent(context, intent);
}

export async function retireRecovery(context: RecoveryContext): Promise<RecoveryReport> {
  const intent = context.intentStore.intent;
  if (intent === undefined) {
    return idleReport("No active local assessment remains to retire.");
  }
  if (intent.phase === "pending_create") {
    const reconciled = await reconcileIntent(context, intent, true);
    if (reconciled.kind === "unsupported") {
      throw recoveryNeedsServer(intent);
    }
    if (reconciled.kind === "error") throw reconciled.error;
    if (reconciled.response.outcome === "bound") {
      await context.intentStore.bind(reconciled.response.binding);
      return await retireBoundIfSafe(context, context.intentStore.intent ?? intent, reconciled.response);
    }
    if (
      reconciled.response.outcome === "rejected_uncreated" ||
      reconciled.response.outcome === "retired_uncreated"
    ) {
      await context.intentStore.retirePendingUncreated(
        reconciled.response.outcome === "retired_uncreated"
          ? "retired_uncreated"
          : "rejected_uncreated"
      );
      return reportFromReconcile(intent, reconciled, "retire");
    }
    return reportFromReconcile(intent, reconciled, "retire");
  }
  return await retireBoundIfSafe(context, intent);
}

export async function resumeRecovery(
  context: ExecutionRecoveryContext
): Promise<{ report: RecoveryReport; run?: RunStatusResponse; binding?: CreateRunResponse }> {
  const intent = requireIntent(context.intentStore, "resume");
  if (intent.phase !== "bound" || intent.binding === undefined) {
    throw new AwError({
      code: "RUN_NOT_BOUND",
      category: "local",
      message:
        "There is no bound assessment to resume. Run recover without flags to inspect the pending create, or recover --retire after the server proves it was never created."
    });
  }
  await assertLocalConfigBinding(intent, context, "resume");
  const binding = intent.binding;
  const status = await readBoundStatus(context, binding);
  if (isTargetExecutionTerminal(status.status)) {
    await assertJournalSafeToRelease(binding.run_id, context.stateDirectory);
    await context.intentStore.retireBoundTerminal(status);
    return {
      report: terminalReport(
        intent,
        status,
        "Target execution already finished. Local execution state was retired. Grading, if any, was left unchanged."
      )
    };
  }
  const connector = requireConnector(context, "resume");
  const run = await runBoundRelay(context, binding, connector);
  await releaseTerminalIfSafe(context, binding, run);
  return {
    report: {
      outcome: "resumed",
      next_action: nextActionForTerminal(run),
      run_id: run.run_id,
      create_request_id: intent.request.create_request_id,
      status: run.status,
      target_execution: isTargetExecutionTerminal(run.status) ? "terminal" : "active",
      evaluation: "unknown",
      recovery_unsupported: false,
      original_error: null
    },
    run,
    binding
  };
}

export async function cancelRecovery(
  context: ExecutionRecoveryContext
): Promise<{ report: RecoveryReport; run?: RunStatusResponse; binding?: CreateRunResponse }> {
  const intent = requireIntent(context.intentStore, "cancel");
  if (intent.phase !== "bound" || intent.binding === undefined) {
    throw new AwError({
      code: "RUN_NOT_BOUND",
      category: "local",
      message:
        "There is no bound assessment to cancel. Use recover --retire only after the server proves an unbound create never became a run."
    });
  }
  const binding = intent.binding;
  if (context.resolvedConfig !== undefined) {
    await assertLocalConfigBinding(intent, context, "cancel");
  }
  if (context.connector !== undefined && context.resolvedConfig !== undefined) {
    const runner = await createRunner(context, binding, context.connector);
    const cancelStatus = await runner.requestCancellation("user_requested");
    const run = isTargetExecutionTerminal(cancelStatus.status)
      ? cancelStatus
      : await runner.run();
    await releaseTerminalIfSafe(context, binding, run);
    return {
      report: {
        outcome: "cancelled",
        next_action: nextActionForTerminal(run),
        run_id: run.run_id,
        create_request_id: intent.request.create_request_id,
        status: run.status,
        target_execution: isTargetExecutionTerminal(run.status) ? "terminal" : "active",
        evaluation: "unknown",
        recovery_unsupported: false,
        original_error: null
      },
      run,
      binding
    };
  }
  const cancelled = await context.cloud.cancelRun(binding.run_id, "user_requested", context.signal);
  const status = isTargetExecutionTerminal(cancelled.status)
    ? cancelled
    : await context.cloud.getRunStatus(binding.run_id, context.signal);
  if (isTargetExecutionTerminal(status.status)) {
    await assertJournalSafeToRelease(binding.run_id, context.stateDirectory);
    await context.intentStore.retireBoundTerminal(status);
  }
  return {
    report: {
      outcome: "cancelled",
      next_action: isTargetExecutionTerminal(status.status)
        ? nextActionForTerminal(status)
        : "Cancellation was requested. Keep the local state and run recover --resume with the original configuration to drain cleanup."
      ,
      run_id: status.run_id,
      create_request_id: intent.request.create_request_id,
      status: status.status,
      target_execution: isTargetExecutionTerminal(status.status) ? "terminal" : "active",
      evaluation: "unknown",
      recovery_unsupported: false,
      original_error: null
    },
    run: status,
    binding
  };
}

export async function prepareCreateAttempt(
  context: RecoveryContext,
  requested: CreateRunIntentRequest
): Promise<CreatePreparation> {
  const existing = context.intentStore.intent;
  if (existing === undefined) return { kind: "create_new" };
  if (existing.phase === "bound" && existing.binding !== undefined) {
    return await settleBoundForCreate(context, existing, requested);
  }
  if (intentRequestMatches(existing, requested)) {
    return { kind: "replay_pending", intent: existing };
  }
  const reconciled = await reconcileIntent(context, existing, false);
  if (reconciled.kind === "unsupported" || reconciled.kind === "error") {
    throw activeRunExists(
      existing,
      "A different assessment is already active for this AugmentWorks API origin. Run recover to inspect it before starting another."
    );
  }
  if (reconciled.response.outcome === "bound") {
    await context.intentStore.bind(reconciled.response.binding);
    const bound = context.intentStore.intent;
    if (bound === undefined || bound.binding === undefined) {
      throw activeRunExists(existing);
    }
    return await settleBoundForCreate(context, bound, requested);
  }
  if (
    reconciled.response.outcome === "rejected_uncreated" ||
    reconciled.response.outcome === "retired_uncreated"
  ) {
    await context.intentStore.retirePendingUncreated(
      reconciled.response.outcome === "retired_uncreated" ? "retired_uncreated" : "rejected_uncreated"
    );
    return { kind: "create_new" };
  }
  throw activeRunExists(
    existing,
    "A different pending assessment still needs recovery. Run recover to inspect it; do not delete the journal."
  );
}

export async function settleCreateFailure(
  context: RecoveryContext,
  intent: RunIntent,
  error: unknown
): Promise<CreateRunResponse> {
  const reconciled = await reconcileIntent(context, intent, false);
  if (reconciled.kind === "error" && isPreservedAuthOrIsolation(reconciled.error)) {
    throw withRecoverHint(reconciled.error, intent, true);
  }
  if (reconciled.kind === "response" && reconciled.response.outcome === "bound") {
    await context.intentStore.bind(reconciled.response.binding);
    return reconciled.response.binding;
  }
  if (
    reconciled.kind === "response" &&
    (reconciled.response.outcome === "rejected_uncreated" ||
      reconciled.response.outcome === "retired_uncreated")
  ) {
    await context.intentStore.retirePendingUncreated(
      reconciled.response.outcome === "retired_uncreated" ? "retired_uncreated" : "rejected_uncreated"
    );
    throw withRecoverHint(error, intent, false);
  }
  const inFlight =
    reconciled.kind === "response" &&
    reconciled.response.outcome === "unknown" &&
    reconciled.response.reason === "in_flight";
  if (isTypedRejectedUncreated(error) && !inFlight) {
    await context.intentStore.retirePendingUncreated("rejected_uncreated");
    throw withRecoverHint(error, intent, false);
  }
  throw withRecoverHint(error, intent, true);
}

export async function releaseTerminalIfSafe(
  context: RecoveryContext,
  binding: CreateRunResponse,
  run: RunStatusResponse
): Promise<void> {
  if (!isTargetExecutionTerminal(run.status)) return;
  await assertJournalSafeToRelease(binding.run_id, context.stateDirectory);
  await context.intentStore.retireBoundTerminal(run);
}

export async function assertJournalSafeToRelease(
  runId: string,
  stateDirectory: string
): Promise<void> {
  const inspection = await inspectRelayJournal({ runId, stateDirectory });
  if (inspection.outstandingPreparedAttempts.length > 0) {
    throw new AwError({
      code: "CLEANUP_INCOMPLETE",
      category: "cleanup",
      message:
        "The assessment is terminal on the server, but a prepared fixture still requires cleanup. Local recovery state was kept. Run recover --resume with the original configuration, or recover --cancel to drain cleanup.",
      details: {
        outstanding_count: inspection.outstandingPreparedAttempts.length,
        first_attempt_id: inspection.outstandingPreparedAttempts[0] ?? "unknown"
      }
    });
  }
  if (inspection.unacknowledged) {
    throw new AwError({
      code: "RELAY_JOURNAL_INCOMPLETE",
      category: "cleanup",
      message:
        "The assessment is terminal on the server, but local command acknowledgements are incomplete. Local recovery state was kept. Run recover --resume with the original configuration."
    });
  }
}

async function settleBoundForCreate(
  context: RecoveryContext,
  intent: RunIntent,
  requested: CreateRunIntentRequest
): Promise<CreatePreparation> {
  if (intent.binding === undefined) {
    throw activeRunExists(intent);
  }
  const status = await readBoundStatus(context, intent.binding);
  const targetExecution = targetExecutionFromStatus(status.status);
  if (targetExecution === "active") {
    if (intentRequestMatches(intent, requested)) {
      return { kind: "resume_bound", intent, binding: intent.binding };
    }
    throw activeRunExists(
      intent,
      "A different assessment is already active. Run recover to inspect it, recover --resume to continue the recorded assessment, or recover --cancel to request cancellation. Local state was not replaced."
    );
  }
  await assertJournalSafeToRelease(intent.binding.run_id, context.stateDirectory);
  await context.intentStore.retireBoundTerminal(status);
  return { kind: "start_after_terminal" };
}

async function inspectBoundIntent(
  context: RecoveryContext,
  intent: RunIntent
): Promise<RecoveryReport> {
  if (intent.binding === undefined) {
    return unknownReport(intent, false, "The bound assessment is missing its server identity.");
  }
  const reconciled = await reconcileIntent(context, intent, false);
  if (reconciled.kind === "response" && reconciled.response.outcome === "bound") {
    const journal = await inspectRelayJournal({
      runId: reconciled.response.binding.run_id,
      stateDirectory: context.stateDirectory
    });
    if (
      reconciled.response.target_execution === "terminal" &&
      (journal.outstandingPreparedAttempts.length > 0 || journal.unacknowledged)
    ) {
      return {
        outcome: "cleanup_outstanding",
        next_action:
          "Target execution is terminal, but local cleanup or acknowledgements are incomplete. Run recover --resume or recover --cancel with the original configuration. Do not delete the journal.",
        run_id: reconciled.response.binding.run_id,
        create_request_id: intent.request.create_request_id,
        status: reconciled.response.run?.status ?? reconciled.response.binding.status,
        target_execution: "terminal",
        evaluation: reconciled.response.evaluation ?? "unknown",
        recovery_unsupported: false,
        original_error: null
      };
    }
    return reportFromReconcile(intent, reconciled, "inspect");
  }
  try {
    const status = await readBoundStatus(context, intent.binding);
    const journal = await inspectRelayJournal({
      runId: intent.binding.run_id,
      stateDirectory: context.stateDirectory
    });
    if (
      isTargetExecutionTerminal(status.status) &&
      (journal.outstandingPreparedAttempts.length > 0 || journal.unacknowledged)
    ) {
      return {
        outcome: "cleanup_outstanding",
        next_action:
          "Target execution is terminal, but local cleanup or acknowledgements are incomplete. Run recover --resume or recover --cancel with the original configuration. Do not delete the journal.",
        run_id: status.run_id,
        create_request_id: intent.request.create_request_id,
        status: status.status,
        target_execution: "terminal",
        evaluation: "unknown",
        recovery_unsupported: reconciled.kind === "unsupported",
        original_error: null
      };
    }
    return {
      outcome: isTargetExecutionTerminal(status.status) ? "terminal" : "bound",
      next_action: isTargetExecutionTerminal(status.status)
        ? "Run recover --retire to clear local execution state after confirming cleanup is complete. Then start a new test if needed."
        : "Run recover --resume with the original configuration to continue, or recover --cancel to request cancellation.",
      run_id: status.run_id,
      create_request_id: intent.request.create_request_id,
      status: status.status,
      target_execution: targetExecutionFromStatus(status.status),
      evaluation: "unknown",
      recovery_unsupported: reconciled.kind === "unsupported",
      original_error: null
    };
  } catch (error) {
    if (isPreservedAuthOrIsolation(error)) throw error;
    return unknownReport(
      intent,
      reconciled.kind === "unsupported",
      error instanceof AwError
        ? error.message
        : "The bound assessment could not be inspected. Local state was kept."
    );
  }
}

async function retireBoundIfSafe(
  context: RecoveryContext,
  intent: RunIntent,
  reconciledBound?: Extract<ReconcileRunIntentResponse, { outcome: "bound" }>
): Promise<RecoveryReport> {
  if (intent.binding === undefined) {
    throw new AwError({
      code: "RUN_NOT_BOUND",
      category: "local",
      message: "The active assessment has no server binding to retire."
    });
  }
  let bound = reconciledBound;
  if (bound === undefined) {
    const reconciled = await reconcileIntent(context, intent, false);
    if (reconciled.kind === "response" && reconciled.response.outcome === "bound") {
      bound = reconciled.response;
    } else if (reconciled.kind === "error" && isPreservedAuthOrIsolation(reconciled.error)) {
      throw reconciled.error;
    }
  }
  const status = bound?.run ?? (await readBoundStatus(context, intent.binding));
  const targetExecution = bound?.target_execution ?? targetExecutionFromStatus(status.status);
  if (targetExecution === "active" || !isTargetExecutionTerminal(status.status)) {
    throw new AwError({
      code: "RUN_NOT_TERMINAL",
      category: "local",
      message:
        "recover --retire cannot cancel an active assessment. Use recover --cancel, or wait until target execution is terminal."
    });
  }
  await assertJournalSafeToRelease(intent.binding.run_id, context.stateDirectory);
  await context.intentStore.retireBoundTerminal(status);
  const evaluation = bound?.evaluation ?? "unknown";
  return {
    ...terminalReport(
      intent,
      status,
      evaluation === "pending"
        ? "Local execution state was retired. Grading is still pending and was not cancelled. You can start a new hosted test."
        : "Local execution state was retired. Evaluation, if still pending, was left unchanged. You can start a new hosted test."
    ),
    evaluation
  };
}

type ReconcileResult =
  | { kind: "response"; response: ReconcileRunIntentResponse }
  | { kind: "unsupported" }
  | { kind: "error"; error: AwError };

async function reconcileIntent(
  context: RecoveryContext,
  intent: RunIntent,
  retireIfUncreated: boolean
): Promise<ReconcileResult> {
  try {
    const response = await context.cloud.reconcileRunIntent(
      {
        protocol_version: RUN_INTENT_RECONCILE_PROTOCOL_VERSION,
        create_request_id: intent.request.create_request_id,
        create_request_sha256: intent.request_sha256,
        workspace_id: context.tenant.workspace_id,
        connector_id: context.tenant.connector_id,
        ...(intent.binding === undefined ? {} : { run_id: intent.binding.run_id }),
        retire_if_uncreated: retireIfUncreated
      },
      context.signal
    );
    return { kind: "response", response };
  } catch (error) {
    if (error instanceof AwError && error.code === "RECOVERY_UNSUPPORTED") {
      return { kind: "unsupported" };
    }
    if (error instanceof AwError) return { kind: "error", error };
    return {
      kind: "error",
      error: new AwError({
        code: "RELAY_UNREACHABLE",
        category: "relay",
        message: "Could not reach the AugmentWorks relay to reconcile the assessment.",
        retryable: true,
        cause: error
      })
    };
  }
}

async function readBoundStatus(
  context: RecoveryContext,
  binding: CreateRunResponse
): Promise<RunStatusResponse> {
  try {
    const status = await context.cloud.getRunStatus(binding.run_id, context.signal);
    if (status.run_id !== binding.run_id) {
      throw new AwError({
        code: "RUN_BINDING_MISMATCH",
        category: "protocol",
        message: "AugmentWorks returned a status for a different run."
      });
    }
    return status;
  } catch (error) {
    if (isPreservedAuthOrIsolation(error)) throw error;
    throw error;
  }
}

function reportFromReconcile(
  intent: RunIntent,
  reconciled: ReconcileResult,
  action: "inspect" | "retire"
): RecoveryReport {
  if (reconciled.kind === "unsupported") {
    return unknownReport(
      intent,
      true,
      action === "retire"
        ? "This server does not support create-key retirement. Local state was kept."
        : "This server does not support run-intent reconciliation. Re-run the same test command if the create is still within the replay window, or upgrade the hosted service."
    );
  }
  if (reconciled.kind === "error") {
    if (isPreservedAuthOrIsolation(reconciled.error)) throw reconciled.error;
    return unknownReport(intent, false, reconciled.error.message);
  }
  const response = reconciled.response;
  if (response.outcome === "bound") {
    const evaluation = response.evaluation ?? "unknown";
    const journalNote =
      response.target_execution === "terminal"
        ? " If local cleanup is complete, recover --retire can clear execution state without cancelling grading."
        : " Run recover --resume with the original configuration, or recover --cancel to request cancellation.";
    return {
      outcome: response.target_execution === "terminal" ? "terminal" : "bound",
      next_action:
        response.target_execution === "terminal"
          ? `Target execution is terminal.${evaluation === "pending" ? " Grading is still pending and was not cancelled." : ""}${journalNote}`
          : `The server bound this create to run ${response.binding.run_id}.${journalNote}`,
      run_id: response.binding.run_id,
      create_request_id: intent.request.create_request_id,
      status: response.run?.status ?? response.binding.status,
      target_execution: response.target_execution,
      evaluation,
      recovery_unsupported: false,
      original_error: null
    };
  }
  if (response.outcome === "rejected_uncreated") {
    return {
      outcome: "rejected_uncreated",
      next_action:
        action === "retire"
          ? "The rejected create was retired. Correct the command and start a new hosted test."
          : "The server proved this create never became a run. Run recover --retire, then correct the command.",
      run_id: null,
      create_request_id: intent.request.create_request_id,
      status: null,
      target_execution: null,
      evaluation: null,
      recovery_unsupported: false,
      original_error: {
        code: response.rejection.code,
        message: response.rejection.message
      }
    };
  }
  if (response.outcome === "retired_uncreated") {
    return {
      outcome: "retired_uncreated",
      next_action: "The create key is retired. You can start a new hosted test with a new request.",
      run_id: null,
      create_request_id: intent.request.create_request_id,
      status: null,
      target_execution: null,
      evaluation: null,
      recovery_unsupported: false,
      original_error: null
    };
  }
  return unknownReport(
    intent,
    false,
    response.reason === "in_flight"
      ? "Creation may still be in flight. Keep the local state and retry recover."
      : "The server could not prove whether this create became a run. Local state was kept."
  );
}

function idleReport(nextAction: string): RecoveryReport {
  return {
    outcome: "idle",
    next_action: nextAction,
    run_id: null,
    create_request_id: null,
    status: null,
    target_execution: null,
    evaluation: null,
    recovery_unsupported: false,
    original_error: null
  };
}

function terminalReport(
  intent: RunIntent,
  status: RunStatusResponse,
  nextAction: string
): RecoveryReport {
  return {
    outcome: "terminal",
    next_action: nextAction,
    run_id: status.run_id,
    create_request_id: intent.request.create_request_id,
    status: status.status,
    target_execution: "terminal",
    evaluation: "unknown",
    recovery_unsupported: false,
    original_error: null
  };
}

function unknownReport(
  intent: RunIntent,
  recoveryUnsupported: boolean,
  message: string
): RecoveryReport {
  return {
    outcome: "unknown",
    next_action: `${message} Local assessment state was kept. Do not delete the journal.`,
    run_id: intent.binding?.run_id ?? null,
    create_request_id: intent.request.create_request_id,
    status: intent.binding?.status ?? null,
    target_execution: intent.binding === undefined ? null : targetExecutionFromStatus(intent.binding.status),
    evaluation: null,
    recovery_unsupported: recoveryUnsupported,
    original_error: null
  };
}

function activeRunExists(intent: RunIntent, message?: string): AwError {
  return new AwError({
    code: "ACTIVE_RUN_EXISTS",
    category: "local",
    message:
      message ??
      "A different assessment is already active for this AugmentWorks API origin. Run recover to inspect it before starting another.",
    details: {
      create_request_id: intent.request.create_request_id,
      ...(intent.binding === undefined ? {} : { run_id: intent.binding.run_id })
    }
  });
}

function recoveryNeedsServer(intent: RunIntent): AwError {
  return new AwError({
    code: "RECOVERY_UNSUPPORTED",
    category: "protocol",
    message:
      "This AugmentWorks server cannot prove that the pending create never became a run. Local state was kept. Upgrade the hosted service before using recover --retire on an unbound create.",
    details: { create_request_id: intent.request.create_request_id }
  });
}

function withRecoverHint(error: unknown, intent: RunIntent, preserved: boolean): unknown {
  if (!(error instanceof AwError)) return error;
  const suffix = preserved
    ? " Local assessment state was kept. Run recover to inspect it; do not delete the journal."
    : "";
  if (error.message.includes("Run recover") || suffix === "") return error;
  return new AwError({
    code: error.code,
    category: error.category,
    message: `${error.message}${suffix}`,
    retryable: error.retryable,
    details: {
      ...error.details,
      create_request_id: intent.request.create_request_id
    },
    cause: error
  });
}

function isPreservedAuthOrIsolation(error: unknown): boolean {
  if (!(error instanceof AwError)) return false;
  return (
    error.category === "auth" ||
    error.code === "CLOUD_AUTH_REJECTED" ||
    error.code === "ACTIVE_RUN_TENANT_MISMATCH" ||
    error.code === "AUTH_TENANT_CHANGED"
  );
}

function targetExecutionFromStatus(
  status: CreateRunResponse["status"] | RunStatusResponse["status"]
): "active" | "terminal" {
  return isTargetExecutionTerminal(status) ? "terminal" : "active";
}

function requireIntent(store: RunIntentStore, action: string): RunIntent {
  const intent = store.intent;
  if (intent === undefined) {
    throw new AwError({
      code: "RUN_INTENT_MISSING",
      category: "local",
      message: `No active assessment is present to ${action}.`
    });
  }
  return intent;
}

async function assertLocalConfigBinding(
  intent: RunIntent,
  context: ExecutionRecoveryContext,
  action: "resume" | "cancel"
): Promise<void> {
  const resolvedConfig = context.resolvedConfig;
  if (resolvedConfig === undefined) {
    if (action === "resume") {
      throw new AwError({
        code: "CONFIG_REQUIRED_FOR_RESUME",
        category: "config",
        message:
          "recover --resume needs the original augmentworks.yaml so it can verify the recorded target binding before executing cleanup or target operations."
      });
    }
    return;
  }
  if (
    intent.request.config_sha256 !== resolvedConfig.configDigest ||
    !(await recordedBoundaryMatches(intent, resolvedConfig, context.stateDirectory))
  ) {
    throw new AwError({
      code: "ACTIVE_RUN_EXISTS",
      category: "local",
      message:
        "The recorded assessment uses a different target configuration. recover --resume and recover --cancel execute only that recorded assessment. Inspect it with recover, or restore the original configuration."
    });
  }
}

/**
 * An authorized run records its execution scope's boundary hash, not the config's. The
 * runner checks augmentworks.yaml against that scope's boundary before any target call.
 */
async function recordedBoundaryMatches(
  intent: RunIntent,
  resolvedConfig: ResolvedConfig,
  stateDirectory: string
): Promise<boolean> {
  const recorded = intent.request.target.boundary_sha256;
  if (recorded === targetBoundarySha256(resolvedConfig)) return true;
  const runId = intent.binding?.run_id;
  const scope = runId === undefined ? undefined : await loadExecutionScopeBinding(runId, { stateDirectory });
  if (scope !== undefined) return scope.bindingKind === "hosted" && scope.targetBoundaryHash === recorded;
  return packetRequiresHostedScope(intent.request.packet);
}

function requireConnector(
  context: ExecutionRecoveryContext,
  action: "resume"
): HttpConnector {
  if (context.connector === undefined) {
    throw new AwError({
      code: "CONFIG_REQUIRED_FOR_RESUME",
      category: "config",
      message: `recover --${action} needs a verified local target configuration before it can execute or drain cleanup.`
    });
  }
  return context.connector;
}

async function createRunner(
  context: ExecutionRecoveryContext,
  binding: CreateRunResponse,
  connector: HttpConnector
): Promise<RelayRunner> {
  const dispatchPolicy =
    context.resolvedConfig === undefined && !packetRequiresHostedScope(binding.packet)
      ? undefined
      : await resolveDispatchPolicyForBinding({
          cloud: context.cloud,
          binding,
          workspaceId: context.tenant.workspace_id,
          ...(context.resolvedConfig === undefined ? {} : { resolved: context.resolvedConfig }),
          stateDirectory: context.stateDirectory,
          ...(context.signal === undefined ? {} : { signal: context.signal })
        });
  const options: ConstructorParameters<typeof RelayRunner>[0] = {
    cloud: context.cloud,
    connector,
    binding,
    stateDirectory: context.stateDirectory,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.onProgress === undefined ? {} : { onProgress: context.onProgress }),
    ...(dispatchPolicy === undefined ? {} : { dispatchPolicy }),
    ...(context.resolvedConfig === undefined ? {} : { secrets: context.resolvedConfig.secrets })
  };
  return context.runner?.(options) ?? new RelayRunner(options);
}

async function runBoundRelay(
  context: ExecutionRecoveryContext,
  binding: CreateRunResponse,
  connector: HttpConnector
): Promise<RunStatusResponse> {
  return await (await createRunner(context, binding, connector)).run();
}

function nextActionForTerminal(run: RunStatusResponse): string {
  if (run.status === "cancelled") {
    return "The assessment was cancelled. You can start a new hosted test.";
  }
  if (run.outcome === "passed") {
    return "The assessment completed. Inspect the dashboard run URL if you still have it.";
  }
  return "The assessment finished. Inspect the dashboard for the recorded outcome, then start a new hosted test if needed.";
}
