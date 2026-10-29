import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudClient, FailureDisposition, SafeRelayFailure } from "../../src/cloud/client.js";
import type {
  CommandAck,
  CreateRunResponse,
  RelayCommand,
  RelayResult,
  RunStatusResponse
} from "../../src/cloud/protocol.js";
import { AwError } from "../../src/errors.js";
import { RelayJournal } from "../../src/relay/journal.js";
import { RelayRunner } from "../../src/relay/runner.js";
import type { LiveExecutionPolicy } from "../../src/suite/live-policy.js";
import { LIMITS } from "../../src/util/limits.js";
import { packet, relayCommand, resultFor } from "./helpers.js";
import { authorizedDispatchPolicy } from "../../src/real-data/policy.js";
import { canaryRedactionPolicy, hostedScopeResponse, serverDefaultRedactionPolicy } from "../real-data/helpers.js";
import { CANARIES } from "../data-policy/helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-relay-runner-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sendRelayCommand(): Extract<RelayCommand, { kind: "send" }> {
  const command = relayCommand("send");
  if (command.kind !== "send") throw new Error("expected a send command");
  return command;
}

function binding(overrides: Partial<CreateRunResponse> = {}): CreateRunResponse {
  return {
    protocol_version: "aw-relay/0.1",
    create_request_id: `crq_${"a".repeat(24)}`,
    create_request_sha256: "c".repeat(64),
    create_disposition: "created",
    run_id: "run-1",
    session_id: "session-1",
    packet,
    config_sha256: "b".repeat(64),
    fencing_epoch: 2,
    status: "connected",
    dashboard_url: "https://augmentworks.ai/dashboard/runs/run-1",
    run_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    credit_state: "reserved",
    ...overrides
  };
}

class MockCloud {
  readonly commands: RelayCommand[];
  readonly completions: Array<{ command: RelayCommand; result: RelayResult }> = [];
  readonly failures: Array<{
    command: RelayCommand;
    error: SafeRelayFailure;
    disposition: FailureDisposition;
  }> = [];
  cancelled = false;

  constructor(commands: RelayCommand[]) {
    this.commands = commands;
  }

  async pollOperation(options: { afterSequence: number }) {
    const command = this.commands.find((item) => item.sequence === options.afterSequence + 1) ?? null;
    return {
      protocol_version: "aw-relay/0.1" as const,
      run_id: "run-1",
      session_id: "session-1",
      status: command === null ? (this.cancelled ? "cancelled" : "completed") : this.cancelled ? "cancel_requested" : "running",
      command
    };
  }

  async completeOperation(command: RelayCommand, result: RelayResult): Promise<CommandAck> {
    this.completions.push({ command, result });
    return { protocol_version: "aw-relay/0.1", command_id: command.command_id, accepted: true };
  }

  async failOperation(
    command: RelayCommand,
    error: SafeRelayFailure,
    disposition: FailureDisposition
  ): Promise<CommandAck> {
    this.failures.push({ command, error, disposition });
    return { protocol_version: "aw-relay/0.1", command_id: command.command_id, accepted: true };
  }

  async getRunStatus(): Promise<RunStatusResponse> {
    return {
      protocol_version: "aw-relay/0.1",
      run_id: "run-1",
      status: this.cancelled ? "cancelled" : "completed",
      outcome: this.cancelled ? null : "passed",
      credit_state: "consumed"
    };
  }

  async cancelRun(): Promise<RunStatusResponse> {
    this.cancelled = true;
    return {
      protocol_version: "aw-relay/0.1",
      run_id: "run-1",
      status: "cancel_requested",
      credit_state: "consumed"
    };
  }
}

function asCloud(mock: MockCloud): CloudClient {
  return mock as unknown as CloudClient;
}

describe("RelayRunner", () => {
  it("runs one operation at a time and durably acknowledges normalized results", async () => {
    const commands = [
      relayCommand("prepare"),
      relayCommand("send", { command_id: "command-send-2", sequence: 2 }),
      relayCommand("cleanup", { command_id: "command-cleanup-3", sequence: 3 })
    ];
    const cloud = new MockCloud(commands);
    let active = 0;
    let maximumActive = 0;
    const connector = {
      isIdempotent: (kind: RelayCommand["kind"]) => kind !== "send",
      execute: vi.fn(async (kind: RelayCommand["kind"], input: unknown) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const command = commands.find((candidate) => candidate.kind === kind && candidate.input === input);
        if (command === undefined) throw new Error("unexpected command");
        await Promise.resolve();
        active -= 1;
        return resultFor(command);
      })
    };
    const runner = new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0
    });
    const result = await runner.run();
    expect(result).toMatchObject({ status: "completed", outcome: "passed" });
    expect(maximumActive).toBe(1);
    expect(connector.execute).toHaveBeenCalledTimes(3);
    expect(cloud.completions.map((item) => item.command.command_id)).toEqual([
      "command-prepare-1",
      "command-send-2",
      "command-cleanup-3"
    ]);
  });

  it("marks a crashed non-idempotent send indeterminate instead of replaying it", async () => {
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("send");
    const journal = await new RelayJournal({ runId: command.run_id, stateDirectory }).open();
    await journal.accept(command);
    await journal.markStarted(command.command_id);
    await journal.close();
    const cloud = new MockCloud([command]);
    const connector = {
      isIdempotent: () => false,
      execute: vi.fn(async () => resultFor(command))
    };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      pollWaitMs: 0
    }).run();
    expect(connector.execute).not.toHaveBeenCalled();
    expect(cloud.failures).toHaveLength(1);
    expect(cloud.failures[0]).toMatchObject({
      disposition: "outcome_indeterminate",
      error: { code: "OUTCOME_INDETERMINATE" }
    });
  });

  it("safely reexecutes a crashed operation explicitly declared idempotent", async () => {
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("prepare");
    const journal = await new RelayJournal({ runId: command.run_id, stateDirectory }).open();
    await journal.accept(command);
    await journal.markStarted(command.command_id);
    await journal.close();
    const cleanup = relayCommand("cleanup", {
      command_id: "command-cleanup-2",
      sequence: 2
    });
    const cloud = new MockCloud([command, cleanup]);
    const connector = {
      isIdempotent: () => true,
      execute: vi.fn(async (kind: RelayCommand["kind"]) =>
        resultFor(kind === "cleanup" ? cleanup : command)
      )
    };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      pollWaitMs: 0
    }).run();
    expect(connector.execute).toHaveBeenCalledTimes(2);
    expect(cloud.completions).toHaveLength(2);
    expect(cloud.failures).toHaveLength(0);
  });

  it("re-sends a cached completion after expiry when its cloud acknowledgement was lost", async () => {
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("send");
    const journal = await new RelayJournal({ runId: command.run_id, stateDirectory }).open();
    await journal.accept(command);
    await journal.markStarted(command.command_id);
    await journal.recordSuccess(command.command_id, resultFor(command));
    await journal.close();
    const cloud = new MockCloud([command]);
    const connector = { execute: vi.fn(async () => resultFor(command)), isIdempotent: () => false };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      now: () => new Date(Date.parse(command.expires_at) + 1_000),
      pollWaitMs: 0
    }).run();
    expect(connector.execute).not.toHaveBeenCalled();
    expect(cloud.completions).toHaveLength(1);
  });

  it("aborts an active non-idempotent send on cancellation, reports indeterminate, then drains cleanup", async () => {
    const send = relayCommand("send");
    const cleanup = relayCommand("cleanup", {
      command_id: "command-cleanup-2",
      sequence: 2
    });
    const cloud = new MockCloud([send, cleanup]);
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const connector = {
      isIdempotent: (kind: RelayCommand["kind"]) => kind === "cleanup",
      execute: vi.fn(async (kind: RelayCommand["kind"], _input: unknown, context: { signal?: AbortSignal }) => {
        if (kind === "cleanup") return resultFor(cleanup);
        notifyStarted();
        await new Promise<void>((_resolve, reject) => {
          context.signal?.addEventListener(
            "abort",
            () =>
              reject(
                new AwError({
                  code: "TARGET_OUTCOME_INDETERMINATE",
                  category: "target",
                  message: "The send may have completed.",
                  operation: "send"
                })
              ),
            { once: true }
          );
        });
        throw new Error("unreachable");
      })
    };
    const runner = new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0
    });
    const running = runner.run();
    await started;
    await runner.requestCancellation();
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(cloud.failures[0]).toMatchObject({ disposition: "outcome_indeterminate" });
    expect(cloud.completions.at(-1)?.command.kind).toBe("cleanup");
    expect(connector.execute.mock.calls.map((call) => call[0])).toEqual(["send", "cleanup"]);
  });

  it("never aborts an active cleanup when graceful cancellation is requested", async () => {
    const prepare = relayCommand("prepare");
    const cleanup = relayCommand("cleanup", {
      command_id: "command-cleanup-2",
      sequence: 2
    });
    const cloud = new MockCloud([prepare, cleanup]);
    let notifyCleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      notifyCleanupStarted = resolve;
    });
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupSignal: AbortSignal | undefined;
    const connector = {
      isIdempotent: () => true,
      execute: vi.fn(
        async (
          kind: RelayCommand["kind"],
          _input: unknown,
          context: { signal?: AbortSignal }
        ) => {
          if (kind === "prepare") return resultFor(prepare);
          cleanupSignal = context.signal;
          notifyCleanupStarted();
          await cleanupReleased;
          return resultFor(cleanup);
        }
      )
    };
    const runner = new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0
    });
    const running = runner.run();
    await cleanupStarted;
    await runner.requestCancellation();
    expect(cleanupSignal?.aborted).toBe(false);
    releaseCleanup();
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    expect(cloud.completions.at(-1)?.command.kind).toBe("cleanup");
  });

  it("reports a returned non-idempotent send with invalid correlation as indeterminate", async () => {
    const send = relayCommand("send");
    const cloud = new MockCloud([send]);
    const connector = {
      isIdempotent: () => false,
      execute: vi.fn(async () => ({ ...resultFor(send), turn_id: "wrong-turn" }))
    };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0
    }).run();
    expect(cloud.failures).toHaveLength(1);
    expect(cloud.failures[0]).toMatchObject({
      disposition: "outcome_indeterminate",
      error: { code: "TARGET_CORRELATION_ERROR" }
    });
  });

  it("durably finalizes an expired crashed non-idempotent send as indeterminate", async () => {
    const now = Date.now();
    const send = relayCommand("send", {
      issued_at: new Date(now - 120_000).toISOString(),
      expires_at: new Date(now - 60_000).toISOString()
    });
    const stateDirectory = await temporaryDirectory();
    const journal = await new RelayJournal({ runId: send.run_id, stateDirectory }).open();
    await journal.accept(send);
    await journal.markStarted(send.command_id);
    await journal.close();
    const cloud = new MockCloud([send]);
    const connector = {
      isIdempotent: () => false,
      execute: vi.fn(async () => resultFor(send))
    };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      pollWaitMs: 0
    }).run();
    expect(connector.execute).not.toHaveBeenCalled();
    expect(cloud.failures[0]).toMatchObject({
      disposition: "outcome_indeterminate",
      error: { code: "OUTCOME_INDETERMINATE" }
    });
  });

  it("does not reexecute an expired idempotent prepare and still requires cleanup", async () => {
    const now = Date.now();
    const prepare = relayCommand("prepare", {
      issued_at: new Date(now - 120_000).toISOString(),
      expires_at: new Date(now - 60_000).toISOString()
    });
    const cleanup = relayCommand("cleanup", {
      command_id: "command-cleanup-2",
      sequence: 2
    });
    const stateDirectory = await temporaryDirectory();
    const journal = await new RelayJournal({ runId: prepare.run_id, stateDirectory }).open();
    await journal.accept(prepare);
    await journal.markStarted(prepare.command_id);
    await journal.close();
    const cloud = new MockCloud([prepare, cleanup]);
    const connector = {
      isIdempotent: () => true,
      execute: vi.fn(async (kind: RelayCommand["kind"]) => {
        if (kind !== "cleanup") throw new Error("expired prepare was reexecuted");
        return resultFor(cleanup);
      })
    };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      pollWaitMs: 0
    }).run();
    expect(connector.execute).toHaveBeenCalledOnce();
    expect(cloud.failures[0]).toMatchObject({
      disposition: "failed",
      error: { code: "COMMAND_EXPIRED_AFTER_START" }
    });
    expect(cloud.completions.at(-1)?.command.kind).toBe("cleanup");
  });

  it("retries an explicitly idempotent cleanup at most three times with identical inputs", async () => {
    const prepare = relayCommand("prepare");
    const cleanup = relayCommand("cleanup", {
      command_id: "command-cleanup-2",
      sequence: 2
    });
    const cloud = new MockCloud([prepare, cleanup]);
    let cleanupAttempts = 0;
    const connector = {
      isIdempotent: () => true,
      execute: vi.fn(
        async (kind: RelayCommand["kind"], _input: unknown, _context: unknown) => {
          if (kind === "prepare") return resultFor(prepare);
          cleanupAttempts += 1;
          if (cleanupAttempts < 3) {
            throw new AwError({
              code: "TARGET_TEMPORARY_FAILURE",
              category: "target",
              message: "Cleanup is temporarily unavailable.",
              retryable: true,
              operation: "cleanup"
            });
          }
          return resultFor(cleanup);
        }
      )
    };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0
    }).run();
    const cleanupCalls = connector.execute.mock.calls.filter((call) => call[0] === "cleanup");
    expect(cleanupCalls).toHaveLength(3);
    expect(new Set(cleanupCalls.map((call) => call[1])).size).toBe(1);
    expect(new Set(cleanupCalls.map((call) => call[2])).size).toBe(1);
    expect(cloud.failures).toHaveLength(0);
  });

  it("refuses a terminal run while a prepared fixture remains outstanding", async () => {
    const prepare = relayCommand("prepare");
    const cloud = new MockCloud([prepare]);
    const connector = {
      isIdempotent: () => true,
      execute: vi.fn(async () => resultFor(prepare))
    };
    await expect(
      new RelayRunner({
        cloud: asCloud(cloud),
        connector,
        binding: binding(),
        stateDirectory: await temporaryDirectory(),
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "CLEANUP_INCOMPLETE", category: "cleanup" });
  });

  it("enforces the immutable server run expiry before polling", async () => {
    const now = Date.now();
    const cloud = new MockCloud([]);
    const connector = { execute: vi.fn() };
    await expect(
      new RelayRunner({
        cloud: asCloud(cloud),
        connector,
        binding: binding({ run_expires_at: new Date(now - 1).toISOString() }),
        stateDirectory: await temporaryDirectory(),
        now: () => new Date(now),
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "RUN_EXPIRED" });
    expect(connector.execute).not.toHaveBeenCalled();
  });

  it("does not reset the durable local runtime deadline after restart", async () => {
    const startedAt = Date.now();
    const stateDirectory = await temporaryDirectory();
    const serverExpiresAt = new Date(startedAt + 2 * LIMITS.maxRunMs).toISOString();
    const journal = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    await journal.bindRunDeadline(
      serverExpiresAt,
      new Date(startedAt + LIMITS.maxRunMs).toISOString()
    );
    await journal.close();

    const cloud = new MockCloud([]);
    const connector = { execute: vi.fn() };
    await expect(
      new RelayRunner({
        cloud: asCloud(cloud),
        connector,
        binding: binding({ run_expires_at: serverExpiresAt }),
        stateDirectory,
        now: () => new Date(startedAt + LIMITS.maxRunMs + 1),
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "RUN_TIME_LIMIT_EXCEEDED" });
    expect(connector.execute).not.toHaveBeenCalled();
  });

  it("rejects a stale fence before local execution", async () => {
    const bad = relayCommand("send", { fencing_epoch: 1 });
    const cloud = new MockCloud([bad]);
    const connector = { execute: vi.fn(async () => resultFor(bad)) };
    await expect(
      new RelayRunner({
        cloud: asCloud(cloud),
        connector,
        binding: binding(),
        stateDirectory: await temporaryDirectory(),
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "STALE_FENCE" });
    expect(connector.execute).not.toHaveBeenCalled();
  });

  it("adopts attempt_id as the conversation identifier and rejects a mismatched send", async () => {
    const matched = relayCommand("send");
    const contexts: Array<{ conversationId?: string; attemptId?: string }> = [];
    const matchedCloud = new MockCloud([matched]);
    const matchedConnector = {
      execute: vi.fn(async (_kind, _input, context: { conversationId?: string; attemptId?: string }) => {
        contexts.push(context);
        return resultFor(matched);
      })
    };
    await new RelayRunner({
      cloud: asCloud(matchedCloud),
      connector: matchedConnector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0
    }).run();
    expect(contexts[0]).toMatchObject({ conversationId: "attempt-1", attemptId: "attempt-1" });

    const mismatched = relayCommand("send", {
      input: {
        protocol_version: "aw-target/0.1",
        turn_id: "turn-1",
        idempotency_key: "idempotency-send-1",
        conversation_id: "other-attempt",
        message: { role: "user", content: "Refund the order" },
        metadata: {}
      }
    });
    const mismatchedCloud = new MockCloud([mismatched]);
    const mismatchedConnector = { execute: vi.fn(async () => resultFor(mismatched)) };
    await expect(
      new RelayRunner({
        cloud: asCloud(mismatchedCloud),
        connector: mismatchedConnector,
        binding: binding(),
        stateDirectory: await temporaryDirectory(),
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "CONVERSATION_IDENTITY_MISMATCH" });
    expect(mismatchedConnector.execute).not.toHaveBeenCalled();
  });

  it("replays a completed send without executing again, preserving the original attempt identity", async () => {
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("send", {
      input: {
        protocol_version: "aw-target/0.1",
        turn_id: "turn-1",
        idempotency_key: "idempotency-send-1",
        conversation_id: "attempt-1",
        message: { role: "user", content: "Refund the order" },
        metadata: {}
      }
    });
    const journal = await new RelayJournal({ runId: command.run_id, stateDirectory }).open();
    await journal.accept(command);
    await journal.markStarted(command.command_id);
    await journal.recordSuccess(command.command_id, resultFor(command));
    await journal.close();
    const cloud = new MockCloud([command]);
    const connector = { execute: vi.fn(async () => resultFor(command)), isIdempotent: () => true };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      pollWaitMs: 0
    }).run();
    expect(connector.execute).not.toHaveBeenCalled();
    expect(cloud.completions).toHaveLength(1);
    expect(cloud.completions[0]?.command.attempt_id).toBe("attempt-1");
    expect(cloud.completions[0]?.command.kind === "send" && cloud.completions[0].command.input.conversation_id).toBe(
      "attempt-1"
    );
  });

  it("records a timed-out live send as indeterminate and will not replay it even if the connector claims send is idempotent", async () => {
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("send");
    const journal = await new RelayJournal({ runId: command.run_id, stateDirectory }).open();
    await journal.accept(command);
    await journal.markStarted(command.command_id);
    await journal.close();
    const cloud = new MockCloud([command]);
    const connector = {
      isIdempotent: () => true,
      execute: vi.fn(async () => resultFor(command))
    };
    const livePolicy: LiveExecutionPolicy = {
      origin: "https://support.example.com",
      authorizationKind: "owned_target",
      authorizationRef: "fixture-pilot-approval",
      expiresAt: "2099-12-31T23:59:59Z",
      maxMessages: 3,
      allowedMessages: ["Refund the order"],
      allowedCaseIds: ["live.hours"]
    };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      livePolicy,
      pollWaitMs: 0
    }).run();
    expect(connector.execute).not.toHaveBeenCalled();
    expect(cloud.failures).toMatchObject([
      { disposition: "outcome_indeterminate", error: { code: "OUTCOME_INDETERMINATE" } }
    ]);
  });

  it("refuses a second live send after the dispatched-message cap, including the indeterminate send", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = relayCommand("send");
    const second = relayCommand("send", {
      command_id: "command-send-2",
      sequence: 2,
      idempotency_key: "idempotency-send-2"
    });
    const journal = await new RelayJournal({ runId: first.run_id, stateDirectory }).open();
    await journal.accept(first);
    await journal.markStarted(first.command_id);
    await journal.recordFailure(
      first.command_id,
      { code: "OUTCOME_INDETERMINATE", safe_message: "timeout after dispatch", retryable: false },
      "outcome_indeterminate"
    );
    await journal.acknowledge(first.command_id);
    await journal.close();
    const cloud = new MockCloud([second]);
    const connector = { execute: vi.fn(async () => resultFor(second)), isIdempotent: () => true };
    const livePolicy: LiveExecutionPolicy = {
      origin: "https://support.example.com",
      authorizationKind: "owned_target",
      authorizationRef: "fixture-pilot-approval",
      expiresAt: "2099-12-31T23:59:59Z",
      maxMessages: 1,
      allowedMessages: ["Refund the order"],
      allowedCaseIds: ["live.hours"]
    };
    await expect(
      new RelayRunner({
        cloud: asCloud(cloud),
        connector,
        binding: binding(),
        stateDirectory,
        livePolicy,
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "LIVE_TARGET_MESSAGE_LIMIT" });
    expect(connector.execute).not.toHaveBeenCalled();
  });
});

function relayUnavailable(retryAfterMs: number): AwError {
  return new AwError({
    code: "RELAY_UNAVAILABLE",
    category: "relay",
    message: "The relay is temporarily unavailable.",
    retryable: true,
    details: { http_status: 503, retry_after_ms: retryAfterMs }
  });
}

describe("AUG-412 poll retry and server-proven skips", () => {
  it("retries a poll 503 after Retry-After and still delivers sequence 2", async () => {
    const commands = [
      relayCommand("send"),
      relayCommand("send", { command_id: "command-send-2", sequence: 2 })
    ];
    const cloud = new MockCloud(commands);
    const polls: number[] = [];
    let failed = false;
    const poll = cloud.pollOperation.bind(cloud);
    cloud.pollOperation = async (options: { afterSequence: number }) => {
      polls.push(options.afterSequence);
      if (options.afterSequence === 1 && !failed) {
        failed = true;
        throw relayUnavailable(40);
      }
      return await poll(options);
    };
    // Both sends share turn-1, so one canned result correlates with either.
    const connector = { execute: vi.fn(async () => resultFor(commands[0]!)) };
    const started = Date.now();
    const run = await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0,
      pollRetryBaseMs: 1
    }).run();
    expect(run.status).toBe("completed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(polls.slice(0, 3)).toEqual([0, 1, 1]);
    expect(cloud.completions.map((item) => item.command.sequence)).toEqual([1, 2]);
  });

  it("keeps the process alive through the retry pause after a poll 503", async () => {
    // In a real CLI the pause is the only pending work, so an unref'd timer let
    // Node exit 13 ("unsettled top-level await") with no run_id.
    const fixture = fileURLToPath(new URL("./fixtures/poll-retry-process.ts", import.meta.url));
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const child = spawnSync(
      process.execPath,
      ["--disable-warning=DEP0205", "--import", tsx, fixture, await temporaryDirectory()],
      { encoding: "utf8", timeout: 30_000 }
    );
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ status: "completed", polls: 2 });
  });

  it("stops retrying at the run deadline and names the run in the error JSON", async () => {
    const cloud = new MockCloud([]);
    cloud.pollOperation = async () => {
      throw relayUnavailable(60_000);
    };
    const error = await new RelayRunner({
      cloud: asCloud(cloud),
      connector: { execute: vi.fn() },
      binding: binding({ run_expires_at: new Date(Date.now() + 30_000).toISOString() }),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0,
      pollRetryBaseMs: 1
    })
      .run()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AwError);
    expect((error as AwError).toSafeJSON()).toMatchObject({
      code: "RELAY_UNAVAILABLE",
      run_id: "run-1"
    });
  });

  it("accepts a skipped sequence the server proves closed", async () => {
    const commands = [
      relayCommand("send"),
      relayCommand("send", { command_id: "command-send-3", sequence: 3 })
    ];
    const cloud = new MockCloud(commands);
    const polls: number[] = [];
    cloud.pollOperation = async (options: { afterSequence: number }) => {
      polls.push(options.afterSequence);
      const command = options.afterSequence === 0 ? commands[0]! : options.afterSequence === 1 ? commands[1]! : null;
      return {
        protocol_version: "aw-relay/0.1" as const,
        run_id: "run-1",
        session_id: "session-1",
        status: command === null ? "completed" : "running",
        command,
        skipped_sequences: options.afterSequence === 1 ? [2] : []
      };
    };
    const connector = { execute: vi.fn(async () => resultFor(commands[0]!)) };
    const run = await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0
    }).run();
    expect(run.status).toBe("completed");
    expect(polls).toEqual([0, 1, 3]);
    expect(cloud.completions.map((item) => item.command.sequence)).toEqual([1, 3]);
  });

  it("still fails a sequence gap without server proof, with the run ID", async () => {
    const commands = [
      relayCommand("send"),
      relayCommand("send", { command_id: "command-send-3", sequence: 3 })
    ];
    const cloud = new MockCloud(commands);
    cloud.pollOperation = async (options: { afterSequence: number }) => ({
      protocol_version: "aw-relay/0.1" as const,
      run_id: "run-1",
      session_id: "session-1",
      status: "running",
      command: options.afterSequence === 0 ? commands[0]! : commands[1]!
    });
    const connector = { execute: vi.fn(async () => resultFor(commands[0]!)) };
    const error = await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      pollWaitMs: 0
    })
      .run()
      .catch((caught: unknown) => caught);
    expect((error as AwError).toSafeJSON()).toMatchObject({
      code: "COMMAND_SEQUENCE_GAP",
      run_id: "run-1",
      details: { expected_sequence: 2, actual_sequence: 3 }
    });
    expect(connector.execute).toHaveBeenCalledTimes(1);
  });
});

describe("AUG-404 lost acknowledgements", () => {
  it("re-sends a journaled completion when the server has already moved to the next command", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = relayCommand("send");
    const second = relayCommand("send", { command_id: "command-send-2", sequence: 2 });
    const journal = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    await journal.accept(first);
    await journal.markStarted(first.command_id);
    await journal.recordSuccess(first.command_id, resultFor(first));
    await journal.close();
    // The server took the first upload, so it now delivers sequence 2 after cursor 0.
    const cloud = new MockCloud([second]);
    cloud.pollOperation = async (options: { afterSequence: number }) => ({
      protocol_version: "aw-relay/0.1" as const,
      run_id: "run-1",
      session_id: "session-1",
      status: options.afterSequence < 2 ? "running" : "completed",
      command: options.afterSequence < 2 ? second : null
    });
    const connector = { execute: vi.fn(async () => resultFor(second)), isIdempotent: () => false };
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      pollWaitMs: 0
    }).run();
    expect(connector.execute).toHaveBeenCalledTimes(1);
    expect(cloud.completions.map((item) => item.command.command_id)).toEqual([
      first.command_id,
      second.command_id
    ]);
    expect(cloud.completions[0]?.result).toEqual(resultFor(first));
  });
});

describe("authorized dispatch policy", () => {
  it("does not replay a timed-out authorized send even when the connector claims send is idempotent", async () => {
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("send");
    const journal = await new RelayJournal({ runId: command.run_id, stateDirectory }).open();
    await journal.accept(command);
    await journal.markStarted(command.command_id);
    await journal.close();
    const cloud = new MockCloud([command]);
    const connector = {
      isIdempotent: () => true,
      execute: vi.fn(async () => resultFor(command))
    };
    const response = hostedScopeResponse();
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory,
      dispatchPolicy: authorizedDispatchPolicy({
        scope: response.scope,
        boundary: response.targetBoundary,
        dataPolicy: response.dataPolicy,
        redactionProfile: response.redactionProfile
      }),
      pollWaitMs: 0
    }).run();
    expect(connector.execute).not.toHaveBeenCalled();
    expect(cloud.failures).toMatchObject([
      { disposition: "outcome_indeterminate", error: { code: "OUTCOME_INDETERMINATE" } }
    ]);
  });

  it("rejects cleanup unless the admitted boundary allows it", async () => {
    const cleanup = relayCommand("cleanup");
    const cloud = new MockCloud([cleanup]);
    const connector = { execute: vi.fn(async () => resultFor(cleanup)), isIdempotent: () => true };
    const response = hostedScopeResponse();
    await expect(
      new RelayRunner({
        cloud: asCloud(cloud),
        connector,
        binding: binding(),
        stateDirectory: await temporaryDirectory(),
        dispatchPolicy: authorizedDispatchPolicy({
          scope: response.scope,
          boundary: response.targetBoundary
        }),
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
    expect(connector.execute).not.toHaveBeenCalled();
  });

  it("counts an indeterminate send against the finite authorized budget", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = relayCommand("send");
    const second = relayCommand("send", {
      command_id: "command-send-2",
      sequence: 2,
      idempotency_key: "idempotency-send-2"
    });
    const journal = await new RelayJournal({ runId: first.run_id, stateDirectory }).open();
    await journal.accept(first);
    await journal.markStarted(first.command_id);
    await journal.recordFailure(
      first.command_id,
      { code: "OUTCOME_INDETERMINATE", safe_message: "timeout after dispatch", retryable: false },
      "outcome_indeterminate"
    );
    await journal.acknowledge(first.command_id);
    await journal.close();
    const cloud = new MockCloud([second]);
    const connector = { execute: vi.fn(async () => resultFor(second)), isIdempotent: () => true };
    const response = hostedScopeResponse();
    const tight = {
      ...response.scope,
      budget: { ...response.scope.budget, maxMessages: 1, maxCommands: 1 }
    };
    await expect(
      new RelayRunner({
        cloud: asCloud(cloud),
        connector,
        binding: binding(),
        stateDirectory,
        dispatchPolicy: authorizedDispatchPolicy({
          scope: tight,
          boundary: response.targetBoundary
        }),
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "EXECUTION_BUDGET_EXHAUSTED" });
    expect(connector.execute).not.toHaveBeenCalled();
  });

  it("minimizes invented canaries with landed R06 before completeOperation", async () => {
    const command = sendRelayCommand();
    const cloud = new MockCloud([command]);
    const raw = {
      protocol_version: "aw-target/0.1" as const,
      turn_id: command.input.turn_id,
      message: {
        role: "assistant" as const,
        content: `Weekday hours are 9. Contact ${CANARIES.email} token=${CANARIES.token} api_key=${CANARIES.apiKey}`
      },
      events: [],
      finished: true,
      metadata: {}
    };
    const connector = { execute: vi.fn(async () => raw), isIdempotent: () => true };
    const response = hostedScopeResponse();
    const { policy, profile } = canaryRedactionPolicy({ dataClass: "business", contentHandling: "minimized" });
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      dispatchPolicy: authorizedDispatchPolicy({
        scope: response.scope,
        boundary: response.targetBoundary,
        dataPolicy: policy,
        redactionProfile: profile
      }),
      pollWaitMs: 0
    }).run();
    expect(cloud.completions).toHaveLength(1);
    const uploaded = JSON.stringify(cloud.completions[0]?.result);
    expect(uploaded).not.toContain(CANARIES.email);
    expect(uploaded).not.toContain(CANARIES.token);
    expect(uploaded).not.toContain(CANARIES.apiKey);
    expect(uploaded).toContain("Weekday hours are 9");
    expect(cloud.failures).toHaveLength(0);
  });

  it("keeps the reply under the server's default minimized profile (AUG-357)", async () => {
    const command = sendRelayCommand();
    const cloud = new MockCloud([command]);
    const raw = {
      protocol_version: "aw-target/0.1" as const,
      turn_id: command.input.turn_id,
      message: {
        role: "assistant" as const,
        content: `Weekday support hours are 9:00-17:00 UTC. api_key=${CANARIES.apiKey}`,
        finish_reason: "stop"
      },
      events: [
        {
          event_id: "event-1",
          type: "tool_call" as const,
          tool_name: "lookup_hours",
          call_id: "call-1",
          arguments: { region: "EU", token: CANARIES.token }
        }
      ],
      finished: true,
      metadata: { model: "stub" }
    };
    const connector = { execute: vi.fn(async () => raw), isIdempotent: () => false };
    const response = hostedScopeResponse();
    const { policy, profile } = serverDefaultRedactionPolicy();
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      dispatchPolicy: authorizedDispatchPolicy({
        scope: response.scope,
        boundary: response.targetBoundary,
        dataPolicy: policy,
        redactionProfile: profile
      }),
      pollWaitMs: 0
    }).run();
    expect(cloud.failures).toHaveLength(0);
    expect(cloud.completions).toHaveLength(1);
    const uploaded = cloud.completions[0]?.result as Record<string, unknown>;
    expect(uploaded).toMatchObject({
      protocol_version: "aw-target/0.1",
      turn_id: command.input.turn_id,
      finished: true,
      metadata: { model: "stub" },
      message: { role: "assistant", finish_reason: "stop" },
      events: [{ type: "tool_call", tool_name: "lookup_hours", arguments: { region: "EU" } }]
    });
    expect(JSON.stringify(uploaded)).toContain("Weekday support hours are 9:00-17:00 UTC.");
    expect(JSON.stringify(uploaded)).not.toContain(CANARIES.apiKey);
    expect(JSON.stringify(uploaded)).not.toContain(CANARIES.token);
  });

  async function uploadUnderServerDefaultProfile(
    contentHandling: "minimized" | "verbatim",
    content: string
  ): Promise<string> {
    const command = sendRelayCommand();
    const cloud = new MockCloud([command]);
    const raw = {
      protocol_version: "aw-target/0.1" as const,
      turn_id: command.input.turn_id,
      message: { role: "assistant" as const, content },
      events: [],
      finished: true,
      metadata: {}
    };
    const connector = { execute: vi.fn(async () => raw), isIdempotent: () => true };
    const response = hostedScopeResponse();
    const { policy, profile } = serverDefaultRedactionPolicy({ dataClass: "personal", contentHandling });
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      dispatchPolicy: authorizedDispatchPolicy({
        scope: response.scope,
        boundary: response.targetBoundary,
        dataPolicy: policy,
        redactionProfile: profile
      }),
      pollWaitMs: 0
    }).run();
    expect(cloud.failures).toHaveLength(0);
    expect(cloud.completions).toHaveLength(1);
    return JSON.stringify(cloud.completions[0]?.result);
  }

  it("keeps email and phone in a verbatim reply and still masks credentials (AUG-417)", async () => {
    const phone = "+1 555 0197 4242";
    const uploaded = await uploadUnderServerDefaultProfile(
      "verbatim",
      `Write to ${CANARIES.email} or call ${phone}. api_key=${CANARIES.apiKey}`
    );
    expect(uploaded).toContain(CANARIES.email);
    expect(uploaded).toContain(phone);
    expect(uploaded).not.toContain("[REDACTED:email]");
    expect(uploaded).not.toContain("[REDACTED:phone]");
    expect(uploaded).not.toContain(CANARIES.apiKey);
    expect(uploaded).toContain("[REDACTED:credential]");
  });

  it("still masks email and phone in a minimized reply (AUG-400, AUG-417)", async () => {
    const phone = "+1 555 0197 4242";
    const uploaded = await uploadUnderServerDefaultProfile(
      "minimized",
      `Write to ${CANARIES.email} or call ${phone}. api_key=${CANARIES.apiKey}`
    );
    expect(uploaded).not.toContain(CANARIES.email);
    expect(uploaded).not.toContain(phone);
    expect(uploaded).not.toContain(CANARIES.apiKey);
    expect(uploaded).toContain("[REDACTED:email]");
    expect(uploaded).toContain("[REDACTED:phone]");
    expect(uploaded).toContain("[REDACTED:credential]");
  });

  it("excludes credentials in verbatim mode without dropping declared business text", async () => {
    const command = sendRelayCommand();
    const cloud = new MockCloud([command]);
    const raw = {
      protocol_version: "aw-target/0.1" as const,
      turn_id: command.input.turn_id,
      message: {
        role: "assistant" as const,
        content: `Hours remain weekday. Reach ${CANARIES.email} api_key=${CANARIES.apiKey}`
      },
      events: [],
      finished: true,
      metadata: {}
    };
    const connector = { execute: vi.fn(async () => raw), isIdempotent: () => true };
    const response = hostedScopeResponse();
    const { policy, profile } = canaryRedactionPolicy({ dataClass: "public", contentHandling: "verbatim" });
    await new RelayRunner({
      cloud: asCloud(cloud),
      connector,
      binding: binding(),
      stateDirectory: await temporaryDirectory(),
      dispatchPolicy: authorizedDispatchPolicy({
        scope: response.scope,
        boundary: response.targetBoundary,
        dataPolicy: policy,
        redactionProfile: profile
      }),
      pollWaitMs: 0
    }).run();
    const uploaded = JSON.stringify(cloud.completions[0]?.result);
    expect(uploaded).not.toContain(CANARIES.apiKey);
    expect(uploaded).toContain("Hours remain weekday");
  });

  it("rejects missing authorized-policy metadata instead of uploading raw content", async () => {
    const command = sendRelayCommand();
    const cloud = new MockCloud([command]);
    const raw = {
      protocol_version: "aw-target/0.1" as const,
      turn_id: command.input.turn_id,
      message: { role: "assistant" as const, content: `leak ${CANARIES.email}` },
      events: [],
      finished: true,
      metadata: {}
    };
    const connector = { execute: vi.fn(async () => raw), isIdempotent: () => true };
    const response = hostedScopeResponse();
    await expect(
      new RelayRunner({
        cloud: asCloud(cloud),
        connector,
        binding: binding(),
        stateDirectory: await temporaryDirectory(),
        dispatchPolicy: authorizedDispatchPolicy({
          scope: response.scope,
          boundary: response.targetBoundary
        }),
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "UNSUPPORTED_DATA_POLICY" });
    expect(connector.execute).not.toHaveBeenCalled();
    expect(cloud.completions).toHaveLength(0);
    expect(JSON.stringify(cloud.failures)).not.toContain(CANARIES.email);
  });

  it("rejects a missing redaction profile instead of uploading raw content", async () => {
    const command = sendRelayCommand();
    const cloud = new MockCloud([command]);
    const raw = {
      protocol_version: "aw-target/0.1" as const,
      turn_id: command.input.turn_id,
      message: { role: "assistant" as const, content: `leak ${CANARIES.email}` },
      events: [],
      finished: true,
      metadata: {}
    };
    const connector = { execute: vi.fn(async () => raw), isIdempotent: () => true };
    const response = hostedScopeResponse();
    await expect(
      new RelayRunner({
        cloud: asCloud(cloud),
        connector,
        binding: binding(),
        stateDirectory: await temporaryDirectory(),
        dispatchPolicy: authorizedDispatchPolicy({
          scope: response.scope,
          boundary: response.targetBoundary,
          dataPolicy: response.dataPolicy
        }),
        pollWaitMs: 0
      }).run()
    ).rejects.toMatchObject({ code: "REDACTION_PROFILE_MISMATCH" });
    expect(connector.execute).not.toHaveBeenCalled();
    expect(cloud.completions).toHaveLength(0);
    expect(JSON.stringify(cloud.failures)).not.toContain(CANARIES.email);
  });

  it("rejects a stale data-policy hash instead of returning raw content", () => {
    const response = hostedScopeResponse();
    const { policy, profile } = canaryRedactionPolicy();
    const stale = { ...policy, policyHash: "f".repeat(64) };
    expect(() =>
      new RelayRunner({
        cloud: asCloud(new MockCloud([])),
        connector: { execute: vi.fn() },
        binding: binding(),
        dispatchPolicy: authorizedDispatchPolicy({
          scope: response.scope,
          boundary: response.targetBoundary,
          dataPolicy: stale,
          redactionProfile: profile
        })
      })
    ).toThrow(
      expect.objectContaining({ code: "DATA_POLICY_STALE" })
    );
  });
});
