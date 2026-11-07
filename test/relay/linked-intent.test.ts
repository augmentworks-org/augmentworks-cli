import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CreateRunIntentRequest } from "../../src/relay/run-intent.js";
import { RunIntentStore } from "../../src/relay/run-intent.js";

const originalId = `crq_${"a".repeat(32)}`;
const otherId = `crq_${"b".repeat(32)}`;
const request = {
  protocol_version: "aw-relay/0.3",
  packet: { key: "response-quality", version: "0.1.0" },
  config_sha256: "a".repeat(64),
  target: {
    name: "staging",
    boundary_sha256: "b".repeat(64),
    capabilities: {
      prepare: false,
      observation: false,
      cleanup: false,
      tool_events: false,
      observation_keys: []
    }
  },
  assessment: {
    plan_hash: "c".repeat(64),
    profile: "quick",
    evaluation_mode: "hybrid",
    disclosure_version: null,
    reference_bundle: {
      bundleId: "fixture",
      entries: [],
      refundPolicy: null,
      knowledgeBoundary: null,
      targetAlreadyConfigured: true
    }
  },
  ci_admission_id: "10000000-0000-4000-8000-000000000016",
  quote_id: "55555555-5555-4555-8555-555555555555",
  max_credits: 8
} satisfies CreateRunIntentRequest;

describe("platform-issued relay intent", () => {
  let stateDirectory: string;
  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "aw-linked-intent-"));
  });
  afterEach(async () => {
    await rm(stateDirectory, { recursive: true, force: true });
  });

  function store(linkedCreateRequestId?: string) {
    return new RunIntentStore({
      apiOrigin: new URL("https://api.example.test"),
      stateDirectory,
      tenant: { workspace_id: "workspace", connector_id: "connector" },
      ...(linkedCreateRequestId === undefined ? {} : { linkedCreateRequestId })
    });
  }

  it("locks by logical CI request without adopting another CI or interactive run", async () => {
    const first = await store(originalId).open();
    const second = await store(otherId).open();
    const interactive = await store().open();
    try {
      await expect(store(originalId).open()).rejects.toMatchObject({ code: "RUN_INTENT_LOCKED" });
      expect((await first.loadOrCreate(request)).intent.request.create_request_id).toBe(originalId);
      expect((await second.loadOrCreate(request)).intent.request.create_request_id).toBe(otherId);
      const { ci_admission_id: _id, ...unlinked } = request;
      await expect(interactive.loadOrCreate(request)).rejects.toMatchObject({ code: "LINKED_RUN_INTENT_CONFLICT" });
      const ordinary = await interactive.loadOrCreate(unlinked);
      expect([originalId, otherId]).not.toContain(ordinary.intent.request.create_request_id);
    } finally {
      await Promise.all([first.close(), second.close(), interactive.close()]);
    }
  });

  it("resumes the exact body and refuses quote, cap or target changes", async () => {
    const first = await store(originalId).open();
    const saved = await first.loadOrCreate(request);
    await first.close();
    const replay = await store(originalId).open();
    try {
      for (const change of [
        { max_credits: 9 },
        { ci_admission_id: "10000000-0000-4000-8000-000000000017" },
        { quote_id: "44444444-4444-4444-8444-444444444444" },
        { target: { ...request.target, boundary_sha256: "d".repeat(64) } }
      ]) {
        await expect(replay.loadOrCreate({ ...request, ...change })).rejects.toMatchObject({
          code: "LINKED_RUN_INTENT_CONFLICT"
        });
      }
      expect(await replay.loadOrCreate(request)).toEqual({ intent: saved.intent, resumed: true });
    } finally {
      await replay.close();
    }
  });

  it("recognizes an archived terminal run even after another restart mid-recovery", async () => {
    const first = await store(originalId).open();
    const { intent } = await first.loadOrCreate(request);
    await first.bind({
      protocol_version: "aw-relay/0.3",
      create_request_id: originalId,
      create_request_sha256: intent.request_sha256,
      create_disposition: "created",
      run_id: "run-a",
      session_id: "session-a",
      packet: { ...request.packet, sha256: "e".repeat(64) },
      config_sha256: request.config_sha256,
      fencing_epoch: 1,
      status: "completed",
      dashboard_url: "https://example.test/portal/runs/run-a",
      run_expires_at: "2030-01-01T00:00:00.000Z",
      credit_state: "consumed"
    });
    await first.removeTerminal({
      protocol_version: "aw-relay/0.1",
      run_id: "run-a",
      status: "completed",
      credit_state: "consumed"
    });
    await first.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = await store(originalId).open();
      try {
        await expect(retry.loadOrCreate({ ...request, max_credits: 9 })).rejects.toMatchObject({
          code: "LINKED_RUN_INTENT_CONFLICT"
        });
        expect((await retry.loadOrCreate(request)).archivedRunId).toBe("run-a");
      } finally {
        await retry.close();
      }
    }
  });

  it("refuses a retired uncreated request and requires an explicit valid platform key", async () => {
    expect(() => store("../sensitive")).toThrow(
      expect.objectContaining({ code: "INVALID_LINKED_CREATE_REQUEST_ID" })
    );
    const first = await store(originalId).open();
    try {
      await first.loadOrCreate(request);
      await first.retirePendingUncreated("retired_uncreated");
      await expect(first.loadOrCreate(request)).rejects.toMatchObject({
        code: "LINKED_RUN_INTENT_RETIRED"
      });
      expect(first.intent).toBeUndefined();
    } finally {
      await first.close();
    }
  });
});
