import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readdir,
  rename,
  rmdir,
  unlink
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { AwError } from "../errors.js";
import { realDataError } from "../real-data/errors.js";
import { acquireSecureLock, ensureSecureDirectory } from "../relay/secure-lock.js";
import { sameFileIdentity } from "../system/file-identity.js";
import { findUnsafeSymbolicLinkComponent } from "../system/path-safety.js";
import {
  ActionIntentSchema,
  type ActionIntent,
  type IntentState
} from "./documents.js";

const MAX_INTENT_BYTES = 256 * 1024;
const LOCK_WAIT_MS = 2_000;
const UNKNOWN_OWNER_GRACE_MS = 400;
const INTENT_FILE_NAME = /^[a-f0-9]{64}\.json$/;

const LEDGER_LOCK_ERRORS = {
  locked: "ACTION_LEDGER_LOCKED",
  unsafe: "UNSAFE_ACTION_LEDGER",
  unknownOwner: "ACTION_LEDGER_OWNER_UNKNOWN",
  foreignOwner: "UNSAFE_ACTION_LEDGER",
  changed: "UNSAFE_ACTION_LEDGER"
} as const;

export class ActionIntentLedger {
  constructor(private readonly directory: string) {}

  async read(intentId: string): Promise<ActionIntent | null> {
    return this.withLock(async () => this.readUnlocked(intentId));
  }

  async createPrepared(intent: ActionIntent): Promise<ActionIntent> {
    return this.withLock(async () => {
      const existing = await this.readUnlocked(intent.intentId);
      if (existing !== null) return existing;
      await this.writeUnlocked(intent);
      return intent;
    });
  }

  async claimDispatch(intentId: string, permit: ActionIntent["permit"]): Promise<{
    readonly won: boolean;
    readonly intent: ActionIntent;
  }> {
    return this.withLock(async () => {
      const existing = await this.readUnlocked(intentId);
      if (existing === null) {
        throw realDataError("ACTION_OUTCOME_INDETERMINATE", "The action intent ledger has no record to dispatch.");
      }
      if (existing.state !== "prepared" || existing.toolInvocations !== 0) {
        return { won: false, intent: existing };
      }
      const next: ActionIntent = { ...existing, state: "dispatching", permit };
      await this.writeUnlocked(next);
      return { won: true, intent: next };
    });
  }

  async transition(
    intentId: string,
    from: readonly IntentState[],
    next: ActionIntent
  ): Promise<ActionIntent> {
    return this.withLock(async () => {
      const existing = await this.readUnlocked(intentId);
      if (existing === null) {
        throw realDataError("ACTION_OUTCOME_INDETERMINATE", "The action intent ledger has no record to advance.");
      }
      if (!from.includes(existing.state)) return existing;
      if (next.intentId !== intentId) {
        throw realDataError("ACTION_NOT_ALLOWED", "An action intent cannot change its identity.");
      }
      if (next.toolInvocations < existing.toolInvocations) {
        throw realDataError("ACTION_NOT_ALLOWED", "An action intent cannot forget a tool invocation.");
      }
      await this.writeUnlocked(next);
      return next;
    });
  }

  async list(): Promise<readonly ActionIntent[]> {
    return this.withLock(async () => {
      const names = await readdir(this.directory);
      const intents: ActionIntent[] = [];
      for (const name of names) {
        if (!INTENT_FILE_NAME.test(name)) continue;
        const intentId = name.slice(0, -".json".length);
        const intent = await this.readUnlocked(intentId);
        if (intent !== null) intents.push(intent);
      }
      return intents;
    });
  }

  private async readUnlocked(intentId: string): Promise<ActionIntent | null> {
    const path = this.path(intentId);
    let pathStat: Stats;
    try {
      pathStat = await lstat(path);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return null;
      throw unsafeLedger("The action intent record could not be inspected.", error);
    }
    assertOwnedRegularFile(pathStat, "The action intent record must be a current-user regular file.");
    if (pathStat.size > MAX_INTENT_BYTES) {
      throw unsafeLedger("The action intent record is too large.");
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | noFollowFlag());
      let identity = await handle.stat();
      if (!sameIdentity(pathStat, identity) || !identity.isFile() || !isCurrentOwner(identity.uid)) {
        throw unsafeLedger("The action intent record changed while it was being opened.");
      }
      if (process.platform !== "win32" && (identity.mode & 0o777) !== 0o600) {
        await handle.chmod(0o600);
        identity = await handle.stat();
        if (
          !sameIdentity(pathStat, identity) ||
          !identity.isFile() ||
          !isCurrentOwner(identity.uid) ||
          (identity.mode & 0o777) !== 0o600
        ) {
          throw unsafeLedger("The action intent record permissions could not be secured.");
        }
      }
      if (identity.size > MAX_INTENT_BYTES) {
        throw unsafeLedger("The action intent record is too large.");
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength > MAX_INTENT_BYTES) {
        throw unsafeLedger("The action intent record is too large.");
      }
      return parseIntentBytes(bytes, intentId);
    } catch (error) {
      if (error instanceof AwError) throw error;
      throw unsafeLedger("The action intent record could not be read.", error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async writeUnlocked(intent: ActionIntent): Promise<void> {
    const parsed = ActionIntentSchema.safeParse(intent);
    if (!parsed.success) {
      throw realDataError("ACTION_NOT_ALLOWED", "The action intent record is not valid.");
    }
    const destination = this.path(parsed.data.intentId);
    await rejectReplaceableIntentPath(destination);
    const temporary = join(
      this.directory,
      `.${parsed.data.intentId}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    );
    const serialized = `${JSON.stringify(parsed.data)}\n`;
    if (Buffer.byteLength(serialized) > MAX_INTENT_BYTES) {
      throw unsafeLedger("The action intent record is too large.");
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
        0o600
      );
      await secureNewFile(handle);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rejectReplaceableIntentPath(destination);
      await rename(temporary, destination);
      await verifyPrivateIntentFile(destination);
      await syncDirectory(this.directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      if (error instanceof AwError) throw error;
      throw unsafeLedger("The action intent record could not be persisted.", error);
    }
  }

  private path(intentId: string): string {
    if (!/^[a-f0-9]{64}$/.test(intentId)) {
      throw realDataError("ACTION_NOT_ALLOWED", "The action intent id is not a SHA-256 digest.");
    }
    return join(this.directory, `${intentId}.json`);
  }

  private async withLock<T>(body: () => Promise<T>): Promise<T> {
    await this.prepareDirectory();
    const lockPath = join(this.directory, ".lock");
    await prepareLockDirectory(lockPath);
    const started = Date.now();
    let reclaimedEmptyLock = false;
    for (;;) {
      try {
        const handle = await acquireSecureLock({
          path: lockPath,
          label: "action intent ledger",
          errorCodes: LEDGER_LOCK_ERRORS
        });
        try {
          return await body();
        } finally {
          await handle.release();
        }
      } catch (error) {
        if (!(error instanceof AwError)) throw error;
        const elapsed = Date.now() - started;
        if (error.code === "ACTION_LEDGER_LOCKED" && elapsed < LOCK_WAIT_MS) {
          await delay(20);
          continue;
        }
        if (error.code === "ACTION_LEDGER_LOCKED") {
          throw realDataError(
            "ACTION_OUTCOME_INDETERMINATE",
            "The action intent ledger is locked by another recovery."
          );
        }
        if (
          error.code === "ACTION_LEDGER_OWNER_UNKNOWN" &&
          elapsed < UNKNOWN_OWNER_GRACE_MS
        ) {
          await delay(15);
          continue;
        }
        // A secure lock publishes owner.json before it is held. An empty
        // directory that is still ownerless after the grace period is not a
        // live owner; reclaim it once so a crash between mkdir and the owner
        // record cannot wedge recovery. A readable unknown owner stays closed.
        if (error.code === "ACTION_LEDGER_OWNER_UNKNOWN" && !reclaimedEmptyLock) {
          reclaimedEmptyLock = true;
          if (await reclaimEmptyOwnedLock(lockPath)) continue;
        }
        throw error;
      }
    }
  }

  private async prepareDirectory(): Promise<void> {
    await rejectUnsafeLedgerPath(this.directory);
    await ensureSecureDirectory({
      path: this.directory,
      recursive: true,
      label: "action intent ledger",
      errorCode: "UNSAFE_ACTION_LEDGER",
      repairOwned: true
    });
  }
}

async function prepareLockDirectory(lockPath: string): Promise<void> {
  let stat: Stats;
  try {
    stat = await lstat(lockPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw unsafeLedger("The action intent ledger lock could not be inspected.", error);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw unsafeLedger("The action intent ledger lock must be a real directory.");
  }
  if (!isCurrentOwner(stat.uid)) {
    throw unsafeLedger("The action intent ledger lock is not owned by the current user.");
  }
  const names = await readdir(lockPath);
  // Secure locks are created mode 0700. An empty, non-private directory is the
  // previous ownerless protocol (or a crash before that protocol could publish
  // an owner) and cannot be an in-progress secure lock.
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700 && names.length === 0) {
    if (await reclaimEmptyOwnedLock(lockPath)) return;
  }
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
    await chmod(lockPath, 0o700);
    const secured = await lstat(lockPath);
    if (
      secured.isSymbolicLink() ||
      !secured.isDirectory() ||
      !sameIdentity(stat, secured) ||
      !isCurrentOwner(secured.uid) ||
      (secured.mode & 0o777) !== 0o700
    ) {
      throw unsafeLedger("The action intent ledger lock permissions could not be secured.");
    }
  }
}

async function reclaimEmptyOwnedLock(lockPath: string): Promise<boolean> {
  let stat: Stats;
  try {
    stat = await lstat(lockPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return true;
    throw unsafeLedger("The action intent ledger lock could not be inspected.", error);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isCurrentOwner(stat.uid)) {
    throw unsafeLedger("The action intent ledger lock must be a current-user directory.");
  }
  const names = await readdir(lockPath);
  if (names.length !== 0) return false;
  const again = await lstat(lockPath);
  const namesAgain = await readdir(lockPath);
  if (
    !sameIdentity(stat, again) ||
    again.isSymbolicLink() ||
    !again.isDirectory() ||
    !isCurrentOwner(again.uid) ||
    namesAgain.length !== 0
  ) {
    return false;
  }
  try {
    await rmdir(lockPath);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return true;
    if (isErrorCode(error, "ENOTEMPTY") || isErrorCode(error, "EEXIST")) return false;
    throw unsafeLedger("The action intent ledger lock could not be reclaimed.", error);
  }
}

async function rejectUnsafeLedgerPath(directory: string): Promise<void> {
  let existing: string | undefined;
  try {
    existing = await deepestExistingPath(directory);
  } catch (error) {
    throw unsafeLedger("The action intent ledger path could not be inspected.", error);
  }
  if (existing === undefined) return;
  let unsafeComponent: string | undefined;
  try {
    unsafeComponent = await findUnsafeSymbolicLinkComponent(existing);
  } catch (error) {
    throw unsafeLedger("The action intent ledger path could not be inspected.", error);
  }
  if (unsafeComponent !== undefined) {
    throw unsafeLedger("The action intent ledger path is a symbolic link or contains one.");
  }
}

async function deepestExistingPath(path: string): Promise<string | undefined> {
  let current = resolve(path);
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

async function rejectReplaceableIntentPath(path: string): Promise<void> {
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw unsafeLedger("The action intent record could not be inspected.", error);
  }
  assertOwnedRegularFile(stat, "The action intent record must be a current-user regular file.");
}

async function verifyPrivateIntentFile(path: string): Promise<void> {
  const stat = await lstat(path);
  assertOwnedRegularFile(stat, "The action intent record must be a current-user regular file.");
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
    throw unsafeLedger("The action intent record permissions could not be secured.");
  }
  if (stat.size > MAX_INTENT_BYTES) {
    throw unsafeLedger("The action intent record is too large.");
  }
}

function assertOwnedRegularFile(stat: Stats, message: string): void {
  if (stat.isSymbolicLink() || !stat.isFile() || !isCurrentOwner(stat.uid)) {
    throw unsafeLedger(message);
  }
}

async function secureNewFile(handle: FileHandle): Promise<void> {
  try {
    await handle.chmod(0o600);
    const stat = await handle.stat();
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)) {
      throw new Error("action intent permissions are unsafe");
    }
    if (!isCurrentOwner(stat.uid)) {
      throw new Error("action intent owner is unsafe");
    }
  } catch (error) {
    throw unsafeLedger("The action intent record permissions could not be secured.", error);
  }
}

function parseIntentBytes(bytes: Buffer, intentId: string): ActionIntent {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw realDataError("ACTION_OUTCOME_INDETERMINATE", "The action intent record is unreadable.");
  }
  const parsed = ActionIntentSchema.safeParse(value);
  if (!parsed.success) {
    throw realDataError("ACTION_OUTCOME_INDETERMINATE", "The action intent record is unreadable.");
  }
  if (parsed.data.intentId !== intentId) {
    throw realDataError("ACTION_NOT_ALLOWED", "An action intent cannot change its identity.");
  }
  return parsed.data;
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | noFollowFlag());
    await handle.sync();
  } catch (error) {
    if (isExpectedDirectorySyncError(error)) return;
    throw unsafeLedger("The action intent ledger directory could not be synchronized.", error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isExpectedDirectorySyncError(error: unknown): boolean {
  return (
    process.platform === "win32" &&
    isErrorCode(error, "EACCES", "EBADF", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM")
  );
}

function noFollowFlag(): number {
  return process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number"
    ? 0
    : constants.O_NOFOLLOW;
}

function isCurrentOwner(uid: number): boolean {
  const getuid = process.getuid;
  return getuid === undefined || uid === getuid();
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right);
}

function unsafeLedger(message: string, cause?: unknown): AwError {
  return new AwError({
    code: "UNSAFE_ACTION_LEDGER",
    category: "local",
    message,
    ...(cause === undefined ? {} : { cause })
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref?.();
  });
}

function isErrorCode(error: unknown, ...codes: readonly string[]): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    codes.includes(String((error as { code?: unknown }).code))
  );
}
