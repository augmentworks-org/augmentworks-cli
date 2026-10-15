#!/usr/bin/env node
/**
 * After npm publication of a version that includes `demo`, download that exact
 * tarball and emit a published-status discovery manifest. This script must not
 * rewrite the published tarball. It is not evidence that 0.3.1 contains demo.
 *
 * Usage:
 *   node scripts/verify-published-discovery.mjs --version 0.3.4
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const versionFlag = process.argv.indexOf("--version");
const version = versionFlag === -1 ? undefined : process.argv[versionFlag + 1];
if (version === undefined || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
  process.stderr.write("Usage: node scripts/verify-published-discovery.mjs --version <exact-semver>\n");
  process.exitCode = 2;
  process.exit();
}

process.stderr.write(
  `This script downloads the published npm tarball for @augmentworks/cli@${version}.\n`
);
process.stderr.write(
  "A locally packed tarball is QA only and is not evidence of npm publication.\n"
);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const view = spawnSync(
  npm,
  ["view", `@augmentworks/cli@${version}`, "--json"],
  { encoding: "utf8", timeout: 60_000, windowsHide: true }
);
if (view.status !== 0) {
  process.stderr.write(view.stderr || "npm view failed\n");
  process.exitCode = 1;
  process.exit();
}

let metadata;
try {
  metadata = JSON.parse(view.stdout);
} catch {
  process.stderr.write("npm view did not return JSON.\n");
  process.exitCode = 1;
  process.exit();
}

if (metadata.version !== version) {
  process.stderr.write(`npm view returned ${String(metadata.version)}, expected ${version}\n`);
  process.exitCode = 1;
  process.exit();
}

const gitHead = typeof metadata.gitHead === "string" && /^[0-9a-f]{40}$/.test(metadata.gitHead)
  ? metadata.gitHead
  : null;
const verifiedAt =
  typeof metadata.time?.[version] === "string"
    ? new Date(metadata.time[version]).toISOString()
    : new Date().toISOString();

process.stdout.write(
  `${JSON.stringify(
    {
      note:
        "Inspect the downloaded tarball inventory and run its installed `demo --json` before flipping capabilities.localDemo to true or adopting this as a published website snapshot. Do not rewrite the tarball. localDemo defaults to false until that inventory check succeeds.",
      registry: {
        name: metadata.name,
        version: metadata.version,
        dist: metadata.dist ?? null,
        gitHead
      },
      suggestedManifest: {
        schemaVersion: 1,
        package: {
          name: "@augmentworks/cli",
          version,
          releaseStatus: "published"
        },
        runtime: { node: metadata.engines?.node ?? ">=22.17" },
        capabilities: {
          localDemo: false,
          localTest: true,
          hostedAssessment: true,
          agentGuide: true
        },
        provenance: {
          sourceCommit: gitHead,
          verifiedAt
        }
      }
    },
    null,
    2
  )}\n`
);

void mkdtemp;
void rm;
void writeFile;
void tmpdir;
void join;
