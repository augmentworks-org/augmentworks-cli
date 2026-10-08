import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface LockPackage {
  readonly version?: string;
  readonly dev?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

describe("source-map-js release audit", () => {
  it("resolves the dev-only postcss chain outside GHSA-68fv-2mgg-jv7q", async () => {
    const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8")) as {
      packages: Record<string, LockPackage>;
    };
    const root = lock.packages[""];
    const postcss = lock.packages["node_modules/postcss"];
    const sourceMap = lock.packages["node_modules/source-map-js"];

    expect(root?.dependencies?.["source-map-js"]).toBeUndefined();
    expect(root?.devDependencies && "source-map-js" in (root.devDependencies ?? {})).toBe(false);
    expect(postcss?.dependencies?.["source-map-js"]).toBe("^1.2.1");
    expect(sourceMap?.version).toBe("1.2.2");
    expect(sourceMap?.dev).toBe(true);
    expect(sourceMap?.version && sourceMap.version >= "1.2.2").toBe(true);
  });
});
