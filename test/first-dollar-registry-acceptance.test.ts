import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  LAST_VERIFIED_PUBLISHED_AT,
  LAST_VERIFIED_PUBLISHED_GIT_HEAD,
  LAST_VERIFIED_PUBLISHED_INTEGRITY,
  LAST_VERIFIED_PUBLISHED_PACKAGE_VERSION,
  NPM_PACKAGE,
  PUBLISHED_PACKAGE_VERIFIED,
  REGISTRY_0_3_3_GIT_HEAD,
  SOURCE_PACKAGE_VERSION
} from "../src/release.js";

const firstDollarUrl = new URL(
  "../docs/feature-readiness/first-dollar-registry-acceptance.json",
  import.meta.url
);
const registryEvidenceUrl = new URL(
  "../docs/feature-readiness/published-registry-evidence.json",
  import.meta.url
);

type CheckStatus = "pass" | "fail" | "not_run";

interface FirstDollarEvidence {
  schemaVersion: string;
  verifiedAt: string | null;
  cli: {
    packageName: string;
    version: string;
    gitHead: string | null;
    integrity: string | null;
    registryUrl: string;
  };
  mainContractSha: string;
  bundlePaths: string[];
  commands: string[];
  checks: Array<{
    name: string;
    artifactKind: "registry";
    status: CheckStatus;
    evidence: string;
  }>;
  limitations: string[];
}

interface PublishedRegistryEvidence {
  schemaVersion: string;
  lastIndependentlyInspected: {
    version: string;
    gitHead: string;
    integrity: string;
    verifiedAt: string;
  };
  thisPackageIdentity: {
    version: string;
    gitHead: string | null;
    integrity: string | null;
    verifiedAt: string | null;
    status: string;
  };
}

describe("first-dollar registry acceptance handoff", () => {
  it("records independently inspected 0.3.4 registry evidence separately from this package identity", async () => {
    const evidence = JSON.parse(await readFile(firstDollarUrl, "utf8")) as FirstDollarEvidence;

    expect(evidence.schemaVersion).toBe("aw-first-dollar-release/1");
    expect(evidence.cli.packageName).toBe(NPM_PACKAGE);
    expect(evidence.cli.version).toBe("0.3.4");
    expect(evidence.cli.version).not.toBe(SOURCE_PACKAGE_VERSION);
    expect(evidence.cli.registryUrl).toBe("https://registry.npmjs.org/@augmentworks/cli/0.3.4");
    expect(evidence.cli.gitHead).toBe("c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f");
    expect(evidence.cli.integrity).toBe(
      "sha512-TLeAzDglZoGL6fWLxA9rIUwJd69NFqgmlONzU4uRmhDz4S31+dfSZpaj44ahb6lUjnmuoY6sDmfPStxFzInpVQ=="
    );
    expect(evidence.verifiedAt).toBe("2026-09-08T06:38:24.847Z");
    expect(evidence.mainContractSha).toBe("650472d91442a6866a7b6ef18e6dacc23a2a9260");
    expect(evidence.bundlePaths).toEqual(expect.arrayContaining([
      "assets/starters/response-quality/own-chatbot.suite.yaml",
      "assets/starters/workflow/server.mjs",
      "assets/customer-suites/faq-non-commerce.yaml"
    ]));
    expect(evidence.commands).toEqual(expect.arrayContaining([
      "probe",
      "suite validate",
      "test --suite",
      "run report"
    ]));
    expect(evidence.checks.length).toBeGreaterThan(0);
    expect(evidence.checks.every((check) => check.artifactKind === "registry")).toBe(true);
    expect(evidence.checks.every((check) => ["pass", "fail", "not_run"].includes(check.status))).toBe(
      true
    );
    expect(JSON.stringify(evidence)).not.toMatch(/sk-(?:ant-)?api/iu);
    expect(JSON.stringify(evidence)).not.toMatch(/npx --yes @augmentworks\/cli@0\.3\.2\b/u);
  });

  it("does not treat packaged identity as a live 0.3.8 registry probe", async () => {
    const evidence = JSON.parse(await readFile(firstDollarUrl, "utf8")) as FirstDollarEvidence;
    const registryIdentity = evidence.checks.find(
      (check) => check.name === "registry-tarball-gitHead-integrity"
    );

    expect(PUBLISHED_PACKAGE_VERIFIED).toBe(true);
    expect(LAST_VERIFIED_PUBLISHED_PACKAGE_VERSION).toBe("0.3.8");
    expect(LAST_VERIFIED_PUBLISHED_GIT_HEAD).toBe(
      "f36d9086bad1ac109a7670e8acc9bf14a5d15047"
    );
    expect(LAST_VERIFIED_PUBLISHED_INTEGRITY).toBe(
      "sha512-T+e1VWQ8plx0jJMdkOHxocpH8SjCr9BSeRLMsCnCHAO0Z3z9bhgIf0um9x6eyWJfwPz01YOL7CZvM6sLTiSLIA=="
    );
    expect(LAST_VERIFIED_PUBLISHED_AT).toBe("2026-10-08T01:42:45.969Z");
    expect(REGISTRY_0_3_3_GIT_HEAD).toBe("4a08ea0d352f2515e725cb9ca946807112422436");
    expect(registryIdentity?.status).toBe("pass");
    expect(evidence.cli.gitHead).not.toBeNull();
    expect(evidence.cli.integrity).not.toBeNull();
    expect(evidence.verifiedAt).not.toBeNull();
    expect(evidence.cli.version).toBe("0.3.4");
    expect(evidence.cli.gitHead).not.toBe(LAST_VERIFIED_PUBLISHED_GIT_HEAD);
    expect(evidence.limitations.some((line) => line.includes("0.3.3"))).toBe(true);
    expect(evidence.limitations.some((line) => line.includes("0.3.4"))).toBe(true);
  });
});

describe("published registry evidence record", () => {
  it("records independently inspected 0.3.8 without relabeling 0.3.7", async () => {
    const record = JSON.parse(await readFile(registryEvidenceUrl, "utf8")) as PublishedRegistryEvidence & {
      immutableArtifacts: Array<{ version: string; gitHead: string }>;
    };

    expect(record.schemaVersion).toBe("aw-cli-registry-evidence/1");
    expect(record.lastIndependentlyInspected.version).toBe("0.3.8");
    expect(record.lastIndependentlyInspected.gitHead).toBe(
      "f36d9086bad1ac109a7670e8acc9bf14a5d15047"
    );
    expect(record.lastIndependentlyInspected.integrity).toBe(
      "sha512-T+e1VWQ8plx0jJMdkOHxocpH8SjCr9BSeRLMsCnCHAO0Z3z9bhgIf0um9x6eyWJfwPz01YOL7CZvM6sLTiSLIA=="
    );
    expect(record.lastIndependentlyInspected.verifiedAt).toBe("2026-10-08T01:42:45.969Z");
    expect(record.thisPackageIdentity.version).toBe(SOURCE_PACKAGE_VERSION);
    expect(record.thisPackageIdentity.version).toBe("0.3.8");
    expect(record.thisPackageIdentity.gitHead).toBe("f36d9086bad1ac109a7670e8acc9bf14a5d15047");
    expect(record.thisPackageIdentity.integrity).toBe(
      "sha512-T+e1VWQ8plx0jJMdkOHxocpH8SjCr9BSeRLMsCnCHAO0Z3z9bhgIf0um9x6eyWJfwPz01YOL7CZvM6sLTiSLIA=="
    );
    expect(record.thisPackageIdentity.verifiedAt).toBe("2026-10-08T01:42:45.969Z");
    expect(record.thisPackageIdentity.status).toBe("independently-inspected");
    expect(record.thisPackageIdentity.version).toBe(record.lastIndependentlyInspected.version);
    expect(record.immutableArtifacts.find((artifact) => artifact.version === "0.3.7")?.gitHead).toBe(
      "876454878a31a897aec1d722fa838c9c0ecea2aa"
    );
    expect(record.immutableArtifacts.find((artifact) => artifact.version === "0.3.6")?.gitHead).toBe(
      "a9b927a2413305003f817c20e9c5df277512f83e"
    );
    expect(record.immutableArtifacts.find((artifact) => artifact.version === "0.3.5")?.gitHead).toBe(
      "11570f6cf883ec6e6743e010c35134bb485234dd"
    );
  });
});
