import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("a clean consumer can install the tarball and import both exports offline", {
  skip: process.env.npm_execpath ? false : "Run npm test to exercise the npm package.",
}, t => {
  const consumer = mkdtempSync(join(tmpdir(), "aw-mcp-contracts-"));
  t.after(() => rmSync(consumer, { recursive: true, force: true }));
  const env = { ...process.env, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" };
  const npm = (cwd, args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, env, encoding: "utf8" });
  const [packed] = JSON.parse(npm(root, ["pack", "--json", "--ignore-scripts", "--pack-destination", consumer]));
  assert.equal(packed.name, "@augmentworks/mcp-contracts");
  assert.deepEqual(packed.files.map(file => file.path).sort(),
    ["LICENSE", "README.md", "fixtures/read-v1.json", "index.mjs", "package.json"]);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  npm(consumer, ["install", "--ignore-scripts", "--no-package-lock", join(consumer, packed.filename)]);
  const probe = `
    import assert from "node:assert/strict";
    import { createReadToolDefinitions, parseReadToolArgs, projectReadToolResult } from "@augmentworks/mcp-contracts";
    import fixtures from "@augmentworks/mcp-contracts/fixtures/read-v1.json" with { type: "json" };
    assert.equal(typeof createReadToolDefinitions, "function");
    for (const { tool, args, upstream, expected } of fixtures.cases) {
      assert.deepEqual(projectReadToolResult(tool, parseReadToolArgs(tool, args), upstream), expected);
    }
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", probe], { cwd: consumer, env });
});
