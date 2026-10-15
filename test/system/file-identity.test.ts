import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sameFileIdentity } from "../../src/system/file-identity.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("sameFileIdentity", () => {
  it("requires the same inode and device id", () => {
    expect(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }, "linux")).toBe(true);
    expect(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 3 }, "linux")).toBe(false);
    expect(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 9, ino: 2 }, "linux")).toBe(false);
    expect(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 9, ino: 2 }, "win32")).toBe(false);
    expect(sameFileIdentity({ dev: 0, ino: 2 }, { dev: 9, ino: 2 }, "linux")).toBe(false);
  });

  it("treats a zero Windows dev as unknown when the inode matches", () => {
    expect(sameFileIdentity({ dev: 0, ino: 2 }, { dev: 9, ino: 2 }, "win32")).toBe(true);
    expect(sameFileIdentity({ dev: 9, ino: 2 }, { dev: 0, ino: 2 }, "win32")).toBe(true);
    expect(sameFileIdentity({ dev: 0, ino: 2 }, { dev: 0, ino: 2 }, "win32")).toBe(true);
    expect(sameFileIdentity({ dev: 0, ino: 2 }, { dev: 9, ino: 3 }, "win32")).toBe(false);
  });

  it("treats a path lstat and a handle stat as the same file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "augmentworks-file-identity-"));
    directories.push(directory);
    const path = join(directory, "file.txt");
    await writeFile(path, "ok");
    const beforeOpen = await lstat(path);
    const handle = await open(path, "r");
    try {
      expect(sameFileIdentity(beforeOpen, await handle.stat())).toBe(true);
    } finally {
      await handle.close();
    }
  });
});
