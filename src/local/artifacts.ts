import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { redactSecrets } from "../connector/mapping.js";
import { inspectOutbound, type DataPolicyContext } from "../data-policy/index.js";
import { AwError } from "../errors.js";
import { sameFileIdentity } from "../system/file-identity.js";
import { assertJsonLimits } from "../util/limits.js";
import { sha256Json } from "./canonical.js";
import { LOCAL_TRUST_NOTICE, renderLocalReportHtml } from "./report-html.js";
import { renderLocalReportJunit } from "./report-junit.js";
import type { LocalJson, LocalRunResult } from "./types.js";

const REPORT_JSON = "report.json";
const REPORT_JUNIT = "junit.xml";
const REPORT_HTML = "report.html";
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

const BOUNDARY_KEYS = new Set([
  "auth_headers",
  "base_url",
  "cause",
  "config_path",
  "environment",
  "headers",
  "operation_path",
  "operation_paths",
  "packet_path",
  "path",
  "raw_request",
  "raw_response",
  "stack",
  "url"
]);

export interface WriteLocalArtifactsOptions {
  readonly result: LocalRunResult;
  readonly outputDirectory: string;
  readonly secrets?: readonly string[];
  readonly dataPolicy?: DataPolicyContext;
}

export interface LocalArtifactPaths {
  readonly directory: string;
  readonly json: string;
  readonly junit: string;
  readonly html: string;
  readonly resultSha256: string;
  readonly safeResult: LocalRunResult;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export async function preflightLocalOutputDirectory(outputDirectory: string): Promise<string> {
  const directory = resolve(outputDirectory);
  try {
    await inspectSafeParent(dirname(directory));
    const metadata = await lstat(directory).catch((cause: unknown) => {
      if (isNodeError(cause, "ENOENT")) return undefined;
      throw cause;
    });
    if (metadata === undefined) return directory;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw unsafeOutput();
    throw new AwError({
      code: "LOCAL_OUTPUT_EXISTS",
      category: "config",
      message: "The local report output directory already exists; refusing to overwrite it."
    });
  } catch (cause) {
    if (cause instanceof AwError) throw cause;
    throw new AwError({
      code: "LOCAL_OUTPUT_PARENT_UNAVAILABLE",
      category: "config",
      message: "The local report parent directory is unavailable.",
      cause
    });
  }
}

export async function writeLocalArtifacts(
  options: WriteLocalArtifactsOptions
): Promise<LocalArtifactPaths> {
  const directory = resolve(options.outputDirectory);
  const withoutHash = projectLocalResult(
    prepareLocalResult(options.result, options.secrets ?? []),
    options.dataPolicy
  );
  assertJsonLimits(withoutHash, "local assessment result");
  const resultSha256 = sha256Json(withoutHash as LocalJson);
  const safeResult = { ...withoutHash, result_sha256: resultSha256 } as unknown as LocalRunResult;
  const json = `${JSON.stringify(safeResult, null, 2)}\n`;
  const junit = renderLocalReportJunit(safeResult, resultSha256);
  const html = renderLocalReportHtml(safeResult, resultSha256);
  const rendered = [
    { name: REPORT_JSON, content: json },
    { name: REPORT_JUNIT, content: junit },
    { name: REPORT_HTML, content: html }
  ] as const;
  for (const artifact of rendered) assertArtifactSize(artifact.name, artifact.content);

  const identity = await createFreshOutputDirectory(directory);
  const temporaryPaths: string[] = [];
  const ownedFiles = new Map<string, FileIdentity>();
  try {
    for (const artifact of rendered) {
      const temporary = resolve(
        directory,
        `.${artifact.name}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`
      );
      const fileIdentity = await writePrivateFile(temporary, artifact.content);
      temporaryPaths.push(temporary);
      ownedFiles.set(temporary, fileIdentity);
    }
    for (let index = 0; index < rendered.length; index += 1) {
      const temporary = temporaryPaths[index]!;
      const final = resolve(directory, rendered[index]!.name);
      await link(temporary, final);
      ownedFiles.set(final, ownedFiles.get(temporary)!);
    }
    for (const temporary of temporaryPaths) {
      await unlinkOwnedFile(temporary, ownedFiles.get(temporary)!);
      ownedFiles.delete(temporary);
    }
    await syncDirectory(directory);
  } catch (cause) {
    await removeOwnedOutput(directory, identity, ownedFiles);
    if (cause instanceof AwError) throw cause;
    throw new AwError({
      code: "LOCAL_REPORT_WRITE_FAILED",
      category: "local",
      message: "Could not safely publish the local assessment reports.",
      cause
    });
  }

  return {
    directory,
    json: resolve(directory, REPORT_JSON),
    junit: resolve(directory, REPORT_JUNIT),
    html: resolve(directory, REPORT_HTML),
    resultSha256,
    safeResult
  };
}

function prepareLocalResult(result: LocalRunResult, secrets: readonly string[]): Record<string, unknown> {
  const withoutBoundary = removeBoundaryFields(result, new WeakSet<object>());
  // The scorer distinguishes protocol structure from evidence text. Preserve
  // that distinction here: redacting the whole object would corrupt enums and
  // identifiers when a configured secret happens to equal a value such as
  // "passed". Arbitrary evidence JSON still receives recursive key/value
  // redaction through redactSecrets.
  const redacted = redactLocalEvidence(
    withoutBoundary as LocalRunResult,
    secrets
  ) as unknown as Record<string, unknown>;
  delete redacted["result_sha256"];
  const provenance = asRecord(redacted["provenance"]);
  return {
    ...redacted,
    schema_version: "AW-LOCAL-RESULT-1",
    provenance: {
      ...provenance,
      execution_mode: "local",
      executor: "customer_environment",
      platform_received: false,
      verification: "unverified",
      signature: null,
      trust_label: LOCAL_TRUST_NOTICE,
      customer_executed: true,
      augmentworks_verified: false,
      signed: false,
      managed_review: false,
      uploaded: false,
      cloud_contacted: false
    }
  };
}

function projectLocalResult(
  result: Record<string, unknown>,
  context: DataPolicyContext | undefined
): Record<string, unknown> {
  if (context === undefined) return result;
  const inspected = inspectOutbound(result, context.policy, context.profile, context.localSecrets);
  if (inspected.receipt.outcome === "blocked" || inspected.blockedPaths.length > 0) {
    throw new AwError({
      code: "DATA_POLICY_BLOCKED",
      category: "evidence",
      message: "The local report was blocked by the data policy. Evidence is unavailable.",
      retryable: false
    });
  }
  if (inspected.representation === null || typeof inspected.representation !== "object" || Array.isArray(inspected.representation)) {
    throw new AwError({
      code: "DATA_POLICY_BLOCKED",
      category: "evidence",
      message: "The local report could not be projected into a retained representation.",
      retryable: false
    });
  }
  return inspected.representation as Record<string, unknown>;
}

function redactLocalEvidence(result: LocalRunResult, secrets: readonly string[]): LocalRunResult {
  const redactText = (value: string): string => redactSecrets(value, secrets);
  result.packet.name = redactText(result.packet.name);
  result.target.name = redactText(result.target.name);
  for (const requirement of result.requirements) {
    requirement.statement = redactText(requirement.statement);
  }
  for (const scenarioResult of result.results) {
    scenarioResult.title = redactText(scenarioResult.title);
    scenarioResult.expected_behavior = redactText(scenarioResult.expected_behavior);
    scenarioResult.evaluator = redactText(scenarioResult.evaluator);
    scenarioResult.evidence_summary = redactText(scenarioResult.evidence_summary);
  }
  for (const finding of result.findings) {
    finding.title = redactText(finding.title);
    finding.description = redactText(finding.description);
  }
  for (const scenario of result.scenarios) {
    scenario.name = redactText(scenario.name);
    scenario.description = redactText(scenario.description);
    scenario.expected_behavior = redactText(scenario.expected_behavior);
  }
  for (const attempt of result.attempts) {
    for (const turn of attempt.turns) {
      turn.user_content = redactText(turn.user_content);
      if (typeof turn.assistant_content === "string") {
        turn.assistant_content = redactText(turn.assistant_content);
      }
      if (typeof turn.finish_reason === "string") {
        turn.finish_reason = redactText(turn.finish_reason);
      }
      for (const event of turn.events ?? []) {
        event.type = redactText(event.type);
        event.event_id = redactText(event.event_id);
        event.data = redactSecrets(event.data, secrets);
      }
    }
    for (const observation of attempt.observations) {
      observation.key = redactText(observation.key);
      observation.source = redactText(observation.source);
      observation.value = redactSecrets(observation.value, secrets);
    }
    for (const assertion of attempt.assertions) {
      assertion.description = redactText(assertion.description);
      assertion.actual = redactSecrets(assertion.actual, secrets);
    }
    for (const error of attempt.errors) {
      error.code = redactText(error.code);
      error.message = redactText(error.message);
    }
  }
  return result;
}

function removeBoundaryFields(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED:CYCLE]";
  seen.add(value);
  if (Array.isArray(value)) {
    const copy = value.map((child) => removeBoundaryFields(child, seen));
    seen.delete(value);
    return copy;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeKey(key);
    if (
      BOUNDARY_KEYS.has(normalized) ||
      normalized.endsWith("_path") ||
      normalized.endsWith("_url")
    ) {
      continue;
    }
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: removeBoundaryFields(child, seen)
    });
  }
  seen.delete(value);
  return copy;
}

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

async function createFreshOutputDirectory(path: string): Promise<{ dev: number; ino: number }> {
  const parent = dirname(path);
  try {
    await preflightLocalOutputDirectory(path);
    await ensureSafeParent(parent);
  } catch (cause) {
    if (cause instanceof AwError) throw cause;
    throw new AwError({
      code: "LOCAL_OUTPUT_PARENT_UNAVAILABLE",
      category: "config",
      message: "The local report parent directory is unavailable.",
      cause
    });
  }

  try {
    await mkdir(path, { mode: 0o700 });
  } catch (cause) {
    if (isNodeError(cause, "EEXIST")) {
      const metadata = await lstat(path).catch(() => undefined);
      if (metadata?.isSymbolicLink()) throw unsafeOutput();
      throw new AwError({
        code: "LOCAL_OUTPUT_EXISTS",
        category: "config",
        message: "The local report output directory already exists; refusing to overwrite it."
      });
    }
    throw new AwError({
      code: "LOCAL_OUTPUT_CREATE_FAILED",
      category: "local",
      message: "Could not create the local report output directory.",
      cause
    });
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw unsafeOutput();
  return { dev: metadata.dev, ino: metadata.ino };
}

async function writePrivateFile(path: string, content: string): Promise<FileIdentity> {
  const noFollow =
    process.platform !== "win32" && typeof fsConstants.O_NOFOLLOW === "number"
      ? fsConstants.O_NOFOLLOW
      : 0;
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o600
  );
  let identity: FileIdentity | undefined;
  let failure: unknown;
  let failed = false;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw unsafeOutput();
    identity = { dev: metadata.dev, ino: metadata.ino };
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (cause) {
    failed = true;
    failure = cause;
  } finally {
    await handle.close();
  }
  if (failed) {
    if (identity !== undefined) await unlinkOwnedFile(path, identity);
    throw failure;
  }
  return identity!;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeOwnedOutput(
  path: string,
  identity: FileIdentity,
  ownedFiles: ReadonlyMap<string, FileIdentity>
): Promise<void> {
  for (const [ownedPath, fileIdentity] of ownedFiles) {
    await unlinkOwnedFile(ownedPath, fileIdentity);
  }
  const metadata = await lstat(path).catch(() => undefined);
  if (
    metadata === undefined ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !sameFileIdentity(metadata, identity)
  ) {
    return;
  }
  // rmdir is intentionally non-recursive. If any unknown entry appeared, leave
  // the directory in place instead of deleting data that this process did not
  // create and bind by inode.
  await rmdir(path).catch(() => undefined);
}

async function unlinkOwnedFile(path: string, identity: FileIdentity): Promise<void> {
  const metadata = await lstat(path).catch(() => undefined);
  if (
    metadata === undefined ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !sameFileIdentity(metadata, identity)
  ) {
    return;
  }
  await unlink(path).catch(() => undefined);
}

async function ensureSafeParent(parent: string): Promise<void> {
  const anchor = trustedAnchor(parent);
  const anchorMetadata = await lstat(anchor);
  if (anchorMetadata.isSymbolicLink() || !anchorMetadata.isDirectory()) throw unsafeOutput();
  const suffix = relative(anchor, parent);
  if (suffix === "") return;
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw unsafeOutput();
  }
  let current = anchor;
  for (const segment of suffix.split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, segment);
    let metadata = await lstat(current).catch((cause: unknown) => {
      if (isNodeError(cause, "ENOENT")) return undefined;
      throw cause;
    });
    if (metadata === undefined) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (cause) {
        if (!isNodeError(cause, "EEXIST")) throw cause;
      }
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw unsafeOutput();
  }
}

async function inspectSafeParent(parent: string): Promise<void> {
  const anchor = trustedAnchor(parent);
  const anchorMetadata = await lstat(anchor);
  if (anchorMetadata.isSymbolicLink() || !anchorMetadata.isDirectory()) throw unsafeOutput();
  const suffix = relative(anchor, parent);
  if (suffix === "") return;
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw unsafeOutput();
  }
  let current = anchor;
  for (const segment of suffix.split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, segment);
    const metadata = await lstat(current).catch((cause: unknown) => {
      if (isNodeError(cause, "ENOENT")) return undefined;
      throw cause;
    });
    // Once one component is absent, no deeper component can exist. The writer
    // performs the same checks again while creating the parent chain.
    if (metadata === undefined) return;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw unsafeOutput();
  }
}

function trustedAnchor(path: string): string {
  const candidates = [resolve(process.cwd()), resolve(tmpdir()), resolve(homedir())]
    .filter((candidate) => containsPath(candidate, path))
    .sort((left, right) => right.length - left.length);
  return candidates[0] ?? parse(path).root;
}

function containsPath(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

function assertArtifactSize(name: string, content: string): void {
  if (Buffer.byteLength(content, "utf8") <= MAX_ARTIFACT_BYTES) return;
  throw new AwError({
    code: "LOCAL_REPORT_TOO_LARGE",
    category: "evidence",
    message: `The generated ${name} exceeds the local report size limit.`
  });
}

function unsafeOutput(): AwError {
  return new AwError({
    code: "LOCAL_OUTPUT_UNSAFE",
    category: "config",
    message: "The local report output path is a symbolic link or unsafe filesystem object."
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
