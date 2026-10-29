import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RelayJournal } from "../../src/relay/journal.js";
import { relayCommand, resultFor } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-relay-journal-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("RelayJournal", () => {
  it("fsyncs a replayable accepted/started/completed/acknowledged state machine", async () => {
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("send");
    const first = await new RelayJournal({ runId: command.run_id, stateDirectory }).open();
    await first.accept(command);
    await first.markStarted(command.command_id);
    const completion = await first.recordSuccess(command.command_id, resultFor(command));
    await first.acknowledge(command.command_id);
    expect(completion.disposition).toBe("completed");
    expect(first.lastAcknowledgedSequence).toBe(1);
    const journalPath = first.path;
    await first.close();

    const second = await new RelayJournal({ runId: command.run_id, stateDirectory }).open();
    const replay = await second.accept(command);
    expect(replay).toMatchObject({ started: true, acknowledged: true });
    expect(replay.completion).toMatchObject({ disposition: "completed" });
    expect((await readFile(journalPath, "utf8")).trim().split("\n")).toHaveLength(4);
    if (process.platform !== "win32") {
      expect((await lstat(journalPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(journalPath))).mode & 0o777).toBe(0o700);
    }
    await second.close();
  });

  it("rejects hash conflicts, sequence gaps, and stale fencing epochs", async () => {
    const journal = await new RelayJournal({
      runId: "run-1",
      stateDirectory: await temporaryDirectory()
    }).open();
    const first = relayCommand("send");
    await journal.accept(first);
    await journal.markStarted(first.command_id);
    await journal.recordSuccess(first.command_id, resultFor(first));
    await journal.acknowledge(first.command_id);

    await expect(
      journal.accept({ ...first, expires_at: new Date(Date.now() + 120_000).toISOString() })
    ).rejects.toMatchObject({ code: "COMMAND_REPLAY_CONFLICT" });
    await expect(
      journal.accept(
        relayCommand("observe", {
          command_id: "command-observe-gap",
          sequence: 3,
          fencing_epoch: 2
        })
      )
    ).rejects.toMatchObject({ code: "COMMAND_SEQUENCE_GAP" });
    await expect(
      journal.accept(
        relayCommand("observe", {
          command_id: "command-observe-stale",
          sequence: 2,
          fencing_epoch: 1
        })
      )
    ).rejects.toMatchObject({ code: "STALE_FENCE" });
    await journal.close();
  });

  it("recovers an incomplete final append without replaying a durable side effect", async () => {
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("send");
    const journal = await new RelayJournal({ runId: command.run_id, stateDirectory }).open();
    await journal.accept(command);
    await journal.markStarted(command.command_id);
    const path = journal.path;
    await journal.close();
    await writeFile(path, `${await readFile(path, "utf8")}{\"partial\":`, "utf8");

    const recovered = await new RelayJournal({ runId: command.run_id, stateDirectory }).open();
    expect(recovered.state(command.command_id)).toMatchObject({ started: true, acknowledged: false });
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
    await recovered.close();
  });

  it("refuses a symlinked journal path", async () => {
    if (process.platform === "win32") return;
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("send");
    const probe = new RelayJournal({ runId: command.run_id, stateDirectory });
    await rm(probe.path, { force: true });
    await writeFile(join(stateDirectory, "target"), "not a journal\n");
    await rm(dirname(probe.path), { recursive: true, force: true });
    await mkdir(dirname(probe.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(probe.path), 0o700);
    await symlink(join(stateDirectory, "target"), probe.path);
    await expect(probe.open()).rejects.toMatchObject({ code: "UNSAFE_JOURNAL_PATH" });
  });

  it("rejects an existing broad state directory without changing its permissions", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryDirectory();
    const broad = join(root, "broad-state");
    await mkdir(broad, { mode: 0o777 });
    await chmod(broad, 0o777);
    const journal = new RelayJournal({ runId: "run-1", stateDirectory: broad });
    await expect(journal.open()).rejects.toMatchObject({ code: "UNSAFE_STATE_DIRECTORY" });
    expect((await lstat(broad)).mode & 0o777).toBe(0o777);
  });

  it("prevents two processes from owning the same run journal", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    const second = new RelayJournal({ runId: "run-1", stateDirectory });
    try {
      await expect(second.open()).rejects.toMatchObject({ code: "JOURNAL_LOCKED" });
      await first.close();
      await expect(second.open()).resolves.toBe(second);
    } finally {
      await first.close().catch(() => undefined);
      await second.close().catch(() => undefined);
    }
  });

  it("refuses a symlinked journal lock", async () => {
    if (process.platform === "win32") return;
    const stateDirectory = await temporaryDirectory();
    const probe = new RelayJournal({ runId: "run-1", stateDirectory });
    await mkdir(dirname(probe.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(probe.path), 0o700);
    const target = join(stateDirectory, "lock-target");
    await writeFile(target, "not a lock\n");
    await symlink(target, `${probe.path}.lock`);
    await expect(probe.open()).rejects.toMatchObject({ code: "UNSAFE_JOURNAL_LOCK" });
  });

  it("tracks prepare obligations until a successful cleanup is durable", async () => {
    const stateDirectory = await temporaryDirectory();
    const prepare = relayCommand("prepare");
    const cleanup = relayCommand("cleanup", {
      command_id: "command-cleanup-2",
      sequence: 2
    });
    const journal = await new RelayJournal({ runId: prepare.run_id, stateDirectory }).open();
    await journal.accept(prepare);
    await journal.markStarted(prepare.command_id);
    await journal.recordSuccess(prepare.command_id, resultFor(prepare));
    await journal.acknowledge(prepare.command_id);
    expect(journal.outstandingPreparedAttempts()).toEqual([prepare.attempt_id]);
    await journal.accept(cleanup);
    await journal.markStarted(cleanup.command_id);
    await journal.recordSuccess(cleanup.command_id, resultFor(cleanup));
    await journal.acknowledge(cleanup.command_id);
    expect(journal.outstandingPreparedAttempts()).toEqual([]);
    await journal.close();
  });

  it("keeps recovery journals but purges fully acknowledged clean terminals", async () => {
    const stateDirectory = await temporaryDirectory();
    const prepare = relayCommand("prepare");
    const cleanup = relayCommand("cleanup", {
      command_id: "command-cleanup-2",
      sequence: 2
    });
    const first = await new RelayJournal({ runId: prepare.run_id, stateDirectory }).open();
    await first.accept(prepare);
    await first.markStarted(prepare.command_id);
    await first.recordSuccess(prepare.command_id, resultFor(prepare));
    await first.acknowledge(prepare.command_id);
    const path = first.path;
    await first.close({ purge: true });
    await expect(lstat(path)).resolves.toBeDefined();

    const recovered = await new RelayJournal({ runId: prepare.run_id, stateDirectory }).open();
    await recovered.accept(cleanup);
    await recovered.markStarted(cleanup.command_id);
    await recovered.recordSuccess(cleanup.command_id, resultFor(cleanup));
    await recovered.acknowledge(cleanup.command_id);
    await recovered.close({ purge: true });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("counts started sends, including indeterminate outcomes, toward the live dispatch cap", async () => {
    const journal = await new RelayJournal({
      runId: "run-1",
      stateDirectory: await temporaryDirectory()
    }).open();
    const first = relayCommand("send");
    await journal.accept(first);
    expect(journal.dispatchedSendCount()).toBe(0);
    await journal.markStarted(first.command_id);
    expect(journal.dispatchedSendCount()).toBe(1);
    await journal.recordFailure(
      first.command_id,
      { code: "OUTCOME_INDETERMINATE", safe_message: "timeout after dispatch", retryable: false },
      "outcome_indeterminate"
    );
    expect(journal.dispatchedSendCount()).toBe(1);
    await journal.acknowledge(first.command_id);
    const second = relayCommand("observe", { command_id: "command-observe-2", sequence: 2 });
    await journal.accept(second);
    await journal.markStarted(second.command_id);
    expect(journal.dispatchedSendCount()).toBe(1);
    await journal.close();
  });

  it("writes transformed send content and never journals a blocked secret", async () => {
    const { makeContext, CANARIES } = await import("../data-policy/helpers.js");
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("send");
    const turnId = command.kind === "send" ? command.input.turn_id : "turn-1";
    const context = makeContext("public", "minimized", [
      { id: "mask-content", selector: "/content/content", action: "mask", detector: "email" }
    ]);
    const journal = await new RelayJournal({
      runId: command.run_id,
      stateDirectory,
      dataPolicy: context
    }).open();
    await journal.accept(command);
    await journal.markStarted(command.command_id);
    const completion = await journal.recordSuccess(command.command_id, {
      protocol_version: "aw-target/0.1",
      turn_id: turnId,
      message: {
        role: "assistant",
        content: `Done for ${CANARIES.email} ${CANARIES.secret}`
      },
      events: [],
      finished: true,
      metadata: {}
    });
    expect(completion.disposition).toBe("completed");
    if (completion.disposition === "completed") {
      expect(JSON.stringify(completion.result)).not.toContain(CANARIES.secret);
      expect(JSON.stringify(completion.result)).not.toContain(CANARIES.email);
    }
    const onDisk = await readFile(journal.path, "utf8");
    expect(onDisk).not.toContain(CANARIES.secret);
    expect(onDisk).not.toContain(CANARIES.email);
    await journal.close();
  });

  it("records an indeterminate sanitized failure when policy blocks after send", async () => {
    const { makeContext, CANARIES } = await import("../data-policy/helpers.js");
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("send");
    const turnId = command.kind === "send" ? command.input.turn_id : "turn-1";
    const context = makeContext("business", "minimized", [
      { id: "block-content", selector: "/content/content", action: "block", detector: "field" }
    ]);
    const journal = await new RelayJournal({
      runId: command.run_id,
      stateDirectory,
      dataPolicy: context
    }).open();
    await journal.accept(command);
    await journal.markStarted(command.command_id);
    const completion = await journal.recordSuccess(command.command_id, {
      protocol_version: "aw-target/0.1",
      turn_id: turnId,
      message: { role: "assistant", content: CANARIES.secret },
      events: [],
      finished: true,
      metadata: {}
    });
    expect(completion).toMatchObject({
      disposition: "outcome_indeterminate",
      error: { code: "DATA_POLICY_BLOCKED", retryable: false }
    });
    const onDisk = await readFile(journal.path, "utf8");
    expect(onDisk).not.toContain(CANARIES.secret);
    expect(onDisk).not.toContain('"disposition":"completed"');
    await journal.close();
  });

  it("AUG-412: accepts a sequence gap only with server proof and survives a reload", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = relayCommand("send");
    const third = relayCommand("send", { command_id: "command-send-3", sequence: 3 });
    const journal = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    await journal.accept(first);
    await journal.markStarted(first.command_id);
    await journal.recordSuccess(first.command_id, resultFor(first));
    await journal.acknowledge(first.command_id);

    // Without proof the gap still fails, and a non-contiguous skip proves nothing.
    await expect(journal.accept(third)).rejects.toMatchObject({ code: "COMMAND_SEQUENCE_GAP" });
    expect(await journal.recordServerSkips([3])).toEqual([]);
    await expect(journal.accept(third)).rejects.toMatchObject({ code: "COMMAND_SEQUENCE_GAP" });
    expect(journal.lastAcknowledgedSequence).toBe(1);

    // With proof for sequence 2 the poll cursor moves past it and 3 is accepted.
    expect(await journal.recordServerSkips([2])).toEqual([2]);
    expect(await journal.recordServerSkips([2])).toEqual([]);
    expect(journal.lastAcknowledgedSequence).toBe(2);
    await expect(
      journal.accept(relayCommand("send", { command_id: "command-send-2", sequence: 2 }))
    ).rejects.toMatchObject({ code: "COMMAND_SEQUENCE_CONFLICT" });
    await journal.accept(third);
    await journal.markStarted(third.command_id);
    await journal.recordSuccess(third.command_id, resultFor(third));
    await journal.acknowledge(third.command_id);
    expect(journal.lastAcknowledgedSequence).toBe(3);
    await journal.close();

    const reloaded = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    expect(reloaded.lastAcknowledgedSequence).toBe(3);
    expect(reloaded.skippedSequences()).toEqual([2]);
    expect(reloaded.pending()).toBeUndefined();
    await reloaded.close();
  });

  it("AUG-412: a server skip closes a locally pending command the server will never deliver", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = relayCommand("send");
    const journal = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    await journal.accept(first);
    await journal.markStarted(first.command_id);
    expect(journal.pending()).toBeDefined();
    expect(await journal.recordServerSkips([1, 2])).toEqual([1, 2]);
    expect(journal.pending()).toBeUndefined();
    expect(journal.lastAcknowledgedSequence).toBe(2);
    await expect(journal.accept(first)).rejects.toMatchObject({ code: "COMMAND_SEQUENCE_CONFLICT" });
    await journal.close();
    const reloaded = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    expect(reloaded.state(first.command_id)).toMatchObject({ skipped: true, acknowledged: false });
    expect(reloaded.lastAcknowledgedSequence).toBe(2);
    await reloaded.close();
  });

  it("AUG-404: records abandoned work on a terminal run and keeps it across a reload", async () => {
    const stateDirectory = await temporaryDirectory();
    const prepare = relayCommand("prepare");
    const send = relayCommand("send", { command_id: "command-send-2", sequence: 2 });
    const journal = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    await journal.accept(prepare);
    await journal.markStarted(prepare.command_id);
    await journal.recordSuccess(prepare.command_id, resultFor(prepare));
    await journal.acknowledge(prepare.command_id);
    await journal.accept(send);
    await journal.markStarted(send.command_id);
    await expect(journal.abandon(prepare.command_id, "run_terminal_uncompleted")).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT"
    });
    await journal.abandon(send.command_id, "run_terminal_uncompleted");
    expect(journal.pending()).toBeUndefined();
    expect(journal.outstandingPreparedAttempts()).toEqual(["attempt-1"]);
    expect(await journal.abandonOutstandingCleanup()).toEqual(["attempt-1"]);
    expect(journal.outstandingPreparedAttempts()).toEqual([]);
    await journal.close();

    const reloaded = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    expect(reloaded.pending()).toBeUndefined();
    expect(reloaded.outstandingPreparedAttempts()).toEqual([]);
    expect(reloaded.state(send.command_id)).toMatchObject({ abandoned: "run_terminal_uncompleted" });
    expect(reloaded.state(prepare.command_id)).toMatchObject({ abandoned: "run_terminal_cleanup" });
    expect(reloaded.lastAcknowledgedSequence).toBe(2);
    await reloaded.close();
  });

  it("still loads a journal written before skipped and abandoned records existed", async () => {
    const stateDirectory = await temporaryDirectory();
    const command = relayCommand("send");
    const journal = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    await journal.accept(command);
    await journal.markStarted(command.command_id);
    await journal.recordSuccess(command.command_id, resultFor(command));
    const path = journal.path;
    await journal.close();
    const events = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).toEqual(["accepted", "started", "completed"]);
    const reloaded = await new RelayJournal({ runId: "run-1", stateDirectory }).open();
    expect(reloaded.pending()?.completion).toMatchObject({ disposition: "completed" });
    expect(reloaded.lastAcknowledgedSequence).toBe(0);
    await reloaded.close();
  });
});
