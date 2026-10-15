import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SUPPORTED_NODE_MINIMUM, nodeSupportWarning } from "../../src/system/node-support.js";

describe("nodeSupportWarning", () => {
  it("matches engines.node in package.json", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8")
    ) as { engines: { node: string } };
    const { major, minor } = SUPPORTED_NODE_MINIMUM;
    expect(packageJson.engines.node).toBe(`>=${major}.${minor}`);
  });

  it("warns below the floor and stays quiet from the floor up", () => {
    for (const version of ["20.19.0", "v20.19.0", "22.11.0", "18.0.0"]) {
      expect(nodeSupportWarning(version)).toMatch(/^Warning: AugmentWorks supports Node\.js 22\.12 or newer\. /);
    }
    expect(nodeSupportWarning("20.19.0")).toContain("You're running v20.19.0.");
    for (const version of ["22.12.0", "22.20.0", "24.0.0", "26.1.0", "not-a-version"]) {
      expect(nodeSupportWarning(version)).toBeNull();
    }
  });
});
