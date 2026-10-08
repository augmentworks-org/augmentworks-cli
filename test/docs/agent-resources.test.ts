import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function read(path: string): Promise<string> {
  return (await readFile(resolve(root, path), "utf8")).replace(/\r\n?/gu, "\n");
}

describe("agent resources", () => {
  it("keeps host wrappers aligned with the canonical guidance file", async () => {
    const guidance = (await read("agent-resources/guidance.md")).trim();
    expect(guidance.length).toBeGreaterThan(200);
    const skill = await read("agent-resources/augmentworks/SKILL.md");
    const cursor = await read("agent-resources/cursor/augmentworks.mdc");
    const codex = await read("agent-resources/codex/AGENTS.snippet.md");
    for (const wrapper of [skill, cursor, codex]) {
      expect(wrapper).toContain(guidance);
      expect(wrapper).not.toMatch(/npx(?:\s+(?:--yes|-y))?\s+@augmentworks\/cli@latest\b/u);
      expect(wrapper).not.toMatch(/npx(?:\s+(?:--yes|-y))?\s+@augmentworks\/cli@0\.3\.3\b/u);
      expect(wrapper).not.toMatch(/npx(?:\s+(?:--yes|-y))?\s+@augmentworks\/cli@0\.3\.5\b/u);
      expect(wrapper).not.toMatch(/npx(?:\s+(?:--yes|-y))?\s+@augmentworks\/cli@0\.3\.6\b/u);
      expect(wrapper).not.toMatch(/npx(?:\s+(?:--yes|-y))?\s+@augmentworks\/cli@0\.3\.7\b/u);
      expect(wrapper).toMatch(/npx(?:\s+(?:--yes|-y))?\s+@augmentworks\/cli@0\.3\.8\b/u);
    }
    expect(skill.startsWith("---\nname: augmentworks\n")).toBe(true);
    expect(cursor).toContain("alwaysApply: false");
    expect(codex).toContain("Copy into a repository");
  });
});
