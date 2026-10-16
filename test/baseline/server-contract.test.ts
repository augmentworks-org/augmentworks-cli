import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CreateBaselineRequestSchema,
  normalizePromoteResponse,
  PromoteBaselineRequestSchema
} from "../../src/baseline/protocol.js";

// Server-produced documents vendored from main `docs/contracts/aw-feature-v1.fixtures.json`.
const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const producer = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-feature-v1.producer.fixtures.json"), "utf8")
) as { fixtures: Record<string, { valid: boolean; document: Record<string, unknown> }> };

function producerDocument(name: string): Record<string, unknown> {
  const entry = producer.fixtures[name];
  if (entry === undefined || !entry.valid) throw new Error(`missing valid producer fixture ${name}`);
  return structuredClone(entry.document);
}

describe("baseline requests and responses against the server's contract", () => {
  const runId = "22222222-2222-4222-8222-222222222222";

  it("promote sends runId and a revision of at least 1", () => {
    const base = { schemaVersion: "aw-release-policy/1", packageVersion: "aw-feature/1" } as const;
    expect(PromoteBaselineRequestSchema.safeParse({ ...base, runId, expectedPromotionRevision: 1 }).success).toBe(
      true
    );
    expect(
      PromoteBaselineRequestSchema.safeParse({ ...base, candidateRunId: runId, expectedPromotionRevision: 1 })
        .success
    ).toBe(false);
    expect(PromoteBaselineRequestSchema.safeParse({ ...base, runId, expectedPromotionRevision: 0 }).success).toBe(
      false
    );
  });

  it("create sends the fields the server requires", () => {
    expect(
      CreateBaselineRequestSchema.safeParse({
        schemaVersion: "aw-release-policy/1",
        packageVersion: "aw-feature/1",
        name: "main",
        applicationName: "support-bot",
        environmentName: "production",
        runId
      }).success
    ).toBe(true);
  });

  it("reads the saved baseline from the server's record envelope", () => {
    const record = producerDocument("baseline_record");
    const result = normalizePromoteResponse({ ok: true, record, createsBillableRun: false });
    expect(result.baselineId).toBe(record["baselineId"]);
    expect(result.runId).toBe(record["runId"]);
    expect(result.promotionRevision).toBe(record["promotionRevision"]);
    expect(result.createsBillableRun).toBe(false);
  });
});
