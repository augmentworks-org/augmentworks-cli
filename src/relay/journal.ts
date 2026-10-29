import { constants, type Stats } from "node:fs";
import { open, lstat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { AwError } from "../errors.js";
import { sameFileIdentity } from "../system/file-identity.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import {
  PacketBindingSchema,
  RelayResultSchema,
  parseRelayResult,
  type PacketBinding,
  type RelayCommand,
  type RelayResult
} from "../cloud/protocol.js";
import type { FailureDisposition, SafeRelayFailure } from "../cloud/client.js";
import { LIMITS } from "../util/limits.js";
import { getStateDirectory } from "./state-dir.js";
import {
  acquireSecureLock,
  ensureSecureDirectory,
  type SecureLockHandle
} from "./secure-lock.js";
import {
  DATA_POLICY_BLOCKED_FAILURE,
  projectRelayResult,
  type DataPolicyContext
} from "../data-policy/index.js";

export const JOURNAL_VERSION = "aw-relay-journal/0.1" as const;

const failureSchema = z
  .object({
    code: z.string().min(1).max(120),
    safe_message: z.string().min(1).max(1_000),
    retryable: z.boolean()
  })
  .strict();

const acceptedSchema = z
  .object({
    journal_version: z.literal(JOURNAL_VERSION),
    event: z.literal("accepted"),
    at: z.string().datetime({ offset: true }),
    command_id: z.string().min(1).max(300),
    kind: z.enum(["prepare", "send", "observe", "cleanup"]),
    attempt_id: z.string().min(1).max(300),
    session_id: z.string().min(1).max(300),
    run_id: z.string().min(1).max(300),
    packet: PacketBindingSchema,
    config_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.number().int().min(1).max(LIMITS.maxCommandsExpanded),
    fencing_epoch: z.number().int().min(1),
    request_sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
const transitionBase = {
  journal_version: z.literal(JOURNAL_VERSION),
  at: z.string().datetime({ offset: true }),
  command_id: z.string().min(1).max(300)
} as const;
const startedSchema = z.object({ ...transitionBase, event: z.literal("started") }).strict();
const successCompletionSchema = z
  .object({
    ...transitionBase,
    event: z.literal("completed"),
    disposition: z.literal("completed"),
    result_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    result: RelayResultSchema
  })
  .strict();
const failureCompletionSchema = z
  .object({
    ...transitionBase,
    event: z.literal("completed"),
    disposition: z.enum(["failed", "outcome_indeterminate"]),
    result_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    error: failureSchema
  })
  .strict();
const acknowledgedSchema = z
  .object({ ...transitionBase, event: z.literal("acknowledged") })
  .strict();
const deadlineBoundSchema = z
  .object({
    journal_version: z.literal(JOURNAL_VERSION),
    event: z.literal("deadline_bound"),
    at: z.string().datetime({ offset: true }),
    run_id: z.string().min(1).max(300),
    server_expires_at: z.string().datetime({ offset: true }),
    local_expires_at: z.string().datetime({ offset: true }),
    effective_expires_at: z.string().datetime({ offset: true }),
    source: z.enum(["server", "local"])
  })
  .strict();

/**
 * A sequence the server proved it closed and will never deliver (AUG-412). It is
 * written only for a sequence the server listed in `skipped_sequences`. When the
 * sequence belongs to a command this journal accepted but never acknowledged, the
 * record closes that command; otherwise it must be the next sequence.
 */
const skippedSchema = z
  .object({
    journal_version: z.literal(JOURNAL_VERSION),
    event: z.literal("skipped"),
    at: z.string().datetime({ offset: true }),
    run_id: z.string().min(1).max(300),
    sequence: z.number().int().min(1).max(LIMITS.maxCommandsExpanded)
  })
  .strict();
/**
 * Local work the CLI gave up on because the server run is already terminal
 * (AUG-404): a command that was accepted but never completed, or a prepared
 * fixture whose cleanup the server can no longer send.
 */
const abandonedSchema = z
  .object({
    ...transitionBase,
    event: z.literal("abandoned"),
    reason: z.enum(["run_terminal_uncompleted", "run_terminal_cleanup"])
  })
  .strict();

const journalRecordSchema = z.union([
  deadlineBoundSchema,
  acceptedSchema,
  startedSchema,
  successCompletionSchema,
  failureCompletionSchema,
  acknowledgedSchema,
  skippedSchema,
  abandonedSchema
]);

type AcceptedRecord = z.infer<typeof acceptedSchema>;
type JournalRecord = z.infer<typeof journalRecordSchema>;
export type JournalCompletion =
  | { disposition: "completed"; result: RelayResult; resultSha256: string }
  | {
      disposition: FailureDisposition;
      error: SafeRelayFailure;
      resultSha256: string;
    };

export type JournalAbandonReason = z.infer<typeof abandonedSchema>["reason"];

export interface JournalCommandState {
  readonly accepted: AcceptedRecord;
  readonly started: boolean;
  readonly completion?: JournalCompletion;
  readonly acknowledged: boolean;
  /** The server proved it closed this command and will never deliver it again. */
  readonly skipped?: true;
  readonly abandoned?: JournalAbandonReason;
}

interface MutableCommandState {
  accepted: AcceptedRecord;
  started: boolean;
  completion?: JournalCompletion;
  acknowledged: boolean;
  skipped?: true;
  abandoned?: JournalAbandonReason;
}

export interface RelayJournalOptions {
  runId: string;
  stateDirectory?: string;
  now?: () => Date;
  dataPolicy?: DataPolicyContext;
}

export interface RelayJournalCloseOptions {
  purge?: boolean;
}

export interface JournalRunDeadline {
  readonly expiresAtMs: number;
  readonly source: "server" | "local";
}

export class RelayJournal {
  readonly path: string;
  readonly runId: string;
  readonly #stateDirectory: string;
  readonly #relayDirectory: string;
  readonly #lockPath: string;
  readonly #now: () => Date;
  readonly #dataPolicy: DataPolicyContext | undefined;
  readonly #states = new Map<string, MutableCommandState>();
  readonly #sequenceOwners = new Map<number, string>();
  readonly #skippedSequences = new Set<number>();
  #handle: FileHandle | undefined;
  #lock: SecureLockHandle | undefined;
  #deadline: z.infer<typeof deadlineBoundSchema> | undefined;
  #binding:
    | { runId: string; packet: PacketBinding; configSha256: string; sessionId: string }
    | undefined;
  #highestSequence = 0;
  #lastAcknowledgedSequence = 0;
  #currentFence = 0;

  constructor(options: RelayJournalOptions) {
    this.runId = options.runId;
    this.#now = options.now ?? (() => new Date());
    this.#dataPolicy = options.dataPolicy;
    const stateDirectory = options.stateDirectory ?? getStateDirectory();
    this.#stateDirectory = stateDirectory;
    this.#relayDirectory = join(stateDirectory, "relay");
    this.path = join(this.#relayDirectory, `run-${sha256(options.runId).slice(0, 32)}.jsonl`);
    this.#lockPath = `${this.path}.lock`;
  }

  get highestSequence(): number {
    return this.#highestSequence;
  }

  get lastAcknowledgedSequence(): number {
    return this.#lastAcknowledgedSequence;
  }

  get currentFence(): number {
    return this.#currentFence;
  }

  async bindRunDeadline(
    serverExpiresAt: string,
    localExpiresAt: string
  ): Promise<JournalRunDeadline> {
    this.#assertOpen();
    const server = normalizeDeadline(serverExpiresAt);
    const local = normalizeDeadline(localExpiresAt);
    const existing = this.#deadline;
    if (existing !== undefined) {
      if (existing.run_id !== this.runId || existing.server_expires_at !== server.iso) {
        throw new AwError({
          code: "RUN_DEADLINE_BINDING_MISMATCH",
          category: "protocol",
          message: "The relay run expiry changed from its durable journal binding."
        });
      }
      return {
        expiresAtMs: Date.parse(existing.effective_expires_at),
        source: existing.source
      };
    }
    const source = server.milliseconds <= local.milliseconds ? "server" : "local";
    const effective = source === "server" ? server : local;
    const record: z.infer<typeof deadlineBoundSchema> = {
      journal_version: JOURNAL_VERSION,
      event: "deadline_bound",
      at: this.#now().toISOString(),
      run_id: this.runId,
      server_expires_at: server.iso,
      local_expires_at: local.iso,
      effective_expires_at: effective.iso,
      source
    };
    await this.#append(record);
    this.#deadline = record;
    return { expiresAtMs: effective.milliseconds, source };
  }

  async open(): Promise<this> {
    if (this.#handle !== undefined) return this;
    await ensureSecureDirectory({
      path: this.#stateDirectory,
      recursive: true,
      label: "AugmentWorks state",
      errorCode: "UNSAFE_STATE_DIRECTORY"
    });
    await ensureSecureDirectory({
      path: this.#relayDirectory,
      recursive: false,
      label: "AugmentWorks relay state",
      errorCode: "UNSAFE_STATE_DIRECTORY"
    });
    await this.#acquireLock();
    let recoveryHandle: FileHandle | undefined;
    let openedHandle: FileHandle | undefined;
    try {
      await rejectUnsafeJournalPath(this.path);
      recoveryHandle = await open(
        this.path,
        constants.O_CREAT | constants.O_RDWR | noFollowFlag(),
        0o600
      );
      await secureFileHandle(recoveryHandle, 0o600, "UNSAFE_JOURNAL_PATH", "relay journal");
      const recoveryIdentity = await verifiedJournalIdentity(this.path, recoveryHandle);
      await this.#recoverAndLoad(recoveryHandle);

      openedHandle = await open(
        this.path,
        constants.O_APPEND | constants.O_RDWR | noFollowFlag()
      );
      await secureFileHandle(openedHandle, 0o600, "UNSAFE_JOURNAL_PATH", "relay journal");
      const appendIdentity = await verifiedJournalIdentity(this.path, openedHandle);
      if (!sameFileIdentity(recoveryIdentity, appendIdentity)) {
        throw journalChanged("The relay journal changed while append access was being established.");
      }
      this.#handle = openedHandle;
      await recoveryHandle.close();
      recoveryHandle = undefined;
      return this;
    } catch (error) {
      this.#handle = undefined;
      await openedHandle?.close().catch(() => undefined);
      await recoveryHandle?.close().catch(() => undefined);
      await this.#releaseLock().catch(() => undefined);
      if (error instanceof AwError) throw error;
      throw unsafeJournalOpen(error);
    }
  }

  async close(options: RelayJournalCloseOptions = {}): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    let failure: unknown;
    try {
      const identity =
        handle !== undefined && options.purge === true && this.#canPurge()
          ? await handle.stat()
          : undefined;
      await handle?.close();
      if (identity !== undefined) await purgeOwnedJournal(this.path, identity);
    } catch (error) {
      failure = error;
    }
    try {
      await this.#releaseLock();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  state(commandId: string): JournalCommandState | undefined {
    const state = this.#states.get(commandId);
    return state === undefined ? undefined : freezeState(state);
  }

  pending(): JournalCommandState | undefined {
    for (const state of this.#states.values()) {
      if (isOpenState(state)) return freezeState(state);
    }
    return undefined;
  }

  /** Commands that are neither acknowledged nor closed, in sequence order. */
  unsettled(): JournalCommandState[] {
    return [...this.#states.values()]
      .filter(isOpenState)
      .sort((left, right) => left.accepted.sequence - right.accepted.sequence)
      .map(freezeState);
  }

  /** Sequences the server proved closed and that no accepted command owns. */
  skippedSequences(): number[] {
    return [...this.#skippedSequences].sort((left, right) => left - right);
  }

  outstandingPreparedAttempts(): readonly string[] {
    const outstanding = new Set<string>();
    const ordered = [...this.#states.values()].sort(
      (left, right) => left.accepted.sequence - right.accepted.sequence
    );
    for (const state of ordered) {
      if (
        state.accepted.kind === "prepare" &&
        state.abandoned === undefined &&
        prepareMayHaveCreatedFixture(state)
      ) {
        outstanding.add(state.accepted.attempt_id);
      }
      if (
        state.accepted.kind === "cleanup" &&
        state.completion?.disposition === "completed"
      ) {
        outstanding.delete(state.accepted.attempt_id);
      }
    }
    return [...outstanding];
  }

  dispatchedSendCount(): number {
    let count = 0;
    for (const state of this.#states.values()) {
      if (state.accepted.kind === "send" && state.started) count += 1;
    }
    return count;
  }

  dispatchedCommandCount(): number {
    let count = 0;
    for (const state of this.#states.values()) {
      if (state.started) count += 1;
    }
    return count;
  }

  dispatchedActionCount(): number {
    let count = 0;
    for (const state of this.#states.values()) {
      if (state.started && state.accepted.kind !== "send") count += 1;
    }
    return count;
  }

  commandIds(): string[] {
    return [...this.#states.keys()];
  }

  async accept(command: RelayCommand): Promise<JournalCommandState> {
    this.#assertOpen();
    const requestSha256 = sha256(canonicalize(command));
    const existing = this.#states.get(command.command_id);
    if (existing !== undefined) {
      if (existing.skipped === true || (existing.abandoned !== undefined && !existing.acknowledged)) {
        throw journalError(
          "COMMAND_SEQUENCE_CONFLICT",
          "The relay delivered a command it had already closed.",
          command
        );
      }
      if (
        existing.accepted.request_sha256 !== requestSha256 ||
        existing.accepted.sequence !== command.sequence ||
        existing.accepted.fencing_epoch !== command.fencing_epoch
      ) {
        throw journalError(
          "COMMAND_REPLAY_CONFLICT",
          "A replayed command does not match its durable journal entry.",
          command
        );
      }
      return freezeState(existing);
    }

    const pending = this.pending();
    if (pending !== undefined) {
      throw journalError(
        "COMMAND_IN_FLIGHT",
        "The relay sent a second command before acknowledging the first.",
        command
      );
    }
    this.#validateBinding(command);
    if (command.fencing_epoch < this.#currentFence) {
      throw journalError("STALE_FENCE", "The relay command uses a stale fencing epoch.", command);
    }
    if (this.#skippedSequences.has(command.sequence)) {
      throw journalError(
        "COMMAND_SEQUENCE_CONFLICT",
        "The relay delivered a command sequence it reported as skipped.",
        command
      );
    }
    if (command.sequence !== this.#highestSequence + 1) {
      throw journalError(
        "COMMAND_SEQUENCE_GAP",
        "The relay command sequence is missing or out of order.",
        command,
        { expected_sequence: this.#highestSequence + 1, actual_sequence: command.sequence }
      );
    }
    if (this.#sequenceOwners.has(command.sequence)) {
      throw journalError("COMMAND_SEQUENCE_CONFLICT", "A command sequence was reused.", command);
    }

    const record: AcceptedRecord = {
      journal_version: JOURNAL_VERSION,
      event: "accepted",
      at: this.#now().toISOString(),
      command_id: command.command_id,
      kind: command.kind,
      attempt_id: command.attempt_id,
      session_id: command.session_id,
      run_id: command.run_id,
      packet: structuredClone(command.packet),
      config_sha256: command.config_sha256,
      sequence: command.sequence,
      fencing_epoch: command.fencing_epoch,
      request_sha256: requestSha256
    };
    await this.#append(record);
    const state: MutableCommandState = {
      accepted: record,
      started: false,
      acknowledged: false
    };
    this.#states.set(command.command_id, state);
    this.#sequenceOwners.set(command.sequence, command.command_id);
    this.#highestSequence = command.sequence;
    this.#currentFence = Math.max(this.#currentFence, command.fencing_epoch);
    this.#binding ??= {
      runId: command.run_id,
      packet: command.packet,
      configSha256: command.config_sha256,
      sessionId: command.session_id
    };
    return freezeState(state);
  }

  async markStarted(commandId: string): Promise<void> {
    const state = this.#requireState(commandId);
    if (state.started) return;
    await this.#append({
      journal_version: JOURNAL_VERSION,
      event: "started",
      at: this.#now().toISOString(),
      command_id: commandId
    });
    state.started = true;
  }

  async recordSuccess(commandId: string, result: RelayResult): Promise<JournalCompletion> {
    const state = this.#requireStarted(commandId);
    if (state.completion !== undefined) return state.completion;
    const detachedResult = structuredClone(parseRelayResult(state.accepted.kind, result));
    if (this.#dataPolicy !== undefined) {
      const projected = projectRelayResult(state.accepted.kind, detachedResult, this.#dataPolicy);
      if (projected.disposition !== "completed" || projected.result === undefined) {
        return this.recordFailure(
          commandId,
          projected.failure ?? DATA_POLICY_BLOCKED_FAILURE,
          "outcome_indeterminate"
        );
      }
      return this.#persistSuccess(commandId, projected.result);
    }
    return this.#persistSuccess(commandId, detachedResult);
  }

  async #persistSuccess(commandId: string, detachedResult: RelayResult): Promise<JournalCompletion> {
    const state = this.#requireStarted(commandId);
    if (state.completion !== undefined) return state.completion;
    const resultSha256 = sha256(canonicalize(detachedResult));
    await this.#append({
      journal_version: JOURNAL_VERSION,
      event: "completed",
      disposition: "completed",
      at: this.#now().toISOString(),
      command_id: commandId,
      result_sha256: resultSha256,
      result: detachedResult
    });
    state.completion = { disposition: "completed", result: detachedResult, resultSha256 };
    return state.completion;
  }

  async recordFailure(
    commandId: string,
    error: SafeRelayFailure,
    disposition: FailureDisposition
  ): Promise<JournalCompletion> {
    const state = this.#requireStarted(commandId);
    if (state.completion !== undefined) return state.completion;
    const parsedError = failureSchema.safeParse(error);
    if (!parsedError.success) throw journalCorrupt("Relay failure is not safe to persist.");
    const detachedError = structuredClone(parsedError.data);
    const resultSha256 = sha256(canonicalize({ disposition, error: detachedError }));
    await this.#append({
      journal_version: JOURNAL_VERSION,
      event: "completed",
      disposition,
      at: this.#now().toISOString(),
      command_id: commandId,
      result_sha256: resultSha256,
      error: detachedError
    });
    state.completion = { disposition, error: detachedError, resultSha256 };
    return state.completion;
  }

  async acknowledge(commandId: string): Promise<void> {
    const state = this.#requireState(commandId);
    if (state.completion === undefined) {
      throw journalCorrupt("Cannot acknowledge a command without a durable completion.");
    }
    if (state.acknowledged) return;
    await this.#append({
      journal_version: JOURNAL_VERSION,
      event: "acknowledged",
      at: this.#now().toISOString(),
      command_id: commandId
    });
    state.acknowledged = true;
    this.#recomputeAcknowledgedSequence();
  }

  /**
   * Records the sequences the server proved it closed and will never deliver
   * (AUG-412). Sequences are taken in ascending order while they stay contiguous
   * with what this journal already holds; the first one past a gap stops the
   * walk, so a later command beyond it still raises COMMAND_SEQUENCE_GAP.
   * Returns the sequences newly recorded.
   */
  async recordServerSkips(sequences: readonly number[]): Promise<number[]> {
    this.#assertOpen();
    const recorded: number[] = [];
    let previous = 0;
    for (const sequence of sequences) {
      if (!Number.isInteger(sequence) || sequence <= previous || sequence < 1) {
        throw skipError("The relay reported skipped sequences out of order.", sequence);
      }
      previous = sequence;
      const ownerId = this.#sequenceOwners.get(sequence);
      if (ownerId !== undefined) {
        const owner = this.#states.get(ownerId);
        if (owner === undefined) throw journalCorrupt("Relay journal sequence owner is missing.");
        if (owner.skipped === true) continue;
        if (owner.acknowledged) {
          throw skipError("The relay reported an acknowledged command as skipped.", sequence);
        }
        await this.#appendSkip(sequence);
        owner.skipped = true;
        recorded.push(sequence);
        continue;
      }
      if (this.#skippedSequences.has(sequence)) continue;
      if (sequence !== this.#highestSequence + 1) break;
      await this.#appendSkip(sequence);
      this.#skippedSequences.add(sequence);
      this.#highestSequence = sequence;
      recorded.push(sequence);
    }
    if (recorded.length > 0) this.#recomputeAcknowledgedSequence();
    return recorded;
  }

  /**
   * Gives up on a command because the server run is terminal (AUG-404). Only an
   * unacknowledged command with no completion, or a prepare whose fixture still
   * needs cleanup, can be abandoned.
   */
  async abandon(commandId: string, reason: JournalAbandonReason): Promise<void> {
    const state = this.#requireState(commandId);
    if (state.abandoned !== undefined) return;
    assertAbandonable(state, reason);
    await this.#append({
      journal_version: JOURNAL_VERSION,
      event: "abandoned",
      at: this.#now().toISOString(),
      command_id: commandId,
      reason
    });
    state.abandoned = reason;
    this.#recomputeAcknowledgedSequence();
  }

  /**
   * Abandons the cleanup of every prepared fixture still outstanding, for a run the
   * server already finished and so will never send cleanup for. Returns the attempt
   * IDs whose fixtures were left in place.
   */
  async abandonOutstandingCleanup(): Promise<string[]> {
    const outstanding = this.outstandingPreparedAttempts();
    const attempts = new Set(outstanding);
    for (const state of this.#states.values()) {
      if (
        state.accepted.kind === "prepare" &&
        state.abandoned === undefined &&
        attempts.has(state.accepted.attempt_id) &&
        prepareMayHaveCreatedFixture(state)
      ) {
        await this.abandon(state.accepted.command_id, "run_terminal_cleanup");
      }
    }
    return [...outstanding];
  }

  async #appendSkip(sequence: number): Promise<void> {
    await this.#append({
      journal_version: JOURNAL_VERSION,
      event: "skipped",
      at: this.#now().toISOString(),
      run_id: this.runId,
      sequence
    });
  }

  async #recoverAndLoad(handle: FileHandle): Promise<void> {
    const bytes = await handle.readFile();
    let completeBytes = bytes.length;
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
      const newline = bytes.lastIndexOf(0x0a);
      completeBytes = newline < 0 ? 0 : newline + 1;
      await handle.truncate(completeBytes);
      await handle.sync();
    }
    if (completeBytes === 0) return;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, completeBytes));
    } catch (error) {
      throw journalCorrupt("Relay journal is not valid UTF-8.", error);
    }
    const lines = text.split("\n").filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      let value: unknown;
      try {
        value = JSON.parse(lines[index] ?? "");
      } catch (error) {
        throw journalCorrupt(`Relay journal line ${index + 1} is invalid JSON.`, error);
      }
      const parsed = journalRecordSchema.safeParse(value);
      if (!parsed.success) throw journalCorrupt(`Relay journal line ${index + 1} is invalid.`);
      this.#applyLoaded(parsed.data);
    }
    this.#recomputeAcknowledgedSequence();
  }

  async #acquireLock(): Promise<void> {
    if (this.#lock !== undefined) return;
    this.#lock = await acquireSecureLock({
      path: this.#lockPath,
      label: "relay journal",
      now: this.#now,
      errorCodes: {
        locked: "JOURNAL_LOCKED",
        unsafe: "UNSAFE_JOURNAL_LOCK",
        unknownOwner: "JOURNAL_LOCK_OWNER_UNKNOWN",
        foreignOwner: "JOURNAL_LOCK_OWNER_FOREIGN",
        changed: "JOURNAL_LOCK_CHANGED"
      }
    });
  }

  async #releaseLock(): Promise<void> {
    const lock = this.#lock;
    if (lock === undefined) return;
    await lock.release();
    this.#lock = undefined;
  }

  #canPurge(): boolean {
    return (
      [...this.#states.values()].every((state) => !isOpenState(state)) &&
      this.outstandingPreparedAttempts().length === 0
    );
  }

  #applyLoaded(record: JournalRecord): void {
    if (record.event === "deadline_bound") {
      if (this.#deadline !== undefined || record.run_id !== this.runId) {
        throw journalCorrupt("Relay journal run deadline binding is duplicated or changed.");
      }
      const server = Date.parse(record.server_expires_at);
      const local = Date.parse(record.local_expires_at);
      const expectedSource = server <= local ? "server" : "local";
      const expectedExpiry = Math.min(server, local);
      if (
        !Number.isFinite(server) ||
        !Number.isFinite(local) ||
        record.source !== expectedSource ||
        Date.parse(record.effective_expires_at) !== expectedExpiry
      ) {
        throw journalCorrupt("Relay journal run deadline binding is invalid.");
      }
      this.#deadline = record;
      return;
    }
    if (record.event === "skipped") {
      if (record.run_id !== this.runId) throw journalCorrupt("Relay journal run binding changed.");
      const ownerId = this.#sequenceOwners.get(record.sequence);
      if (ownerId !== undefined) {
        const owner = this.#states.get(ownerId);
        if (owner === undefined || owner.acknowledged || owner.skipped === true) {
          throw journalCorrupt("Relay journal skip record is out of order.");
        }
        owner.skipped = true;
        return;
      }
      if (record.sequence !== this.#highestSequence + 1) {
        throw journalCorrupt("Relay journal contains a command sequence gap.");
      }
      this.#skippedSequences.add(record.sequence);
      this.#highestSequence = record.sequence;
      return;
    }
    if (record.event === "accepted") {
      if (record.run_id !== this.runId) throw journalCorrupt("Relay journal run binding changed.");
      if (this.#states.has(record.command_id) || this.#sequenceOwners.has(record.sequence)) {
        throw journalCorrupt("Relay journal contains a duplicate command or sequence.");
      }
      if (record.sequence !== this.#highestSequence + 1) {
        throw journalCorrupt("Relay journal contains a command sequence gap.");
      }
      const candidate = {
        runId: record.run_id,
        packet: record.packet,
        configSha256: record.config_sha256,
        sessionId: record.session_id
      };
      if (this.#binding !== undefined && canonicalize(this.#binding) !== canonicalize(candidate)) {
        throw journalCorrupt("Relay journal command binding changed.");
      }
      if (record.fencing_epoch < this.#currentFence) {
        throw journalCorrupt("Relay journal fencing epoch regressed.");
      }
      this.#binding ??= candidate;
      this.#currentFence = record.fencing_epoch;
      this.#highestSequence = record.sequence;
      this.#sequenceOwners.set(record.sequence, record.command_id);
      this.#states.set(record.command_id, {
        accepted: record,
        started: false,
        acknowledged: false
      });
      return;
    }
    const state = this.#states.get(record.command_id);
    if (state === undefined) throw journalCorrupt("Relay journal transition has no accepted command.");
    if (record.event === "abandoned") {
      if (state.abandoned !== undefined) {
        throw journalCorrupt("Relay journal contains duplicate abandoned records.");
      }
      try {
        assertAbandonable(state, record.reason);
      } catch (error) {
        throw journalCorrupt("Relay journal abandoned record is out of order.", error);
      }
      state.abandoned = record.reason;
      return;
    }
    if (record.event === "started") {
      if (state.started) throw journalCorrupt("Relay journal contains duplicate started records.");
      state.started = true;
      return;
    }
    if (record.event === "completed") {
      if (!state.started || state.completion !== undefined) {
        throw journalCorrupt("Relay journal completion is out of order.");
      }
      if (record.disposition === "completed") {
        if (sha256(canonicalize(record.result)) !== record.result_sha256) {
          throw journalCorrupt("Relay journal result hash does not match its payload.");
        }
        let typedResult: RelayResult;
        try {
          typedResult = parseRelayResult(state.accepted.kind, record.result);
        } catch (error) {
          throw journalCorrupt("Relay journal result does not match its operation kind.", error);
        }
        state.completion = {
          disposition: "completed",
          result: typedResult,
          resultSha256: record.result_sha256
        };
      } else {
        if (sha256(canonicalize({ disposition: record.disposition, error: record.error })) !== record.result_sha256) {
          throw journalCorrupt("Relay journal failure hash does not match its payload.");
        }
        state.completion = {
          disposition: record.disposition,
          error: record.error,
          resultSha256: record.result_sha256
        };
      }
      return;
    }
    if (state.completion === undefined || state.acknowledged) {
      throw journalCorrupt("Relay journal acknowledgement is out of order.");
    }
    state.acknowledged = true;
  }

  #validateBinding(command: RelayCommand): void {
    if (command.run_id !== this.runId) {
      throw journalError("RUN_BINDING_MISMATCH", "The command belongs to a different run.", command);
    }
    if (
      (command.kind === "prepare" || command.kind === "cleanup") &&
      command.input.attempt_id !== command.attempt_id
    ) {
      throw journalError(
        "ATTEMPT_BINDING_MISMATCH",
        "The command input belongs to a different attempt.",
        command
      );
    }
    if (command.kind === "prepare" && command.input.run_id !== command.run_id) {
      throw journalError("RUN_BINDING_MISMATCH", "The prepare input belongs to a different run.", command);
    }
    if (
      (command.kind === "prepare" || command.kind === "send") &&
      command.input.idempotency_key !== command.idempotency_key
    ) {
      throw journalError(
        "IDEMPOTENCY_BINDING_MISMATCH",
        "The command idempotency key does not match its semantic input.",
        command
      );
    }
    if (this.#binding === undefined) return;
    const same =
      command.run_id === this.#binding.runId &&
      command.session_id === this.#binding.sessionId &&
      command.config_sha256 === this.#binding.configSha256 &&
      canonicalize(command.packet) === canonicalize(this.#binding.packet);
    if (!same) {
      throw journalError(
        "RUN_BINDING_MISMATCH",
        "The relay changed the run, packet, session, or configuration binding.",
        command
      );
    }
  }

  #requireState(commandId: string): MutableCommandState {
    this.#assertOpen();
    const state = this.#states.get(commandId);
    if (state === undefined) throw journalCorrupt("Relay command was not accepted before transition.");
    return state;
  }

  #requireStarted(commandId: string): MutableCommandState {
    const state = this.#requireState(commandId);
    if (!state.started) throw journalCorrupt("Relay command was not durably started.");
    return state;
  }

  #assertOpen(): void {
    if (this.#handle === undefined) {
      throw new AwError({
        code: "JOURNAL_CLOSED",
        category: "local",
        message: "The relay journal is closed."
      });
    }
  }

  async #append(record: JournalRecord): Promise<void> {
    const handle = this.#handle;
    if (handle === undefined) throw journalCorrupt("Relay journal is not open.");
    await handle.appendFile(`${canonicalize(record)}\n`, { encoding: "utf8" });
    await handle.sync();
  }

  /**
   * The poll cursor: the highest sequence such that it and every sequence below it
   * is acknowledged, proven skipped by the server, or abandoned on a terminal run.
   */
  #recomputeAcknowledgedSequence(): void {
    let sequence = 0;
    while (true) {
      const next = sequence + 1;
      if (this.#skippedSequences.has(next)) {
        sequence = next;
        continue;
      }
      const owner = this.#sequenceOwners.get(next);
      const state = owner === undefined ? undefined : this.#states.get(owner);
      if (state === undefined || isOpenState(state)) break;
      sequence = next;
    }
    this.#lastAcknowledgedSequence = sequence;
  }
}

export interface RelayJournalInspection {
  readonly present: boolean;
  readonly outstandingPreparedAttempts: readonly string[];
  readonly unacknowledged: boolean;
}

/** Whether a journal file exists for the run, without opening or locking it. */
export async function relayJournalExists(options: RelayJournalOptions): Promise<boolean> {
  const path = new RelayJournal(options).path;
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new AwError({
        code: "UNSAFE_JOURNAL_PATH",
        category: "local",
        message: "The relay journal must be a regular file and cannot be a symbolic link."
      });
    }
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

export async function inspectRelayJournal(
  options: RelayJournalOptions
): Promise<RelayJournalInspection> {
  const journal = new RelayJournal(options);
  if (!(await relayJournalExists(options))) {
    return { present: false, outstandingPreparedAttempts: [], unacknowledged: false };
  }
  await journal.open();
  try {
    return {
      present: true,
      outstandingPreparedAttempts: journal.outstandingPreparedAttempts(),
      unacknowledged: journal.pending() !== undefined
    };
  } finally {
    await journal.close({ purge: false });
  }
}

function freezeState(state: MutableCommandState): JournalCommandState {
  return structuredClone({
    accepted: state.accepted,
    started: state.started,
    ...(state.completion === undefined ? {} : { completion: state.completion }),
    acknowledged: state.acknowledged,
    ...(state.skipped === true ? { skipped: true as const } : {}),
    ...(state.abandoned === undefined ? {} : { abandoned: state.abandoned })
  });
}

/** Neither acknowledged nor closed by a server skip or a terminal-run abandon. */
function isOpenState(state: MutableCommandState): boolean {
  return !state.acknowledged && state.skipped !== true && state.abandoned === undefined;
}

function assertAbandonable(state: MutableCommandState, reason: JournalAbandonReason): void {
  if (reason === "run_terminal_uncompleted") {
    if (state.acknowledged || state.completion !== undefined) {
      throw journalCorrupt("Only a command with no completion can be abandoned as uncompleted.");
    }
    return;
  }
  if (state.accepted.kind !== "prepare" || !prepareMayHaveCreatedFixture(state)) {
    throw journalCorrupt("Only a prepare that may have created a fixture can abandon its cleanup.");
  }
}

function skipError(message: string, sequence: number): AwError {
  return new AwError({
    code: "COMMAND_SEQUENCE_CONFLICT",
    category: "protocol",
    message,
    details: { skipped_sequence: sequence }
  });
}

function normalizeDeadline(value: string): { iso: string; milliseconds: number } {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new AwError({
      code: "INVALID_RUN_DEADLINE",
      category: "protocol",
      message: "The relay run expiry is not a valid absolute timestamp."
    });
  }
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function prepareMayHaveCreatedFixture(state: MutableCommandState): boolean {
  if (!state.started) return false;
  if (state.completion === undefined || state.completion.disposition !== "failed") return true;
  return !new Set(["RUN_CANCELLED", "COMMAND_EXPIRED"]).has(state.completion.error.code);
}

function journalError(
  code: string,
  message: string,
  command: RelayCommand,
  details?: Readonly<Record<string, string | number | boolean>>
): AwError {
  return new AwError({
    code,
    category: "protocol",
    message,
    operation: command.kind,
    commandId: command.command_id,
    details
  });
}

function journalCorrupt(message: string, cause?: unknown): AwError {
  return new AwError({
    code: "JOURNAL_CORRUPT",
    category: "local",
    message,
    cause
  });
}

async function rejectUnsafeJournalPath(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new AwError({
        code: "UNSAFE_JOURNAL_PATH",
        category: "local",
        message: "The relay journal must be a regular file and cannot be a symbolic link."
      });
    }
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
}

async function verifiedJournalIdentity(path: string, handle: FileHandle): Promise<Stats> {
  let pathIdentity: Stats;
  let handleIdentity: Stats;
  try {
    pathIdentity = await lstat(path);
    handleIdentity = await handle.stat();
  } catch (error) {
    throw journalChanged(
      "The relay journal changed while its file identity was being verified.",
      error
    );
  }
  if (pathIdentity.isSymbolicLink() || !pathIdentity.isFile() || !handleIdentity.isFile()) {
    throw new AwError({
      code: "UNSAFE_JOURNAL_PATH",
      category: "local",
      message: "The relay journal must be a regular file and cannot be a symbolic link."
    });
  }
  if (!sameFileIdentity(pathIdentity, handleIdentity)) {
    throw journalChanged("The relay journal changed while its file identity was being verified.");
  }
  return handleIdentity;
}

function journalChanged(message: string, cause?: unknown): AwError {
  return new AwError({
    code: "JOURNAL_CHANGED",
    category: "local",
    message,
    cause
  });
}

async function purgeOwnedJournal(path: string, owned: Stats): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (error) {
    throw new AwError({
      code: "JOURNAL_CHANGED",
      category: "local",
      message: "The relay journal changed before it could be purged safely.",
      cause: error
    });
  }
  if (current.isSymbolicLink() || !current.isFile() || !sameFileIdentity(current, owned)) {
    throw journalChanged("The relay journal changed before it could be purged safely.");
  }
  await unlink(path);
}

async function secureFileHandle(
  handle: FileHandle,
  mode: number,
  code: string,
  label: string
): Promise<void> {
  try {
    await handle.chmod(mode);
    const stat = await handle.stat();
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o777) !== mode)) {
      throw new Error(`${label} permissions are unsafe`);
    }
  } catch (error) {
    throw new AwError({
      code,
      category: "local",
      message: `The ${label} permissions could not be secured.`,
      cause: error
    });
  }
}

function unsafeJournalOpen(cause: unknown): AwError {
  return new AwError({
    code: "UNSAFE_JOURNAL_PATH",
    category: "local",
    message: "The relay journal path could not be opened without following links.",
    cause
  });
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
}

function isMissingPath(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
