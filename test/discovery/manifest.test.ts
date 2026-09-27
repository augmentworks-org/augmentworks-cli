import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LAST_VERIFIED_PUBLISHED_DISCOVERY,
  parseDiscoveryManifest,
  sourceDiscoveryManifest,
  buildDiscoveryManifest
} from "../../src/discovery.js";
import { SOURCE_PACKAGE_VERSION } from "../../src/release.js";

const committedUrl = new URL("../../contracts/discovery-manifest.json", import.meta.url);

describe("discovery manifest", () => {
  it("keeps the committed source artifact synchronized and development-status", async () => {
    const committed = JSON.parse(await readFile(committedUrl, "utf8")) as unknown;
    const expected = sourceDiscoveryManifest();
    expect(committed).toEqual(expected);
    const parsed = parseDiscoveryManifest(committed);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.package.version).toBe(SOURCE_PACKAGE_VERSION);
      expect(parsed.manifest.package.releaseStatus).toBe("development");
      expect(parsed.manifest.capabilities.localDemo).toBe(true);
      expect(parsed.manifest.commands.localDemo).toEqual(["node", "dist/index.js", "demo"]);
      expect(parsed.manifest.provenance.verifiedAt).toBeNull();
      expect(parsed.manifest.provenance.sourceCommit).toBeNull();
    }
  });

  it("keeps the last independently inspected published 0.3.7 snapshot with demo", () => {
    const parsed = parseDiscoveryManifest(LAST_VERIFIED_PUBLISHED_DISCOVERY);
    expect(parsed.ok).toBe(true);
    expect(LAST_VERIFIED_PUBLISHED_DISCOVERY.package.version).toBe("0.3.7");
    expect(LAST_VERIFIED_PUBLISHED_DISCOVERY.package.releaseStatus).toBe("published");
    expect(LAST_VERIFIED_PUBLISHED_DISCOVERY.capabilities.localDemo).toBe(true);
    expect(LAST_VERIFIED_PUBLISHED_DISCOVERY.commands.localDemo).toEqual([
      "npx",
      "--yes",
      "@augmentworks/cli@0.3.7",
      "demo"
    ]);
    expect(LAST_VERIFIED_PUBLISHED_DISCOVERY.provenance.verifiedAt).toBe(
      "2026-09-27T21:06:12.276Z"
    );
    expect(LAST_VERIFIED_PUBLISHED_DISCOVERY.provenance.sourceCommit).toBe(
      "876454878a31a897aec1d722fa838c9c0ecea2aa"
    );
  });

  it("rejects capability/command mismatches and invalid schema", () => {
    const missingCommand = buildDiscoveryManifest({ localDemo: true });
    const invalid = {
      ...missingCommand,
      capabilities: { ...missingCommand.capabilities, localDemo: true },
      commands: { ...missingCommand.commands, localDemo: null }
    };
    expect(parseDiscoveryManifest(invalid).ok).toBe(false);
    expect(parseDiscoveryManifest({ schemaVersion: 2 }).ok).toBe(false);
    expect(
      parseDiscoveryManifest({
        ...missingCommand,
        commands: {
          ...missingCommand.commands,
          localDemo: ["node", "dist/index.js", "demo", "&&", "curl", "https://example"]
        }
      }).ok
    ).toBe(false);
  });

  it("requires npx pins and verification timestamps for published status", () => {
    const unpublishedStamp = buildDiscoveryManifest({
      releaseStatus: "published",
      version: "0.3.2",
      localDemo: true,
      verifiedAt: null
    });
    expect(parseDiscoveryManifest(unpublishedStamp).ok).toBe(false);

    const published = buildDiscoveryManifest({
      releaseStatus: "published",
      version: "0.3.2",
      localDemo: true,
      verifiedAt: "2026-09-06T00:00:00.000Z",
      sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    const parsed = parseDiscoveryManifest(published);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.commands.localDemo?.[0]).toBe("npx");
      expect(parsed.manifest.commands.localDemo?.[2]).toBe("@augmentworks/cli@0.3.2");
    }
  });

  it("keeps the source checkout development-status without claiming this tarball is already inspected", () => {
    const source = sourceDiscoveryManifest();
    expect(source.package.version).toBe("0.3.7");
    expect(source.package.releaseStatus).toBe("development");
    expect(source.provenance.verifiedAt).toBeNull();
    expect(source.provenance.sourceCommit).toBeNull();
    expect(LAST_VERIFIED_PUBLISHED_DISCOVERY.package.version).toBe("0.3.7");
    expect(LAST_VERIFIED_PUBLISHED_DISCOVERY.capabilities.localDemo).toBe(true);
    expect(source.capabilities.localDemo).toBe(true);
  });
});

void resolve;
void fileURLToPath;
