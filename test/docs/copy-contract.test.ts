import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  HOSTED_COMMANDS,
  HOSTED_PACKET_REFERENCE,
  LOCAL_COMMANDS,
  LOCAL_PACKET_REFERENCE,
  PUBLISHED_LOCAL_COMMANDS,
  PUBLISHED_PACKAGE_VERSION,
  SOURCE_ASSESSMENT_COMMANDS,
  SOURCE_PACKAGE_VERSION,
  SOURCE_REPOSITORY,
  SOURCE_USAGE_COMMAND,
  SOURCE_USAGE_JSON_COMMAND,
  SOURCE_BILLING_COMMAND,
  SOURCE_BILLING_JSON_COMMAND,
  SOURCE_BILLING_PRINT_COMMAND,
  SOURCE_ESTIMATE_COMMAND,
  SOURCE_ESTIMATE_JSON_COMMAND,
  SOURCE_INIT_COMMAND,
  SOURCE_INIT_WORKFLOW_COMMAND,
  SOURCE_PREVIEW_MAPPING_COMMAND,
  SOURCE_PREVIEW_MAPPING_JSON_COMMAND,
  SOURCE_PROBE_COMMAND,
  SOURCE_PROBE_JSON_COMMAND,
  SOURCE_PROBE_YES_COMMAND,
  SOURCE_RUN_STATUS_COMMAND,
  SOURCE_RUN_WAIT_COMMAND,
  SOURCE_RUN_REPORT_COMMAND,
  SOURCE_COMPARE_COMMAND,
  SOURCE_GATE_COMMAND,
  SOURCE_GATE_WAIT_COMMAND,
  SOURCE_BASELINE_STATUS_COMMAND,
  SOURCE_INVESTIGATION_INSPECT_COMMAND,
  SOURCE_INVESTIGATION_INSPECT_JSON_COMMAND,
  SOURCE_INVESTIGATION_FETCH_COMMAND,
  SOURCE_INVESTIGATION_EXPORT_COMMAND,
  SOURCE_INVESTIGATION_TEST_COMMAND,
  SOURCE_CATALOG_LIST_COMMAND,
  SOURCE_CATALOG_SHOW_COMMAND,
  SOURCE_SELECTION_COMPILE_COMMAND,
  SOURCE_TEST_SHARD_COMMAND,
  SOURCE_GATE_MANIFEST_COMMAND,
  allowedDocumentedNpxPins,
  initNextSteps
} from "../../src/release.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const documentedSurfaces = [
  "README.md",
  "docs/agent-setup.md",
  "docs/authentication.md",
  "docs/configuration.md",
  "docs/protocol.md",
  "docs/security-model.md",
  "docs/troubleshooting.md",
  "docs/customer-suites.md",
  "docs/investigation.md",
  "docs/discovery-handoff.md",
  "docs/distribution-runbook.md",
  "docs/stabilization-implementation.md",
  "docs/stabilization-rollout.md",
  "docs/examples/github-actions-hosted.yml",
  "docs/examples/github-actions-local.yml",
  "examples/refund-agent/README.md",
  "examples/response-agent/README.md",
  "examples/basic-chat/README.md",
  "examples/faq-chatbot/README.md",
  "agent-resources/guidance.md"
] as const;

async function readSurface(path: string): Promise<string> {
  return (await readFile(resolve(projectRoot, path), "utf8")).replace(/\r\n?/gu, "\n");
}

describe("customer-facing CLI copy", () => {
  it.each(documentedSurfaces)("%s does not advertise an unregistered command", async (path) => {
    const content = await readSurface(path);

    expect(content).not.toMatch(
      /\bnpx(?:\s+(?:--yes|-y))?\s+["']?@augmentworks\/cli(?:@[^\s"'\x60]+)?["']?\s+connect\b/u
    );
    expect(content).not.toMatch(
      /\bnpx(?:\s+(?:--yes|-y))?\s+["']?@augmentworks\/cli(?:@[^\s"'\x60]+)?["']?\s+run(?!\s+(?:status|wait|retry-evaluation|report)\b)/u
    );
    expect(content).not.toMatch(/(?:^|\s)augmentworks\s+connect\b/u);
    expect(content).not.toMatch(
      /(?:^|\s)augmentworks\s+run(?!\s+(?:status|wait|retry-evaluation|report)\b)/u
    );
  });

  it.each(documentedSurfaces)("%s does not contain a stale deployment gate", async (path) => {
    const content = await readSurface(path);

    expect(content).not.toMatch(
      /(?:production|hosted|relay|service)[^\n.]{0,100}(?:not deployed|undeployed|once deployed|until [^\n.]* deployed)/iu
    );
  });

  it.each(documentedSurfaces)("%s pins executable npx examples to the verified published package", async (path) => {
    const content = await readSurface(path);
    const allowed = allowedDocumentedNpxPins();

    for (const match of content.matchAll(
      /npx(?:\s+(?:--yes|-y))?\s+@augmentworks\/cli@(\d+\.\d+\.\d+)/gu
    )) {
      expect(allowed).toContain(match[1]);
    }
  });

  it("leads with the source demo, then verified published local and hosted paths", async () => {
    const readme = await readSurface("README.md");

    expect(readme).toContain(HOSTED_COMMANDS.login);
    expect(readme).toContain(HOSTED_COMMANDS.test);
    expect(readme).toContain(HOSTED_PACKET_REFERENCE);
    expect(readme).toContain(LOCAL_PACKET_REFERENCE);
    expect(readme).toContain(SOURCE_REPOSITORY);
    expect(readme).toContain("npm ci");
    expect(readme).toContain(LOCAL_COMMANDS.demo);
    expect(readme).toContain(PUBLISHED_LOCAL_COMMANDS.test);
    expect(readme).toContain(`@augmentworks/cli@${PUBLISHED_PACKAGE_VERSION}`);
    if (SOURCE_PACKAGE_VERSION !== PUBLISHED_PACKAGE_VERSION) {
      expect(readme).not.toMatch(
        new RegExp(`npx(?:\\s+(?:--yes|-y))?\\s+@augmentworks/cli@${SOURCE_PACKAGE_VERSION}\\b`, "u")
      );
    }
    expect(readme).toContain(SOURCE_ASSESSMENT_COMMANDS.doctor);
    expect(readme).toContain(SOURCE_ASSESSMENT_COMMANDS.testQuick);
    expect(readme).toContain(SOURCE_ASSESSMENT_COMMANDS.testFull);
    expect(readme).toContain(SOURCE_USAGE_COMMAND);
    expect(readme).toContain(SOURCE_USAGE_JSON_COMMAND);
    expect(readme).toContain(SOURCE_BILLING_COMMAND);
    expect(readme).toContain(SOURCE_BILLING_JSON_COMMAND);
    expect(readme).toContain(SOURCE_BILLING_PRINT_COMMAND);
    expect(readme).toContain(SOURCE_ESTIMATE_COMMAND);
    expect(readme).toContain(SOURCE_ESTIMATE_JSON_COMMAND);
    expect(readme).toContain(SOURCE_INIT_COMMAND);
    expect(readme).toContain(SOURCE_INIT_WORKFLOW_COMMAND);
    expect(readme).toContain(PUBLISHED_LOCAL_COMMANDS.demo);
    expect(readme).toContain(SOURCE_PREVIEW_MAPPING_COMMAND);
    expect(readme).toContain(SOURCE_PREVIEW_MAPPING_JSON_COMMAND);
    expect(readme).toContain(SOURCE_PROBE_COMMAND);
    expect(readme).toContain(SOURCE_PROBE_JSON_COMMAND);
    expect(readme).toContain(SOURCE_PROBE_YES_COMMAND);
    expect(readme).toContain(SOURCE_RUN_STATUS_COMMAND);
    expect(readme).toContain(SOURCE_RUN_WAIT_COMMAND);
    expect(readme).toContain(SOURCE_RUN_REPORT_COMMAND);
    expect(readme).toContain(SOURCE_COMPARE_COMMAND);
    expect(readme).toContain(SOURCE_GATE_COMMAND);
    expect(readme).toContain(SOURCE_GATE_WAIT_COMMAND);
    expect(readme).toContain(SOURCE_BASELINE_STATUS_COMMAND);
    expect(readme).toContain(SOURCE_INVESTIGATION_INSPECT_COMMAND);
    expect(readme).toContain(SOURCE_INVESTIGATION_INSPECT_JSON_COMMAND);
    expect(readme).toContain(SOURCE_INVESTIGATION_FETCH_COMMAND);
    expect(readme).toContain(SOURCE_INVESTIGATION_EXPORT_COMMAND);
    expect(readme).toContain(SOURCE_INVESTIGATION_TEST_COMMAND);
    expect(readme).toContain(SOURCE_CATALOG_LIST_COMMAND);
    expect(readme).toContain(SOURCE_CATALOG_SHOW_COMMAND);
    expect(readme).toContain(SOURCE_SELECTION_COMPILE_COMMAND);
    expect(readme).toContain(SOURCE_TEST_SHARD_COMMAND);
    expect(readme).toContain(SOURCE_GATE_MANIFEST_COMMAND);
    expect(HOSTED_COMMANDS.test).toContain("--assessment");

    const demoAt = readme.indexOf(LOCAL_COMMANDS.demo);
    const publishedLocalAt = readme.indexOf(PUBLISHED_LOCAL_COMMANDS.test);
    const hostedTestAt = readme.indexOf(HOSTED_COMMANDS.test);
    expect(demoAt).toBeGreaterThan(-1);
    expect(publishedLocalAt).toBeGreaterThan(demoAt);
    expect(hostedTestAt).toBeGreaterThan(demoAt);
    const tick = String.fromCharCode(96);
    for (const command of ["login", "logout", "whoami", "usage", "billing", "init", "doctor", "preview-mapping", "probe", "demo", "catalog", "selection", "test", "suite", "investigation", "run", "compare", "gate", "baseline", "recover", "action", "schema"]) {
      expect(readme).toContain("| " + tick + command);
    }
  });

  it("documents separate platform and target credentials", async () => {
    const authentication = await readSurface("docs/authentication.md");
    const readme = await readSurface("README.md");
    const authenticationCopy = authentication.replace(/\s+/gu, " ");

    expect(authenticationCopy).toContain(
      "That connector credential is used only for CLI-to-AugmentWorks API"
    );
    expect(authenticationCopy).toContain("Target authentication is configured independently");
    expect(authenticationCopy).toContain("AUGMENTWORKS_API_KEY");
    expect(authenticationCopy).toContain("CHATBOT_API_KEY");
    expect(readme).toContain("Target authentication is separate");
  });

  it.each([
    "README.md",
    "docs/agent-setup.md",
    "docs/security-model.md",
    "docs/configuration.md",
    "docs/troubleshooting.md",
    "docs/customer-suites.md",
    "docs/qa/README.md",
    "agent-resources/guidance.md",
    "assets/starters/response-quality/OWN-TARGET.md",
    "assets/starters/workflow/OWN-TARGET.md",
    "examples/faq-chatbot/README.md"
  ] as const)("%s does not keep a blanket synthetic-only product ban", async (path) => {
    const content = (await readSurface(path)).replace(/\s+/gu, " ");
    const obsolete = [
      /Do not connect production systems or use production or regulated data\./u,
      /synthetic test data only\./u,
      /Use only an authorized, isolated synthetic target and synthetic test data\./u,
      /v0\.2 is for authorized, isolated synthetic targets/u,
      /v0\.2 supports authorized, isolated synthetic targets in test or staging environments and synthetic test data only\./u,
      /This package keeps that same target boundary\./u
    ];
    for (const pattern of obsolete) {
      expect(content, pattern.source).not.toMatch(pattern);
    }
    expect(content).toMatch(/release-disabled/u);
    expect(content.toLowerCase()).toContain("synthetic");
  });

  it("states gated real-data availability without claiming the release is on", async () => {
    const readme = (await readSurface("README.md")).replace(/\s+/gu, " ");
    const agentSetup = (await readSurface("docs/agent-setup.md")).replace(/\s+/gu, " ");
    const securityModel = (await readSurface("docs/security-model.md")).replace(/\s+/gu, " ");
    const troubleshooting = (await readSurface("docs/troubleshooting.md")).replace(/\s+/gu, " ");

    for (const content of [readme, agentSetup, securityModel]) {
      expect(content).toContain("Test your chatbot with your questions and business rules.");
      expect(content).toContain("hosted real-data");
      expect(content).toContain("release-disabled");
      expect(content).toContain("This text is not legal approval");
      expect(content).not.toMatch(/real-data is (already )?enabled/iu);
      expect(content).not.toMatch(/\b(SOC\s*2|HIPAA)\b[^\n.]{0,80}\b(certified|compliant)\b/iu);
    }
    expect(readme).toContain("aw-packet/local-authorized-1");
    expect(readme).toContain("account-free");
    expect(readme).toContain("fictional");
    expect(agentSetup).toContain("suite:write");
    expect(agentSetup).not.toContain("Use test or staging data only.");
    expect(securityModel).toContain("Zero Data Retention");
    expect(troubleshooting).toContain("synthetic_only: false");
    expect(troubleshooting).toContain("aw-packet/0.1");
    expect(initNextSteps()).toContain("hosted real-data stays release-disabled");
    expect(initNextSteps()).not.toContain("isolated synthetic target values");
  });

  it("uses gated init and local-test command copy without labeling authorized local runs synthetic", async () => {
    const init = await readSurface("src/commands/init.ts");
    const localTest = await readSurface("src/commands/local-test.ts");
    expect(init).toContain("Add only the prepare, send, observe, and cleanup hooks required by the selected pattern.");
    expect(init).toContain("The packaged starter is fictional.");
    expect(init).toContain("Hosted real-data quote and admission stay release-disabled");
    expect(init).toContain("Do not set \\`synthetic_only: true\\` on a live or authorized document");
    expect(init).not.toContain("Add only synthetic prepare, send, observe, and cleanup hooks");
    expect(init).not.toContain("Preview mappings with a synthetic JSON fixture");
    expect(localTest).toContain("Cancellation requested; draining cleanup.");
    expect(localTest).not.toContain("draining synthetic cleanup");
    expect(localTest).toContain("local attempt(s)");
    expect(localTest).not.toContain("local synthetic attempt(s)");
  });

  it("documents the local no-control-plane boundary without promising an air gap", async () => {
    const readme = (await readSurface("README.md")).replace(/\s+/gu, " ");
    const authentication = (await readSurface("docs/authentication.md")).replace(/\s+/gu, " ");
    const securityModel = (await readSurface("docs/security-model.md")).replace(/\s+/gu, " ");

    expect(readme).toContain("requires no AugmentWorks account and contacts no AugmentWorks service");
    expect(readme).toContain("configured target may itself be a network service");
    expect(authentication).toContain("Authentication is not used by `test --local`");
    expect(securityModel).toContain("contacts no AugmentWorks control-plane endpoint");
    expect(securityModel).toContain("not a promise of an air-gapped assessment");
  });

  it("documents strict local packet and schema contracts", async () => {
    const readme = await readSurface("README.md");
    const configuration = (await readSurface("docs/configuration.md")).replace(/\s+/gu, " ");

    expect(readme).toContain("support-refunds-starter@0.1.0");
    expect(readme).toContain("strict `aw-packet/0.1` JSON format");
    expect(readme).toContain("schema --kind local-packet");
    expect(readme).toContain("schema --kind local-result");
    expect(configuration).toContain('`schema_version: "aw-packet/0.1"`');
    expect(configuration).toContain("URLs, downloaded packets, JavaScript, and modules are not accepted");
  });

  it("preserves the local artifact trust boundary and fresh output contract", async () => {
    const trustLabel =
      "Local, customer-executed result. AugmentWorks did not receive or independently verify this run. This artifact is unsigned and is not a certification, audit, or hosted evidence record.";
    const readme = (await readSurface("README.md")).replace(/\s+/gu, " ");
    const securityModel = (await readSurface("docs/security-model.md")).replace(/\s+/gu, " ");
    const troubleshooting = (await readSurface("docs/troubleshooting.md")).replace(/\s+/gu, " ");

    expect(readme).toContain(trustLabel);
    expect(securityModel).toContain(trustLabel);
    expect(troubleshooting).toContain(trustLabel);
    expect(readme).toContain("`AW-LOCAL-RESULT-1`");
    expect(readme).toContain("`--output-dir <path>`");
    expect(readme).toContain("selected leaf must not already exist");
    expect(readme).toContain("self-contained static file with no scripts or external assets");
  });

  it("documents local cleanup, crash, and exit behavior", async () => {
    const readme = (await readSurface("README.md")).replace(/\s+/gu, " ");
    const securityModel = (await readSurface("docs/security-model.md")).replace(/\s+/gu, " ");
    const troubleshooting = (await readSurface("docs/troubleshooting.md")).replace(/\s+/gu, " ");

    expect(readme).toContain("A cleanup failure stops new attempts");
    expect(readme).toContain("A hard process or machine failure cannot guarantee cleanup");
    expect(securityModel).toContain("a second interrupt exits immediately");
    expect(troubleshooting).toContain("cleanup failure has exit code `6`");
    expect(troubleshooting).toContain("Hosted-only auth and relay codes `3` and `4` are unreachable");
  });

  it("documents resume and remediation as the same hosted test command", async () => {
    const readme = await readSurface("README.md");
    const troubleshooting = await readSurface("docs/troubleshooting.md");
    const agentSetup = await readSurface("docs/agent-setup.md");
    const example = await readSurface("examples/refund-agent/README.md");

    for (const content of [readme, troubleshooting, agentSetup, example]) {
      expect(content).toMatch(/no[\s`]*--rerun[\s`]*flag/u);
      expect(content).not.toMatch(
        /npx(?:[^\n]|\\\n)*@augmentworks\/cli@[^\n]*(?:[^\n]|\\\n)*test(?:[^\n]|\\\n)*--rerun/u
      );
    }
    expect(troubleshooting).toContain("Re-run the exact same `test` command");
    expect(example).toContain("git clone https://github.com/augmentworks-org/augmentworks-cli.git");
    expect(example).toContain("copy .env.example .env");
    expect(example).toContain(PUBLISHED_LOCAL_COMMANDS.test);
    expect(example).toContain(HOSTED_PACKET_REFERENCE);
    expect(example).toContain(LOCAL_PACKET_REFERENCE);
  });
});
