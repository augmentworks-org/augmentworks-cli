import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CLI_RELEASE, SOURCE_PACKAGE_VERSION } from "../../src/release.js";
import { CLI_VERSION, HOSTED_ASSESSMENT_OPTION_HELP } from "../../src/version.js";
import { runSourceCli } from "../util/cli-process.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const currentSurfaces = [
  "README.md",
  "docs/agent-setup.md",
  "docs/discovery-handoff.md",
  "docs/distribution-runbook.md",
  "docs/command-examples.md",
  "docs/examples/README.md",
  "docs/examples/github-actions-hosted.yml",
  "docs/examples/github-actions-local.yml",
  "docs/examples/github-actions-hosted-gate.yml",
  "docs/examples/github-actions-hosted-source.yml",
  "agent-resources/guidance.md",
  "agent-resources/augmentworks/SKILL.md",
  "agent-resources/codex/AGENTS.snippet.md",
  "assets/starters/response-quality/OWN-TARGET.md",
  "assets/starters/workflow/OWN-TARGET.md",
  "schemas/v1/cli-release.json"
] as const;

const supersededPatterns: Array<{ name: string; pattern: RegExp }> = [
  { name: "Candidate 0.3.4", pattern: /Candidate 0\.3\.4/u },
  { name: "That candidate includes", pattern: /That candidate includes/u },
  { name: "this candidate pin", pattern: /this candidate pin/u },
  { name: "this 0.3.4 candidate", pattern: /this 0\.3\.4 candidate/u },
  { name: "0.3.4 candidate", pattern: /0\.3\.4 candidate/u },
  { name: "(candidate;", pattern: /\(candidate;/u },
  {
    name: "last independently verified npm remains 0.3.2",
    pattern: /last independently verified npm remains [`*_]*0\.3\.2/iu
  },
  {
    name: "source 0.3.3; published 0.3.2",
    pattern: /source 0\.3\.3;\s*published 0\.3\.2/u
  },
  { name: "invite-only package", pattern: /invite-only/iu }
];

async function readSurface(path: string): Promise<string> {
  return (await readFile(resolve(projectRoot, path), "utf8")).replace(/\r\n?/gu, "\n");
}

describe("current release truth", () => {
  it.each(currentSurfaces)("%s does not embed superseded 0.3.2/0.3.3/candidate claims", async (path) => {
    const content = await readSurface(path);
    for (const { name, pattern } of supersededPatterns) {
      expect(content, `${path} still contains ${name}`).not.toMatch(pattern);
    }
  });

  it("pins current user-facing surfaces to this package version", async () => {
    expect(SOURCE_PACKAGE_VERSION).toBe(CLI_VERSION);
    expect(CLI_RELEASE.published_package_verified).toBe(true);
    expect(CLI_RELEASE.published_package_version).toBe(CLI_VERSION);

    const readme = await readSurface("README.md");
    expect(readme).toContain(`@augmentworks/cli@${CLI_VERSION}`);
    const runbook = await readSurface("docs/distribution-runbook.md");
    expect(runbook).toContain(`| This package (\`package.json\`) | \`${CLI_VERSION}\` |`);

    const guidance = await readSurface("agent-resources/guidance.md");
    expect(guidance).toContain(`@augmentworks/cli@${CLI_VERSION}`);
  });

  it("derives test --help assessment copy from the current protocol constant", async () => {
    const testHelp = await runSourceCli(["test", "--help"], { cwd: projectRoot });
    expect(testHelp.exitCode).toBe(0);
    expect(testHelp.stdout).toContain(HOSTED_ASSESSMENT_OPTION_HELP);
    expect(testHelp.stdout).not.toMatch(/source 0\.3\.3/u);
    expect(testHelp.stdout).not.toMatch(/published 0\.3\.2 uses aw-relay\/0\.2/u);
    expect(testHelp.stdout).not.toMatch(/Candidate 0\.3\.4/u);
  });
});
