import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import { CiAdmissionUuidSchema as uuid, CreateRunRequestV3Schema, type CreateRunRequestV3 } from "../cloud/protocol.js";
import type { ResolvedConfig } from "../config/types.js";
import { AwError } from "../errors.js";
import { sameFileIdentity } from "../system/file-identity.js";
import { canonicalize, sha256 } from "../util/canonical.js";

const origin = z.string().max(2048).regex(/^https:\/\/[^/?#@\\\s]+$/).refine((value) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}).describe("Canonical HTTPS origin, without credentials, path, query or fragment.");

export const CiAdmissionSchema = z.object({
  schemaVersion: z.literal("aw-github-integration/1"),
  admissionId: uuid,
  createRequestId: CreateRunRequestV3Schema.shape.create_request_id,
  bindingId: uuid,
  baselineId: uuid.nullable(),
  operationId: uuid.nullable(),
  suiteRevisionId: uuid,
  quoteId: uuid,
  maxCredits: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  executionPlanDigest: z.string().regex(/^[0-9a-f]{64}$/),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("fixed"), origin }).strict(),
    z.object({
      kind: z.literal("verified_preview"),
      origin,
      deploymentId: z.string().max(128).regex(/^dpl_[A-Za-z0-9]+$/),
      testedRevision: z.string().regex(/^[0-9a-f]{40}$/)
    }).strict()
  ]),
  runId: uuid.nullable()
}).strict().describe("The platform's admitted or already-linked CI response. A file carries the binding; the relay independently authenticates and authorizes the caller.");

export type CiAdmission = z.infer<typeof CiAdmissionSchema>;

const MAX_ADMISSION_BYTES = 16 * 1024;

function invalidHandoff(): AwError {
  return new AwError({
    code: "CI_ADMISSION_INVALID",
    category: "config",
    message: "Expected a regular UTF-8 JSON file up to 16 KiB containing one aw-github-integration/1 admission response."
  });
}

export async function loadCiAdmission(file: string, cwd = process.cwd()): Promise<CiAdmission> {
  const path = resolve(cwd, file);
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.size > MAX_ADMISSION_BYTES) throw invalidHandoff();
    const flags = process.platform === "win32" ? constants.O_RDONLY :
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    handle = await open(path, flags);
    const actual = await handle.stat();
    if (!actual.isFile() || !sameFileIdentity(before, actual)) throw invalidHandoff();
    const bytes = Buffer.alloc(MAX_ADMISSION_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_ADMISSION_BYTES) throw invalidHandoff();
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    return CiAdmissionSchema.parse(JSON.parse(source));
  } catch {
    // Filesystem and parser errors can contain paths, raw file contents or credentials.
    throw invalidHandoff();
  } finally {
    await handle?.close();
  }
}

type CiExecutionPlan = Pick<CreateRunRequestV3, "protocol_version" | "packet" | "config_sha256" | "target" | "assessment">;

// Estimate and create hash exactly the same relay fields with the CLI's canonical
// JSON encoder. Authorization, quote identity and spend ceiling are bound separately.
export function ciExecutionPlanDigest(plan: CiExecutionPlan): string {
  const { protocol_version, packet, config_sha256, target, assessment } = plan;
  return sha256(canonicalize({ protocol_version, packet, config_sha256, target, assessment }));
}

export function assertCiExecutionPlan(admission: CiAdmission, plan: CiExecutionPlan): void {
  if (plan.assessment.suite_revision_id !== admission.suiteRevisionId ||
      ciExecutionPlanDigest(plan) !== admission.executionPlanDigest) {
    throw new AwError({
      code: "CI_ADMISSION_PLAN_MISMATCH",
      category: "config",
      message: "The local execution plan or saved suite revision differs from the CI admission. Use the originally approved inputs."
    });
  }
}

export function assertCiTarget(admission: CiAdmission, resolved: ResolvedConfig): void {
  // Config resolution and HttpConnector restrict every operation to this base origin;
  // the connector also rejects redirects. Never use the admission to change the target.
  const { baseUrl } = resolved;
  if (baseUrl.origin !== admission.target.origin || baseUrl.username || baseUrl.password) throw wrongTarget();
  for (const operation of Object.values(resolved.config.target.operations)) {
    if (operation === undefined) continue;
    const target = URL.parse(operation.path, baseUrl);
    if (!target || target.origin !== admission.target.origin || target.username || target.password) {
      throw wrongTarget();
    }
  }
}

function wrongTarget(): AwError {
  return new AwError({
    code: "CI_ADMISSION_TARGET_MISMATCH",
    category: "config",
    message: "The locally configured target origin differs from the CI admission. Use the originally approved deployment."
  });
}
