import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CLI_RELEASE,
  HOSTED_COMMAND_PIN,
  HOSTED_COMMANDS,
  INIT_NEXT_STEPS,
  LAST_VERIFIED_PUBLISHED_PACKAGE_VERSION,
  LAST_VERIFIED_PUBLISHED_GIT_HEAD,
  LAST_VERIFIED_PUBLISHED_AT,
  LAST_VERIFIED_PUBLISHED_INTEGRITY,
  LOCAL_COMMANDS,
  LOCAL_DISTRIBUTION,
  PUBLISHED_PACKAGE_VERIFIED,
  PUBLISHED_PACKAGE_VERSION,
  REGISTRY_0_3_3_GIT_HEAD,
  REGISTRY_0_3_6_GIT_HEAD,
  SOURCE_PACKAGE_VERSION,
  allowedDocumentedNpxPins,
  CUSTOMER_CLI_PLACEHOLDER,
  formatCustomerCli,
  formatNpx,
  formatSourceCli,
  initNextSteps,
  renderStarterOwnTarget
} from "../src/release.js";
import { CLI_VERSION, CONFIG_VERSION, RELAY_PROTOCOL_VERSION } from "../src/version.js";

const fixtureUrl = new URL("../schemas/v1/cli-release.json", import.meta.url);

describe("CLI release metadata", () => {
  it("keeps source version, protocol, and the checked-in website fixture synchronized", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as typeof CLI_RELEASE;

    expect(SOURCE_PACKAGE_VERSION).toBe(CLI_VERSION);
    expect(CLI_RELEASE.source_package_version).toBe(CLI_VERSION);
    expect(CLI_RELEASE.protocol_version).toBe(RELAY_PROTOCOL_VERSION);
    expect(CLI_RELEASE.config_version).toBe(CONFIG_VERSION);
    expect(CLI_RELEASE).toEqual(fixture);
  });

  it("pins hosted npx commands to this package version, not 0.3.2 or 0.3.3", () => {
    expect(SOURCE_PACKAGE_VERSION).toBe("0.3.7");
    expect(PUBLISHED_PACKAGE_VERSION).toBe("0.3.7");
    expect(HOSTED_COMMAND_PIN).toBe(SOURCE_PACKAGE_VERSION);
    expect(HOSTED_COMMAND_PIN).not.toBe("0.3.2");
    expect(HOSTED_COMMAND_PIN).not.toBe("0.3.3");
    expect(HOSTED_COMMAND_PIN).not.toBe("0.3.4");
    expect(HOSTED_COMMAND_PIN).not.toBe("0.3.5");
    expect(HOSTED_COMMAND_PIN).not.toBe("0.3.6");
    expect(allowedDocumentedNpxPins()).toEqual(["0.3.7"]);
    expect(HOSTED_COMMANDS.login).toBe(formatNpx(HOSTED_COMMAND_PIN, ["login"]));
    expect(HOSTED_COMMANDS.initAgent).toBe(formatNpx(HOSTED_COMMAND_PIN, ["init", "--agent"]));
    expect(HOSTED_COMMANDS.recover).toBe(formatNpx(HOSTED_COMMAND_PIN, ["recover"]));
    expect(HOSTED_COMMANDS.test).toContain(`@augmentworks/cli@${HOSTED_COMMAND_PIN}`);
    expect(HOSTED_COMMANDS.test).toContain("--assessment");
    expect(HOSTED_COMMANDS.test).not.toContain("--local");
    expect(INIT_NEXT_STEPS).not.toContain("Published @augmentworks/cli@0.3.2 does not generate");
  });

  it("exposes published-line identity without baking a stale last-verified 0.3.2 result", () => {
    expect(PUBLISHED_PACKAGE_VERIFIED).toBe(true);
    expect(CLI_RELEASE.published_package_verified).toBe(true);
    expect(LAST_VERIFIED_PUBLISHED_PACKAGE_VERSION).toBe("0.3.7");
    expect(LAST_VERIFIED_PUBLISHED_GIT_HEAD).toBe("876454878a31a897aec1d722fa838c9c0ecea2aa");
    expect(LAST_VERIFIED_PUBLISHED_AT).toBe("2026-09-27T21:06:12.276Z");
    expect(LAST_VERIFIED_PUBLISHED_INTEGRITY).toBe(
      "sha512-O9IRRBgpCwRwQzUtIOgpa0nxRQ5UU6x28S7+G6e+egwmRP8QwvHTJgJUzmmFhyq+MhtzW8CPRHnAXhxRHNBIBA=="
    );
    expect(REGISTRY_0_3_3_GIT_HEAD).toBe("4a08ea0d352f2515e725cb9ca946807112422436");
    expect(REGISTRY_0_3_6_GIT_HEAD).toBe("a9b927a2413305003f817c20e9c5df277512f83e");
    expect(CLI_RELEASE.notes).toContain("Published-line 0.3.7");
    expect(CLI_RELEASE.notes).not.toMatch(/Candidate 0\.3\.4/u);
    expect(CLI_RELEASE.notes).not.toMatch(/Last independently verified published tarball remains @augmentworks\/cli@0\.3\.2/u);
    expect(CLI_RELEASE.notes).toContain("published-registry-evidence.json");
    expect(CLI_RELEASE.notes).toContain("876454878a31a897aec1d722fa838c9c0ecea2aa");
    expect(CLI_RELEASE.notes).toContain("a9b927a2413305003f817c20e9c5df277512f83e");
  });

  it("does not advertise unpublished local npx pins", () => {
    if (LOCAL_DISTRIBUTION === "git") {
      expect(SOURCE_PACKAGE_VERSION).not.toBe(PUBLISHED_PACKAGE_VERSION);
      expect(allowedDocumentedNpxPins()).not.toContain(SOURCE_PACKAGE_VERSION);
      expect(LOCAL_COMMANDS.test).toBe(
        [
          "node dist/index.js test \\",
          "  --local \\",
          "  -c augmentworks.yaml \\",
          "  --packet support-refunds-starter@0.1.0 \\",
          "  --open"
        ].join("\n")
      );
      expect(LOCAL_COMMANDS.test).toContain("node dist/index.js");
      expect(LOCAL_COMMANDS.test).not.toMatch(/npx\s+--yes\s+@augmentworks\/cli@0\.2\.0/u);
    } else {
      expect(LOCAL_COMMANDS.test).toContain(`@augmentworks/cli@${PUBLISHED_PACKAGE_VERSION}`);
    }
  });

  it("keeps default init next-steps copy and names a custom connector file", () => {
    expect(initNextSteps()).toBe(INIT_NEXT_STEPS);
    expect(INIT_NEXT_STEPS).toContain(
      "created augmentworks.yaml, augmentworks.assessment.yaml, starter references, and the packaged fixture server"
    );
    expect(INIT_NEXT_STEPS).toContain("probe");
    expect(initNextSteps("custom.yaml")).toContain(
      "created custom.yaml, augmentworks.assessment.yaml, starter references, and the packaged fixture server"
    );
    expect(initNextSteps("nested/custom.yaml", "nested/augmentworks.assessment.yaml")).toContain(
      "created nested/custom.yaml, nested/augmentworks.assessment.yaml, starter references, and the packaged fixture server"
    );
  });

  it("does not tell npm-installed customers to run node dist/index.js after init", async () => {
    expect(formatSourceCli(["probe", "-c", "augmentworks.yaml"])).toBe(
      "node dist/index.js probe -c augmentworks.yaml"
    );

    const preview = [
      "preview-mapping",
      "-c",
      "augmentworks.yaml",
      "--operation",
      "send",
      "--fixture",
      "./fixtures/send-response.json"
    ] as const;

    if (LOCAL_DISTRIBUTION === "npm") {
      expect(INIT_NEXT_STEPS).not.toContain("node dist/index.js");
      expect(initNextSteps()).not.toContain("node dist/index.js");
      expect(initNextSteps("custom.yaml")).not.toContain("node dist/index.js");
      expect(formatCustomerCli([...preview])).toBe(formatNpx(PUBLISHED_PACKAGE_VERSION, preview));
      expect(initNextSteps()).toContain(formatNpx(PUBLISHED_PACKAGE_VERSION, preview));
      expect(initNextSteps()).toContain(
        formatNpx(PUBLISHED_PACKAGE_VERSION, ["probe", "-c", "augmentworks.yaml"])
      );
      expect(initNextSteps()).toContain(
        formatNpx(PUBLISHED_PACKAGE_VERSION, ["probe", "-c", "augmentworks.yaml", "--yes"])
      );
      expect(initNextSteps("custom.yaml")).toContain(
        formatNpx(PUBLISHED_PACKAGE_VERSION, ["probe", "-c", "custom.yaml"])
      );
    } else {
      expect(formatCustomerCli([...preview])).toBe(formatSourceCli(preview));
      expect(initNextSteps()).toContain("node dist/index.js preview-mapping");
    }

    const guides = await Promise.all([
      readFile(new URL("../assets/starters/response-quality/OWN-TARGET.md", import.meta.url), "utf8"),
      readFile(new URL("../assets/starters/workflow/OWN-TARGET.md", import.meta.url), "utf8")
    ]);
    for (const guide of guides) {
      expect(guide).toContain(CUSTOMER_CLI_PLACEHOLDER);
      const rendered = renderStarterOwnTarget(guide);
      expect(rendered).not.toContain(CUSTOMER_CLI_PLACEHOLDER);
      if (LOCAL_DISTRIBUTION === "npm") {
        expect(rendered).not.toContain("node dist/index.js");
        expect(rendered).toContain(`npx --yes @augmentworks/cli@${PUBLISHED_PACKAGE_VERSION}`);
      } else {
        expect(rendered).toContain("node dist/index.js");
      }
    }
  });
});
