import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { hostname } from "node:os";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rmdir,
  unlink
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { AwError } from "../errors.js";
import { sameFileIdentity } from "../system/file-identity.js";
import { canonicalize } from "../util/canonical.js";

const LOCK_VERSION = "aw-secure-lock/0.1" as const;
const OWNER_FILE = "owner.json";
const MAX_OWNER_BYTES = 4 * 1024;
const MAX_ACQUIRE_ATTEMPTS = 4;

const ownerSchema = z
  .object({
    lock_version: z.literal(LOCK_VERSION),
    pid: z.number().int().positive(),
    hostname: z.string().min(1).max(255),
    boot_id: z.string().min(1).max(255).nullable(),
    process_start_id: z.string().min(1).max(255).nullable(),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    created_at: z.string().datetime({ offset: true })
  })
  .strict();

type LockOwner = z.infer<typeof ownerSchema>;
export type ProcessProbe = "alive" | "dead" | "unknown";

export interface SecureLockRuntime {
  readonly pid: number;
  readonly hostname: string;
  readonly bootId: string | null;
  readonly processStartId: string | null;
  readonly nonce: () => string;
  readonly probeProcess: (pid: number) => ProcessProbe | Promise<ProcessProbe>;
  readonly processStartIdFor: (pid: number) => string | null | Promise<string | null>;
}

export interface SecureLockErrorCodes {
  readonly locked: string;
  readonly unsafe: string;
  readonly unknownOwner: string;
  readonly foreignOwner: string;
  readonly changed: string;
}

export interface SecureLockOptions {
  readonly path: string;
  readonly label: string;
  readonly errorCodes: SecureLockErrorCodes;
  readonly now?: () => Date;
  readonly runtime?: SecureLockRuntime;
}

export interface SecureLockHandle {
  readonly path: string;
  release(): Promise<void>;
}

export interface SecureDirectoryOptions {
  readonly path: string;
  readonly recursive: boolean;
  readonly label: string;
  readonly errorCode: string;
  /**
   * When true, a real directory owned by the current user is tightened to
   * mode 0700 before the private-directory check. Symlinks and foreign owners
   * are still refused. Default callers keep the fail-closed check.
   */
  readonly repairOwned?: boolean;
}

interface OwnerSnapshot {
  readonly owner: LockOwner;
  readonly identity: Stats;
}

export async function ensureSecureDirectory(options: SecureDirectoryOptions): Promise<void> {
  let created = false;
  let stat: Stats;
  try {
    try {
      stat = await lstat(options.path);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      try {
        const firstCreated = await mkdir(options.path, {
          recursive: options.recursive,
          mode: 0o700
        });
        created = options.recursive ? firstCreated !== undefined : true;
      } catch (mkdirError) {
        if (!isErrorCode(mkdirError, "EEXIST")) throw mkdirError;
      }
      stat = await lstat(options.path);
    }
    if (!created) {
      if (options.repairOwned === true) {
        assertOwnedDirectory(stat);
        if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
          await chmod(options.path, 0o700);
          const repaired = await lstat(options.path);
          if (!sameFileIdentity(repaired, stat)) {
            throw new Error("directory changed while permissions were being secured");
          }
          stat = repaired;
        }
      }
      assertPrivateDirectory(stat);
      return;
    }
    assertOwnedDirectory(stat);
    await chmod(options.path, 0o700);
    assertPrivateDirectory(await lstat(options.path));
  } catch (error) {
    if (error instanceof AwError && error.code === options.errorCode) throw error;
    throw new AwError({
      code: options.errorCode,
      category: "local",
      message: `The ${options.label} directory must already be private or be created by AugmentWorks.`,
      cause: error
    });
  }
}

export async function acquireSecureLock(options: SecureLockOptions): Promise<SecureLockHandle> {
  const runtime = options.runtime ?? (await defaultRuntime());
  const now = options.now ?? (() => new Date());
  validateRuntime(runtime, options);
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(options.path, { mode: 0o700 });
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw lockError(options, "unsafe", "could not be created safely", error);
      await reclaimDeadOwner(options, runtime);
      continue;
    }
    return initializeOwnedLock(options, runtime, now);
  }
  throw lockError(options, "changed", "changed repeatedly while ownership was being acquired");
}

async function initializeOwnedLock(
  options: SecureLockOptions,
  runtime: SecureLockRuntime,
  now: () => Date
): Promise<SecureLockHandle> {
  const ownerPath = join(options.path, OWNER_FILE);
  let handle: FileHandle | undefined;
  try {
    await secureDirectory(options.path, options);
    handle = await open(
      ownerPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag(),
      0o600
    );
    await secureOwnerHandle(handle, options);
    const owner: LockOwner = {
      lock_version: LOCK_VERSION,
      pid: runtime.pid,
      hostname: runtime.hostname,
      boot_id: runtime.bootId,
      process_start_id: runtime.processStartId,
      nonce: runtime.nonce(),
      created_at: now().toISOString()
    };
    const parsed = ownerSchema.safeParse(owner);
    if (!parsed.success) throw lockError(options, "unsafe", "has invalid local owner identity");
    await handle.writeFile(`${canonicalize(parsed.data)}\n`, "utf8");
    await handle.sync();
    const directoryIdentity = await lstat(options.path);
    const ownerIdentity = await handle.stat();
    return new OwnedSecureLock(
      options,
      parsed.data.nonce,
      directoryIdentity,
      ownerIdentity,
      handle
    );
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(ownerPath).catch(() => undefined);
    await rmdir(options.path).catch(() => undefined);
    if (error instanceof AwError) throw error;
    throw lockError(options, "unsafe", "could not establish secure ownership", error);
  }
}

class OwnedSecureLock implements SecureLockHandle {
  readonly path: string;
  readonly #options: SecureLockOptions;
  readonly #nonce: string;
  readonly #directoryIdentity: Stats;
  readonly #ownerIdentity: Stats;
  #handle: FileHandle | undefined;

  constructor(
    options: SecureLockOptions,
    nonce: string,
    directoryIdentity: Stats,
    ownerIdentity: Stats,
    handle: FileHandle
  ) {
    this.path = options.path;
    this.#options = options;
    this.#nonce = nonce;
    this.#directoryIdentity = directoryIdentity;
    this.#ownerIdentity = ownerIdentity;
    this.#handle = handle;
  }

  async release(): Promise<void> {
    const handle = this.#handle;
    if (handle === undefined) return;
    const ownerPath = join(this.path, OWNER_FILE);
    const directory = await inspectLockDirectory(this.#options);
    const snapshot = await readOwner(ownerPath, this.#options);
    if (
      !sameIdentity(directory, this.#directoryIdentity) ||
      !sameIdentity(snapshot.identity, this.#ownerIdentity) ||
      snapshot.owner.nonce !== this.#nonce
    ) {
      throw lockError(this.#options, "changed", "changed before it could be released safely");
    }
    this.#handle = undefined;
    await handle.close();
    try {
      await unlink(ownerPath);
      await rmdirLockDirectory(this.path, this.#options, "could not be released atomically");
    } catch (error) {
      if (error instanceof AwError) throw error;
      throw lockError(this.#options, "changed", "could not be released atomically", error);
    }
  }
}

async function reclaimDeadOwner(
  options: SecureLockOptions,
  runtime: SecureLockRuntime
): Promise<void> {
  const directory = await inspectLockDirectoryIfPresent(options);
  if (directory === undefined) return;
  const ownerPath = join(options.path, OWNER_FILE);
  const first = await readOwnerIfLockPresent(ownerPath, options);
  if (first === undefined) return;
  if (first.owner.hostname !== runtime.hostname) {
    throw lockError(options, "foreignOwner", "belongs to a different host");
  }
  const previousBoot =
    first.owner.boot_id !== null &&
    runtime.bootId !== null &&
    first.owner.boot_id !== runtime.bootId;
  // A boot mismatch proves the recorded process cannot still own the lock.
  // Otherwise, process.kill(pid, 0) gives every supported Node platform a
  // conservative path to reclaim a positively dead owner even when that OS
  // has no Linux-style boot ID or /proc process start time.
  if (!previousBoot) {
    const probe = await runtime.probeProcess(first.owner.pid);
    if (probe === "alive") {
      const currentStart =
        first.owner.pid === runtime.pid
          ? runtime.processStartId
          : await runtime.processStartIdFor(first.owner.pid);
      // Our own PID is positive proof of a live local owner even on macOS and
      // Windows, where a portable process-start identifier is unavailable.
      // Keep the lock rather than misclassifying that owner as ambiguous. A
      // mismatched start identifier still proves PID reuse when both sides
      // provide one.
      if (
        first.owner.pid === runtime.pid &&
        (first.owner.process_start_id === null ||
          currentStart === null ||
          first.owner.process_start_id === currentStart)
      ) {
        throw lockError(options, "locked", "is owned by the current process");
      }
      if (first.owner.process_start_id === null || currentStart === null) {
        throw lockError(options, "unknownOwner", "has an ambiguous process identifier");
      }
      if (first.owner.process_start_id === currentStart) {
        throw lockError(options, "locked", "is owned by a live process");
      }
      // A live process with a different start identity is a reused PID. The
      // recorded owner is gone, so it is safe to continue to the unchanged
      // inode/nonce check below instead of permanently wedging the lock.
    } else if (probe !== "dead") {
      throw lockError(options, "unknownOwner", "owner liveness could not be established");
    }
  }

  const currentDirectory = await inspectLockDirectoryIfPresent(options);
  if (currentDirectory === undefined) return;
  const currentOwner = await readOwnerIfLockPresent(ownerPath, options);
  if (currentOwner === undefined) return;
  if (
    !sameIdentity(directory, currentDirectory) ||
    !sameIdentity(first.identity, currentOwner.identity) ||
    first.owner.nonce !== currentOwner.owner.nonce
  ) {
    throw lockError(options, "changed", "changed while stale ownership was being verified");
  }

  try {
    await unlink(ownerPath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw lockError(options, "changed", "could not atomically claim its dead owner", error);
    }
  }
  try {
    await rmdirLockDirectory(options.path, options, "could not atomically claim its dead owner");
  } catch (error) {
    if (error instanceof AwError) throw error;
    throw lockError(options, "changed", "could not atomically claim its dead owner", error);
  }
}

async function inspectLockDirectoryIfPresent(options: SecureLockOptions): Promise<Stats | undefined> {
  try {
    return await inspectLockDirectory(options);
  } catch (error) {
    // Holder already released: mkdir can create the lock on the next attempt.
    // Do not re-stat here; a replacement lock may already exist.
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

async function readOwnerIfLockPresent(
  path: string,
  options: SecureLockOptions
): Promise<OwnerSnapshot | undefined> {
  try {
    return await readOwner(path, options);
  } catch (error) {
    if (isMissingPathError(error) && (await pathIsMissing(options.path))) return undefined;
    throw error;
  }
}

async function inspectLockDirectory(options: SecureLockOptions): Promise<Stats> {
  let stat: Stats;
  try {
    stat = await lstat(options.path);
  } catch (error) {
    throw lockError(options, "changed", "disappeared while ownership was being checked", error);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)
  ) {
    throw lockError(options, "unsafe", "must be a private real directory");
  }
  return stat;
}

async function readOwner(path: string, options: SecureLockOptions): Promise<OwnerSnapshot> {
  let handle: FileHandle | undefined;
  try {
    const pathIdentity = await lstat(path);
    if (pathIdentity.isSymbolicLink() || !pathIdentity.isFile()) {
      throw lockError(options, "unsafe", "owner record must be a regular file, not a link");
    }
    handle = await open(path, constants.O_RDONLY | noFollowFlag());
    const identity = await handle.stat();
    if (
      !identity.isFile() ||
      !sameIdentity(pathIdentity, identity) ||
      (process.platform !== "win32" && (identity.mode & 0o777) !== 0o600) ||
      identity.size > MAX_OWNER_BYTES
    ) {
      throw lockError(options, "unsafe", "has an unsafe owner record");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_OWNER_BYTES) throw lockError(options, "unsafe", "owner record is too large");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      throw lockError(options, "unknownOwner", "owner record is unreadable", error);
    }
    const parsed = ownerSchema.safeParse(value);
    if (!parsed.success) throw lockError(options, "unknownOwner", "owner record is invalid");
    return { owner: parsed.data, identity };
  } catch (error) {
    if (error instanceof AwError) throw error;
    throw lockError(options, "unknownOwner", "owner record could not be verified", error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function secureDirectory(path: string, options: SecureLockOptions): Promise<void> {
  try {
    await chmod(path, 0o700);
    const stat = await lstat(path);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)
    ) {
      throw new Error("lock directory permissions are unsafe");
    }
  } catch (error) {
    throw lockError(options, "unsafe", "directory permissions could not be secured", error);
  }
}

async function secureOwnerHandle(handle: FileHandle, options: SecureLockOptions): Promise<void> {
  try {
    await handle.chmod(0o600);
    const stat = await handle.stat();
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)) {
      throw new Error("owner record permissions are unsafe");
    }
  } catch (error) {
    throw lockError(options, "unsafe", "owner record permissions could not be secured", error);
  }
}

async function defaultRuntime(): Promise<SecureLockRuntime> {
  const currentHostname = hostname();
  const bootId = await linuxValue("/proc/sys/kernel/random/boot_id");
  const processStartId = await linuxProcessStartIdFromPath("/proc/self/stat");
  return {
    pid: process.pid,
    hostname: currentHostname,
    bootId,
    processStartId,
    nonce: () => randomBytes(16).toString("hex"),
    probeProcess: probeProcess,
    processStartIdFor: (pid) =>
      pid === process.pid ? processStartId : linuxProcessStartIdFromPath(`/proc/${pid}/stat`)
  };
}

async function linuxValue(path: string): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value.length > 0 && value.length <= 255 ? value : null;
  } catch {
    return null;
  }
}

async function linuxProcessStartIdFromPath(path: string): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    const value = await readFile(path, "utf8");
    const close = value.lastIndexOf(")");
    if (close < 0) return null;
    const fieldsFromState = value.slice(close + 1).trim().split(/\s+/);
    const startTime = fieldsFromState[19];
    return startTime !== undefined && /^\d+$/.test(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

function probeProcess(pid: number): ProcessProbe {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (isErrorCode(error, "ESRCH")) return "dead";
    return "unknown";
  }
}

function validateRuntime(runtime: SecureLockRuntime, options: SecureLockOptions): void {
  if (
    !Number.isInteger(runtime.pid) ||
    runtime.pid <= 0 ||
    runtime.hostname.length < 1 ||
    runtime.hostname.length > 255
  ) {
    throw lockError(options, "unsafe", "has invalid local runtime identity");
  }
}

function assertPrivateDirectory(stat: Stats): void {
  assertOwnedDirectory(stat);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
    throw new Error("directory permissions are unsafe");
  }
}

function assertOwnedDirectory(stat: Stats): void {
  const getuid = process.getuid;
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (process.platform !== "win32" && getuid !== undefined && stat.uid !== getuid())
  ) {
    throw new Error("directory ownership is unsafe");
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right);
}

async function rmdirLockDirectory(
  path: string,
  options: SecureLockOptions,
  reason: string
): Promise<void> {
  const attempts = process.platform === "win32" ? 8 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rmdir(path);
      return;
    } catch (error) {
      lastError = error;
      if (isMissingPathError(error)) return;
      const retryable =
        process.platform === "win32" &&
        (isErrorCode(error, "ENOTEMPTY") ||
          isErrorCode(error, "EBUSY") ||
          isErrorCode(error, "EPERM"));
      if (!retryable || attempt === attempts - 1) {
        throw lockError(options, "changed", reason, error);
      }
      await delay(10 * 2 ** attempt);
    }
  }
  throw lockError(options, "changed", reason, lastError);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
}

function lockError(
  options: SecureLockOptions,
  kind: keyof SecureLockErrorCodes,
  reason: string,
  cause?: unknown
): AwError {
  return new AwError({
    code: options.errorCodes[kind],
    category: "local",
    message: `The ${options.label} lock ${reason}.`,
    cause
  });
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isMissingPathError(error: unknown): boolean {
  if (isErrorCode(error, "ENOENT")) return true;
  return error instanceof AwError && isMissingPathError(error.cause);
}

async function pathIsMissing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return isErrorCode(error, "ENOENT");
  }
}
