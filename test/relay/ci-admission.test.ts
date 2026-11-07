import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ciExecutionPlanDigest, CiAdmissionSchema, assertCiExecutionPlan, assertCiTarget, loadCiAdmission } from "../../src/relay/ci-admission.js";
import { resolvedFor } from "../investigation/helpers.js";

const example = new URL("../../examples/github-ci/admission.json", import.meta.url);
const schema = new URL("../../schemas/v1/github-ci-admission.schema.json", import.meta.url);
const admission = CiAdmissionSchema.parse(JSON.parse(await readFile(example, "utf8")));

// Synthetic cross-language test vector for the platform and runner.
const plan = {
  protocol_version: "aw-relay/0.3",
  config_sha256: "b".repeat(64),
  packet: { key: "response-quality", version: "0.1.0" },
  target: {
    name: "staging",
    boundary_sha256: "c".repeat(64),
    capabilities: { prepare: false, cleanup: false, observation: false, tool_events: false, observation_keys: [] }
  },
  assessment: {
    profile: "quick", plan_hash: "d".repeat(64), evaluation_mode: "deterministic", disclosure_version: null,
    suite_id: "returns", suite_revision_id: admission.suiteRevisionId, suite_content_hash: "e".repeat(64),
    reference_bundle: { bundleId: "returns", entries: [], refundPolicy: null, knowledgeBoundary: null, targetAlreadyConfigured: true }
  }
} satisfies Parameters<typeof ciExecutionPlanDigest>[0];

describe("GitHub CI admission handoff", () => {
  it("ships the response schema used by the runner and accepts the pinned platform example", async () => {
    const published = JSON.parse(await readFile(schema, "utf8"));
    expect(published).toEqual({ ...z.toJSONSchema(CiAdmissionSchema), $id: "schemas/v1/github-ci-admission.schema.json", title: "AugmentWorks GitHub CI admission" });
    expect(await loadCiAdmission("examples/github-ci/admission.json")).toEqual(admission);
    expect(CiAdmissionSchema.safeParse({ ...admission, target: { kind: "fixed", origin: "https://stage.example.test" }, runId: admission.admissionId }).success).toBe(true);
  });

  it.each([
    { schemaVersion: "aw-github-integration/2" }, { admissionId: "a" }, { runId: "local_run_123" },
    { createRequestId: "crq_x" }, { maxCredits: -1 }, { maxCredits: Number.MAX_SAFE_INTEGER + 1 },
    { scope: "unexpected" }, { executionPlanDigest: "changed" },
    { target: { kind: "fixed", origin: "https://staging.example.test/" } },
    { target: { kind: "fixed", origin: "https://user:secret@staging.example.test" } },
    { target: { kind: "fixed", origin: "http://staging.example.test" } },
    { target: { ...admission.target, kind: "verified_preview", deploymentId: "wrong" } }
  ])("rejects malformed or extended handoffs", (override) => {
    expect(CiAdmissionSchema.safeParse({ ...admission, ...override }).success).toBe(false);
  });

  it("bounds and redacts malformed file input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-admission-"));
    try {
      const path = join(directory, "aw_api_private");
      for (const bytes of [
        Buffer.from('{"token":"aw_api_private"}'),
        Buffer.concat([Buffer.from(JSON.stringify(admission)), Buffer.alloc(16 * 1024, 0x20)]),
        Buffer.from([0xc3, 0x28])
      ]) {
        await writeFile(path, bytes);
        const error = await loadCiAdmission(path).catch((error: unknown) => error);
        expect(error).toMatchObject({ code: "CI_ADMISSION_INVALID" });
        expect(String(error)).not.toContain("aw_api_private");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hashes the immutable execution fields independently of JSON key order and quote identity", () => {
    const approved = { ...admission, executionPlanDigest: "881a0b6ebec8447e17abd0e86aea52a37183f96a7e1bf219c1f9334c49b50c3d" };
    const fullCreate = { ...plan, packet: { version: plan.packet.version, key: plan.packet.key }, create_request_id: "another", ci_admission_id: "another", quote_id: "another", max_credits: 9 };
    expect(ciExecutionPlanDigest(fullCreate)).toBe(approved.executionPlanDigest);
    expect(() => assertCiExecutionPlan(approved, plan)).not.toThrow();
    for (const changed of [
      { ...plan, config_sha256: "a".repeat(64) },
      { ...plan, target: { ...plan.target, boundary_sha256: "a".repeat(64) } },
      { ...plan, assessment: { ...plan.assessment, selected_scenario_ids: ["one"] } },
      { ...plan, packet: { ...plan.packet, version: "0.2.0" } }
    ]) {
      expect(() => assertCiExecutionPlan(approved, changed)).toThrow(expect.objectContaining({ code: "CI_ADMISSION_PLAN_MISMATCH" }));
    }
    expect(() => assertCiExecutionPlan({ ...approved, suiteRevisionId: admission.bindingId }, plan)).toThrow();
  });

  it("compares the local origin and every enabled operation without applying remote URLs to the connector", () => {
    const local = resolvedFor({ prepare: true, observe: true, cleanup: true });
    const resolved = { ...local, baseUrl: new URL(admission.target.origin + "/agent/") };
    expect(() => assertCiTarget(admission, resolved)).not.toThrow();
    expect(() => assertCiTarget(admission, local)).toThrow(expect.objectContaining({ code: "CI_ADMISSION_TARGET_MISMATCH" }));
    for (const key of ["send", "observe", "prepare", "cleanup"] as const) {
      const operations = { ...local.config.target.operations, [key]: { ...local.config.target.operations[key]!, path: "//other.example.test/path" } };
      expect(() => assertCiTarget(admission, { ...resolved, config: { ...local.config, target: { ...local.config.target, operations } } })).toThrow(expect.objectContaining({ code: "CI_ADMISSION_TARGET_MISMATCH" }));
    }
    expect(resolved.baseUrl.href).toBe(admission.target.origin + "/agent/");
  });
});
