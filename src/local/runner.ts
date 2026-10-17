import { randomUUID } from "node:crypto";

import { TARGET_PROTOCOL_VERSION } from "../cloud/protocol.js";
import type { HttpConnector } from "../connector/http.js";
import type { ConnectorExecutionContext, ConnectorResult } from "../connector/types.js";
import type { DataPolicyContext } from "../data-policy/index.js";
import { AwError, type OperationKind } from "../errors.js";
import { CLI_VERSION } from "../version.js";
import { stableId, stableKey } from "./canonical.js";
import {
  buildLocalRunResult,
  localAttemptId,
  scoreLocalAttempt,
  type MissingAttemptReason
} from "./scorer.js";
import type {
  LocalAttemptResult,
  LocalOperationError,
  LocalOperationRecord,
  LocalRunResult,
  AnyLocalPacketManifest,
  PacketScenario
} from "./types.js";
import { isLocalAuthorizedPacket } from "./types.js";
import { assertScopeNotExpired, operationPermittedByEffects } from "../real-data/boundary.js";
import { realDataError } from "../real-data/errors.js";

const CLEANUP_RETRY_DELAYS_MS = [100, 250] as const;
const DEFAULT_LOCAL_RUN_DEADLINE_MS = 30 * 60_000;
type LocalOperationInput = Record<string, unknown> & { readonly idempotency_key?: string };

export type LocalConnector = Pick<HttpConnector, "execute" | "isIdempotent">;

export type LocalProgressEvent =
  | { readonly type: "run_started"; readonly runId: string; readonly attempts: number }
  | {
      readonly type: "attempt_started";
      readonly attemptId: string;
      readonly scenarioKey: string;
      readonly repetitionIndex: number;
    }
  | {
      readonly type: "operation_started";
      readonly attemptId: string;
      readonly kind: OperationKind;
      readonly turnIndex?: number;
    }
  | {
      readonly type: "operation_completed";
      readonly attemptId: string;
      readonly kind: OperationKind;
      readonly turnIndex?: number;
    }
  | {
      readonly type: "operation_failed";
      readonly attemptId: string;
      readonly kind: OperationKind;
      readonly code: string;
      readonly indeterminate: boolean;
      readonly turnIndex?: number;
    }
  | {
      readonly type: "attempt_completed";
      readonly attempt: LocalAttemptResult;
    }
  | { readonly type: "cancellation_requested"; readonly runId: string }
  | { readonly type: "run_completed"; readonly result: LocalRunResult };

export interface LocalRunnerOptions {
  readonly connector: LocalConnector;
  readonly packet: AnyLocalPacketManifest;
  readonly packetSha256: string;
  readonly targetName: string;
  readonly configSha256: string;
  readonly secrets?: readonly string[];
  readonly cliVersion?: string;
  readonly runId?: string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: LocalProgressEvent) => void;
  readonly runDeadlineMs?: number;
  readonly dataPolicy?: DataPolicyContext;
}

export class LocalRunner {
  readonly #connector: LocalConnector;
  readonly #packet: AnyLocalPacketManifest;
  readonly #packetSha256: string;
  readonly #targetName: string;
  readonly #configSha256: string;
  readonly #secrets: readonly string[];
  readonly #cliVersion: string;
  readonly #runId: string;
  readonly #now: () => Date;
  readonly #signal: AbortSignal | undefined;
  readonly #onProgress: ((event: LocalProgressEvent) => void) | undefined;
  readonly #runDeadlineMs: number;
  readonly #dataPolicy: DataPolicyContext | undefined;
  #messagesDispatched = 0;
  #commandsDispatched = 0;
  #actionsDispatched = 0;
  readonly #startedMs: number;
  #activeOperation: { kind: OperationKind; controller: AbortController } | undefined;
  #cancelRequested = false;
  #stopKind: "user" | "deadline" | undefined;
  #running = false;

  constructor(options: LocalRunnerOptions) {
    this.#connector = options.connector;
    this.#packet = options.packet;
    this.#packetSha256 = options.packetSha256;
    this.#targetName = options.targetName;
    this.#configSha256 = options.configSha256;
    this.#secrets = options.secrets ?? [];
    this.#cliVersion = options.cliVersion ?? CLI_VERSION;
    this.#runId = options.runId ?? `local_run_${randomUUID().replaceAll("-", "")}`;
    this.#now = options.now ?? (() => new Date());
    this.#signal = options.signal;
    this.#onProgress = options.onProgress;
    this.#runDeadlineMs = options.runDeadlineMs ?? DEFAULT_LOCAL_RUN_DEADLINE_MS;
    this.#dataPolicy = options.dataPolicy;
    this.#startedMs = Date.now();
    if (isLocalAuthorizedPacket(this.#packet)) {
      assertScopeNotExpired(this.#packet.execution_scope.expiresAt, Date.now(), "This packet's local scope");
    }
    if (
      !Number.isSafeInteger(this.#runDeadlineMs) ||
      this.#runDeadlineMs < 1 ||
      this.#runDeadlineMs > DEFAULT_LOCAL_RUN_DEADLINE_MS
    ) {
      throw new AwError({
        code: "LOCAL_RUN_DEADLINE_INVALID",
        category: "config",
        message: "The local run deadline must be between 1 ms and 30 minutes."
      });
    }
  }

  get runId(): string {
    return this.#runId;
  }

  get cancelRequested(): boolean {
    return this.#cancelRequested;
  }

  get interrupted(): boolean {
    return this.#stopKind === "user";
  }

  requestCancellation(reason: "user" | "deadline" = "user"): void {
    if (this.#cancelRequested) return;
    this.#cancelRequested = true;
    this.#stopKind = reason;
    if (this.#activeOperation?.kind !== "cleanup") {
      this.#activeOperation?.controller.abort("local assessment cancellation requested");
    }
    this.#onProgress?.({ type: "cancellation_requested", runId: this.#runId });
  }

  async run(): Promise<LocalRunResult> {
    if (this.#running) {
      throw new AwError({
        code: "LOCAL_RUN_ALREADY_ACTIVE",
        category: "local",
        message: "This local assessment runner is already active."
      });
    }
    this.#running = true;
    const attempts: LocalAttemptResult[] = [];
    let stoppedReason: MissingAttemptReason | undefined;
    const requestedAttempts = this.#packet.scenarios.reduce(
      (total, scenario) => total + scenario.repetitions,
      0
    );
    const abortListener = (): void => this.requestCancellation("user");
    if (this.#signal?.aborted === true) this.requestCancellation("user");
    else this.#signal?.addEventListener("abort", abortListener, { once: true });
    const deadline = setTimeout(() => this.requestCancellation("deadline"), this.#runDeadlineMs);
    deadline.unref?.();
    this.#onProgress?.({ type: "run_started", runId: this.#runId, attempts: requestedAttempts });

    try {
      outer: for (const scenario of this.#packet.scenarios) {
        for (let repetitionIndex = 0; repetitionIndex < scenario.repetitions; repetitionIndex += 1) {
          if (this.#cancelRequested) {
            stoppedReason = this.#cancelStopReason();
            break outer;
          }
          const attempt = await this.#runAttempt(scenario, repetitionIndex);
          attempts.push(attempt);
          this.#onProgress?.({ type: "attempt_completed", attempt });
          if (attempt.cleanup_status === "failed") {
            stoppedReason = this.#stopReason(
              "not_run_after_cleanup_failure",
              "No additional synthetic attempts were started because cleanup could not be confirmed."
            );
            break outer;
          }
          if (this.#cancelRequested) {
            stoppedReason = this.#cancelStopReason();
            break outer;
          }
        }
      }

      const result = buildLocalRunResult({
        runId: this.#runId,
        cliVersion: this.#cliVersion,
        packet: this.#packet,
        packetSha256: this.#packetSha256,
        targetName: this.#targetName,
        configSha256: this.#configSha256,
        attempts,
        ...(stoppedReason === undefined ? {} : { stoppedReason }),
        secrets: this.#secrets
      });
      this.#onProgress?.({ type: "run_completed", result });
      return result;
    } finally {
      clearTimeout(deadline);
      this.#signal?.removeEventListener("abort", abortListener);
      this.#running = false;
    }
  }

  async #runAttempt(
    scenario: PacketScenario,
    repetitionIndex: number
  ): Promise<LocalAttemptResult> {
    const attemptId = localAttemptId(this.#runId, scenario.key, repetitionIndex);
    this.#onProgress?.({
      type: "attempt_started",
      attemptId,
      scenarioKey: scenario.key,
      repetitionIndex
    });
    const operations: LocalOperationRecord[] = [];
    let stoppedReason: { code: string; message: string; retryable?: boolean } | undefined;
    let mayProceed = true;

    try {
      if (Object.keys(scenario.fixture).length > 0) {
        const input: LocalOperationInput = {
          protocol_version: TARGET_PROTOCOL_VERSION,
          run_id: this.#runId,
          attempt_id: attemptId,
          scenario_key: scenario.key,
          repetition_index: repetitionIndex,
          idempotency_key: this.#idempotencyKey(attemptId, "prepare"),
          mode: "evaluation",
          fixture: scenario.fixture,
          metadata: { execution_mode: "local" }
        };
        const record = await this.#execute("prepare", input, attemptId);
        operations.push(record);
        mayProceed = record.disposition === "completed";
      }

      for (let turnIndex = 0; mayProceed && turnIndex < scenario.turns.length; turnIndex += 1) {
        if (this.#cancelRequested) {
          stoppedReason = cancellationReason();
          break;
        }
        const turn = scenario.turns[turnIndex]!;
        const turnId = stableId("local_turn", attemptId, String(turnIndex));
        const input: LocalOperationInput = {
          protocol_version: TARGET_PROTOCOL_VERSION,
          turn_id: turnId,
          idempotency_key: this.#idempotencyKey(attemptId, "send", turnIndex),
          message: { role: "user", content: turn.content },
          metadata: {
            execution_mode: "local",
            scenario_key: scenario.key,
            repetition_index: repetitionIndex,
            attempt_id: attemptId
          }
        };
        const record = await this.#execute("send", input, attemptId, turnIndex, turnId);
        operations.push(record);
        if (record.disposition !== "completed") mayProceed = false;
      }

      if (scenario.observation_keys.length > 0 && operations.some(({ kind }) => kind === "send")) {
        const requestId = stableId("local_observe", attemptId);
        const input: LocalOperationInput = {
          protocol_version: TARGET_PROTOCOL_VERSION,
          request_id: requestId,
          probe_keys: [...scenario.observation_keys],
          metadata: {
            execution_mode: "local",
            scenario_key: scenario.key,
            repetition_index: repetitionIndex,
            attempt_id: attemptId
          }
        };
        operations.push(await this.#execute("observe", input, attemptId, undefined, undefined, requestId));
      }

      if (this.#cancelRequested) stoppedReason = cancellationReason();
    } finally {
      if (this.#requiresCleanup(scenario)) {
        const input: LocalOperationInput = {
          protocol_version: TARGET_PROTOCOL_VERSION,
          attempt_id: attemptId
        };
        operations.push(await this.#executeCleanup(input, attemptId));
      }
    }

    if (operations.length === 0) {
      throw new AwError({
        code: "LOCAL_ATTEMPT_EMPTY",
        category: "local",
        message: "The local packet produced an attempt with no executable operations."
      });
    }
    return scoreLocalAttempt({
      scenario,
      repetitionIndex,
      attemptId,
      operations,
      cleanupRequired: this.#requiresCleanup(scenario),
      ...(stoppedReason === undefined ? {} : { stoppedReason }),
      secrets: this.#secrets
    });
  }

  async #executeCleanup(
    input: LocalOperationInput,
    attemptId: string
  ): Promise<LocalOperationRecord> {
    let attempt = 0;
    while (true) {
      const record = await this.#execute("cleanup", input, attemptId, undefined, undefined, undefined, true);
      const error = record.disposition === "completed" ? undefined : record.error;
      const retry =
        error?.retryable === true &&
        this.#connector.isIdempotent("cleanup") &&
        attempt < CLEANUP_RETRY_DELAYS_MS.length;
      if (!retry) return record;
      const delayMs = CLEANUP_RETRY_DELAYS_MS[attempt++]!;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  async #execute(
    kind: OperationKind,
    input: LocalOperationInput,
    attemptId: string,
    turnIndex?: number,
    turnId?: string,
    requestId?: string,
    ignoreCancellation = false
  ): Promise<LocalOperationRecord> {
    this.#assertAuthorizedOperation(kind);
    const startedAt = this.#timestamp();
    const commandId = stableId(
      "local_command",
      this.#runId,
      attemptId,
      kind,
      String(turnIndex ?? 0)
    );
    const idempotencyKey =
      typeof input.idempotency_key === "string"
        ? input.idempotency_key
        : this.#idempotencyKey(attemptId, kind, turnIndex);
    const controller = new AbortController();
    const abortListener = (): void => controller.abort(this.#signal?.reason);
    if (!ignoreCancellation) {
      if (this.#cancelRequested || this.#signal?.aborted === true) controller.abort("cancelled");
      else this.#signal?.addEventListener("abort", abortListener, { once: true });
    }
    this.#activeOperation = { kind, controller };
    this.#onProgress?.({
      type: "operation_started",
      attemptId,
      kind,
      ...(turnIndex === undefined ? {} : { turnIndex })
    });
    const context: ConnectorExecutionContext = {
      commandId,
      idempotencyKey,
      runId: this.#runId,
      attemptId,
      ...(turnId === undefined ? {} : { turnId }),
      ...(requestId === undefined ? {} : { requestId }),
      signal: controller.signal,
      ...(this.#dataPolicy === undefined ? {} : { dataPolicy: this.#dataPolicy })
    };
    try {
      const result = (await this.#connector.execute(kind, input, context)) as ConnectorResult;
      const record: LocalOperationRecord = {
        kind,
        started_at: startedAt,
        completed_at: this.#timestamp(),
        ...(turnIndex === undefined ? {} : { turn_index: turnIndex }),
        disposition: "completed",
        result
      };
      this.#onProgress?.({
        type: "operation_completed",
        attemptId,
        kind,
        ...(turnIndex === undefined ? {} : { turnIndex })
      });
      return record;
    } catch (cause) {
      const error = safeOperationError(cause);
      const indeterminate =
        cause instanceof AwError &&
        (cause.code === "TARGET_OUTCOME_INDETERMINATE" || cause.code === "OUTCOME_INDETERMINATE");
      this.#onProgress?.({
        type: "operation_failed",
        attemptId,
        kind,
        code: error.code,
        indeterminate,
        ...(turnIndex === undefined ? {} : { turnIndex })
      });
      return {
        kind,
        started_at: startedAt,
        completed_at: this.#timestamp(),
        ...(turnIndex === undefined ? {} : { turn_index: turnIndex }),
        disposition: indeterminate ? "outcome_indeterminate" : "failed",
        error
      };
    } finally {
      if (!ignoreCancellation) this.#signal?.removeEventListener("abort", abortListener);
      if (this.#activeOperation?.controller === controller) this.#activeOperation = undefined;
    }
  }

  #requiresCleanup(scenario: PacketScenario): boolean {
    return this.#packet.required_capabilities.cleanup || Object.keys(scenario.fixture).length > 0;
  }

  #idempotencyKey(attemptId: string, kind: OperationKind, index = 0): string {
    return stableKey("local_idem", this.#runId, attemptId, kind, String(index));
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #stopReason(code: MissingAttemptReason["code"], message: string): MissingAttemptReason {
    return { code, message, at: this.#timestamp() };
  }

  #cancelStopReason(): MissingAttemptReason {
    return this.#stopReason(
      "run_cancelled",
      this.#stopKind === "deadline"
        ? "The 30-minute local assessment deadline was reached."
        : "The local assessment was cancelled."
    );
  }

  #assertAuthorizedOperation(kind: OperationKind): void {
    if (!isLocalAuthorizedPacket(this.#packet)) return;
    const scope = this.#packet.execution_scope;
    assertScopeNotExpired(scope.expiresAt, this.#now().getTime());
    const elapsedSeconds = (this.#now().getTime() - this.#startedMs) / 1000;
    if (elapsedSeconds > scope.budget.maxRuntimeSeconds) {
      throw realDataError(
        "EXECUTION_BUDGET_EXHAUSTED",
        `Local target runtime exceeded maxRuntimeSeconds (${String(scope.budget.maxRuntimeSeconds)}). Grading of already-recorded attempts can continue; do not replay the send.`
      );
    }
    if (!operationPermittedByEffects(kind, scope.effects)) {
      throw realDataError("ACTION_NOT_ALLOWED", `Local authorized scope does not permit ${kind} operations.`);
    }
    const next = {
      messages: this.#messagesDispatched + (kind === "send" ? 1 : 0),
      commands: this.#commandsDispatched + 1,
      actions: this.#actionsDispatched + (kind === "send" ? 0 : 1)
    };
    if (
      next.messages > scope.budget.maxMessages ||
      next.commands > scope.budget.maxCommands ||
      next.actions > scope.budget.maxActions
    ) {
      throw realDataError(
        "EXECUTION_BUDGET_EXHAUSTED",
        "Local authorized execution budget exhausted, including indeterminate sends."
      );
    }
    this.#messagesDispatched = next.messages;
    this.#commandsDispatched = next.commands;
    this.#actionsDispatched = next.actions;
  }
}

function safeOperationError(cause: unknown): LocalOperationError {
  if (cause instanceof AwError) {
    return { code: cause.code, message: cause.message, retryable: cause.retryable };
  }
  return {
    code: "LOCAL_OPERATION_FAILED",
    message: "The local target operation failed unexpectedly.",
    retryable: false
  };
}

function cancellationReason(): { code: string; message: string; retryable: false } {
  return {
    code: "LOCAL_RUN_CANCELLED",
    message: "The local assessment was cancelled; cleanup was drained before exit.",
    retryable: false
  };
}
