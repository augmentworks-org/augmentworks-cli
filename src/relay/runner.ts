import type { HttpConnector } from "../connector/http.js";
import type { ConnectorExecutionContext } from "../connector/types.js";
import type { CloudClient, SafeRelayFailure } from "../cloud/client.js";
import {
  commandProtocolForCreate,
  parseRelayResult,
  type CreateRunResponse,
  type RelayCommand,
  type RelayResult,
  type RunStatusResponse
} from "../cloud/protocol.js";
import { AwError, withRunId } from "../errors.js";
import { canonicalize } from "../util/canonical.js";
import { LIMITS } from "../util/limits.js";
import { RelayJournal, type JournalCompletion } from "./journal.js";
import { resendJournaledCompletion } from "./completion-resend.js";
import type { JournalRunDeadline } from "./journal.js";
import { type LiveExecutionPolicy } from "../suite/live-policy.js";
import {
  assertCommandAllowed,
  sendIsReplayable,
  type DispatchPolicy
} from "../real-data/policy.js";
import {
  assertAuthorizedPrivacyDocuments,
  minimizeForUpload,
  requireAuthorizedPrivacyDocuments
} from "../real-data/privacy.js";
import { dispatchPolicyPrivacyContext } from "../real-data/r06-service.js";
import { relayContentParts } from "../data-policy/index.js";
import type { JsonValue } from "../config/types.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const CLEANUP_RETRY_DELAYS_MS = [100, 250] as const;
/** AUG-412: backoff between retries of a failed poll or status read: first pause, then cap. */
const POLL_RETRY_BASE_MS = 500;
const POLL_RETRY_CAP_MS = 15_000;
/**
 * AUG-405: how long a cancelled run keeps polling for its cleanup commands before
 * giving up. One minute was too short to drain them reliably.
 */
const DEFAULT_CANCELLATION_DRAIN_MS = 5 * 60_000;
type RelayConnector = {
  execute: HttpConnector["execute"];
  isIdempotent?: (kind: RelayCommand["kind"]) => boolean;
};

export interface RelayRunnerOptions {
  cloud: CloudClient;
  connector: RelayConnector;
  binding: CreateRunResponse;
  journal?: RelayJournal;
  stateDirectory?: string;
  now?: () => Date;
  pollWaitMs?: number;
  statusEveryEmptyPolls?: number;
  cancellationDrainMs?: number;
  /** First pause before retrying a failed poll; doubles per failure up to 15 s. */
  pollRetryBaseMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: RelayProgressEvent) => void;
  livePolicy?: LiveExecutionPolicy;
  dispatchPolicy?: DispatchPolicy;
  secrets?: readonly string[];
}

export type RelayProgressEvent =
  | { type: "connected"; runId: string; dashboardUrl: string }
  | { type: "operation_started"; commandId: string; kind: RelayCommand["kind"]; sequence: number }
  | {
      type: "operation_completed";
      commandId: string;
      kind: RelayCommand["kind"];
      sequence: number;
      replayed: boolean;
    }
  | { type: "operation_failed"; commandId: string; kind: RelayCommand["kind"]; code: string }
  | { type: "cancellation_requested"; runId: string }
  | { type: "terminal"; run: RunStatusResponse };

export class RelayRunner {
  readonly #cloud: CloudClient;
  readonly #connector: RelayConnector;
  readonly #binding: CreateRunResponse;
  readonly #journal: RelayJournal;
  readonly #now: () => Date;
  readonly #pollWaitMs: number;
  readonly #statusEveryEmptyPolls: number;
  readonly #cancellationDrainMs: number;
  readonly #pollRetryBaseMs: number;
  readonly #signal: AbortSignal | undefined;
  readonly #onProgress: ((event: RelayProgressEvent) => void) | undefined;
  #cancelRequested = false;
  #cancelRequestedAt: number | undefined;
  #cancelPromise: Promise<RunStatusResponse> | undefined;
  #pollAbort: AbortController | undefined;
  #operationAbort: AbortController | undefined;
  #activeKind: RelayCommand["kind"] | undefined;
  #deadline: JournalRunDeadline | undefined;
  #purgeJournalOnClose = false;
  #running = false;
  readonly #dispatchPolicy: DispatchPolicy | undefined;
  readonly #secrets: readonly string[];

  constructor(options: RelayRunnerOptions) {
    this.#cloud = options.cloud;
    this.#connector = options.connector;
    this.#binding = options.binding;
    this.#dispatchPolicy =
      options.dispatchPolicy ??
      (options.livePolicy === undefined
        ? undefined
        : { kind: "live_informational", live: options.livePolicy });
    this.#secrets = options.secrets ?? [];
    const privacyContext = dispatchPolicyPrivacyContext(this.#dispatchPolicy, this.#secrets);
    this.#journal =
      options.journal ??
      new RelayJournal({
        runId: options.binding.run_id,
        ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(privacyContext === undefined ? {} : { dataPolicy: privacyContext })
      });
    this.#now = options.now ?? (() => new Date());
    this.#pollWaitMs = options.pollWaitMs ?? 25_000;
    this.#statusEveryEmptyPolls = options.statusEveryEmptyPolls ?? 2;
    this.#cancellationDrainMs = options.cancellationDrainMs ?? DEFAULT_CANCELLATION_DRAIN_MS;
    this.#pollRetryBaseMs = options.pollRetryBaseMs ?? POLL_RETRY_BASE_MS;
    this.#signal = options.signal;
    this.#onProgress = options.onProgress;
  }

  get cancelRequested(): boolean {
    return this.#cancelRequested;
  }

  async requestCancellation(reason = "user_requested"): Promise<RunStatusResponse> {
    if (this.#cancelPromise !== undefined) return this.#cancelPromise;
    this.#cancelRequested = true;
    this.#cancelRequestedAt = this.#now().getTime();
    this.#pollAbort?.abort("cancellation requested");
    if (this.#activeKind !== "cleanup") {
      this.#operationAbort?.abort("cancellation requested");
    }
    this.#onProgress?.({ type: "cancellation_requested", runId: this.#binding.run_id });
    this.#cancelPromise = this.#cloud.cancelRun(
      this.#binding.run_id,
      reason,
      this.#signal,
      commandProtocolForCreate(this.#binding.protocol_version)
    );
    return this.#cancelPromise;
  }

  async run(): Promise<RunStatusResponse> {
    if (this.#running) {
      throw new AwError({
        code: "RELAY_ALREADY_RUNNING",
        category: "local",
        message: "This relay runner is already active."
      });
    }
    this.#running = true;
    try {
      await this.#journal.open();
    } catch (error) {
      this.#running = false;
      throw withRunId(error, this.#binding.run_id);
    }
    try {
      this.#deadline = await this.#journal.bindRunDeadline(
        this.#binding.run_expires_at,
        new Date(this.#now().getTime() + LIMITS.maxRunMs).toISOString()
      );
      this.#onProgress?.({
        type: "connected",
        runId: this.#binding.run_id,
        dashboardUrl: this.#binding.dashboard_url
      });
      let emptyPolls = 0;
      let failedReads = 0;
      while (true) {
        this.#throwIfStopped();
        this.#pollAbort = new AbortController();
        const pollSignal = combineSignals(this.#signal, this.#pollAbort.signal);
        let poll;
        try {
          poll = await this.#cloud.pollOperation({
            runId: this.#binding.run_id,
            sessionId: this.#binding.session_id,
            afterSequence: this.#journal.lastAcknowledgedSequence,
            fencingEpoch: this.#binding.fencing_epoch,
            waitMs: this.#pollWaitMs,
            signal: pollSignal,
            protocolVersion: commandProtocolForCreate(this.#binding.protocol_version)
          });
        } catch (error) {
          if (this.#cancelRequested && isCancellationError(error)) continue;
          if (!isRetryableRead(error)) throw error;
          await this.#pauseBeforeRetry(error, failedReads, pollSignal);
          failedReads += 1;
          continue;
        } finally {
          this.#pollAbort = undefined;
        }
        failedReads = 0;

        if (poll === null) {
          emptyPolls += 1;
          if (emptyPolls % this.#statusEveryEmptyPolls !== 0) continue;
          const status = await this.#readStatusWithRetry();
          if (TERMINAL_STATUSES.has(status.status)) return this.#finish(status);
          continue;
        }
        emptyPolls = 0;
        if (poll.run_id !== this.#binding.run_id || poll.session_id !== this.#binding.session_id) {
          throw new AwError({
            code: "RUN_BINDING_MISMATCH",
            category: "protocol",
            message: "The relay poll response changed its run or session binding."
          });
        }
        if (poll.status === "cancel_requested") {
          this.#cancelRequested = true;
          this.#cancelRequestedAt ??= this.#now().getTime();
        }
        // AUG-412: sequences the server proved it closed advance the poll cursor.
        const skipped = poll.skipped_sequences ?? [];
        if (skipped.length > 0) await this.#journal.recordServerSkips(skipped);
        if (poll.command !== null) await this.#processCommand(poll.command);
        if (TERMINAL_STATUSES.has(poll.status) && poll.command === null) {
          const status = await this.#readStatusWithRetry();
          return this.#finish(status);
        }
      }
    } catch (error) {
      throw withRunId(error, this.#binding.run_id);
    } finally {
      this.#running = false;
      await this.#journal.close({ purge: this.#purgeJournalOnClose });
    }
  }

  /**
   * AUG-412: waits before retrying a failed poll or status read. The pause is at
   * least the server's Retry-After, with capped exponential backoff, and never
   * runs past the run deadline: the read fails instead.
   */
  async #pauseBeforeRetry(error: unknown, failures: number, signal: AbortSignal): Promise<void> {
    const advertised =
      error instanceof AwError && typeof error.details?.["retry_after_ms"] === "number"
        ? Math.max(0, error.details["retry_after_ms"])
        : 0;
    const backoff = Math.min(
      this.#pollRetryBaseMs * 2 ** Math.min(failures, 16),
      POLL_RETRY_CAP_MS
    );
    const pause = Math.max(advertised, backoff);
    const deadline = this.#deadline?.expiresAtMs;
    if (deadline === undefined || this.#now().getTime() + pause >= deadline) throw error;
    try {
      await delay(pause, signal);
    } catch (interrupted) {
      // A cancellation request ends the pause early; the loop then polls again.
      if (this.#cancelRequested && this.#signal?.aborted !== true) return;
      throw interrupted;
    }
  }

  async #readStatusWithRetry(): Promise<RunStatusResponse> {
    let failures = 0;
    while (true) {
      try {
        return await this.#cloud.getRunStatus(this.#binding.run_id, this.#signal);
      } catch (error) {
        if (!isRetryableRead(error)) throw error;
        await this.#pauseBeforeRetry(error, failures, this.#signal ?? new AbortController().signal);
        failures += 1;
        this.#throwIfStopped();
      }
    }
  }

  async #processCommand(command: RelayCommand): Promise<void> {
    const durable = this.#journal.state(command.command_id);
    this.#validateCommand(command, durable !== undefined);
    if (this.#dispatchPolicy !== undefined && durable?.started !== true) {
      assertCommandAllowed(command, this.#dispatchPolicy, this.#journal);
    }
    await this.#settleLostAcknowledgement(command);
    let state = await this.#journal.accept(command);
    let replayed = durable !== undefined;
    const wasStarted = state.started;
    const idempotent =
      sendIsReplayable(this.#dispatchPolicy) === false && command.kind === "send"
        ? false
        : this.#isIdempotent(command.kind);
    const expired = Date.parse(command.expires_at) <= this.#now().getTime();

    if (state.completion === undefined && expired) {
      if (!state.started) await this.#journal.markStarted(command.command_id);
      const indeterminate = wasStarted && !idempotent;
      const error: SafeRelayFailure = indeterminate
        ? {
            code: "OUTCOME_INDETERMINATE",
            safe_message: "The expired local operation previously started without a durable outcome.",
            retryable: false
          }
        : {
            code: wasStarted ? "COMMAND_EXPIRED_AFTER_START" : "COMMAND_EXPIRED",
            safe_message: wasStarted
              ? "The idempotent local operation expired before it could be safely resumed."
              : "The command expired before local execution.",
            retryable: false
          };
      state = {
        ...state,
        started: true,
        completion: await this.#journal.recordFailure(
          command.command_id,
          error,
          indeterminate ? "outcome_indeterminate" : "failed"
        )
      };
    }

    if (
      state.completion === undefined &&
      state.started &&
      !idempotent
    ) {
      const error: SafeRelayFailure = {
        code: "OUTCOME_INDETERMINATE",
        safe_message: "The prior local operation started but did not durably record an outcome.",
        retryable: false
      };
      state = {
        ...state,
        completion: await this.#journal.recordFailure(
          command.command_id,
          error,
          "outcome_indeterminate"
        )
      };
    }

    if (state.completion === undefined) {
      await this.#journal.markStarted(command.command_id);
      this.#onProgress?.({
        type: "operation_started",
        commandId: command.command_id,
        kind: command.kind,
        sequence: command.sequence
      });
      if (this.#cancelRequested && command.kind !== "cleanup") {
        const error: SafeRelayFailure = {
          code: "RUN_CANCELLED",
          safe_message: "The assessment was cancelled before this operation started.",
          retryable: false
        };
        state = {
          ...state,
          completion: await this.#journal.recordFailure(command.command_id, error, "failed")
        };
      } else {
        assertAuthorizedPrivacyDocuments(this.#dispatchPolicy);
        let connectorReturned = false;
        try {
          const raw = await this.#executeConnectorCommand(command, idempotent);
          connectorReturned = true;
          const result = parseRelayResult(command.kind, await this.#minimizeUploadedResult(command.kind, raw));
          validateResultCorrelation(command, result);
          state = {
            ...state,
            completion: await this.#journal.recordSuccess(command.command_id, result)
          };
        } catch (error) {
          const failure = safeFailure(error, command);
          const disposition =
            isIndeterminate(error) ||
            (connectorReturned && command.kind === "send" && !idempotent)
              ? "outcome_indeterminate"
              : "failed";
          state = {
            ...state,
            completion: await this.#journal.recordFailure(
              command.command_id,
              failure,
              disposition
            )
          };
        }
      }
      replayed = false;
    }

    const completion = state.completion;
    if (completion === undefined) throw new Error("Relay completion was not recorded");
    await this.#acknowledge(command, completion);
    await this.#journal.acknowledge(command.command_id);
    if (completion.disposition === "completed") {
      this.#onProgress?.({
        type: "operation_completed",
        commandId: command.command_id,
        kind: command.kind,
        sequence: command.sequence,
        replayed
      });
    } else {
      this.#onProgress?.({
        type: "operation_failed",
        commandId: command.command_id,
        kind: command.kind,
        code: completion.error.code
      });
    }
  }

  /**
   * AUG-404: after a crash between uploading a completion and journaling its
   * acknowledgement, the server has moved on and delivers the next command. Re-send
   * the journaled completion first; once the server accepts it as an identical
   * repeat (or proves the command closed) the journal can take the next command.
   */
  async #settleLostAcknowledgement(command: RelayCommand): Promise<void> {
    const pending = this.#journal.pending();
    if (
      pending === undefined ||
      pending.completion === undefined ||
      pending.accepted.command_id === command.command_id ||
      command.sequence <= pending.accepted.sequence
    ) {
      return;
    }
    await resendJournaledCompletion({
      cloud: this.#cloud,
      journal: this.#journal,
      state: pending,
      protocolVersion: commandProtocolForCreate(this.#binding.protocol_version),
      runTerminal: false,
      signal: this.#signal
    });
  }

  async #executeConnectorCommand(command: RelayCommand, idempotent: boolean): Promise<unknown> {
    const controller = new AbortController();
    this.#operationAbort = controller;
    this.#activeKind = command.kind;
    const signal = combineOptionalSignals(this.#signal, controller.signal);
    const context = connectorContext(command, signal, dispatchPolicyPrivacyContext(this.#dispatchPolicy, this.#secrets));
    let attempt = 0;
    try {
      while (true) {
        try {
          return await this.#connector.execute(command.kind, command.input, context);
        } catch (error) {
          const mayRetry =
            command.kind === "cleanup" &&
            idempotent &&
            error instanceof AwError &&
            error.retryable &&
            attempt < CLEANUP_RETRY_DELAYS_MS.length;
          if (!mayRetry) throw error;
          const pause = CLEANUP_RETRY_DELAYS_MS[attempt];
          if (pause === undefined || this.#now().getTime() + pause >= Date.parse(command.expires_at)) {
            throw error;
          }
          attempt += 1;
          await delay(pause, signal);
          if (this.#now().getTime() >= Date.parse(command.expires_at)) throw error;
        }
      }
    } finally {
      this.#activeKind = undefined;
      this.#operationAbort = undefined;
    }
  }

  #isIdempotent(kind: RelayCommand["kind"]): boolean {
    return this.#connector.isIdempotent?.(kind) ?? false;
  }

  async #minimizeUploadedResult(kind: RelayCommand["kind"], raw: unknown): Promise<unknown> {
    const documents = requireAuthorizedPrivacyDocuments(this.#dispatchPolicy);
    if (documents === undefined) return raw;
    const { parts, assemble } = relayContentParts(kind, raw);
    const representations: JsonValue[] = [];
    for (const part of parts) {
      const minimized = await minimizeForUpload(
        { document: part.document, secrets: this.#secrets },
        documents.redactionProfile,
        documents.dataPolicy,
        this.#secrets
      );
      representations.push(minimized.representation as JsonValue);
    }
    return assemble(representations);
  }

  async #acknowledge(command: RelayCommand, completion: JournalCompletion): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const ack =
          completion.disposition === "completed"
            ? await this.#cloud.completeOperation(
                command,
                completion.result,
                completion.resultSha256,
                this.#signal
              )
            : await this.#cloud.failOperation(
                command,
                completion.error,
                completion.disposition,
                completion.resultSha256,
                this.#signal
              );
        if (ack.command_id !== command.command_id) {
          throw new AwError({
            code: "COMMAND_ACK_MISMATCH",
            category: "protocol",
            message: "The relay acknowledged a different command.",
            operation: command.kind,
            commandId: command.command_id
          });
        }
        return;
      } catch (error) {
        lastError = error;
        if (!(error instanceof AwError) || !error.retryable || attempt === 4) break;
        await delay(Math.min(250 * 2 ** attempt, 2_000), this.#signal);
      }
    }
    throw lastError;
  }

  #validateCommand(command: RelayCommand, allowExpiredReplay = false): void {
    const expected = this.#binding;
    const bound =
      command.run_id === expected.run_id &&
      command.session_id === expected.session_id &&
      command.config_sha256 === expected.config_sha256 &&
      canonicalize(command.packet) === canonicalize(expected.packet);
    if (!bound) {
      throw new AwError({
        code: "RUN_BINDING_MISMATCH",
        category: "protocol",
        message: "The relay command changed its run, packet, session, or configuration binding.",
        operation: command.kind,
        commandId: command.command_id
      });
    }
    if (command.fencing_epoch !== expected.fencing_epoch) {
      throw new AwError({
        code:
          command.fencing_epoch < expected.fencing_epoch ? "STALE_FENCE" : "FENCE_BINDING_MISMATCH",
        category: "protocol",
        message: "The relay command uses an invalid fencing epoch.",
        operation: command.kind,
        commandId: command.command_id
      });
    }
    const issued = Date.parse(command.issued_at);
    const expires = Date.parse(command.expires_at);
    const now = this.#now().getTime();
    if (expires <= issued || expires - issued > 10 * 60_000 || issued > now + 60_000) {
      throw new AwError({
        code: "INVALID_COMMAND_TIME",
        category: "protocol",
        message: "The relay command has an invalid issue or expiry time.",
        operation: command.kind,
        commandId: command.command_id
      });
    }
    if (expires <= now && !allowExpiredReplay) {
      throw new AwError({
        code: "COMMAND_EXPIRED",
        category: "protocol",
        message: "The relay command expired before local execution.",
        operation: command.kind,
        commandId: command.command_id
      });
    }
    if (
      command.kind === "send" &&
      command.input.conversation_id !== undefined &&
      command.input.conversation_id !== command.attempt_id
    ) {
      throw new AwError({
        code: "CONVERSATION_IDENTITY_MISMATCH",
        category: "protocol",
        message: "explicit_session_v1 requires conversation_id to equal attempt_id.",
        operation: command.kind,
        commandId: command.command_id
      });
    }
  }

  #throwIfStopped(): void {
    if (this.#signal?.aborted) {
      throw new AwError({
        code: "INTERRUPTED",
        category: "local",
        message: "The connector was interrupted."
      });
    }
    const deadline = this.#deadline;
    if (deadline === undefined) {
      throw new AwError({
        code: "RUN_DEADLINE_UNBOUND",
        category: "local",
        message: "The relay run deadline was not durably bound."
      });
    }
    if (this.#now().getTime() >= deadline.expiresAtMs) {
      throw new AwError({
        code: deadline.source === "server" ? "RUN_EXPIRED" : "RUN_TIME_LIMIT_EXCEEDED",
        category: "relay",
        message:
          deadline.source === "server"
            ? "The assessment exceeded its server-bound run expiry."
            : "The assessment exceeded the durable local runtime limit."
      });
    }
    if (
      this.#cancelRequestedAt !== undefined &&
      this.#now().getTime() - this.#cancelRequestedAt > this.#cancellationDrainMs
    ) {
      throw new AwError({
        code: "CLEANUP_DRAIN_TIMEOUT",
        category: "cleanup",
        message: "Cancellation cleanup did not finish before the drain deadline."
      });
    }
  }

  #finish(run: RunStatusResponse): RunStatusResponse {
    const outstanding = this.#journal.outstandingPreparedAttempts();
    if (outstanding.length > 0) {
      throw new AwError({
        code: "CLEANUP_INCOMPLETE",
        category: "cleanup",
        message: "The run became terminal while a prepared fixture still requires cleanup.",
        details: {
          outstanding_count: outstanding.length,
          first_attempt_id: outstanding[0] ?? "unknown"
        }
      });
    }
    this.#purgeJournalOnClose = true;
    this.#onProgress?.({ type: "terminal", run });
    return run;
  }
}

function connectorContext(
  command: RelayCommand,
  signal?: AbortSignal,
  dataPolicy?: ReturnType<typeof dispatchPolicyPrivacyContext>
): ConnectorExecutionContext {
  const sendConversationId =
    command.kind === "send" && command.input.conversation_id !== undefined
      ? command.input.conversation_id
      : command.attempt_id;
  return {
    commandId: command.command_id,
    idempotencyKey: command.idempotency_key,
    runId: command.run_id,
    attemptId: command.attempt_id,
    conversationId: sendConversationId,
    ...(command.kind === "send" ? { turnId: command.input.turn_id } : {}),
    ...(command.kind === "observe" ? { requestId: command.input.request_id } : {}),
    ...(signal === undefined ? {} : { signal }),
    ...(dataPolicy === undefined ? {} : { dataPolicy })
  };
}

function validateResultCorrelation(command: RelayCommand, result: RelayResult): void {
  const mismatch =
    (command.kind === "prepare" && "attempt_id" in result && result.attempt_id !== command.attempt_id) ||
    (command.kind === "send" && "turn_id" in result && result.turn_id !== command.input.turn_id) ||
    (command.kind === "observe" &&
      "request_id" in result &&
      result.request_id !== command.input.request_id) ||
    (command.kind === "cleanup" && "attempt_id" in result && result.attempt_id !== command.attempt_id);
  if (mismatch) {
    throw new AwError({
      code: "TARGET_CORRELATION_ERROR",
      category: "target",
      message: "The local target returned a mismatched operation identifier.",
      operation: command.kind,
      commandId: command.command_id
    });
  }
  if (command.kind === "observe" && "observations" in result) {
    const allowed = new Set(command.input.probe_keys);
    const keys = result.observations.map((observation) => observation.key);
    if (new Set(keys).size !== keys.length || keys.some((key) => !allowed.has(key))) {
      throw new AwError({
        code: "UNEXPECTED_OBSERVATION",
        category: "evidence",
        message: "The local target returned an unrequested or duplicate observation.",
        operation: command.kind,
        commandId: command.command_id
      });
    }
  }
}

function safeFailure(error: unknown, command: RelayCommand): SafeRelayFailure {
  if (error instanceof AwError) {
    return {
      code: normalizeCode(error.code),
      safe_message: error.message.slice(0, 1_000),
      retryable: error.retryable
    };
  }
  return {
    code: "LOCAL_OPERATION_FAILED",
    safe_message: "The local connector could not complete this operation.",
    retryable: false
  };
}

function normalizeCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 120);
  return normalized || "LOCAL_OPERATION_FAILED";
}

function isIndeterminate(error: unknown): boolean {
  if (!(error instanceof AwError)) return false;
  return new Set([
    "OUTCOME_INDETERMINATE",
    "AMBIGUOUS_SEND",
    "TARGET_OUTCOME_INDETERMINATE",
    "TARGET_TIMEOUT_AFTER_SEND"
  ]).has(error.code);
}

function isCancellationError(error: unknown): boolean {
  return error instanceof AwError && error.code === "RELAY_REQUEST_CANCELLED";
}

/** A relay read that failed in a way the server says is worth retrying (AUG-412). */
function isRetryableRead(error: unknown): boolean {
  return error instanceof AwError && error.retryable && !isCancellationError(error);
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  if (first === undefined) return second;
  return AbortSignal.any([first, second]);
}

function combineOptionalSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second]);
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new AwError({ code: "INTERRUPTED", category: "local", message: "The connector was interrupted." })
      );
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        new AwError({ code: "INTERRUPTED", category: "local", message: "The connector was interrupted." })
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}
