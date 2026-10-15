import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { AwError } from "../errors.js";
import { sameFileIdentity } from "../system/file-identity.js";
import { findUnsafeSymbolicLinkComponent } from "../system/path-safety.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import { parseYamlStrict, StrictYamlError } from "../config/yaml.js";
import type { Diagnostic } from "../config/types.js";
import { looksLikeCustomerSuiteDocument } from "../suite/schema.js";
import {
  ASSESSMENT_FILE_SCHEMA,
  AssessmentFileSchema,
  AssessmentProfileSchema,
  DISCLOSURE_VERSION,
  MAX_ASSESSMENT_FILE_BYTES,
  MAX_REFERENCE_BYTES_TOTAL,
  type AssessmentFile,
  type AssessmentProfile,
  type EvaluationMode,
  type LocalReferenceSpec,
  type PacketSelection
} from "./schema.js";

const CREDENTIAL_KEY =
  /(?:api[_-]?key|secret|password|token|credential|anthropic|judge[_-]?key|grader[_-]?key)/iu;

export interface LoadedLocalReference {
  readonly id: string;
  readonly kind: LocalReferenceSpec["kind"];
  readonly path: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly content: string;
}

export interface LoadedAssessment {
  readonly path: string;
  readonly directory: string;
  readonly document: AssessmentFile;
  readonly profile: AssessmentProfile;
  readonly evaluationMode: EvaluationMode;
  readonly yamlSha256: string;
  readonly freezeSha256: string;
  readonly disclosureVersion: string | null;
  readonly localReferences: readonly LoadedLocalReference[];
  readonly hostedReferenceIds: readonly string[];
}

export interface LoadAssessmentOptions {
  readonly path: string;
  readonly cwd?: string;
  readonly profile?: string;
}

export function parseAssessmentProfile(value: string): AssessmentProfile {
  const parsed = AssessmentProfileSchema.safeParse(value);
  if (!parsed.success) {
    throw assessmentError(
      "ASSESSMENT_PROFILE_INVALID",
      "Profile must be quick, full, combined, or custom."
    );
  }
  return parsed.data;
}

export async function loadAssessmentFile(
  options: LoadAssessmentOptions
): Promise<LoadedAssessment> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const assessmentPath = resolve(cwd, options.path);
  await assertSafeRegularFile(assessmentPath, "ASSESSMENT_FILE_INVALID", "assessment file");
  const bytes = await readBoundedUtf8File(
    assessmentPath,
    MAX_ASSESSMENT_FILE_BYTES,
    "ASSESSMENT_FILE_TOO_LARGE",
    "Assessment files cannot exceed 64 KiB.",
    "ASSESSMENT_FILE_INVALID"
  );
  const yamlSha256 = sha256(bytes);
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYamlStrict(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof StrictYamlError) {
      throw assessmentError(error.code, error.message);
    }
    throw assessmentError("ASSESSMENT_YAML_INVALID", "The assessment file is not valid YAML.", error);
  }
  rejectCredentialMaterial(parsedYaml);
  if (looksLikeCustomerSuiteDocument(parsedYaml)) {
    throw assessmentError(
      "ASSESSMENT_SUITE_FILE",
      "This file is an aw-suite/1, aw-suite/2, or aw-suite/3 customer suite, not an assessment file. Validate with `augmentworks suite validate` or run hosted with `augmentworks test --suite`."
    );
  }
  const parsed = AssessmentFileSchema.safeParse(parsedYaml);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "root";
    throw assessmentError(
      "ASSESSMENT_FILE_INVALID",
      `The assessment file is invalid at ${path}: ${issue?.message ?? "schema validation failed"}.`
    );
  }

  const profile = options.profile === undefined ? parsed.data.profile : parseAssessmentProfile(options.profile);
  const document: AssessmentFile = { ...parsed.data, profile };
  const directory = dirname(assessmentPath);
  const localSpecs = document.references?.local ?? [];
  const hostedReferenceIds = (document.references?.hosted ?? []).map((entry) => entry.id);
  const localReferences = await loadLocalReferences(directory, localSpecs);
  const freezeSha256 = sha256(
    canonicalize({
      schema_version: ASSESSMENT_FILE_SCHEMA,
      yaml_sha256: yamlSha256,
      profile: document.profile,
      evaluation_mode: document.evaluation_mode,
      packets: document.packets,
      parameters: document["parameters"] ?? {},
      selection: document.selection ?? null,
      references: {
        local: localReferences.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          path: entry.relativePath,
          sha256: entry.sha256
        })),
        hosted: hostedReferenceIds
      }
    })
  );

  return {
    path: assessmentPath,
    directory,
    document,
    profile: document.profile,
    evaluationMode: document.evaluation_mode,
    yamlSha256,
    freezeSha256,
    disclosureVersion: document.evaluation_mode === "hybrid" ? DISCLOSURE_VERSION : null,
    localReferences,
    hostedReferenceIds
  };
}

export function primaryPacket(assessment: LoadedAssessment): PacketSelection {
  const packet = assessment.document.packets[0];
  if (packet === undefined) {
    throw assessmentError("ASSESSMENT_FILE_INVALID", "The assessment file must select at least one packet.");
  }
  return packet;
}

export function assessmentDiagnostics(assessment: LoadedAssessment): Diagnostic[] {
  const referenceSummary =
    assessment.localReferences.length > 0
      ? assessment.localReferences
          .map((entry) => `${entry.relativePath}=${entry.sha256.slice(0, 12)}`)
          .join(", ")
      : assessment.hostedReferenceIds.length > 0
        ? `hosted ids ${assessment.hostedReferenceIds.join(", ")}`
        : "none";
  return [
    {
      level: "ok",
      code: "ASSESSMENT_FILE_VALID",
      message: `Assessment schema ${ASSESSMENT_FILE_SCHEMA} profile=${assessment.profile} mode=${assessment.evaluationMode}.`,
      path: assessment.path
    },
    {
      level: "ok",
      code: "ASSESSMENT_YAML_HASH",
      message: `Assessment YAML sha256 ${assessment.yamlSha256}.`
    },
    {
      level: "ok",
      code: "ASSESSMENT_REFERENCES",
      message: `Assessment references: ${referenceSummary}.`
    },
    {
      level: "ok",
      code: "ASSESSMENT_FREEZE_HASH",
      message: `Assessment freeze sha256 ${assessment.freezeSha256}.`
    },
    ...(assessment.document.selection === undefined
      ? []
      : [
          {
            level: "ok" as const,
            code: "ASSESSMENT_SELECTION",
            message: `Hosted selection profile=${assessment.document.selection.profile} (smoke/release compiler fields; not available in --local).`
          }
        ])
  ];
}

async function loadLocalReferences(
  directory: string,
  specs: readonly LocalReferenceSpec[]
): Promise<LoadedLocalReference[]> {
  const loaded: LoadedLocalReference[] = [];
  let totalBytes = 0;
  const ids = new Set<string>();
  for (const spec of specs) {
    if (ids.has(spec.id)) {
      throw assessmentError("ASSESSMENT_REFERENCE_DUPLICATE", `Duplicate reference id ${spec.id}.`);
    }
    ids.add(spec.id);
    const resolved = resolve(directory, spec.path);
    assertPathInside(directory, resolved, spec.path);
    await assertSafeRegularFile(resolved, "ASSESSMENT_REFERENCE_INVALID", "reference file");
    const contents = await readBoundedUtf8File(
      resolved,
      MAX_REFERENCE_BYTES_TOTAL - totalBytes,
      "ASSESSMENT_REFERENCE_TOO_LARGE",
      "Assessment reference files cannot exceed 64 KiB UTF-8 in total.",
      "ASSESSMENT_REFERENCE_INVALID"
    );
    if (contents.includes(0)) {
      throw assessmentError(
        "ASSESSMENT_REFERENCE_BINARY",
        `Reference ${spec.path} contains binary data.`
      );
    }
    totalBytes += contents.byteLength;
    loaded.push({
      id: spec.id,
      kind: spec.kind,
      path: resolved,
      relativePath: spec.path,
      sha256: sha256(contents),
      bytes: contents.byteLength,
      content: contents.toString("utf8")
    });
  }
  return loaded;
}

function assertPathInside(root: string, candidate: string, label: string): void {
  const relativePath = relative(root, candidate);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep.replace("\\", "/")}`)
  ) {
    throw assessmentError(
      "ASSESSMENT_REFERENCE_TRAVERSAL",
      `Reference ${label} must stay under the assessment directory.`
    );
  }
}

async function assertSafeRegularFile(
  path: string,
  code: string,
  label: string
): Promise<void> {
  try {
    if ((await findUnsafeSymbolicLinkComponent(path)) !== undefined) {
      throw assessmentError(code, `The ${label} path cannot contain symbolic links.`);
    }
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw assessmentError(code, `The ${label} must be a regular file and cannot be a symbolic link.`);
    }
  } catch (error) {
    if (error instanceof AwError) throw error;
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw assessmentError(
      missing ? `${code.replace(/_INVALID$/, "_NOT_FOUND")}` : code,
      missing ? `${label} not found: ${path}` : `Could not inspect ${label}: ${path}`,
      error
    );
  }
}

async function readBoundedUtf8File(
  path: string,
  limit: number,
  tooLargeCode: string,
  tooLargeMessage: string,
  invalidCode: string
): Promise<Buffer> {
  let handle;
  try {
    const beforeOpen = await lstat(path);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
      throw assessmentError(invalidCode, "The path must be a regular file and cannot be a symbolic link.");
    }
    if (beforeOpen.size > limit) {
      throw assessmentError(tooLargeCode, tooLargeMessage);
    }
    const noFollow =
      process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number"
        ? constants.O_NOFOLLOW
        : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const metadata = await handle.stat();
    if (!metadata.isFile() || !sameFileIdentity(metadata, beforeOpen)) {
      throw assessmentError(invalidCode, "The file changed while it was being opened.");
    }
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) {
      throw assessmentError(tooLargeCode, tooLargeMessage);
    }
    const slice = bytes.subarray(0, offset);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(slice);
    } catch (cause) {
      throw assessmentError(invalidCode, "The file is not valid UTF-8.", cause);
    }
    return Buffer.from(slice);
  } catch (error) {
    if (error instanceof AwError) throw error;
    throw assessmentError(invalidCode, `Could not read ${path}.`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function rejectCredentialMaterial(value: unknown, path = "root"): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectCredentialMaterial(child, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEY.test(key)) {
      throw assessmentError(
        "ASSESSMENT_CREDENTIAL_FORBIDDEN",
        `Assessment files cannot contain judging credentials or secret material (${path}.${key}).`
      );
    }
    rejectCredentialMaterial(child, `${path}.${key}`);
  }
}

function assessmentError(code: string, message: string, cause?: unknown): AwError {
  return new AwError({ code, category: "config", message, cause });
}
