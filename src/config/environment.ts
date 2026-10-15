import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

import { sameFileIdentity } from "../system/file-identity.js";
import type { Diagnostic } from "./types.js";

export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
export const EXACT_ENV_REFERENCE_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

const MAX_ENV_FILE_BYTES = 256 * 1024;
const ENV_READ_CHUNK_BYTES = 64 * 1024;

export interface EnvironmentLoadResult {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly diagnostics: readonly Diagnostic[];
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

async function readBoundedEnvironment(handle: FileHandle): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  while (true) {
    // Read one byte beyond the limit so a file that grows after fstat cannot
    // bypass the bound.
    const remainingWithSentinel = MAX_ENV_FILE_BYTES - totalBytes + 1;
    const buffer = Buffer.allocUnsafe(Math.min(ENV_READ_CHUNK_BYTES, remainingWithSentinel));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    if (totalBytes > MAX_ENV_FILE_BYTES) {
      throw new Error(`The .env file exceeds the ${MAX_ENV_FILE_BYTES}-byte size limit.`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }

  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function openAndReadEnvironment(envPath: string): Promise<{ readonly metadata: Stats; readonly source: string }> {
  // O_NOFOLLOW provides the race-free symlink boundary on platforms that
  // support it. Windows does not honor that flag, so retain a pre-open lstat
  // and bind it to the opened handle's identity as a best-effort equivalent.
  const noFollowFlag =
    process.platform !== "win32" && typeof fsConstants.O_NOFOLLOW === "number"
      ? fsConstants.O_NOFOLLOW
      : 0;
  let preOpenMetadata: Stats | undefined;
  if (noFollowFlag === 0) {
    preOpenMetadata = await lstat(envPath);
    if (preOpenMetadata.isSymbolicLink()) throw new Error("Refusing to load a symbolic-link .env file.");
    if (!preOpenMetadata.isFile()) throw new Error("The .env path is not a regular file.");
  }

  const flags = fsConstants.O_RDONLY | noFollowFlag;
  let handle: FileHandle;
  try {
    handle = await open(envPath, flags);
  } catch (error) {
    if (isNodeError(error, "ELOOP")) throw new Error("Refusing to load a symbolic-link .env file.");
    throw error;
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("The .env path is not a regular file.");
    if (
      preOpenMetadata !== undefined &&
      !sameFileIdentity(preOpenMetadata, metadata)
    ) {
      throw new Error("The .env file changed while it was being opened.");
    }
    if (metadata.size > MAX_ENV_FILE_BYTES) {
      throw new Error(`The .env file exceeds the ${MAX_ENV_FILE_BYTES}-byte size limit.`);
    }
    return { metadata, source: await readBoundedEnvironment(handle) };
  } finally {
    await handle.close();
  }
}

function parseDoubleQuoted(value: string, line: number): string {
  if (!value.endsWith('"')) {
    throw new Error(`Unterminated double-quoted value on line ${line}.`);
  }
  const trailing = value.slice(value.lastIndexOf('"') + 1).trim();
  if (trailing !== "" && !trailing.startsWith("#")) {
    throw new Error(`Unexpected content after quoted value on line ${line}.`);
  }
  const closingIndex = value.lastIndexOf('"');
  const quoted = value.slice(0, closingIndex + 1);
  try {
    return JSON.parse(quoted) as string;
  } catch {
    throw new Error(`Invalid escape sequence in double-quoted value on line ${line}.`);
  }
}

function parseSingleQuoted(value: string, line: number): string {
  const closingIndex = value.indexOf("'", 1);
  if (closingIndex === -1) throw new Error(`Unterminated single-quoted value on line ${line}.`);
  const trailing = value.slice(closingIndex + 1).trim();
  if (trailing !== "" && !trailing.startsWith("#")) {
    throw new Error(`Unexpected content after quoted value on line ${line}.`);
  }
  return value.slice(1, closingIndex);
}

function parseUnquoted(value: string): string {
  const comment = value.search(/\s+#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

export function parseDotEnv(source: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index] ?? "";
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const equals = line.indexOf("=");
    if (equals <= 0) throw new Error(`Expected NAME=value on line ${lineNumber}.`);
    const name = line.slice(0, equals).trim();
    if (!ENV_NAME_PATTERN.test(name)) throw new Error(`Invalid environment name on line ${lineNumber}.`);
    const rawValue = line.slice(equals + 1).trimStart();
    let value: string;
    if (rawValue.startsWith('"')) value = parseDoubleQuoted(rawValue, lineNumber);
    else if (rawValue.startsWith("'")) value = parseSingleQuoted(rawValue, lineNumber);
    else value = parseUnquoted(rawValue);
    result[name] = value;
  }
  return result;
}

export async function loadEnvironment(
  envPath: string,
  processEnvironment: Readonly<NodeJS.ProcessEnv> = process.env
): Promise<EnvironmentLoadResult> {
  let fileEnvironment: Record<string, string> = Object.create(null) as Record<string, string>;
  const diagnostics: Diagnostic[] = [];
  try {
    const { metadata, source } = await openAndReadEnvironment(envPath);
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      diagnostics.push({
        level: "warning",
        code: "ENV_FILE_PERMISSIONS",
        message: "The .env file is readable by users other than its owner; run chmod 600 on it.",
        path: envPath
      });
    }
    fileEnvironment = parseDotEnv(source);
    diagnostics.push({
      level: "ok",
      code: "ENV_FILE_LOADED",
      message: `Loaded environment variables from ${envPath}.`,
      path: envPath
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({
        level: "error",
        code: "ENV_FILE_INVALID",
        message: error instanceof Error ? error.message : "The .env file is invalid.",
        path: envPath
      });
    }
  }

  return {
    environment: { ...fileEnvironment, ...processEnvironment },
    diagnostics
  };
}

export function exactEnvironmentName(value: string): string | undefined {
  return EXACT_ENV_REFERENCE_PATTERN.exec(value)?.[1];
}
