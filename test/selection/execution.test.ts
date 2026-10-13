import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import type { RelayRunner } from "../../src/relay/runner.js";
import {
  createTestCommand,
  installSelectionExecutionInterruptHandler,
  runTest
} from "../../src/commands/test.js";
import { resolveConfig } from "../../src/config/resolve.js";
import type { AugmentWorksConfig } from "../../src/config/types.js";
import { AwError, EXIT } from "../../src/errors.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import { admitManifestWorkspace } from "../../src/selection/admit.js";
import {
  aggregateExecutionExitCode,
  artifactFromExecution,
  derivedRemainingCredits,
  executionDocumentPath,
  executionJsonFields,
  executionPaths,
  formatSelectionResumeCommand,
  initialExecution,
  interruptExecution,
  markShardAdmitted,
  markShardCompleted,
  markShardFailed,
  markShardQuoted,
  nextRunnableShard,
  openSelectionExecution,
  parseExecutionId,
  resumeExecution,
  saveSelectionExecution,
  skipRemainingPendingShards
} from "../../src/selection/execution.js";
import {
  SELECTION_EXECUTION_DOCUMENT_KIND,
  SELECTION_EXECUTION_DOCUMENT_KIND_V2,
  SelectionExecutionSchema,
  type SuiteSelectionManifest
} from "../../src/selection/schema.js";
import { CANONICAL_HASH, SUITE_ID, SUITE_REVISION, savedSuiteManifest } from "./saved-suite-fixtures.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-suite-selection-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { response: unknown }> };
const billingFixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-billing-v1.fixtures.json"), "utf8")
) as { fixtures: Record<string, { response: unknown }> };

const FIXTURE_WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const FIXTURE_CONNECTOR = "connector-1";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function stateDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-execution-"));
  temporaryDirectories.push(directory);
  if (process.platform !== "win32") await chmod(directory, 0o700);
  return directory;
}

function baseManifest(): SuiteSelectionManifest {
  return fixtures.fixtures["compile_executable"]?.response as SuiteSelectionManifest;
}

function twoShardManifest(manifestHash = `b${"c".repeat(63)}`): SuiteSelectionManifest {
  const compiled = baseManifest();
  const first = compiled.shards[0];
  if (first === undefined) throw new Error("missing shard");
  return {
    ...compiled,
    manifestHash,
    shards: [
      first,
      {
        ...first,
        shardId: "shard-001",
        shardIndex: 1,
        shardIdentityHash: "c".repeat(64)
      }
    ]
  };
}

function threeShardManifest(manifestHash = `b${"c".repeat(63)}`): SuiteSelectionManifest {
  const compiled = twoShardManifest(manifestHash);
  const first = compiled.shards[0];
  if (first === undefined) throw new Error("missing shard");
  return {
    ...compiled,
    shards: [
      ...compiled.shards,
      {
        ...first,
        shardId: "shard-002",
        shardIndex: 2,
        shardIdentityHash: "d".repeat(64)
      }
    ]
  };
}

function fixtureTenant(
  workspaceId = FIXTURE_WORKSPACE,
  extras: { readonly apiOrigin?: string; readonly connectorId?: string } = {}
) {
  return {
    api_origin: extras.apiOrigin ?? "http://127.0.0.1/",
    tenant: {
      workspace_id: workspaceId,
      connector_id: extras.connectorId ?? FIXTURE_CONNECTOR
    }
  };
}

function startExecution(
  manifest: SuiteSelectionManifest,
  aggregateMaxCredits: number,
  options: { readonly now?: () => Date; readonly createExecutionId?: () => string } = {}
) {
  return initialExecution(manifest, aggregateMaxCredits, {
    tenant: fixtureTenant(),
    ...options
  });
}

async function openExec(
  input: Parameters<typeof openSelectionExecution>[0]
): ReturnType<typeof openSelectionExecution> {
  return openSelectionExecution({
    tenant: fixtureTenant(),
    ...input
  });
}

function completeShard(
  execution: ReturnType<typeof initialExecution>,
  shardId: string,
  extras: { readonly runId: string; readonly quoteId: string; readonly units: number }
): ReturnType<typeof initialExecution> {
  return markShardCompleted(
    markShardAdmitted(markShardQuoted(execution, shardId, { quoteId: extras.quoteId, quotedUnits: extras.units }), shardId, {
      runId: extras.runId
    }),
    shardId,
    { chargedUnits: extras.units }
  );
}

function expectSecretSafe(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(text).not.toMatch(/token|api[_-]?key|authorization|https?:\/\/|raw response|Bearer /i);
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(AwError);
  expect((error as AwError).code).toBe(code);
}

async function expectAsyncCode(run: () => Promise<unknown>, code: string): Promise<AwError> {
  try {
    await run();
  } catch (error) {
    expectCode(error, code);
    return error as AwError;
  }
  throw new Error(`expected ${code}`);
}

function doctorFor() {
  const config: AugmentWorksConfig = {
    version: 1,
    target: {
      name: "refunds",
      connector: "http",
      base_url: "http://127.0.0.1:8000",
      operations: {
        send: {
          method: "POST",
          path: "/chat",
          request: { message: "$input.message" },
          response: { content: "$.answer" }
        }
      }
    }
  };
  const inspection = resolveConfig(config, "/tmp/augmentworks.yaml", "/tmp", {});
  const resolvedConfig = inspection.resolvedConfig;
  if (resolvedConfig === undefined) throw new Error("test config did not resolve");
  return async () => ({
    ok: true as const,
    configPath: resolvedConfig.configPath,
    offline: true as const,
    diagnostics: [],
    resolvedConfig
  });
}

describe("selection execution IDs", () => {
  it("creates a cryptographically random execution id for a fresh attempt", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const opened = await openExec({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 20
    });
    expect(opened.kind).toBe("created");
    expect(opened.execution.executionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(opened.execution.shards.every((shard) => shard.state === "pending")).toBe(true);
    expect(opened.execution.remainingCredits).toBe(20);
    await opened.lock.release();
  });

  it("starts a new empty execution after a terminal attempt on the same manifest", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openExec({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 20,
      createExecutionId: () => "11111111-1111-4111-8111-111111111111"
    });
    let execution = markShardQuoted(first.execution, "shard-000", {
      quoteId: "quote-a",
      quotedUnits: 4
    });
    execution = markShardAdmitted(execution, "shard-000", { runId: "run-a" });
    execution = markShardCompleted(execution, "shard-000", { runId: "run-a", chargedUnits: 4 });
    execution = markShardQuoted(execution, "shard-001", { quoteId: "quote-b", quotedUnits: 4 });
    execution = markShardAdmitted(execution, "shard-001", { runId: "run-b" });
    execution = markShardCompleted(execution, "shard-001", { runId: "run-b", chargedUnits: 4 });
    const saved = await saveSelectionExecution(first.paths, execution);
    expect(saved.state).toBe("completed");
    expect(saved.terminalReason).toBeNull();
    await first.lock.release();

    const second = await openExec({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 20,
      createExecutionId: () => "22222222-2222-4222-8222-222222222222"
    });
    expect(second.kind).toBe("rerun");
    expect(second.execution.executionId).toBe("22222222-2222-4222-8222-222222222222");
    expect(second.execution.shards.map((shard) => shard.state)).toEqual(["pending", "pending"]);
    expect(second.execution.shards.some((shard) => shard.runId === "run-a")).toBe(false);
    expect(second.execution.remainingCredits).toBe(20);
    await second.lock.release();
  });

  it("keeps different manifests from colliding", async () => {
    const stateDirectory = await stateDir();
    const a = await openExec({
      stateDirectory,
      manifest: twoShardManifest("a".repeat(64)),
      aggregateMaxCredits: 8,
      createExecutionId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    });
    const b = await openExec({
      stateDirectory,
      manifest: twoShardManifest("d".repeat(64)),
      aggregateMaxCredits: 8,
      createExecutionId: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    });
    expect(a.execution.executionId).not.toBe(b.execution.executionId);
    expect(a.paths.root).not.toBe(b.paths.root);
    await a.lock.release();
    await b.lock.release();
  });

  it("refuses a second invocation without --execution-id while an attempt is unfinished", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openExec({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 20,
      manifestPath: "./suite-selection.manifest.json"
    });
    await first.lock.release();
    const error = await expectAsyncCode(
      () =>
        openExec({
          stateDirectory,
          manifest,
          aggregateMaxCredits: 20,
          manifestPath: "./suite-selection.manifest.json"
        }),
      "SELECTION_RESUME_REQUIRED"
    );
    expect(error.details?.["execution_id"]).toBe(first.execution.executionId);
    expect(error.details?.["recovery_action"]).toBe("resume_execution");
    expect(String(error.details?.["recovery_command"])).toContain("--execution-id");
    expect(error.message).toContain("Resume this attempt");
    expect(error.message).toContain("new rerun");
  });

  it("resumes only the exact execution id and clears interrupted terminal reason", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openExec({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 12
    });
    const interrupted = await saveSelectionExecution(
      first.paths,
      interruptExecution(markShardQuoted(first.execution, "shard-000", { quoteId: "quote-1", quotedUnits: 4 }))
    );
    expect(interrupted.state).toBe("interrupted");
    expect(interrupted.terminalReason).toBeNull();
    await first.lock.release();

    await expectAsyncCode(
      () =>
        openExec({
          stateDirectory,
          manifest,
          aggregateMaxCredits: 12,
          executionId: "99999999-9999-4999-8999-999999999999"
        }),
      "SELECTION_EXECUTION_NOT_FOUND"
    );

    const resumed = await openExec({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 12,
      executionId: interrupted.executionId
    });
    expect(resumed.kind).toBe("resumed");
    expect(resumed.execution.state).toBe("running");
    expect(resumed.execution.terminalReason).toBeNull();
    expect(resumed.execution.shards[0]?.quoteId).toBe("quote-1");
    expect(resumed.execution.shards[0]?.quotedUnits).toBe(4);
    await resumed.lock.release();
  });

  it("does not requote or double-subtract completed shards", async () => {
    const manifest = twoShardManifest();
    let execution = startExecution(manifest, 10);
    execution = markShardQuoted(execution, "shard-000", { quoteId: "quote-1", quotedUnits: 4 });
    execution = markShardAdmitted(execution, "shard-000", { runId: "run-1" });
    execution = markShardCompleted(execution, "shard-000", { runId: "run-1", chargedUnits: 4 });
    const remaining = execution.remainingCredits;
    const again = markShardCompleted(execution, "shard-000", { runId: "run-1", chargedUnits: 4 });
    expect(again.remainingCredits).toBe(remaining);
    expect(derivedRemainingCredits(again)).toBe(6);
    expect(nextRunnableShard(again)?.shardId).toBe("shard-001");
  });

  it("restores durable units for a recovered terminal shard and advances coverage", () => {
    const manifest = twoShardManifest();
    let execution = startExecution(manifest, 10);
    execution = markShardQuoted(execution, "shard-000", { quoteId: "quote-1", quotedUnits: 4 });
    execution = markShardAdmitted(execution, "shard-000", { runId: "run-1" });
    execution = markShardCompleted(execution, "shard-000", {
      runId: "run-1",
      chargedUnits: 4,
      quoteId: "quote-1"
    });
    const artifact = artifactFromExecution(manifest, execution);
    expect(artifact.declaredShards).toEqual([
      expect.objectContaining({ shardId: "shard-000", runId: "run-1" })
    ]);
    expect(artifact.missingShardIds).toContain("shard-001");
    expect(execution.remainingCredits).toBe(6);
  });

  it("treats exact budget coverage as complete and budget exhaustion with a pending shard as incomplete", () => {
    const manifest = twoShardManifest();
    let exact = startExecution(manifest, 8);
    exact = markShardCompleted(markShardAdmitted(markShardQuoted(exact, "shard-000", { quoteId: "q1", quotedUnits: 4 }), "shard-000", { runId: "r1" }), "shard-000", { chargedUnits: 4 });
    exact = markShardCompleted(markShardAdmitted(markShardQuoted(exact, "shard-001", { quoteId: "q2", quotedUnits: 4 }), "shard-001", { runId: "r2" }), "shard-001", { chargedUnits: 4 });
    expect(exact.remainingCredits).toBe(0);
    expect(aggregateExecutionExitCode(exact, EXIT.OK)).toBe(EXIT.OK);

    let exhausted = startExecution(manifest, 4);
    exhausted = markShardCompleted(markShardAdmitted(markShardQuoted(exhausted, "shard-000", { quoteId: "q1", quotedUnits: 4 }), "shard-000", { runId: "r1" }), "shard-000", { chargedUnits: 4 });
    exhausted = skipRemainingPendingShards(exhausted, "aggregate_budget");
    expect(exhausted.state).toBe("blocked");
    expect(exhausted.shards[1]?.state).toBe("blocked");
    expect(aggregateExecutionExitCode(exhausted, EXIT.OK)).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(executionJsonFields(exhausted)["coverage_complete"]).toBe(false);
  });

  it("does not let a last-shard pass mask missing coverage", () => {
    const manifest = twoShardManifest();
    let execution = startExecution(manifest, 4);
    execution = markShardCompleted(
      markShardAdmitted(markShardQuoted(execution, "shard-000", { quoteId: "q1", quotedUnits: 4 }), "shard-000", {
        runId: "r1"
      }),
      "shard-000",
      { chargedUnits: 4 }
    );
    execution = skipRemainingPendingShards(execution, "aggregate_budget");
    expect(aggregateExecutionExitCode(execution, EXIT.OK)).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("counts unique quote ids once across duplicate poll/retry completions", () => {
    const manifest = twoShardManifest();
    let execution = startExecution(manifest, 10);
    execution = markShardQuoted(execution, "shard-000", { quoteId: "same-quote", quotedUnits: 4 });
    execution = markShardCompleted(execution, "shard-000", { runId: "run-1", chargedUnits: 4, quoteId: "same-quote" });
    const duplicate = markShardCompleted(execution, "shard-000", {
      runId: "run-1",
      chargedUnits: 4,
      quoteId: "same-quote"
    });
    expect(duplicate.remainingCredits).toBe(6);
    expect(duplicate.shards.reduce((sum, shard) => sum + shard.chargedUnits, 0)).toBe(4);
  });

  it("rejects a quote id already bound to another shard before another quote", () => {
    const manifest = threeShardManifest();
    const execution = completeShard(startExecution(manifest, 10), "shard-000", {
      runId: "r1",
      quoteId: "duplicate-quote",
      units: 4
    });
    expect(execution.remainingCredits).toBe(6);
    const error = (() => {
      try {
        markShardQuoted(execution, "shard-001", { quoteId: "duplicate-quote", quotedUnits: 4 });
        throw new Error("expected SHARD_PROGRESS_BLOCKED");
      } catch (caught) {
        expectCode(caught, "SHARD_PROGRESS_BLOCKED");
        return caught as AwError;
      }
    })();
    expect(error.message).toMatch(/already bound to shard shard-000/i);
    expect(error.message).not.toMatch(/duplicate-quote/);
    expect(error.details).toMatchObject({
      shard_id: "shard-001",
      bound_shard_id: "shard-000",
      recovery_action: "resume_execution"
    });
    expect(error.details).not.toHaveProperty("quote_id");
    expectSecretSafe(error.toSafeJSON());
    expect(execution.remainingCredits).toBe(6);
    expect(execution.shards.map((shard) => shard.state)).toEqual(["completed", "pending", "pending"]);
    expect(nextRunnableShard(execution)?.shardId).toBe("shard-001");
    const reserved = markShardQuoted(startExecution(manifest, 10), "shard-000", {
      quoteId: "in-flight-quote",
      quotedUnits: 4
    });
    expect(() =>
      markShardQuoted(reserved, "shard-001", { quoteId: "in-flight-quote", quotedUnits: 4 })
    ).toThrow(/SHARD_PROGRESS_BLOCKED|already bound/i);
    expect(reserved.remainingCredits).toBe(6);
  });

  it("rejects a run id already bound to another shard before admission or completion", () => {
    const manifest = twoShardManifest();
    let execution = completeShard(startExecution(manifest, 10), "shard-000", {
      runId: "shared-run",
      quoteId: "quote-a",
      units: 4
    });
    execution = markShardQuoted(execution, "shard-001", { quoteId: "quote-b", quotedUnits: 4 });
    expect(() => markShardAdmitted(execution, "shard-001", { runId: "shared-run" })).toThrow(
      /SHARD_PROGRESS_BLOCKED|already bound to shard shard-000/i
    );
    expect(() =>
      markShardCompleted(execution, "shard-001", { runId: "shared-run", chargedUnits: 4, quoteId: "quote-b" })
    ).toThrow(/SHARD_PROGRESS_BLOCKED|already bound/i);
    expect(execution.shards[1]?.state).toBe("quoted");
    expect(execution.remainingCredits).toBe(2);
  });

  it("rejects a failed shard's run id if another shard tries to reuse it", () => {
    const manifest = twoShardManifest();
    let execution = markShardQuoted(startExecution(manifest, 10), "shard-000", {
      quoteId: "quote-a",
      quotedUnits: 4
    });
    execution = markShardFailed(markShardAdmitted(execution, "shard-000", { runId: "failed-run" }), "shard-000", {
      runId: "failed-run"
    });
    execution = markShardQuoted(execution, "shard-001", { quoteId: "quote-b", quotedUnits: 4 });
    expect(() => markShardAdmitted(execution, "shard-001", { runId: "failed-run" })).toThrow(
      /SHARD_PROGRESS_BLOCKED|already bound to shard shard-000/i
    );
  });

  it("still counts each validated shard charge against the aggregate cap", () => {
    const manifest = threeShardManifest();
    let execution = completeShard(startExecution(manifest, 10), "shard-000", {
      runId: "r1",
      quoteId: "quote-1",
      units: 4
    });
    execution = completeShard(execution, "shard-001", { runId: "r2", quoteId: "quote-2", units: 4 });
    expect(execution.remainingCredits).toBe(2);
    expect(execution.shards.reduce((sum, shard) => sum + shard.chargedUnits, 0)).toBe(8);
    expect(() =>
      markShardQuoted(execution, "shard-002", { quoteId: "quote-3", quotedUnits: 6 })
    ).toThrow(/SELECTION_BUDGET_INVARIANT|underflow/i);
  });

  it("allows the same shard to replace an unadmitted quote id", () => {
    const manifest = twoShardManifest();
    let execution = markShardQuoted(startExecution(manifest, 10), "shard-000", {
      quoteId: "quote-old",
      quotedUnits: 4
    });
    execution = markShardQuoted(execution, "shard-000", { quoteId: "quote-new", quotedUnits: 4 });
    execution = markShardQuoted(execution, "shard-001", { quoteId: "quote-old", quotedUnits: 3 });
    expect(execution.shards[0]?.quoteId).toBe("quote-new");
    expect(execution.shards[1]?.quoteId).toBe("quote-old");
    expect(execution.remainingCredits).toBe(3);
  });

  it("fails schema validation for persisted cross-shard quote or run duplicates", () => {
    const manifest = twoShardManifest();
    const valid = completeShard(startExecution(manifest, 10), "shard-000", {
      runId: "r1",
      quoteId: "quote-a",
      units: 4
    });
    const quoteDuplicate = {
      ...valid,
      shards: valid.shards.map((shard) =>
        shard.shardId === "shard-001"
          ? { ...shard, quoteId: "quote-a", quotedUnits: 4, chargedUnits: 4, state: "completed" as const }
          : shard
      )
    };
    const runDuplicate = {
      ...valid,
      shards: valid.shards.map((shard) =>
        shard.shardId === "shard-001"
          ? {
              ...shard,
              quoteId: "quote-b",
              runId: "r1",
              quotedUnits: 4,
              chargedUnits: 4,
              state: "completed" as const
            }
          : shard
      )
    };
    expect(SelectionExecutionSchema.safeParse(quoteDuplicate).success).toBe(false);
    expect(SelectionExecutionSchema.safeParse(runDuplicate).success).toBe(false);
    expect(SelectionExecutionSchema.safeParse(valid).success).toBe(true);
  });

  it("fails closed on negative, overflowing, or missing unit ledgers", () => {
    const manifest = twoShardManifest();
    const execution = startExecution(manifest, 4);
    expect(() =>
      markShardQuoted(execution, "shard-000", { quoteId: "q", quotedUnits: -1 })
    ).toThrow(/SELECTION_BUDGET_INVARIANT|quotedUnits/);
    expect(() =>
      markShardQuoted(execution, "shard-000", { quoteId: "q", quotedUnits: 8 })
    ).toThrow(/SELECTION_BUDGET_INVARIANT|underflow/i);
  });

  it("maps mixed pass/block/failure to a stable failed aggregate exit", () => {
    const manifest = twoShardManifest();
    let execution = startExecution(manifest, 20);
    execution = markShardCompleted(
      markShardAdmitted(markShardQuoted(execution, "shard-000", { quoteId: "q1", quotedUnits: 4 }), "shard-000", {
        runId: "r1"
      }),
      "shard-000",
      { chargedUnits: 4 }
    );
    execution = markShardFailed(execution, "shard-001", { runId: "r2" });
    expect(aggregateExecutionExitCode(execution)).toBe(EXIT.ASSESSMENT_FAILED);
  });

  it("fails closed on an unambiguous v1 progress file instead of relabeling the current login", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest(baseManifest().manifestHash);
    const first = manifest.shards[0]!;
    const v1 = {
      schemaVersion: "aw-selection-progress/1",
      manifestHash: manifest.manifestHash,
      aggregateMaxCredits: 8,
      remainingCredits: 4,
      stoppedReason: null,
      shards: [
        {
          shardId: first.shardId,
          shardIdentityHash: first.shardIdentityHash,
          status: "completed",
          runId: "run-1",
          quoteUnits: 4
        },
        {
          shardId: "shard-001",
          shardIdentityHash: "c".repeat(64),
          status: "pending"
        }
      ]
    };
    const paths = executionPaths(stateDirectory, manifest.manifestHash);
    await mkdir(join(stateDirectory, "selections"), { recursive: true, mode: 0o700 });
    await writeFile(paths.v1Progress, `${JSON.stringify(v1)}\n`, { mode: 0o600 });
    const error = await expectAsyncCode(
      () => openExec({ stateDirectory, manifest, aggregateMaxCredits: 8 }),
      "SELECTION_LEGACY_UNBOUND"
    );
    expect(JSON.parse(await readFile(paths.v1Progress, "utf8"))).toMatchObject({
      schemaVersion: "aw-selection-progress/1"
    });
    expect(error.details?.["original_run_ids"]).toBe("run-1");
    expect(error.details?.["recovery_action"]).toBe("inspect_legacy_unbound");
    expectSecretSafe(error.toSafeJSON());
    const executionsDir = join(paths.root, "executions");
    await expect(readdir(executionsDir)).resolves.toEqual([]);
  });

  it("refuses an ambiguous v1 progress file before any caller can quote", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest(baseManifest().manifestHash);
    const first = manifest.shards[0]!;
    const v1 = {
      schemaVersion: "aw-selection-progress/1",
      manifestHash: manifest.manifestHash,
      aggregateMaxCredits: 4,
      remainingCredits: 0,
      stoppedReason: "stale",
      shards: [
        {
          shardId: first.shardId,
          shardIdentityHash: first.shardIdentityHash,
          status: "completed",
          runId: "run-1"
        },
        {
          shardId: "shard-001",
          shardIdentityHash: "c".repeat(64),
          status: "pending"
        }
      ]
    };
    const paths = executionPaths(stateDirectory, manifest.manifestHash);
    await mkdir(join(stateDirectory, "selections"), { recursive: true, mode: 0o700 });
    await writeFile(paths.v1Progress, `${JSON.stringify(v1)}\n`, { mode: 0o600 });
    await expectAsyncCode(
      () => openExec({ stateDirectory, manifest, aggregateMaxCredits: 4 }),
      "SELECTION_PROGRESS_MIGRATION_REQUIRED"
    );
  });

  it("quarantines truncated JSON and does not silently discard it", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openExec({ stateDirectory, manifest, aggregateMaxCredits: 4 });
    const file = executionDocumentPath(first.paths, first.execution.executionId);
    await first.lock.release();
    await writeFile(file, '{"documentKind":"aw-selection-execution/2"', { mode: 0o600 });
    await expectAsyncCode(
      () =>
        openExec({
          stateDirectory,
          manifest,
          aggregateMaxCredits: 4,
          executionId: first.execution.executionId
        }),
      "SELECTION_EXECUTION_CORRUPT"
    );
    const quarantined = await readdir(join(first.paths.root, "quarantine"));
    expect(quarantined.length).toBeGreaterThan(0);
  });

  it("quarantines persisted cross-shard quote duplicates before resume or quote", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openExec({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 10,
      createExecutionId: () => "11111111-1111-4111-8111-111111111111"
    });
    const quoted = markShardQuoted(first.execution, "shard-000", { quoteId: "shared-quote", quotedUnits: 4 });
    await saveSelectionExecution(first.paths, quoted);
    const file = executionDocumentPath(first.paths, first.execution.executionId);
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      shards: Array<{ shardId: string; quoteId: string | null; quotedUnits: number; state: string }>;
    };
    raw.shards = raw.shards.map((shard) =>
      shard.shardId === "shard-001"
        ? { ...shard, quoteId: "shared-quote", quotedUnits: 4, state: "quoted" }
        : shard
    );
    await writeFile(file, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    await first.lock.release();
    const error = await expectAsyncCode(
      () =>
        openExec({
          stateDirectory,
          manifest,
          aggregateMaxCredits: 10,
          executionId: first.execution.executionId
        }),
      "SELECTION_EXECUTION_CORRUPT"
    );
    expect(error.message).toMatch(/schema validation/i);
    expectSecretSafe(error.toSafeJSON());
    expect(error.details).not.toHaveProperty("quote_id");
    const quarantined = await readdir(join(first.paths.root, "quarantine"));
    expect(quarantined.length).toBeGreaterThan(0);
  });

  it("rejects symlink execution paths", async () => {
    if (process.platform === "win32") return;
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openExec({ stateDirectory, manifest, aggregateMaxCredits: 4 });
    await first.lock.release();
    const target = join(stateDirectory, "other.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    const file = executionDocumentPath(first.paths, first.execution.executionId);
    await rm(file);
    try {
      await symlink(target, file);
    } catch {
      return;
    }
    await expectAsyncCode(
      () =>
        openExec({
          stateDirectory,
          manifest,
          aggregateMaxCredits: 4,
          executionId: first.execution.executionId
        }),
      "UNSAFE_SELECTION_EXECUTION"
    );
  });

  it("contends safely when another invocation holds the execution lock", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openExec({ stateDirectory, manifest, aggregateMaxCredits: 4 });
    await expectAsyncCode(
      () => openExec({ stateDirectory, manifest, aggregateMaxCredits: 4 }),
      "SELECTION_EXECUTION_LOCKED"
    );
    await first.lock.release();
  });

  it("writes execution files as mode 0600 regular files on unix", async () => {
    if (process.platform === "win32") return;
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const opened = await openExec({ stateDirectory, manifest, aggregateMaxCredits: 4 });
    const file = executionDocumentPath(opened.paths, opened.execution.executionId);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(opened.paths.root)).mode & 0o777).toBe(0o700);
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(raw["documentKind"]).toBe(SELECTION_EXECUTION_DOCUMENT_KIND);
    expect(raw["tenant"]).toEqual({
      workspace_id: FIXTURE_WORKSPACE,
      connector_id: FIXTURE_CONNECTOR
    });
    expect(JSON.stringify(raw)).not.toMatch(/token|api[_-]?key|authorization|refresh/i);
    await opened.lock.release();
  });

  it("writes a single interrupted checkpoint then aborts without claiming completion", () => {
    const manifest = twoShardManifest();
    let execution = markShardQuoted(startExecution(manifest, 4), "shard-000", {
      quoteId: "quote-int",
      quotedUnits: 2
    });
    execution = interruptExecution(execution);
    expect(execution.state).toBe("interrupted");
    expect(execution.terminalReason).toBeNull();
    expect(execution.shards[0]?.state).toBe("quoted");
    const resumed = resumeExecution(execution);
    expect(resumed.state).toBe("running");
    expect(resumed.terminalReason).toBeNull();
  });

  it("checkpoints once on SIGINT/SIGTERM and exits on the second signal", () => {
    const listeners = new Map<string, () => void>();
    let exited: number | undefined;
    const host = {
      on(event: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.set(event, listener);
      },
      off(event: "SIGINT" | "SIGTERM") {
        listeners.delete(event);
      },
      exit(code: number): never {
        exited = code;
        throw new Error(`exit ${code}`);
      }
    };
    const abort = new AbortController();
    let checkpoints = 0;
    const remove = installSelectionExecutionInterruptHandler({
      host,
      stderr: { write: () => true },
      abort,
      checkpoint: async () => {
        checkpoints += 1;
      },
      resumeCommand: "augmentworks test --all-shards --execution-id 11111111-1111-4111-8111-111111111111 --max-credits 4"
    });
    listeners.get("SIGINT")?.();
    expect(checkpoints).toBe(1);
    expect(abort.signal.aborted).toBe(true);
    expect(() => listeners.get("SIGINT")?.()).toThrow(/exit 130/);
    expect(exited).toBe(EXIT.INTERRUPTED);
    remove();
  });
});

describe("selection execution CLI", () => {
  it("documents resume versus new rerun on test --help", async () => {
    const { runSourceCli } = await import("../util/cli-process.js");
    const testHelp = await runSourceCli(["test", "--help"], { cwd: projectRoot });
    expect(testHelp.stdout).toContain("--execution-id");
    expect(testHelp.stdout).toContain("resume");
    expect(testHelp.stdout).toMatch(/new\s+execution/);
  });

  it("rejects --execution-id without --all-shards before network work", async () => {
    const test = createTestCommand({
      stdout: { write: () => true },
      stderr: { write: () => true }
    }).exitOverride();
    await expect(
      test.parseAsync(
        [
          "node",
          "augmentworks",
          "--manifest",
          "suite-selection.manifest.json",
          "--execution-id",
          "11111111-1111-4111-8111-111111111111",
          "--max-credits",
          "4",
          "--yes"
        ],
        { from: "node" }
      )
    ).rejects.toMatchObject({ code: "EXECUTION_ID_REQUIRES_ALL_SHARDS" });
  });

  it("refuses resume without --execution-id before authenticate or quote", async () => {
    const cwd = await stateDir();
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest(baseManifest().manifestHash);
    await writeFile(join(cwd, "suite-selection.manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
    const opened = await openExec({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 20,
      manifestPath: "suite-selection.manifest.json"
    });
    await opened.lock.release();
    let authenticated = false;
    await expect(
      runTest(
        {
          manifest: "suite-selection.manifest.json",
          allShards: true,
          maxCredits: "20",
          yes: true,
          cwd,
          stateDirectory,
          handleSignals: false,
          env: { CI: "1" }
        },
        {
          doctor: doctorFor(),
          accessToken: async () => {
            authenticated = true;
            return "token";
          },
          identity: async () => {
            authenticated = true;
            return {
              subject: "user-1",
              workspaceId: "workspace-1",
              connectorId: "connector-1",
              scopes: ["connector:identity", "connector:run"]
            };
          },
          cloud: () => {
            authenticated = true;
            throw new Error("cloud must not initialize");
          },
          stdout: { write: () => true },
          stderr: { write: () => true }
        }
      )
    ).rejects.toMatchObject({ code: "SELECTION_RESUME_REQUIRED" });
    expect(authenticated).toBe(false);
  });

  it("does not read an API key for doctor --offline or resume-required local refusal", async () => {
    const cwd = await stateDir();
    const { runSourceCli } = await import("../util/cli-process.js");
    const doctor = await runSourceCli(["doctor", "--offline", "--json"], {
      cwd,
      env: {
        AUGMENTWORKS_API_KEY: "",
        AUGMENTWORKS_TOKEN: "",
        CI: "1"
      }
    });
    expect(doctor.stdout).not.toContain("sk-");
  });

  it("refuses a persisted cross-shard quote duplicate before authenticate or quote", async () => {
    const cwd = await stateDir();
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest(baseManifest().manifestHash);
    await writeFile(join(cwd, "suite-selection.manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
    const opened = await openExec({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 10,
      manifestPath: "suite-selection.manifest.json"
    });
    await saveSelectionExecution(
      opened.paths,
      markShardQuoted(opened.execution, "shard-000", { quoteId: "shared-quote", quotedUnits: 4 })
    );
    const file = executionDocumentPath(opened.paths, opened.execution.executionId);
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      shards: Array<{ shardId: string; quoteId: string | null; quotedUnits: number; state: string }>;
    };
    raw.shards = raw.shards.map((shard) =>
      shard.shardId === "shard-001"
        ? { ...shard, quoteId: "shared-quote", quotedUnits: 4, state: "quoted" }
        : shard
    );
    await writeFile(file, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    await opened.lock.release();
    let authenticated = false;
    const error = await expectAsyncCode(
      () =>
        runTest(
          {
            manifest: "suite-selection.manifest.json",
            allShards: true,
            executionId: opened.execution.executionId,
            maxCredits: "10",
            yes: true,
            json: true,
            cwd,
            stateDirectory,
            handleSignals: false,
            env: { CI: "1", AUGMENTWORKS_API_KEY: "sk-secret-test-key" }
          },
          {
            doctor: doctorFor(),
            accessToken: async () => {
              authenticated = true;
              return "token";
            },
            identity: async () => {
              authenticated = true;
              return {
                subject: "user-1",
                workspaceId: "workspace-1",
                connectorId: "connector-1",
                scopes: ["connector:identity", "connector:run"]
              };
            },
            cloud: () => {
              authenticated = true;
              throw new Error("cloud must not initialize");
            },
            stdout: { write: () => true },
            stderr: { write: () => true }
          }
        ),
      "SELECTION_EXECUTION_CORRUPT"
    );
    expect(authenticated).toBe(false);
    expect(error.message).toMatch(/schema validation|quarantined/i);
    expectSecretSafe(error.toSafeJSON());
    expect(JSON.stringify(error.toSafeJSON())).not.toContain("sk-secret-test-key");
    expect(JSON.stringify(error.toSafeJSON())).not.toContain("shared-quote");
  });
});

describe("execution helpers", () => {
  it("rejects a non-uuid execution id", () => {
    try {
      parseExecutionId("../secret");
      throw new Error("expected EXECUTION_ID_INVALID");
    } catch (error) {
      expectCode(error, "EXECUTION_ID_INVALID");
    }
    expect(formatSelectionResumeCommand({
      executionId: "11111111-1111-4111-8111-111111111111",
      maxCredits: 20,
      manifestPath: "./suite-selection.manifest.json",
      yes: true
    })).toContain("--all-shards --execution-id");
  });

  it("resumes interrupt-before-quote through observation checkpoints", () => {
    const manifest = twoShardManifest();
    let execution = startExecution(manifest, 20);
    expect(nextRunnableShard(execution)?.state).toBe("pending");
    execution = markShardQuoted(execution, "shard-000", { quoteId: randomUUID(), quotedUnits: 3 });
    expect(nextRunnableShard(execution)?.state).toBe("quoted");
    execution = markShardAdmitted(execution, "shard-000", { runId: "run-obs" });
    expect(nextRunnableShard(execution)?.state).toBe("admitted");
    execution = resumeExecution(interruptExecution(execution));
    expect(execution.state).toBe("running");
    expect(execution.terminalReason).toBeNull();
    expect(nextRunnableShard(execution)?.runId).toBe("run-obs");
  });
});

describe("selection execution tenant pinning", () => {
  function hostedIdentity(
    workspaceId = FIXTURE_WORKSPACE,
    connectorId = FIXTURE_CONNECTOR
  ) {
    return {
      subject: "user-1",
      workspaceId,
      workspaceName: "Fixture workspace",
      connectorId,
      scopes: ["connector:identity", "connector:run"]
    };
  }

  function createRunJson(
    request: Record<string, unknown>,
    runId: string,
    origin: URL
  ): Record<string, unknown> {
    return {
      protocol_version: "aw-relay/0.3",
      create_request_id: request["create_request_id"],
      create_request_sha256: sha256(canonicalize(request)),
      create_disposition: "created",
      run_id: runId,
      session_id: "session-1",
      packet: { key: "aw-customer-suite", version: "1.0.0", sha256: "a".repeat(64) },
      config_sha256: request["config_sha256"],
      fencing_epoch: 1,
      status: "completed",
      dashboard_url: `${origin.origin}/portal/runs/${runId}`,
      run_expires_at: "2099-09-06T00:00:00.000Z",
      credit_state: "reserved"
    };
  }

  function runStatusJson(runId: string, origin: URL): Record<string, unknown> {
    return {
      protocol_version: "aw-relay/0.1",
      run_id: runId,
      status: "completed",
      credit_state: "reserved",
      outcome: "passed",
      dashboard_url: `${origin.origin}/portal/runs/${runId}`
    };
  }

  it("requires a versioned tenant binding on aw-selection-execution/3 and rejects /2 as current", () => {
    const bound = startExecution(twoShardManifest(), 10);
    expect(SelectionExecutionSchema.safeParse(bound).success).toBe(true);
    const { api_origin: _origin, tenant: _tenant, ...rest } = bound;
    const unbound = { ...rest, documentKind: SELECTION_EXECUTION_DOCUMENT_KIND_V2 };
    expect(SelectionExecutionSchema.safeParse(unbound).success).toBe(false);
    expect(bound.tenant.workspace_id).toBe(FIXTURE_WORKSPACE);
    expect(JSON.stringify(bound)).not.toMatch(/access_token|refresh_token|Bearer /i);
  });

  it("rejects a credential switch on resume before any quote and keeps the original run binding", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openExec({ stateDirectory, manifest, aggregateMaxCredits: 20 });
    const admitted = markShardAdmitted(
      markShardQuoted(first.execution, "shard-000", { quoteId: "quote-keep", quotedUnits: 4 }),
      "shard-000",
      { runId: "run-keep" }
    );
    await saveSelectionExecution(first.paths, interruptExecution(admitted));
    await first.lock.release();
    await expectAsyncCode(
      () =>
        openSelectionExecution({
          stateDirectory,
          manifest,
          aggregateMaxCredits: 20,
          executionId: first.execution.executionId,
          tenant: fixtureTenant(OTHER_WORKSPACE)
        }),
      "SELECTION_TENANT_MISMATCH"
    );
    const resumed = await openExec({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 20,
      executionId: first.execution.executionId
    });
    expect(resumed.execution.shards[0]?.runId).toBe("run-keep");
    expect(resumed.execution.shards[0]?.quoteId).toBe("quote-keep");
    expect(resumed.execution.tenant.workspace_id).toBe(FIXTURE_WORKSPACE);
    expect(resumed.execution.remainingCredits).toBe(16);
    await resumed.lock.release();
  });

  it("fails closed on a legacy unbound /2 document instead of relabeling the current login", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openExec({ stateDirectory, manifest, aggregateMaxCredits: 8 });
    const file = executionDocumentPath(first.paths, first.execution.executionId);
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    delete raw["api_origin"];
    delete raw["tenant"];
    raw["documentKind"] = SELECTION_EXECUTION_DOCUMENT_KIND_V2;
    await writeFile(file, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    await first.lock.release();
    const error = await expectAsyncCode(
      () =>
        openExec({
          stateDirectory,
          manifest,
          aggregateMaxCredits: 8,
          executionId: first.execution.executionId
        }),
      "SELECTION_LEGACY_UNBOUND"
    );
    expect(error.details?.["execution_id"]).toBe(first.execution.executionId);
    expect(error.message).toMatch(/will not relabel/i);
    expectSecretSafe(error.toSafeJSON());
    const reread = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(reread["documentKind"]).toBe(SELECTION_EXECUTION_DOCUMENT_KIND_V2);
    expect(reread["tenant"]).toBeUndefined();
  });

  it("denies a foreign-workspace compiled manifest before quote, including catalog shards", () => {
    const manifest = twoShardManifest();
    expect(manifest.workspaceId).toBe(FIXTURE_WORKSPACE);
    try {
      admitManifestWorkspace(manifest, fixtureTenant(OTHER_WORKSPACE).tenant);
      throw new Error("expected SELECTION_TENANT_MISMATCH");
    } catch (error) {
      expectCode(error, "SELECTION_TENANT_MISMATCH");
      const details = (error as AwError).details;
      expect(details?.["expected_workspace_id"]).toBe(FIXTURE_WORKSPACE);
      expect(details?.["actual_workspace_id"]).toBe(OTHER_WORKSPACE);
      expectSecretSafe((error as AwError).toSafeJSON());
    }
  });

  it("rejects a credential swap after shard 1 with zero later quotes, creates, or target calls", async () => {
    const cwd = await stateDir();
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest(baseManifest().manifestHash);
    await writeFile(join(cwd, "suite-selection.manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
    const counts = { quote: 0, create: 0, target: 0, capabilities: 0 };
    let workspaceId = FIXTURE_WORKSPACE;
    const apiOrigin = new URL("http://127.0.0.1:8787/");
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/billing/capabilities") {
        counts.capabilities += 1;
        return Response.json(billingFixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        counts.quote += 1;
        return Response.json(billingFixtures.fixtures["quote_success_with_balance"]?.response);
      }
      if (url.pathname === "/v1/relay/runs" && (init?.method ?? "GET") === "POST") {
        counts.create += 1;
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(createRunJson(request, "run-shard-0", apiOrigin));
      }
      if (url.pathname === "/v1/relay/runs/run-shard-0") {
        workspaceId = OTHER_WORKSPACE;
        return Response.json(runStatusJson("run-shard-0", apiOrigin));
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const error = await expectAsyncCode(
      () =>
        runTest(
          {
            manifest: "suite-selection.manifest.json",
            allShards: true,
            maxCredits: "100",
            yes: true,
            cwd,
            stateDirectory,
            handleSignals: false,
            env: {
              CI: "1",
              AUGMENTWORKS_API_URL: apiOrigin.origin,
              AUGMENTWORKS_API_KEY: "",
              AUGMENTWORKS_TOKEN: "token"
            }
          },
          {
            doctor: doctorFor(),
            apiOrigin: () => apiOrigin,
            accessToken: async () => "token",
            identity: async () => hostedIdentity(workspaceId),
            cloud: (options) =>
              new CloudClient({
                apiUrl: options.apiOrigin,
                accessToken: options.accessToken,
                accessTokenProvider: options.accessTokenProvider,
                fetch: fetchMock
              }),
            connector: () => {
              counts.target += 1;
              throw new Error("target must not be constructed");
            },
            stdout: { write: () => true },
            stderr: { write: () => true }
          }
        ),
      "SELECTION_TENANT_MISMATCH"
    );
    expect(counts).toEqual({ quote: 1, create: 1, target: 0, capabilities: 1 });
    expect(error.details?.["expected_workspace_id"]).toBe(FIXTURE_WORKSPACE);
    expect(error.details?.["actual_workspace_id"]).toBe(OTHER_WORKSPACE);
    expectSecretSafe(error.toSafeJSON());
    const paths = executionPaths(stateDirectory, manifest.manifestHash);
    const names = await readdir(join(paths.root, "executions"));
    const saved = JSON.parse(
      await readFile(join(paths.root, "executions", names[0]!), "utf8")
    ) as {
      remainingCredits: number;
      state: string;
      tenant: { workspace_id: string };
      shards: Array<{ state: string; runId: string | null }>;
    };
    expect(saved.tenant.workspace_id).toBe(FIXTURE_WORKSPACE);
    expect(saved.remainingCredits).toBe(70);
    expect(saved.shards[0]?.state).toBe("completed");
    expect(saved.shards[0]?.runId).toBe("run-shard-0");
    expect(saved.shards[1]?.state).toBe("pending");
    expect(saved.state).toBe("interrupted");
    expect(error.category).toBe("auth");
    expect(error.toSafeJSON()["code"]).toBe("SELECTION_TENANT_MISMATCH");
  });

  it("allows a same-tenant token rotation and still refuses a later connector switch", async () => {
    const cwd = await stateDir();
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest(baseManifest().manifestHash);
    await writeFile(join(cwd, "suite-selection.manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
    let connectorId = FIXTURE_CONNECTOR;
    let tokens = 0;
    const apiOrigin = new URL("http://127.0.0.1:8787/");
    const counts = { quote: 0, create: 0 };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(billingFixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        counts.quote += 1;
        const quote = billingFixtures.fixtures["quote_success_with_balance"]?.response;
        return Response.json({
          ...((quote ?? {}) as object),
          quoteId: counts.quote === 1 ? "55555555-5555-4555-8555-555555555555" : "66666666-6666-4666-8666-666666666666",
          executionUnits: 4
        });
      }
      if (url.pathname === "/v1/relay/runs" && (init?.method ?? "GET") === "POST") {
        counts.create += 1;
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const runId = counts.create === 1 ? "run-rot-0" : "run-rot-1";
        return Response.json(createRunJson(request, runId, apiOrigin));
      }
      if (url.pathname.startsWith("/v1/relay/runs/run-rot-")) {
        const runId = url.pathname.split("/").pop()!;
        connectorId = "connector-other";
        return Response.json(runStatusJson(runId, apiOrigin));
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const error = await expectAsyncCode(
      () =>
        runTest(
          {
            manifest: "suite-selection.manifest.json",
            allShards: true,
            maxCredits: "20",
            yes: true,
            cwd,
            stateDirectory,
            handleSignals: false,
            env: { CI: "1", AUGMENTWORKS_API_URL: apiOrigin.origin }
          },
          {
            doctor: doctorFor(),
            apiOrigin: () => apiOrigin,
            accessToken: async () => {
              tokens += 1;
              return `rotated-token-${String(tokens)}`;
            },
            identity: async () => hostedIdentity(FIXTURE_WORKSPACE, connectorId),
            cloud: (options) =>
              new CloudClient({
                apiUrl: options.apiOrigin,
                accessToken: options.accessToken,
                accessTokenProvider: options.accessTokenProvider,
                fetch: fetchMock
              }),
            connector: () => {
              throw new Error("target must not be constructed");
            },
            stdout: { write: () => true },
            stderr: { write: () => true }
          }
        ),
      "SELECTION_TENANT_MISMATCH"
    );
    expect(counts.quote).toBe(1);
    expect(counts.create).toBe(1);
    expect(error.details?.["expected_workspace_id"]).toBe(FIXTURE_WORKSPACE);
    expectSecretSafe(error.toSafeJSON());
  });

  it("denies a foreign-workspace manifest after authenticate and before any quote", async () => {
    const cwd = await stateDir();
    const stateDirectory = await stateDir();
    const manifest = {
      ...twoShardManifest(baseManifest().manifestHash),
      workspaceId: OTHER_WORKSPACE
    };
    await writeFile(join(cwd, "suite-selection.manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
    const counts = { quote: 0, create: 0, target: 0 };
    const apiOrigin = new URL("http://127.0.0.1:8787/");
    const error = await expectAsyncCode(
      () =>
        runTest(
          {
            manifest: "suite-selection.manifest.json",
            allShards: true,
            maxCredits: "20",
            yes: true,
            cwd,
            stateDirectory,
            handleSignals: false,
            env: { CI: "1", AUGMENTWORKS_API_URL: apiOrigin.origin }
          },
          {
            doctor: doctorFor(),
            apiOrigin: () => apiOrigin,
            accessToken: async () => "token",
            identity: async () => hostedIdentity(),
            cloud: (options) =>
              new CloudClient({
                apiUrl: options.apiOrigin,
                accessToken: options.accessToken,
                accessTokenProvider: options.accessTokenProvider,
                fetch: async (input) => {
                  const url = new URL(String(input));
                  if (url.pathname === "/v1/billing/quote") counts.quote += 1;
                  if (url.pathname === "/v1/relay/runs") counts.create += 1;
                  throw new Error(`unexpected ${url.pathname}`);
                }
              }),
            connector: () => {
              counts.target += 1;
              throw new Error("target must not be constructed");
            },
            stdout: { write: () => true },
            stderr: { write: () => true }
          }
        ),
      "SELECTION_TENANT_MISMATCH"
    );
    expect(counts).toEqual({ quote: 0, create: 0, target: 0 });
    expect(error.details?.["expected_workspace_id"]).toBe(OTHER_WORKSPACE);
    expect(error.details?.["actual_workspace_id"]).toBe(FIXTURE_WORKSPACE);
    expectSecretSafe(error.toSafeJSON());
  });

  it("marks unused all-pending v1 progress migrated without quoting or relabeling spend", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest(baseManifest().manifestHash);
    const first = manifest.shards[0]!;
    const v1 = {
      schemaVersion: "aw-selection-progress/1",
      manifestHash: manifest.manifestHash,
      aggregateMaxCredits: 8,
      remainingCredits: 8,
      stoppedReason: null,
      shards: [
        {
          shardId: first.shardId,
          shardIdentityHash: first.shardIdentityHash,
          status: "pending"
        },
        {
          shardId: "shard-001",
          shardIdentityHash: "c".repeat(64),
          status: "pending"
        }
      ]
    };
    const paths = executionPaths(stateDirectory, manifest.manifestHash);
    await mkdir(join(stateDirectory, "selections"), { recursive: true, mode: 0o700 });
    await writeFile(paths.v1Progress, `${JSON.stringify(v1)}\n`, { mode: 0o600 });
    const opened = await openExec({ stateDirectory, manifest, aggregateMaxCredits: 8 });
    expect(opened.kind).toBe("created");
    expect(opened.execution.tenant.workspace_id).toBe(FIXTURE_WORKSPACE);
    expect(opened.execution.shards.every((shard) => shard.state === "pending")).toBe(true);
    expect(opened.execution.remainingCredits).toBe(8);
    const index = JSON.parse(await readFile(paths.index, "utf8")) as {
      documentKind: string;
      v1Migrated: boolean;
      tenant: { workspace_id: string };
    };
    expect(index.documentKind).toBe("aw-selection-execution-index/3");
    expect(index.v1Migrated).toBe(true);
    expect(index.tenant.workspace_id).toBe(FIXTURE_WORKSPACE);
    await opened.lock.release();
  });

  it("allows a new execution after a terminal attempt when the current tenant differs", async () => {
    const stateDirectory = await stateDir();
    const manifest = twoShardManifest();
    const first = await openExec({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 8,
      createExecutionId: () => "11111111-1111-4111-8111-111111111111"
    });
    let execution = completeShard(first.execution, "shard-000", {
      runId: "run-a",
      quoteId: "quote-a",
      units: 4
    });
    execution = completeShard(execution, "shard-001", {
      runId: "run-b",
      quoteId: "quote-b",
      units: 4
    });
    await saveSelectionExecution(first.paths, execution);
    await first.lock.release();
    const second = await openSelectionExecution({
      stateDirectory,
      manifest,
      aggregateMaxCredits: 8,
      tenant: fixtureTenant(OTHER_WORKSPACE),
      createExecutionId: () => "22222222-2222-4222-8222-222222222222"
    });
    expect(second.kind).toBe("rerun");
    expect(second.execution.tenant.workspace_id).toBe(OTHER_WORKSPACE);
    expect(second.execution.shards.every((shard) => shard.runId === null)).toBe(true);
    await second.lock.release();
  });

  it("completes a saved v2 suite run against an HTML 404 fallback", async () => {
    const cwd = await stateDir();
    const stateDirectory = await stateDir();
    const manifest = savedSuiteManifest();
    await writeFile(join(cwd, "suite-selection.manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
    const apiOrigin = new URL("http://127.0.0.1:8787/");
    const paths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/v1/billing/capabilities") {
        return Response.json(billingFixtures.fixtures["eligible_trial"]?.response);
      }
      if (url.pathname === "/v1/billing/quote") {
        return Response.json(billingFixtures.fixtures["quote_success_with_balance"]?.response);
      }
      if (url.pathname === "/v1/relay/runs" && (init?.method ?? "GET") === "POST") {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          ...createRunJson(request, "run-saved-v2", apiOrigin),
          status: "running"
        });
      }
      if (url.pathname === `/v1/suites/${SUITE_ID}/revisions/${SUITE_REVISION}`) {
        return Response.json({
          suiteId: SUITE_ID,
          revisionId: SUITE_REVISION,
          contentHash: CANONICAL_HASH,
          canonicalDocument: { schemaVersion: "aw-customer-suite/2", syntheticOnly: false }
        });
      }
      const missing = "<!DOCTYPE html><html><body>404: This page could not be found.</body></html>";
      return new Response(missing, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    });
    const result = await runTest(
      {
        manifest: "suite-selection.manifest.json",
        allShards: true,
        maxCredits: "100",
        yes: true,
        cwd,
        stateDirectory,
        handleSignals: false,
        env: { CI: "1", AUGMENTWORKS_API_URL: apiOrigin.origin }
      },
      {
        doctor: doctorFor(),
        apiOrigin: () => apiOrigin,
        accessToken: async () => "token",
        identity: async () => hostedIdentity(),
        cloud: (options) =>
          new CloudClient({
            apiUrl: options.apiOrigin,
            accessToken: options.accessToken,
            accessTokenProvider: options.accessTokenProvider,
            fetch: fetchMock
          }),
        runner: () =>
          ({
            run: async () => runStatusJson("run-saved-v2", apiOrigin),
            requestCancellation: async () => {
              throw new Error("saved suite run must not cancel");
            }
          }) as unknown as RelayRunner,
        stdout: { write: () => true },
        stderr: { write: () => true }
      }
    );
    expect(result.binding.run_id).toBe("run-saved-v2");
    expect(result.run.status).toBe("completed");
    expect(paths.some((path) => path.includes("execution-scope"))).toBe(false);
  });
});
