import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

import { AwError } from "../errors.js";
import { sameFileIdentity } from "../system/file-identity.js";
import { findUnsafeSymbolicLinkComponent } from "../system/path-safety.js";
import { SecretRedactor, isSensitiveKey } from "../system/redact.js";
import { MAX_INVESTIGATION_FILE_BYTES, type InvestigationExport } from "./schema.js";
import { investigationError } from "./errors.js";
import { assertInvestigationObservation, parseInvestigationExport } from "./protocol.js";

export type LoadedInvestigation = {
  readonly sourcePath: string;
  readonly sourceBytes: number;
  readonly document: InvestigationExport;
};

function assertSafeRegularFileSyncPath(path: string): Promise<void> {
  return assertSafeRegularFile(path);
}

async function assertSafeRegularFile(path: string): Promise<void> {
  try {
    if ((await findUnsafeSymbolicLinkComponent(path)) !== undefined) {
      throw investigationError(
        "INVESTIGATION_NOT_A_FILE",
        "The investigation path cannot contain symbolic links.",
        { path }
      );
    }
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw investigationError(
        "INVESTIGATION_NOT_A_FILE",
        "The investigation must be a regular file and cannot be a symbolic link.",
        { path }
      );
    }
  } catch (error) {
    if (error instanceof AwError) throw error;
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw investigationError(
      missing ? "INVESTIGATION_NOT_FOUND" : "INVESTIGATION_NOT_A_FILE",
      missing ? `Investigation file not found: ${path}` : `Could not inspect investigation: ${path}`,
      { path },
      error
    );
  }
}

async function readBoundedUtf8File(path: string, limit: number): Promise<Buffer> {
  let handle;
  try {
    const beforeOpen = await lstat(path);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
      throw investigationError(
        "INVESTIGATION_NOT_A_FILE",
        "The investigation must be a regular file and cannot be a symbolic link.",
        { path }
      );
    }
    if (beforeOpen.size > limit) {
      throw investigationError(
        "INVESTIGATION_TOO_LARGE",
        `Investigation files cannot exceed ${String(limit)} bytes (${String(beforeOpen.size)} bytes).`,
        { path, bytes: beforeOpen.size }
      );
    }
    const noFollow =
      process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const metadata = await handle.stat();
    if (!metadata.isFile() || !sameFileIdentity(metadata, beforeOpen)) {
      throw investigationError(
        "INVESTIGATION_NOT_A_FILE",
        "The investigation file changed while it was being opened.",
        { path }
      );
    }
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) {
      throw investigationError(
        "INVESTIGATION_TOO_LARGE",
        `Investigation files cannot exceed ${String(limit)} bytes.`,
        { path }
      );
    }
    const slice = bytes.subarray(0, offset);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(slice);
    } catch (cause) {
      throw investigationError("INVESTIGATION_NOT_UTF8", "The investigation is not valid UTF-8.", { path }, cause);
    }
    return Buffer.from(slice);
  } catch (error) {
    if (error instanceof AwError) throw error;
    throw investigationError("INVESTIGATION_READ_FAILED", `Could not read investigation: ${path}`, { path }, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function rejectCredentialMaterial(value: unknown, trail = "root"): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectCredentialMaterial(child, `${trail}[${String(index)}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      throw investigationError(
        "INVESTIGATION_CREDENTIAL_FORBIDDEN",
        `Investigation artifacts cannot contain judging credentials or secret material (${trail}.${key}).`,
        { field: `${trail}.${key}` }
      );
    }
    rejectCredentialMaterial(child, `${trail}.${key}`);
  }
}

export function parseInvestigationValue(value: unknown, sourcePath = "investigation"): InvestigationExport {
  rejectCredentialMaterial(value);
  const document = parseInvestigationExport(value, sourcePath);
  assertInvestigationObservation(document);
  return document;
}

export async function loadInvestigationFile(
  filePath: string,
  cwd = process.cwd()
): Promise<LoadedInvestigation> {
  if (filePath.trim() === "") {
    throw investigationError("INVESTIGATION_FILE_REQUIRED", "Provide an investigation JSON path.");
  }
  const absolute = resolve(cwd, filePath);
  await assertSafeRegularFileSyncPath(absolute);
  const lower = absolute.toLowerCase();
  if (!lower.endsWith(".json")) {
    throw investigationError(
      "INVESTIGATION_UNSUPPORTED_EXTENSION",
      `Investigation files must use .json (${absolute}).`,
      { path: absolute }
    );
  }
  const bytes = await readBoundedUtf8File(absolute, MAX_INVESTIGATION_FILE_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw investigationError(
      "INVESTIGATION_JSON_INVALID",
      `Investigation JSON is invalid: ${(error as Error).message}`,
      { path: absolute }
    );
  }
  const document = parseInvestigationValue(parsed, absolute);
  return {
    sourcePath: absolute,
    sourceBytes: bytes.byteLength,
    document
  };
}

export function redactInvestigationText(value: string, secrets: readonly string[] = []): string {
  return new SecretRedactor(secrets).redact(value);
}
