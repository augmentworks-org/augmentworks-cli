import {
  CLI_VERSION,
  CONFIG_VERSION,
  HOSTED_ASSESSMENT_OPTION_HELP,
  RELAY_PROTOCOL_VERSION
} from "./version.js";

export { HOSTED_ASSESSMENT_OPTION_HELP };

export const NPM_PACKAGE = "@augmentworks/cli";
export const SOURCE_REPOSITORY = "https://github.com/augmentworks-org/augmentworks-cli.git";
export const SOURCE_REPOSITORY_HTTPS = "https://github.com/augmentworks-org/augmentworks-cli";
export const EXAMPLE_PATH = "examples/refund-agent";

export const SOURCE_PACKAGE_VERSION: string = CLI_VERSION;
/** Identity of this tarball. Distinct from independently inspected registry evidence. */
export const PUBLISHED_PACKAGE_VERSION: string = CLI_VERSION;
/**
 * Packaged published-line identity. True when this artifact is a published
 * release, not a candidate snapshot.
 *
 * This field is not a live npm registry probe of this exact tarball.
 * Independent inspection of a specific registry version is recorded in
 * LAST_VERIFIED_* and docs/feature-readiness/published-registry-evidence.json,
 * keyed by version. Those records can only be filled after publication and must
 * not be baked back as "this tarball is unverified; use 0.3.2".
 */
export const PUBLISHED_PACKAGE_VERIFIED = true;
/**
 * Last independently inspected npm tarball. This records a downloaded
 * registry artifact, not a live probe baked into that same tarball.
 * Do not relabel 0.3.7, 0.3.6, 0.3.5, 0.3.4, 0.3.3, or 0.3.2 provenance.
 */
export const LAST_VERIFIED_PUBLISHED_PACKAGE_VERSION = "0.3.7";
export const LAST_VERIFIED_PUBLISHED_GIT_HEAD = "876454878a31a897aec1d722fa838c9c0ecea2aa";
export const LAST_VERIFIED_PUBLISHED_AT = "2026-09-27T21:06:12.276Z";
export const LAST_VERIFIED_PUBLISHED_INTEGRITY =
  "sha512-O9IRRBgpCwRwQzUtIOgpa0nxRQ5UU6x28S7+G6e+egwmRP8QwvHTJgJUzmmFhyq+MhtzW8CPRHnAXhxRHNBIBA==";
/** Immutable npm 0.3.3 (not this release). Do not overwrite or relabel. */
export const REGISTRY_0_3_3_GIT_HEAD = "4a08ea0d352f2515e725cb9ca946807112422436";
/** Immutable npm 0.3.4 (not this release). Do not overwrite or relabel. */
export const REGISTRY_0_3_4_GIT_HEAD = "c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f";
export const REGISTRY_0_3_5_GIT_HEAD = "11570f6cf883ec6e6743e010c35134bb485234dd";
/** Immutable npm 0.3.6. Kept as a literal so later inspections do not relabel it. */
export const REGISTRY_0_3_6_GIT_HEAD = "a9b927a2413305003f817c20e9c5df277512f83e";
export const HOSTED_COMMAND_PIN: string = SOURCE_PACKAGE_VERSION;
export const LOCAL_DISTRIBUTION: "npm" | "git" =
  SOURCE_PACKAGE_VERSION === PUBLISHED_PACKAGE_VERSION ? "npm" : "git";

export const HOSTED_PACKET_REFERENCE = "support-refunds@0.1.0";
export const LOCAL_PACKET_REFERENCE = "support-refunds-starter@0.1.0";
export const PROTOCOL_VERSION = RELAY_PROTOCOL_VERSION;
export const TARGET_PROTOCOL_VERSION = "aw-target/0.1";

export type CliReleaseFixture = {
  readonly schema_version: "aw-cli-release/0.1";
  readonly npm_package: typeof NPM_PACKAGE;
  readonly source_package_version: string;
  readonly published_package_version: string;
  readonly published_package_verified: boolean;
  readonly recommended_cli_version: string;
  readonly hosted_command_pin: string;
  readonly local_distribution: "npm" | "git";
  readonly local_source_repository: string;
  readonly local_source_ref: string;
  readonly local_example_path: string;
  readonly hosted_packet: string;
  readonly local_packet: string;
  readonly protocol_version: string;
  readonly target_protocol_version: string;
  readonly config_version: number;
  readonly notes: string;
};

export const CLI_RELEASE: CliReleaseFixture = {
  schema_version: "aw-cli-release/0.1",
  npm_package: NPM_PACKAGE,
  source_package_version: SOURCE_PACKAGE_VERSION,
  published_package_version: PUBLISHED_PACKAGE_VERSION,
  published_package_verified: PUBLISHED_PACKAGE_VERIFIED,
  recommended_cli_version: HOSTED_COMMAND_PIN,
  hosted_command_pin: HOSTED_COMMAND_PIN,
  local_distribution: LOCAL_DISTRIBUTION,
  local_source_repository: SOURCE_REPOSITORY,
  local_source_ref: "main",
  local_example_path: EXAMPLE_PATH,
  hosted_packet: HOSTED_PACKET_REFERENCE,
  local_packet: LOCAL_PACKET_REFERENCE,
  protocol_version: PROTOCOL_VERSION,
  target_protocol_version: TARGET_PROTOCOL_VERSION,
  config_version: CONFIG_VERSION,
  notes:
    "Published-line 0.3.7 includes the AUG-82 suite-selection capability fix plus source work after 0.3.6: native aw-customer-suite/1 upload translation, saved-suite v2 binding, authoritative v2 whole-suite gate receipts, durable execution IDs, cross-shard quote/run uniqueness, and non-destructive generated .env guidance. Generated and documented npx commands pin this package version (0.3.7). published_package_verified is published-line identity (not a candidate), not a live registry probe of this exact tarball. Independent inspection of npm @augmentworks/cli@0.3.7 (gitHead 876454878a31a897aec1d722fa838c9c0ecea2aa, integrity sha512-O9IRRBgpCwRwQzUtIOgpa0nxRQ5UU6x28S7+G6e+egwmRP8QwvHTJgJUzmmFhyq+MhtzW8CPRHnAXhxRHNBIBA==, published 2026-09-27T21:06:12.276Z, tarball SHA-256 37b448b4db2c195b5c361daab10604d57476fa4d9e441916f7bfe2054f81b313) is recorded in docs/feature-readiness/published-registry-evidence.json. The published 0.3.7 tarball itself still embeds the prior LAST_VERIFIED 0.3.6 snapshot; this inspection commit is not inside that immutable artifact. Do not overwrite or relabel immutable npm 0.3.7, 0.3.6 (gitHead a9b927a2413305003f817c20e9c5df277512f83e), 0.3.5, 0.3.4, or 0.3.3. Website adoption of this exact pin is AUG-250. Do not fetch latest. Vendors aw-billing/1 from main 650472d91442a6866a7b6ef18e6dacc23a2a9260 including subscriptions_v1. The CLI does not subscribe, cancel, or collect payment methods. Live subscription sales stay gated on the server. Catalog list/show and selection compile consume aw-coverage-catalog/1 and aw-suite-selection/1 without a local compiler or pricing engine. Saved-suite compiles request aw-suite-selection/2. Do not run @latest."
};

export function formatNpx(pin: string, argv: readonly string[]): string {
  const invocation = `npx --yes ${NPM_PACKAGE}@${pin}`;
  return argv.length === 0 ? invocation : `${invocation} ${argv.join(" ")}`;
}

export function formatWrappedCommand(prefix: string, command: string, lines: readonly string[]): string {
  if (lines.length === 0) return `${prefix} ${command}`;
  return [
    `${prefix} ${command} \\`,
    ...lines.map((line, index) => `  ${line}${index < lines.length - 1 ? " \\" : ""}`)
  ].join("\n");
}

/**
 * Source-checkout invocation after `npm ci && npm run build`.
 * Do not use this for npm-installed customer copy; that must go through
 * `formatCustomerCli` so `LOCAL_DISTRIBUTION === "npm"` prints the published pin.
 */
export function formatSourceCli(argv: readonly string[]): string {
  return argv.length === 0 ? "node dist/index.js" : `node dist/index.js ${argv.join(" ")}`;
}

/** Placeholder in packaged `OWN-TARGET.md` starters, replaced at init. */
export const CUSTOMER_CLI_PLACEHOLDER = "{{AW_CLI}}";

/**
 * Customer-facing CLI invocation for this artifact's distribution.
 * npm tarballs and npx installs use the published pin; git checkouts keep
 * `node dist/index.js` after an explicit build.
 */
export function formatCustomerCli(argv: readonly string[] = []): string {
  if (LOCAL_DISTRIBUTION === "npm") {
    return formatNpx(PUBLISHED_PACKAGE_VERSION, argv);
  }
  return formatSourceCli(argv);
}

export function renderStarterOwnTarget(content: string): string {
  return content.replaceAll(CUSTOMER_CLI_PLACEHOLDER, formatCustomerCli());
}

function formatDocumentedCli(command: string, lines: readonly string[]): string {
  if (LOCAL_DISTRIBUTION === "npm") {
    return formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${PUBLISHED_PACKAGE_VERSION}`, command, lines);
  }
  return formatWrappedCommand("node dist/index.js", command, lines);
}

export const HOSTED_COMMANDS = {
  login: formatNpx(HOSTED_COMMAND_PIN, ["login"]),
  loginDevice: formatNpx(HOSTED_COMMAND_PIN, ["login", "--device"]),
  logout: formatNpx(HOSTED_COMMAND_PIN, ["logout"]),
  whoami: formatNpx(HOSTED_COMMAND_PIN, ["whoami"]),
  initAgent: formatNpx(HOSTED_COMMAND_PIN, ["init", "--agent"]),
  doctor: formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${HOSTED_COMMAND_PIN}`, "doctor", [
    "-c augmentworks.yaml"
  ]),
  schemaConfig: formatNpx(HOSTED_COMMAND_PIN, ["schema", "--kind", "config"]),
  recover: formatNpx(HOSTED_COMMAND_PIN, ["recover"]),
  test: formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${HOSTED_COMMAND_PIN}`, "test", [
    "-c augmentworks.yaml",
    "--assessment ./augmentworks.assessment.yaml",
    "--profile quick",
    "--open"
  ])
} as const;

export const LOCAL_COMMANDS = {
  doctor: formatDocumentedCli("doctor", ["-c augmentworks.yaml"]),
  schemaPacket:
    LOCAL_DISTRIBUTION === "npm"
      ? formatNpx(PUBLISHED_PACKAGE_VERSION, ["schema", "--kind", "local-packet"])
      : formatSourceCli(["schema", "--kind", "local-packet"]),
  schemaResult:
    LOCAL_DISTRIBUTION === "npm"
      ? formatNpx(PUBLISHED_PACKAGE_VERSION, ["schema", "--kind", "local-result"])
      : formatSourceCli(["schema", "--kind", "local-result"]),
  test: formatDocumentedCli("test", [
    "--local",
    "-c augmentworks.yaml",
    `--packet ${LOCAL_PACKET_REFERENCE}`,
    "--open"
  ]),
  demo: formatDocumentedCli("demo", [])
} as const;

export const SOURCE_DEMO_COMMAND = formatSourceCli(["demo"]);
export const SOURCE_PREVIEW_MAPPING_COMMAND = formatSourceCli([
  "preview-mapping",
  "-c",
  "augmentworks.yaml",
  "--operation",
  "send",
  "--fixture",
  "./fixtures/send-response.json"
]);
export const SOURCE_PREVIEW_MAPPING_JSON_COMMAND = formatSourceCli([
  "preview-mapping",
  "-c",
  "augmentworks.yaml",
  "--operation",
  "send",
  "--fixture",
  "./fixtures/send-response.json",
  "--json"
]);
export const SOURCE_DEMO_JSON_COMMAND = formatSourceCli(["demo", "--json"]);
export const SOURCE_USAGE_COMMAND = formatSourceCli(["usage"]);
export const SOURCE_USAGE_JSON_COMMAND = formatSourceCli(["usage", "--json"]);
export const SOURCE_BILLING_COMMAND = formatSourceCli(["billing"]);
export const SOURCE_BILLING_JSON_COMMAND = formatSourceCli(["billing", "--json"]);
export const SOURCE_BILLING_PRINT_COMMAND = formatSourceCli(["billing", "--print"]);
export const SOURCE_INIT_COMMAND = formatSourceCli(["init"]);
export const SOURCE_INIT_WORKFLOW_COMMAND = formatSourceCli(["init", "--starter", "workflow"]);
export const SOURCE_PROBE_COMMAND = formatSourceCli(["probe", "-c", "augmentworks.yaml"]);
export const SOURCE_PROBE_JSON_COMMAND = formatSourceCli(["probe", "-c", "augmentworks.yaml", "--json"]);
export const SOURCE_PROBE_YES_COMMAND = formatSourceCli(["probe", "-c", "augmentworks.yaml", "--yes"]);
export const SOURCE_ESTIMATE_COMMAND = formatSourceCli([
  "test",
  "--assessment",
  "./augmentworks.assessment.yaml",
  "--estimate"
]);
export const SOURCE_ESTIMATE_JSON_COMMAND = formatSourceCli([
  "test",
  "--assessment",
  "./augmentworks.assessment.yaml",
  "--estimate",
  "--json"
]);
export const SOURCE_MAX_CREDITS_COMMAND = formatSourceCli([
  "test",
  "--assessment",
  "./augmentworks.assessment.yaml",
  "--profile",
  "quick",
  "--max-credits",
  "30",
  "--yes"
]);
export const SOURCE_RUN_STATUS_COMMAND = formatSourceCli(["run", "status", "<run-id>"]);
export const SOURCE_RUN_WAIT_COMMAND = formatSourceCli(["run", "wait", "<run-id>"]);
export const SOURCE_RUN_REPORT_COMMAND = formatSourceCli(["run", "report", "<run-id>", "--json"]);
export const SOURCE_COMPARE_COMMAND = formatSourceCli([
  "compare",
  "--run",
  "<run-id>",
  "--baseline",
  "<baseline-id>",
  "--json"
]);
export const SOURCE_GATE_COMMAND = formatSourceCli([
  "gate",
  "--run",
  "<run-id>",
  "--baseline",
  "<baseline-id>",
  "--json"
]);
export const SOURCE_GATE_WAIT_COMMAND = formatSourceCli([
  "gate",
  "--run",
  "<run-id>",
  "--baseline",
  "<baseline-id>",
  "--wait",
  "--timeout-ms",
  "60000",
  "--json"
]);
export const SOURCE_BASELINE_STATUS_COMMAND = formatSourceCli(["baseline", "status", "--json"]);
export const SOURCE_BASELINE_PROMOTE_COMMAND = formatSourceCli([
  "baseline",
  "promote",
  "--run",
  "<run-id>",
  "--baseline",
  "<baseline-id>",
  "--expected-revision",
  "<n>",
  "--json"
]);
export const SOURCE_SUITE_VALIDATE_COMMAND = formatSourceCli([
  "suite",
  "validate",
  "examples/customer-suites/faq-non-commerce.yaml"
]);
export const SOURCE_SUITE_PREVIEW_COMMAND = formatSourceCli([
  "suite",
  "preview",
  "examples/customer-suites/returns-14-day.yaml"
]);
export const SOURCE_SUITE_PREFLIGHT_COMMAND = formatSourceCli([
  "suite",
  "preflight",
  "test/fixtures/customer-suites/live-informational.yaml"
]);
export const SOURCE_SUITE_TEST_COMMAND = formatWrappedCommand("node dist/index.js", "test", [
  "--suite examples/customer-suites/faq-non-commerce.yaml",
  "--max-credits 30",
  "--yes"
]);
export const SOURCE_SUITE_ESTIMATE_COMMAND = formatSourceCli([
  "test",
  "--suite",
  "examples/customer-suites/faq-non-commerce.yaml",
  "--estimate"
]);
export const SOURCE_INVESTIGATION_INSPECT_COMMAND = formatSourceCli([
  "investigation",
  "inspect",
  "examples/investigations/response-only.json"
]);
export const SOURCE_INVESTIGATION_INSPECT_JSON_COMMAND = formatSourceCli([
  "investigation",
  "inspect",
  "examples/investigations/stateful.json",
  "--json"
]);
export const SOURCE_INVESTIGATION_FETCH_COMMAND = formatSourceCli([
  "investigation",
  "fetch",
  "--run",
  "<run-id>",
  "--evaluation",
  "<evaluation-id>",
  "--attempt",
  "<attempt-id>",
  "--criterion",
  "<criterion-id>",
  "--json"
]);
export const SOURCE_INVESTIGATION_EXPORT_COMMAND = formatSourceCli([
  "investigation",
  "export-regression",
  "examples/investigations/response-only.json",
  "--out",
  "regression.yaml"
]);
export const SOURCE_INVESTIGATION_TEST_COMMAND = formatWrappedCommand("node dist/index.js", "test", [
  "--investigation examples/investigations/response-only.json",
  "--max-credits 30",
  "--yes"
]);
export const SOURCE_CATALOG_LIST_COMMAND = formatSourceCli(["catalog", "list", "--json"]);
export const SOURCE_CATALOG_SHOW_COMMAND = formatSourceCli([
  "catalog",
  "show",
  "response-quality/0.1.0/R01"
]);
export const SOURCE_SELECTION_COMPILE_COMMAND = formatWrappedCommand("node dist/index.js", "selection compile", [
  "-c augmentworks.yaml",
  "--assessment ./augmentworks.assessment.yaml",
  "--out ./suite-selection.manifest.json"
]);
export const SOURCE_TEST_SHARD_COMMAND = formatWrappedCommand("node dist/index.js", "test", [
  "--manifest ./suite-selection.manifest.json",
  "--shard shard-000",
  "--max-credits 30",
  "--yes"
]);
export const SOURCE_GATE_MANIFEST_COMMAND = formatSourceCli([
  "gate",
  "--manifest-file",
  "./suite-selection.manifest.json",
  "--declared-shards",
  "./suite-selection.declared-shards.json",
  "--json"
]);

export const PUBLISHED_LOCAL_COMMANDS = {
  doctor: formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${PUBLISHED_PACKAGE_VERSION}`, "doctor", [
    "-c augmentworks.yaml"
  ]),
  test: formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${PUBLISHED_PACKAGE_VERSION}`, "test", [
    "--local",
    "-c augmentworks.yaml",
    `--packet ${LOCAL_PACKET_REFERENCE}`,
    "--open"
  ]),
  demo: formatWrappedCommand(`npx --yes ${NPM_PACKAGE}@${PUBLISHED_PACKAGE_VERSION}`, "demo", [])
} as const;

export const SOURCE_ASSESSMENT_COMMANDS = {
  doctor: formatWrappedCommand("node dist/index.js", "doctor", [
    "--assessment ./augmentworks.assessment.yaml",
    "--profile quick"
  ]),
  testQuick: formatWrappedCommand("node dist/index.js", "test", [
    "--assessment ./augmentworks.assessment.yaml",
    "--profile quick",
    "--max-credits 30",
    "--yes"
  ]),
  testFull: formatWrappedCommand("node dist/index.js", "test", [
    "--assessment ./augmentworks.assessment.yaml",
    "--profile full",
    "--max-credits 30",
    "--yes"
  ])
} as const;

export const DOCTOR_EXAMPLE_OUTPUT = `OK OFFLINE_CHECK_COMPLETE: No target hooks or cloud operations were invoked.
Doctor passed.`;

export const HOSTED_TEST_KEEP_TERMINAL =
  "Keep this terminal open until the assessment finishes. There is no separate connect command.";

export function initNextSteps(
  configDisplay = "augmentworks.yaml",
  assessmentDisplay = "augmentworks.assessment.yaml"
): string {
  const created = `${configDisplay}, ${assessmentDisplay}, starter references, and the packaged fixture server`;
  const preview = formatCustomerCli([
    "preview-mapping",
    "-c",
    configDisplay,
    "--operation",
    "send",
    "--fixture",
    "./fixtures/send-response.json"
  ]);
  const probePlan = formatCustomerCli(["probe", "-c", configDisplay]);
  const probeYes = formatCustomerCli(["probe", "-c", configDisplay, "--yes"]);
  const prefix =
    LOCAL_DISTRIBUTION === "npm"
      ? `Next: edit .env for the authorized target, then run doctor. The packaged starter is an isolated synthetic fixture; hosted real-data stays release-disabled. This build created ${created}.`
      : `Next: edit .env for the authorized target, then run doctor. The packaged starter is an isolated synthetic fixture; hosted real-data stays release-disabled. This source build created ${created}. Published ${NPM_PACKAGE}@${HOSTED_COMMAND_PIN} does not generate those assessment files.`;
  return `${prefix} Then ${preview}, ${probePlan} to read the bounded plan, and ${probeYes} only after that review. Hosted spending consent is --max-credits N; npm --yes is not a ceiling. Doctor and init never probe.`;
}

export const INIT_NEXT_STEPS = initNextSteps();

export const LOGIN_NEXT_STEPS = `Next: run doctor, then keep this terminal open for hosted test --assessment ./augmentworks.assessment.yaml --profile quick --max-credits N --yes. There is no separate connect command. npm --yes is not a spending ceiling.`;

export function allowedDocumentedNpxPins(): readonly string[] {
  const pins = new Set<string>([HOSTED_COMMAND_PIN]);
  if (LOCAL_DISTRIBUTION === "npm") pins.add(PUBLISHED_PACKAGE_VERSION);
  return [...pins];
}
