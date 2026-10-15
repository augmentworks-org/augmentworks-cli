import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { LineCounter, parseDocument } from "yaml";
import { z } from "zod";

import { parseYamlStrict, StrictYamlError } from "../config/yaml.js";
import { AwError } from "../errors.js";
import { sameFileIdentity } from "../system/file-identity.js";
import { findUnsafeSymbolicLinkComponent } from "../system/path-safety.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import { suiteError } from "./errors.js";
import { canonicalLiveTarget } from "./live-target.js";
import {
  CustomerSuiteSchema,
  MAX_SUITE_FILE_BYTES,
  MAX_SUITE_REFERENCE_BYTES_TOTAL,
  customerSuiteSchemaVersion,
  isSupportedSuiteSchemaVersion,
  policyWindowContradiction,
  rewriteAuthoringKeys,
  SUITE_SCHEMA_VERSION,
  SUITE_SCHEMA_VERSION_V2,
  SUITE_SCHEMA_VERSION_V3,
  type CustomerSuite,
  type SuiteReference
} from "./schema.js";

export type SuiteDiagnostic = {
  readonly path: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
};

export type LoadedSuiteReference = {
  readonly id: string;
  readonly kind: SuiteReference["kind"];
  readonly path?: string;
  readonly content: string;
  readonly contentHash: string;
  readonly bytes: number;
};

export type LoadedCustomerSuite = {
  readonly sourcePath: string;
  readonly directory: string;
  readonly sourceBytes: number;
  readonly yamlSha256: string;
  readonly document: CustomerSuite;
  readonly canonicalDocument: Record<string, unknown>;
  readonly contentHash: string;
  readonly references: readonly LoadedSuiteReference[];
  readonly diagnostics: readonly SuiteDiagnostic[];
};

const CREDENTIAL_KEY =
  /(?:api[_-]?key|secret|password|token|credential|private[_-]?key|anthropic|judge[_-]?key|grader[_-]?key)/iu;
const UNSUPPORTED_FEATURE =
  /history_array_v1|\.js\b|\.mjs\b|\.cjs\b|\.sh\b|\.py\b|javascript|shell_script|executable|python_script/iu;

function formatZodIssue(issue: z.ZodIssue): string {
  const loc = issue.path.length > 0 ? issue.path.join(".") : "root";
  return `${loc}: ${issue.message}`;
}

function issueField(issue: z.ZodIssue): string | undefined {
  if (issue.path.length > 0) return issue.path.join(".");
  const unrecognized = /unrecognized key:? ["']?([A-Za-z0-9_.-]+)/iu.exec(issue.message);
  return unrecognized?.[1];
}

function firstLineOf(text: string, needle: string): number | undefined {
  const index = text.indexOf(needle);
  if (index < 0) return undefined;
  return text.slice(0, index).split(/\r?\n/).length;
}

function yamlLineForPath(text: string, issuePath: readonly PropertyKey[]): number | undefined {
  const last = issuePath[issuePath.length - 1];
  if (typeof last === "string") {
    return firstLineOf(text, `${last}:`) ?? firstLineOf(text, last);
  }
  return undefined;
}

async function assertSafeRegularFile(path: string, label: string): Promise<void> {
  try {
    if ((await findUnsafeSymbolicLinkComponent(path)) !== undefined) {
      throw suiteError("SUITE_NOT_A_FILE", `The ${label} path cannot contain symbolic links.`, { path });
    }
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw suiteError(
        "SUITE_NOT_A_FILE",
        `The ${label} must be a regular file and cannot be a symbolic link.`,
        { path }
      );
    }
  } catch (error) {
    if (error instanceof AwError) throw error;
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw suiteError(
      missing ? "SUITE_NOT_FOUND" : "SUITE_NOT_A_FILE",
      missing ? `${label} not found: ${path}` : `Could not inspect ${label}: ${path}`,
      { path },
      error
    );
  }
}

async function readBoundedUtf8File(path: string, limit: number, label: string): Promise<Buffer> {
  let handle;
  try {
    const beforeOpen = await lstat(path);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
      throw suiteError("SUITE_NOT_A_FILE", `The ${label} must be a regular file and cannot be a symbolic link.`);
    }
    if (beforeOpen.size > limit) {
      throw suiteError(
        "SUITE_TOO_LARGE",
        `${label} cannot exceed ${String(limit)} bytes (${String(beforeOpen.size)} bytes).`,
        { path, bytes: beforeOpen.size }
      );
    }
    const noFollow =
      process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const metadata = await handle.stat();
    if (!metadata.isFile() || !sameFileIdentity(metadata, beforeOpen)) {
      throw suiteError("SUITE_NOT_A_FILE", `The ${label} changed while it was being opened.`, { path });
    }
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) {
      throw suiteError("SUITE_TOO_LARGE", `${label} cannot exceed ${String(limit)} bytes.`, { path });
    }
    const slice = bytes.subarray(0, offset);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(slice);
    } catch (cause) {
      throw suiteError("SUITE_NOT_UTF8", `The ${label} is not valid UTF-8.`, { path }, cause);
    }
    return Buffer.from(slice);
  } catch (error) {
    if (error instanceof AwError) throw error;
    throw suiteError("SUITE_READ_FAILED", `Could not read ${label}: ${path}`, { path }, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertPathInside(root: string, candidate: string, label: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath === "" || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw suiteError(
      "SUITE_PATH_ESCAPE",
      `Reference ${label} must stay under the suite directory.`,
      { path: label }
    );
  }
}

function rejectCredentialMaterial(value: unknown, trail = "root"): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectCredentialMaterial(child, `${trail}[${String(index)}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEY.test(key)) {
      throw suiteError(
        "SUITE_CREDENTIAL_FORBIDDEN",
        `Customer suite files cannot contain judging credentials or secret material (${trail}.${key}).`,
        { field: `${trail}.${key}` }
      );
    }
    rejectCredentialMaterial(child, `${trail}.${key}`);
  }
}

function parseAuthoringDocument(text: string, sourcePath: string): unknown {
  const lower = sourcePath.toLowerCase();
  if (lower.endsWith(".json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw suiteError("SUITE_JSON_INVALID", `Suite JSON is invalid: ${(error as Error).message}`, {
        path: sourcePath
      });
    }
  }
  if (!lower.endsWith(".yaml") && !lower.endsWith(".yml")) {
    throw suiteError(
      "SUITE_UNSUPPORTED_EXTENSION",
      `Customer suite files must use .yaml, .yml, or .json (${sourcePath}).`,
      { path: sourcePath }
    );
  }
  const lineCounter = new LineCounter();
  const document = parseDocument(text, {
    prettyErrors: true,
    lineCounter,
    uniqueKeys: true,
    strict: true
  });
  if (document.errors.length > 0) {
    const first = document.errors[0]!;
    const duplicate = first.code === "DUPLICATE_KEY";
    throw suiteError(
      duplicate ? "SUITE_DUPLICATE_KEY" : "SUITE_YAML_INVALID",
      `Suite YAML is invalid: ${first.message}`,
      {
        path: sourcePath,
        ...(first.linePos?.[0]?.line === undefined ? {} : { line: first.linePos[0].line }),
        ...(first.linePos?.[0]?.col === undefined ? {} : { column: first.linePos[0].col })
      }
    );
  }
  try {
    return parseYamlStrict(text);
  } catch (error) {
    if (error instanceof StrictYamlError) {
      throw suiteError(error.code === "YAML_DUPLICATE_KEY" ? "SUITE_DUPLICATE_KEY" : "SUITE_YAML_INVALID", error.message, {
        path: sourcePath
      });
    }
    throw suiteError("SUITE_YAML_INVALID", "The suite file is not valid YAML.", { path: sourcePath }, error);
  }
}

async function loadReferenceContents(
  suiteDir: string,
  document: CustomerSuite
): Promise<LoadedSuiteReference[]> {
  const loaded: LoadedSuiteReference[] = [];
  let totalBytes = 0;
  for (const reference of document.references ?? []) {
    if (reference.path !== undefined) {
      const absolute = resolve(suiteDir, reference.path);
      assertPathInside(suiteDir, absolute, reference.path);
      await assertSafeRegularFile(absolute, `reference ${reference.id}`);
      const remaining = MAX_SUITE_REFERENCE_BYTES_TOTAL - totalBytes;
      if (remaining <= 0) {
        throw suiteError(
          "SUITE_REFERENCE_TOO_LARGE",
          `Suite references cannot exceed ${String(MAX_SUITE_REFERENCE_BYTES_TOTAL)} bytes UTF-8 in total.`
        );
      }
      const bytes = await readBoundedUtf8File(absolute, remaining, `reference ${reference.id}`);
      if (bytes.includes(0)) {
        throw suiteError(
          "SUITE_REFERENCE_BINARY",
          `Reference ${reference.id} contains binary data.`,
          { field: reference.id }
        );
      }
      totalBytes += bytes.byteLength;
      const content = bytes.toString("utf8");
      loaded.push({
        id: reference.id,
        kind: reference.kind,
        path: reference.path,
        content,
        contentHash: sha256(bytes),
        bytes: bytes.byteLength
      });
      continue;
    }
    const content = reference.content ?? "";
    const encoded = Buffer.from(content, "utf8");
    totalBytes += encoded.byteLength;
    if (totalBytes > MAX_SUITE_REFERENCE_BYTES_TOTAL) {
      throw suiteError(
        "SUITE_REFERENCE_TOO_LARGE",
        `Suite references cannot exceed ${String(MAX_SUITE_REFERENCE_BYTES_TOTAL)} bytes UTF-8 in total.`
      );
    }
    loaded.push({
      id: reference.id,
      kind: reference.kind,
      content,
      contentHash: sha256(encoded),
      bytes: encoded.byteLength
    });
  }
  return loaded;
}

function canonicalSuiteDocument(
  document: CustomerSuite,
  references: readonly LoadedSuiteReference[]
): Record<string, unknown> {
  return {
    schemaVersion: document.schemaVersion,
    suiteId: document.suiteId,
    title: document.title,
    ...(document.description === undefined ? {} : { description: document.description }),
    ...(document.tags === undefined ? {} : { tags: document.tags }),
    ...("syntheticOnly" in document && document.syntheticOnly !== undefined
      ? { syntheticOnly: document.syntheticOnly }
      : {}),
    ...("liveTarget" in document ? { liveTarget: canonicalLiveTarget(document.liveTarget) } : {}),
    ...("executionScope" in document ? { executionScope: document.executionScope } : {}),
    cases: document.cases,
    references: references.map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      ...(reference.path === undefined ? {} : { path: reference.path }),
      content: reference.content,
      contentHash: reference.contentHash
    }))
  };
}

function classifySchemaFailure(issues: readonly z.ZodIssue[]): string {
  if (issues.some((issue) => /duplicate case id/i.test(issue.message))) return "SUITE_DUPLICATE_CASE_ID";
  if (issues.some((issue) => /duplicate (criterion|reference) id/i.test(issue.message))) {
    return "SUITE_DUPLICATE_ID";
  }
  if (issues.some((issue) => /missing reference/i.test(issue.message))) return "SUITE_MISSING_REFERENCE";
  if (issues.some((issue) => /unsupported deterministic observation/i.test(issue.message))) {
    return "SUITE_UNSUPPORTED_FEATURE";
  }
  if (
    issues.some((issue) =>
      /live informational|canonical HTTPS origin|live origin|one turn|one repetition/i.test(issue.message)
    )
  ) {
    return "LIVE_TARGET_SCOPE_MISMATCH";
  }
  return "SUITE_INVALID_FIELD";
}

export async function loadCustomerSuiteFile(filePath: string, cwd = process.cwd()): Promise<LoadedCustomerSuite> {
  const absolute = resolve(cwd, filePath);
  await assertSafeRegularFile(absolute, "Customer suite");
  const bytes = await readBoundedUtf8File(absolute, MAX_SUITE_FILE_BYTES, "Customer suite");
  const text = bytes.toString("utf8");
  const parsed = parseAuthoringDocument(text, absolute);
  rejectCredentialMaterial(parsed);

  const version = customerSuiteSchemaVersion(parsed);
  if (version === "aw-assessment-file/1") {
    throw suiteError(
      "SUITE_ASSESSMENT_FILE",
      "This file is an aw-assessment-file/1 assessment, not a customer suite. Use --assessment, or author an aw-suite/1, aw-suite/2, or aw-suite/3 file.",
      { path: absolute }
    );
  }
  if (typeof version === "string" && version.startsWith("aw-packet/")) {
    throw suiteError(
      "SUITE_PACKET_FILE",
      "This file is a local packet, not a customer suite. Use test --local --packet, or author an aw-suite/1, aw-suite/2, or aw-suite/3 file.",
      { path: absolute }
    );
  }
  if (typeof version === "string" && !isSupportedSuiteSchemaVersion(version)) {
    throw suiteError(
      "SUITE_UNSUPPORTED_SCHEMA",
      `Unsupported schema version "${version}". This CLI admits ${SUITE_SCHEMA_VERSION}, ${SUITE_SCHEMA_VERSION_V2}, and ${SUITE_SCHEMA_VERSION_V3}. Unknown versions fail closed and are never downgraded to synthetic.`,
      {
        path: absolute,
        ...(firstLineOf(text, "schema_version") === undefined && firstLineOf(text, "schemaVersion") === undefined
          ? {}
          : { line: firstLineOf(text, "schema_version") ?? firstLineOf(text, "schemaVersion")! })
      }
    );
  }
  if (UNSUPPORTED_FEATURE.test(text)) {
    throw suiteError(
      "SUITE_UNSUPPORTED_FEATURE",
      "Unsupported hosted suite feature (executable script, history_array_v1, or similar). Customer suites admit YAML/JSON cases, references, tags, criteria, and (for aw-suite/1) deterministic observations only.",
      { path: absolute }
    );
  }

  const rewritten = rewriteAuthoringKeys(parsed);
  const result = CustomerSuiteSchema.safeParse(rewritten);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const message = result.error.issues.map(formatZodIssue).join("; ");
    const line = yamlLineForPath(text, issue.path);
    const field = issueField(issue);
    throw suiteError(classifySchemaFailure(result.error.issues), message, {
      path: absolute,
      ...(line === undefined ? {} : { line }),
      ...(field === undefined ? {} : { field })
    });
  }

  const directory = dirname(absolute);
  const references = await loadReferenceContents(directory, result.data);
  const contradiction = policyWindowContradiction([
    ...result.data.cases.flatMap((suiteCase) => suiteCase.expected.facts),
    ...result.data.cases.flatMap((suiteCase) =>
      suiteCase.criteria.flatMap((criterion) => [
        criterion.statement,
        ...(criterion.passConditions ?? []),
        ...(criterion.failConditions ?? [])
      ])
    ),
    ...references.map((reference) => reference.content)
  ]);
  if (contradiction !== undefined) {
    throw suiteError("SUITE_CONTRADICTORY_EXPECTATION", contradiction, { path: absolute });
  }

  const canonicalDocument = canonicalSuiteDocument(result.data, references);
  const contentHash = sha256(canonicalize(canonicalDocument));
  return {
    sourcePath: absolute,
    directory,
    sourceBytes: bytes.byteLength,
    yamlSha256: sha256(bytes),
    document: result.data,
    canonicalDocument,
    contentHash,
    references,
    diagnostics: []
  };
}

export function assertSuiteUnchanged(previous: LoadedCustomerSuite, current: LoadedCustomerSuite): void {
  if (previous.contentHash !== current.contentHash || previous.yamlSha256 !== current.yamlSha256) {
    throw suiteError(
      "SUITE_CHANGED_AFTER_QUOTE",
      "The customer suite file changed after the quote was issued. Re-run estimate or test so admission uses the same server-accepted revision; the CLI will not silently re-pin mutable content.",
      { previousHash: previous.contentHash, currentHash: current.contentHash }
    );
  }
}
