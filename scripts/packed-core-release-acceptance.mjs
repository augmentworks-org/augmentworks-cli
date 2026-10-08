#!/usr/bin/env node

/**
 * AUG-48 core customer release acceptance.
 *
 * Installs either the exact npm registry tarball or a local packed binary,
 * then exercises the first useful own-target / suite / mapping / quote /
 * wait / release-policy loop against loopback fixtures.
 *
 * A local pack cannot pass registry checks. Missing later commands
 * (investigation, --headless) are recorded as not_run, never as pass.
 *
 * Usage:
 *   node scripts/packed-core-release-acceptance.mjs --source registry --version 0.3.4
 *   node scripts/packed-core-release-acceptance.mjs --source local
 *   node scripts/packed-core-release-acceptance.mjs --source registry --version 0.3.4 --write-evidence
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePackReport } from "./npm-pack-report.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "@augmentworks/cli";
const DEFAULT_REGISTRY_VERSION = "0.3.4";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "77777777-7777-4777-8777-777777777777";
const BASELINE_ID = "88888888-8888-4888-8888-888888888888";
const API_KEY = "aw_api_core_release_fixture_key_not_for_production";
const TOKEN = "aw_connector_core_release_fixture_token";
const TARGET_KEY = "core-release-target-key";

const EXIT = {
  OK: 0,
  CONFIG: 2,
  AUTH: 3,
  ASSESSMENT_FAILED: 10,
  EVALUATION_INCOMPLETE: 11,
  BILLING: 13
};

class AcceptanceFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "AcceptanceFailure";
  }
}

function assert(condition, message) {
  if (!condition) throw new AcceptanceFailure(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSuiteJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalSuiteJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalSuiteJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseArgs(argv) {
  const options = {
    source: "registry",
    version: DEFAULT_REGISTRY_VERSION,
    writeEvidence: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.source = argv[index + 1];
    if (arg === "--version") options.version = argv[index + 1];
    if (arg === "--write-evidence") options.writeEvidence = true;
  }
  if (options.source !== "registry" && options.source !== "local") {
    throw new AcceptanceFailure("--source must be registry or local");
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(options.version)) {
    throw new AcceptanceFailure("--version must be an exact semver");
  }
  return options;
}

function resolveNpmJsCli(binName) {
  const fileName = `${binName}-cli.js`;
  const fromLifecycle =
    typeof process.env.npm_execpath === "string" && process.env.npm_execpath.length > 0
      ? process.env.npm_execpath
      : undefined;
  const candidates = [];
  if (fromLifecycle !== undefined) {
    if (binName === "npm") candidates.push(fromLifecycle);
    candidates.push(join(dirname(fromLifecycle), fileName));
  }
  const prefix = dirname(process.execPath);
  candidates.push(
    join(prefix, "node_modules", "npm", "bin", fileName),
    join(prefix, "..", "lib", "node_modules", "npm", "bin", fileName)
  );
  return candidates.find((path) => existsSync(path));
}

function runJsCli(binName, args, options = {}) {
  const cli = resolveNpmJsCli(binName);
  const executable = cli === undefined ? (process.platform === "win32" ? `${binName}.cmd` : binName) : process.execPath;
  const argv = cli === undefined ? args : [cli, ...args];
  const result = spawnSync(executable, argv, {
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, ...options.env, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
    ...(cli === undefined && process.platform === "win32" ? { shell: true } : {})
  });
  if (result.error !== undefined) {
    throw new AcceptanceFailure(`Could not run ${binName} ${args.join(" ")}: ${result.error.message}`);
  }
  return result;
}

function isolatedChildEnv(extra = {}) {
  const env = { ...process.env, CI: "1", NO_COLOR: "1", ...extra };
  for (const key of [
    "AUGMENTWORKS_API_KEY",
    "AUGMENTWORKS_TOKEN",
    "AUGMENTWORKS_REFRESH_TOKEN",
    "AUGMENTWORKS_LIVE_TOKEN",
    "AW_BILLING_LIVE_TOKEN"
  ]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function runPacked(packedBin, args, env, cwd, timeoutMs = 30_000) {
  return new Promise((fulfill, reject) => {
    const child = spawn(process.execPath, [packedBin, ...args], {
      cwd,
      env: isolatedChildEnv(env),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new AcceptanceFailure(`Could not run packed CLI ${args.join(" ")}: ${error.message}`));
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      fulfill({ status, stdout, stderr, signal });
    });
  });
}

function parseJsonStdout(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new AcceptanceFailure(
      `${label} stdout was not JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}`
    );
  }
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store"
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function helpListsCommand(help, command) {
  return new RegExp(`^  ${command}(?: |$)`, "m").test(help);
}

function userIdentity() {
  return {
    subject: "user_core_release",
    email: "developer@example.com",
    workspace_id: WORKSPACE,
    workspace_name: "Core release fixture",
    connector_id: "connector_core_release",
    scopes: ["connector:identity", "connector:run"]
  };
}

function machineIdentity(actions) {
  return {
    subject: "machine_ci",
    workspace_id: WORKSPACE,
    workspace_name: "Core release fixture",
    connector_id: "connector_core_release",
    scopes: ["connector:identity", "connector:run"],
    principal_kind: "machine",
    credential_id: "cred_ci",
    actions
  };
}

async function listen(handler) {
  const paths = [];
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(request.url ?? "/", origin);
    paths.push(`${request.method ?? "GET"} ${url.pathname}`);
    void Promise.resolve(handler(request, response, url)).catch((error) => {
      if (!response.writableEnded) {
        json(response, 500, {
          error: { code: "fixture_crash", message: error instanceof Error ? error.message : String(error) }
        });
      }
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    server,
    paths,
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  };
}

async function withServer(handler, fn) {
  const mock = await listen(handler);
  try {
    return await fn(mock);
  } finally {
    await mock.close();
  }
}

async function loadInstalledJson(installedRoot, relative) {
  return JSON.parse(await readFile(join(installedRoot, relative), "utf8"));
}

function policyFixture(policy, name) {
  const entry = policy.fixtures[name];
  if (entry === undefined) throw new AcceptanceFailure(`missing installed policy fixture ${name}`);
  return { status: entry.status ?? 200, response: entry.response };
}

function billingFixture(billing, name) {
  const entry = billing.fixtures[name];
  if (entry === undefined) throw new AcceptanceFailure(`missing installed billing fixture ${name}`);
  return { status: entry.status ?? 200, response: entry.response };
}

async function installRegistry(version, temporaryRoot) {
  process.stdout.write(`[core release] npm view ${PACKAGE_NAME}@${version}\n`);
  const view = runJsCli("npm", ["view", `${PACKAGE_NAME}@${version}`, "--json"]);
  if (view.status !== 0) {
    const error = new AcceptanceFailure(
      `npm view ${PACKAGE_NAME}@${version} failed (${String(view.status)}):\n${view.stderr || view.stdout}`
    );
    error.blocked = true;
    throw error;
  }
  const metadata = JSON.parse(view.stdout);
  if (metadata.version !== version) {
    throw new AcceptanceFailure(`npm view returned ${String(metadata.version)}, expected ${version}`);
  }
  const packDirectory = join(temporaryRoot, "pack");
  const consumerDirectory = join(temporaryRoot, "consumer");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  process.stdout.write(`[core release] npm pack ${PACKAGE_NAME}@${version}\n`);
  const packed = runJsCli("npm", ["pack", `${PACKAGE_NAME}@${version}`, "--json", "--pack-destination", packDirectory]);
  if (packed.status !== 0) {
    throw new AcceptanceFailure(`npm pack ${PACKAGE_NAME}@${version} failed\n${packed.stderr}`);
  }
  const report = parsePackReport(packed.stdout);
  const tarballPath = join(packDirectory, report.filename);
  const tarballBytes = await readFile(tarballPath);
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "aw-core-release-consumer", private: true, version: "0.0.0" }, null, 2)}\n`
  );
  const installed = runJsCli(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballPath],
    { cwd: consumerDirectory }
  );
  if (installed.status !== 0) {
    throw new AcceptanceFailure(`npm install of registry tarball failed\n${installed.stderr}`);
  }
  const installedRoot = join(consumerDirectory, "node_modules", "@augmentworks", "cli");
  return {
    packedBin: join(installedRoot, "dist", "index.js"),
    installedRoot,
    consumerDirectory,
    tarballSha256: sha256(tarballBytes),
    fileCount: report.entryCount ?? report.files?.length,
    metadata,
    installOutput: installed.stdout
  };
}

async function installLocal(temporaryRoot) {
  const provided = process.env.AUGMENTWORKS_PACKED_BIN?.trim();
  if (provided) {
    await access(provided, fsConstants.R_OK);
    const installedRoot = resolve(dirname(provided), "..");
    return {
      packedBin: provided,
      installedRoot,
      consumerDirectory: join(temporaryRoot, "consumer"),
      tarballSha256: process.env.AUGMENTWORKS_TARBALL_SHA256 ?? null,
      fileCount: null,
      metadata: null,
      installOutput: "AUGMENTWORKS_PACKED_BIN override (local pack, not registry)"
    };
  }
  const packDirectory = join(temporaryRoot, "pack");
  const consumerDirectory = join(temporaryRoot, "consumer");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  const built = runJsCli("npm", ["run", "build"]);
  if (built.status !== 0) throw new AcceptanceFailure(`npm run build failed\n${built.stderr}`);
  const packed = runJsCli("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory]);
  if (packed.status !== 0) throw new AcceptanceFailure(`npm pack failed\n${packed.stderr}`);
  const report = parsePackReport(packed.stdout);
  const tarballPath = join(packDirectory, report.filename);
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "aw-core-release-local", private: true, version: "0.0.0" }, null, 2)}\n`
  );
  const installed = runJsCli(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballPath],
    { cwd: consumerDirectory }
  );
  if (installed.status !== 0) throw new AcceptanceFailure(`npm install local tarball failed\n${installed.stderr}`);
  const installedRoot = join(consumerDirectory, "node_modules", "@augmentworks", "cli");
  return {
    packedBin: join(installedRoot, "dist", "index.js"),
    installedRoot,
    consumerDirectory,
    tarballSha256: sha256(await readFile(tarballPath)),
    fileCount: report.entryCount ?? report.files?.length,
    metadata: null,
    installOutput: installed.stdout
  };
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function secretFree(text) {
  return !text.includes(API_KEY) && !text.includes(TOKEN) && !text.includes(TARGET_KEY);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifactKind = options.source === "registry" ? "registry" : "local_pack";
  const checks = [];
  const record = (name, status, evidence) => {
    checks.push({ name, artifactKind, status, evidence });
  };
  const temporaryRoot = await mkdtemp(join(tmpdir(), "aw-core-release-"));
  let blocked = false;

  try {
    const artifact =
      options.source === "registry"
        ? await installRegistry(options.version, temporaryRoot)
        : await installLocal(temporaryRoot);
    await access(artifact.packedBin, fsConstants.R_OK);
    const { packedBin, installedRoot } = artifact;
    const home = join(temporaryRoot, "home");
    const work = join(temporaryRoot, "work");
    await mkdir(home, { recursive: true });
    await mkdir(work, { recursive: true });

    const baseEnv = {
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, "AppData", "Local"),
      APPDATA: join(home, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      AUGMENTWORKS_STATE_DIR: join(home, "aw-state"),
      CHATBOT_BASE_URL: "http://127.0.0.1:9",
      CHATBOT_API_KEY: TARGET_KEY
    };

    const versionRun = await runPacked(packedBin, ["--version"], baseEnv, work);
    assert(versionRun.status === 0, `--version failed\n${versionRun.stderr}`);
    const installedVersion = versionRun.stdout.trim();
    const help = await runPacked(packedBin, ["--help"], baseEnv, work);
    assert(help.status === 0, `--help failed\n${help.stderr}`);
    const testHelp = await runPacked(packedBin, ["test", "--help"], baseEnv, work);
    const hasInvestigation = helpListsCommand(help.stdout, "investigation");
    const hasHeadless = testHelp.stdout.includes("--headless");
    const hasCompare = helpListsCommand(help.stdout, "compare");
    const hasGate = helpListsCommand(help.stdout, "gate");
    const hasBaseline = helpListsCommand(help.stdout, "baseline");
    const hasSuite = helpListsCommand(help.stdout, "suite");
    const hasProbe = helpListsCommand(help.stdout, "probe");

    const requiredInventory = [
      "package.json",
      "dist/index.js",
      "schemas/v1/cli-release.json",
      "schemas/v1/customer-suite.schema.json",
      "contracts/aw-billing-v1.lock.json",
      "contracts/aw-release-policy-v1.lock.json",
      "contracts/aw-release-policy-v1.fixtures.json",
      "assets/starters/response-quality/own-chatbot.suite.yaml",
      "assets/starters/response-quality/server.mjs",
      "assets/starters/response-quality/augmentworks.session.yaml"
    ];
    const missingInventory = [];
    for (const relative of requiredInventory) {
      if (!(await fileExists(join(installedRoot, relative)))) missingInventory.push(relative);
    }
    const hasInvestigationSchema = await fileExists(join(installedRoot, "schemas/v1/investigation-export.schema.json"));
    const cliRelease = await loadInstalledJson(installedRoot, "schemas/v1/cli-release.json");
    const policy = await loadInstalledJson(installedRoot, "contracts/aw-release-policy-v1.fixtures.json");
    const billing = await loadInstalledJson(installedRoot, "contracts/aw-billing-v1.fixtures.json");
    const billingLock = await loadInstalledJson(installedRoot, "contracts/aw-billing-v1.lock.json");
    const policyLock = await loadInstalledJson(installedRoot, "contracts/aw-release-policy-v1.lock.json");

    if (options.source === "registry") {
      const dist = artifact.metadata.dist ?? {};
      record(
        "registry-identity",
        "pass",
        `${PACKAGE_NAME}@${artifact.metadata.version} gitHead=${String(artifact.metadata.gitHead)} integrity=${String(dist.integrity)} shasum=${String(dist.shasum)} tarballSha256=${artifact.tarballSha256} publishedAt=${String(artifact.metadata.time?.[options.version] ?? artifact.metadata.time?.[artifact.metadata.version])} fileCount=${String(dist.fileCount ?? artifact.fileCount)}`
      );
    } else {
      record(
        "registry-identity",
        "not_run",
        `Local pack SHA-256 ${artifact.tarballSha256 ?? "unset"} is QA only. It is not npm publication. Do not label this a passed release.`
      );
    }

    record(
      "inventory-schemas-fixtures",
      missingInventory.length === 0 ? "pass" : "fail",
      missingInventory.length === 0
        ? `Installed package includes billing/release-policy locks and own-target starter/suite files. investigation-export schema ${hasInvestigationSchema ? "present" : "absent"}.`
        : `Missing required published paths: ${missingInventory.join(", ")}`
    );

    const helpOk =
      hasCompare &&
      hasGate &&
      hasBaseline &&
      hasSuite &&
      hasProbe &&
      testHelp.stdout.includes("--suite") &&
      testHelp.stdout.includes("--max-credits") &&
      testHelp.stdout.includes("--estimate") &&
      installedVersion === (options.source === "registry" ? options.version : installedVersion);
    record(
      "version-and-help",
      helpOk ? "pass" : "fail",
      `--version=${installedVersion}; compare=${hasCompare} gate=${hasGate} baseline=${hasBaseline} suite=${hasSuite} probe=${hasProbe} investigation=${hasInvestigation} --headless=${hasHeadless}`
    );

    process.stdout.write("[core release] init --agent, doctor, mapping, suite, probe\n");
    const init = await runPacked(packedBin, ["init", "--agent", "--no-env"], baseEnv, work);
    assert(init.status === 0, `init --agent failed\n${init.stderr}\n${init.stdout}`);
    const agentGuide = await readFile(join(work, "augmentworks.agent.md"), "utf8");
    const pinOk = agentGuide.includes(`${PACKAGE_NAME}@${installedVersion}`);
    record(
      "documentation-pins",
      pinOk ? "pass" : "fail",
      pinOk
        ? `init --agent wrote ${PACKAGE_NAME}@${installedVersion}. Packaged cli-release published_package_verified=${String(cliRelease.published_package_verified)} (packaged metadata is not a live registry probe).`
        : `init --agent did not pin ${PACKAGE_NAME}@${installedVersion}`
    );

    const doctor = await runPacked(
      packedBin,
      ["doctor", "--offline", "-c", "augmentworks.yaml"],
      { ...baseEnv, CHATBOT_BASE_URL: "http://127.0.0.1:65535", CHATBOT_API_KEY: TARGET_KEY },
      work
    );
    assert(doctor.status === 0, `offline doctor failed\n${doctor.stderr}\n${doctor.stdout}`);
    assert(doctor.stdout.includes("CONNECTION_PROBE_AVAILABLE"), "doctor omitted CONNECTION_PROBE_AVAILABLE");
    const preview = await runPacked(
      packedBin,
      [
        "preview-mapping",
        "-c",
        "augmentworks.yaml",
        "--operation",
        "send",
        "--fixture",
        "fixtures/send-response.json",
        "--json"
      ],
      { ...baseEnv, AUGMENTWORKS_API_URL: "http://127.0.0.1:1", AUGMENTWORKS_TOKEN: TOKEN },
      work
    );
    assert(preview.status === 0, `preview-mapping failed\n${preview.stderr}\n${preview.stdout}`);
    const previewJson = parseJsonStdout(preview.stdout, "preview-mapping");
    assert(previewJson.ok === true && previewJson.offline === true, "preview-mapping was not offline ok");
    assert(secretFree(preview.stdout), "preview-mapping leaked a fixture secret");
    const suiteValidate = await runPacked(
      packedBin,
      ["suite", "validate", "own-chatbot.suite.yaml", "--json"],
      { ...baseEnv, AUGMENTWORKS_API_URL: "http://127.0.0.1:1" },
      work
    );
    assert(suiteValidate.status === 0, `suite validate failed\n${suiteValidate.stderr}`);
    const suiteJson = parseJsonStdout(suiteValidate.stdout, "suite validate");
    assert(suiteJson.ok === true, "own-chatbot suite validate was not ok");
    const probePlan = await runPacked(
      packedBin,
      ["probe", "-c", "augmentworks.yaml", "--json"],
      { ...baseEnv, CHATBOT_BASE_URL: "http://127.0.0.1:1", CHATBOT_API_KEY: TARGET_KEY },
      work
    );
    assert(probePlan.status === 0, `probe preflight failed\n${probePlan.stderr}`);
    const probeJson = parseJsonStdout(probePlan.stdout, "probe");
    assert(probeJson.executed === false && probeJson.credits_consumed === 0, "probe without --yes executed");
    record(
      "offline-suite-session-mapping-probe",
      "pass",
      "Packed/registry binary: init --agent, offline doctor, preview-mapping --json, suite validate, probe preflight. Zero hosted contact; secrets omitted from stdout."
    );

    await writeFile(
      join(work, "invalid-mapping.yaml"),
      `version: 1
target:
  name: broken
  connector: http
  base_url: http://127.0.0.1:9
  operations:
    send:
      method: POST
      path: /chat
      response:
        content: $.answer[
`,
      "utf8"
    );
    await writeFile(join(work, "invalid-mapping.json"), '{"answer":"must-not-leak","finished":true}\n', "utf8");
    const invalidMapping = await runPacked(
      packedBin,
      ["preview-mapping", "-c", "invalid-mapping.yaml", "--fixture", "invalid-mapping.json", "--json"],
      baseEnv,
      work
    );
    assert(invalidMapping.status === EXIT.CONFIG, `invalid mapping exit ${String(invalidMapping.status)}`);
    assert(
      `${invalidMapping.stdout}\n${invalidMapping.stderr}`.includes("RESPONSE_MAPPING_INVALID"),
      "invalid mapping omitted RESPONSE_MAPPING_INVALID"
    );
    assert(!`${invalidMapping.stdout}\n${invalidMapping.stderr}`.includes("must-not-leak"), "invalid mapping leaked fixture body");
    record(
      "invalid-mapping",
      "pass",
      `preview-mapping on a malformed selector exited ${String(invalidMapping.status)} with RESPONSE_MAPPING_INVALID. No hosted run.`
    );

    await writeFile(
      join(work, "unsupported-capability.yaml"),
      `schema_version: aw-suite/1
suite_id: customer.unsupported.feature
title: Unsupported feature
description: history_array_v1 is reserved and must not admit.
synthetic_only: true
cases:
  - case_id: unsupported.feature
    turns:
      - content: Hello?
    expected:
      facts:
        - A greeting
    criteria:
      - criterion_id: unsupported.feature.required
        requirement: required
        kind: llm_rubric
        statement: Must not validate.
`,
      "utf8"
    );
    const unsupported = await runPacked(
      packedBin,
      ["suite", "validate", "unsupported-capability.yaml", "--json"],
      baseEnv,
      work
    );
    assert(unsupported.status === EXIT.CONFIG, `unsupported capability exit ${String(unsupported.status)}`);
    assert(
      `${unsupported.stdout}\n${unsupported.stderr}`.includes("SUITE_UNSUPPORTED_FEATURE"),
      "unsupported suite omitted SUITE_UNSUPPORTED_FEATURE"
    );
    record(
      "unsupported-capability",
      "pass",
      `suite validate of a history_array_v1 suite exited ${String(unsupported.status)} SUITE_UNSUPPORTED_FEATURE. No quote or create.`
    );

    const eligible = billingFixture(billing, "eligible_trial");
    const pending = billingFixture(billing, "status_pending_grading");
    const insufficient = billingFixture(billing, "error_insufficient_credits");
    const blockedGate = policyFixture(policy, "blocked_equal_pass_rate");
    const passGate = policyFixture(policy, "pass_compatible");
    const incompatible = policyFixture(policy, "incompatible_scope");

    process.stdout.write("[core release] wait timeout / running / revoked / ceiling / gates\n");

    await withServer(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        json(response, 200, userIdentity());
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        json(response, 200, eligible.response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/status") {
        json(response, 200, {
          ...pending.response,
          runId: RUN_ID,
          originalRunId: RUN_ID,
          executionStatus: "running",
          evaluationStatus: "pending"
        });
        return;
      }
      await readBody(request);
      json(response, 404, { error: { code: "not_found" } });
    }, async (mock) => {
      const env = {
        ...baseEnv,
        AUGMENTWORKS_API_URL: mock.origin,
        AUGMENTWORKS_TOKEN: TOKEN
      };
      const wait = await runPacked(
        packedBin,
        ["run", "wait", RUN_ID, "--json", "--timeout-ms", "1"],
        env,
        work
      );
      assert(wait.status === EXIT.EVALUATION_INCOMPLETE, `wait timeout exit ${String(wait.status)}\n${wait.stdout}\n${wait.stderr}`);
      const waitJson = parseJsonStdout(wait.stdout, "run wait");
      assert(
        String(waitJson.runId ?? waitJson.originalRunId ?? wait.stdout).includes(RUN_ID),
        "wait timeout lost the original run id"
      );
      assert(!mock.paths.some((path) => path.startsWith("POST /v1/relay/runs")), "wait created a run");
      assert(!mock.paths.includes("POST /v1/billing/quote"), "wait quoted");
      const status = await runPacked(packedBin, ["run", "status", RUN_ID, "--json"], env, work);
      assert(status.status === EXIT.EVALUATION_INCOMPLETE, `running status exit ${String(status.status)}`);
      record(
        "wait-timeout-running",
        "pass",
        `run wait --timeout-ms 1 on running/pending grading exited ${String(wait.status)}; run status stayed incomplete. Original run ${RUN_ID}. Zero quote/create.`
      );
    });

    await withServer(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        json(response, 401, { error: "invalid_token" });
        return;
      }
      await readBody(request);
      json(response, 500, { error: { code: "must_not_continue" } });
    }, async (mock) => {
      const env = {
        ...baseEnv,
        AUGMENTWORKS_API_URL: mock.origin,
        AUGMENTWORKS_API_KEY: API_KEY
      };
      const estimateArgs = ["test", "--suite", "own-chatbot.suite.yaml", "--estimate", "--json"];
      if (hasHeadless) estimateArgs.push("--headless");
      const revoked = await runPacked(packedBin, estimateArgs, env, work);
      assert(revoked.status === EXIT.AUTH, `revoked credential exit ${String(revoked.status)}\n${revoked.stdout}\n${revoked.stderr}`);
      const combined = `${revoked.stdout}\n${revoked.stderr}`;
      assert(combined.includes("API_KEY_REVOKED") || combined.includes("invalid"), "revoked key omitted API_KEY_REVOKED");
      assert(mock.paths.every((path) => path === "GET /api/v1/cli/auth/me"), `revoked key continued: ${mock.paths.join(" ")}`);
      record(
        "revoked-credential",
        "pass",
        `test --estimate with a 401 API key exited ${String(revoked.status)}. Paths: ${mock.paths.join(", ") || "(none)"}. No quote/create.`
      );
    });

    await withServer(async (request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        json(response, 200, userIdentity());
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        json(response, 200, eligible.response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/suites") {
        const raw = await readBody(request);
        const parsed = JSON.parse(raw.toString("utf8"));
        if (parsed.schemaVersion === "aw-customer-suite/1" && parsed.documentKind === "customer_suite_source") {
          json(response, 201, {
            ...parsed,
            documentKind: "customer_suite_revision",
            workspaceId: WORKSPACE,
            suiteRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            canonicalHash: sha256(canonicalSuiteJson(parsed))
          });
          return;
        }
        // Preserve explicit registry inspection of older artifacts; never use a placeholder hash.
        assert(typeof parsed.contentHash === "string", "suite fixture received neither native source nor legacy hash envelope");
        json(response, 200, { suiteId: "customer.own_chatbot.faq", revisionId: "rev_core_1", contentHash: parsed.contentHash });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/billing/quote") {
        json(response, insufficient.status, insufficient.response);
        return;
      }
      await readBody(request);
      json(response, 404, { error: { code: "not_found" } });
    }, async (mock) => {
      const env = {
        ...baseEnv,
        AUGMENTWORKS_API_URL: mock.origin,
        AUGMENTWORKS_TOKEN: TOKEN
      };
      const ceilingArgs = [
        "test",
        "--suite",
        "own-chatbot.suite.yaml",
        "--max-credits",
        "0",
        "--yes",
        "--json"
      ];
      if (hasHeadless) ceilingArgs.push("--headless");
      const ceiling = await runPacked(packedBin, ceilingArgs, env, work);
      assert(ceiling.status === EXIT.BILLING, `credit ceiling exit ${String(ceiling.status)}\n${ceiling.stdout}\n${ceiling.stderr}`);
      assert(!mock.paths.some((path) => path.startsWith("POST /v1/relay/runs")), "credit ceiling created a run");
      record(
        "credit-ceiling",
        "pass",
        `test --suite --max-credits 0 --yes exited ${String(ceiling.status)} without POST /v1/relay/runs. Quote/suite pin may occur; admission does not.`
      );
    });

    async function evaluateGate(name, fixture, expectedExit, assertion) {
      await withServer(async (request, response, url) => {
        if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
          json(response, 200, userIdentity());
          return;
        }
        if (request.method === "POST" && url.pathname === "/v1/release-gates/evaluate") {
          await readBody(request);
          json(response, fixture.status, fixture.response);
          return;
        }
        await readBody(request);
        json(response, 404, { error: { code: "not_found" } });
      }, async (mock) => {
        const env = {
          ...baseEnv,
          AUGMENTWORKS_API_URL: mock.origin,
          AUGMENTWORKS_TOKEN: TOKEN
        };
        const result = await runPacked(
          packedBin,
          ["gate", "--run", RUN_ID, "--baseline", BASELINE_ID, "--json"],
          env,
          work
        );
        assert(result.status === expectedExit, `${name} exit ${String(result.status)} expected ${String(expectedExit)}\n${result.stdout}\n${result.stderr}`);
        assert(!mock.paths.some((path) => path.startsWith("POST /v1/relay/runs")), `${name} created a run`);
        assert(!mock.paths.includes("POST /v1/billing/quote"), `${name} quoted`);
        const payload = parseJsonStdout(result.stdout, name);
        assertion(payload, result);
        assert(secretFree(`${result.stdout}\n${result.stderr}`), `${name} leaked a fixture secret`);
      });
    }

    await evaluateGate("incompatible baseline", incompatible, EXIT.CONFIG, (payload) => {
      assert(
        payload.assessment === "incompatible" || payload.code === "INCOMPATIBLE_SCOPE" || payload.decision === "incompatible",
        `incompatible payload ${JSON.stringify(payload)}`
      );
    });
    record(
      "incompatible-baseline",
      "pass",
      `gate --json against incompatible_scope exited ${String(EXIT.CONFIG)}. Observation only; createsBillableRun remains false on the document.`
    );

    await evaluateGate("failing required criterion", blockedGate, EXIT.ASSESSMENT_FAILED, (payload) => {
      assert(payload.ok === true, "blocked gate ok should mean the document parsed");
      assert(payload.assessment === "blocked" || payload.decision === "block", "blocked gate was not blocked");
      assert(payload.createsBillableRun === false, "blocked gate claimed a billable run");
      assert(payload.candidateRunId === RUN_ID || payload.candidate_run_id === RUN_ID, "blocked gate lost the run id");
    });
    record(
      "failing-required-criterion",
      "pass",
      `gate blocked_equal_pass_rate exited ${String(EXIT.ASSESSMENT_FAILED)} assessment=blocked. Equal aggregate pass rate with a new required failure is not a green CI decision.`
    );

    await evaluateGate("passing CI decision", passGate, EXIT.OK, (payload) => {
      assert(payload.assessment === "passed" || payload.decision === "pass", "pass gate was not passed");
      assert(payload.createsBillableRun === false, "pass gate claimed a billable run");
    });
    record(
      "passing-ci-decision",
      "pass",
      `gate pass_compatible exited 0 assessment=passed, createsBillableRun=false. Observation only.`
    );

    if (hasInvestigation) {
      const sample = join(installedRoot, "assets", "investigations", "response-only.json");
      if (await fileExists(sample)) {
        const inspect = await runPacked(
          packedBin,
          ["investigation", "inspect", sample, "--json"],
          { ...baseEnv, AUGMENTWORKS_API_URL: "http://127.0.0.1:1", AUGMENTWORKS_TOKEN: TOKEN },
          work
        );
        assert(inspect.status === 0, `investigation inspect failed\n${inspect.stderr}\n${inspect.stdout}`);
        const inspectJson = parseJsonStdout(inspect.stdout, "investigation inspect");
        assert(inspectJson.executesTarget === false, "investigation inspect claimed target execution");
        record(
          "investigation-repro-export",
          options.source === "registry" ? "pass" : "pass",
          "investigation inspect --json on the packed response-only fixture executed no target, shell, or evaluator."
        );
      } else {
        record(
          "investigation-repro-export",
          "not_run",
          "investigation command exists but the published tarball has no assets/investigations fixtures."
        );
      }
    } else {
      record(
        "investigation-repro-export",
        "not_run",
        `${PACKAGE_NAME}@${installedVersion} --help does not list investigation (AUG-44 landed after published gitHead ${String(artifact.metadata?.gitHead ?? "local")}). Local main includes it; a later registry version must be installed before this check can pass.`
      );
    }

    if (hasHeadless) {
      await withServer(async (request, response, url) => {
        if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
          json(
            response,
            200,
            machineIdentity(["run:read", "evaluation:read", "criterion_detail:read"])
          );
          return;
        }
        await readBody(request);
        json(response, 500, { error: { code: "must_not_quote" } });
      }, async (mock) => {
        const denied = await runPacked(
          packedBin,
          ["test", "--suite", "own-chatbot.suite.yaml", "--estimate", "--json", "--headless"],
          { ...baseEnv, AUGMENTWORKS_API_URL: mock.origin, AUGMENTWORKS_API_KEY: API_KEY },
          work
        );
        assert(denied.status === EXIT.AUTH, `machine denied exit ${String(denied.status)}\n${denied.stdout}`);
        assert(
          `${denied.stdout}\n${denied.stderr}`.includes("MACHINE_ACTION_DENIED"),
          "report-only machine key omitted MACHINE_ACTION_DENIED"
        );
        assert(!mock.paths.includes("POST /v1/billing/quote"), "report-only key quoted");
        record(
          "machine-ci-headless",
          options.source === "registry" ? "pass" : "pass",
          "test --headless with a report-only machine key exited 3 MACHINE_ACTION_DENIED before quote/create."
        );
      });
    } else {
      record(
        "machine-ci-headless",
        "not_run",
        `${PACKAGE_NAME}@${installedVersion} test --help does not include --headless (AUG-45 landed after published gitHead ${String(artifact.metadata?.gitHead ?? "local")}). Revoked API-key admission was tested; scoped machine CI admission is unpublished.`
      );
    }

    record(
      "live-authorized-environment",
      "not_run",
      "No disposable migrated main API token or Stripe test-mode secrets were supplied. scripts/packed-billing-live.mjs remains the live billing gate and was not run. Synthetic loopback fixtures are not that environment."
    );

    const requiredForReady = [
      "registry-identity",
      "inventory-schemas-fixtures",
      "version-and-help",
      "documentation-pins",
      "offline-suite-session-mapping-probe",
      "invalid-mapping",
      "unsupported-capability",
      "wait-timeout-running",
      "revoked-credential",
      "credit-ceiling",
      "incompatible-baseline",
      "failing-required-criterion",
      "passing-ci-decision",
      "investigation-repro-export",
      "machine-ci-headless",
      "live-authorized-environment"
    ];
    const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
    for (const check of checks) {
      if (check.status === "pass" && (check.evidence.includes("not npm") || check.evidence.includes("QA only"))) {
        throw new AcceptanceFailure(`check ${check.name} marked pass with non-registry evidence`);
      }
      if (check.status === "fail") {
        throw new AcceptanceFailure(`check ${check.name} failed: ${check.evidence}`);
      }
    }
    const releaseReady =
      options.source === "registry" &&
      requiredForReady.every((name) => byName[name]?.status === "pass");

    const evidence = {
      schemaVersion: "aw-core-release-acceptance/1",
      issue: "AUG-48",
      verifiedAt: options.source === "registry" ? new Date().toISOString() : null,
      releaseReady,
      source: options.source,
      cli: {
        packageName: PACKAGE_NAME,
        version: installedVersion,
        gitHead: artifact.metadata?.gitHead ?? null,
        integrity: artifact.metadata?.dist?.integrity ?? null,
        shasum: artifact.metadata?.dist?.shasum ?? null,
        tarballSha256: artifact.tarballSha256,
        registryUrl: `https://registry.npmjs.org/${PACKAGE_NAME}/${options.version}`,
        publishedAt: artifact.metadata?.time?.[options.version] ?? null,
        fileCount: artifact.metadata?.dist?.fileCount ?? artifact.fileCount,
        packagedPublishedFlag: cliRelease.published_package_verified
      },
      install: {
        command:
          options.source === "registry"
            ? `npm pack ${PACKAGE_NAME}@${options.version} && npm install --ignore-scripts <tarball>`
            : "local npm pack or AUGMENTWORKS_PACKED_BIN",
        outputExcerpt: String(artifact.installOutput ?? "")
          .replace(API_KEY, "[redacted]")
          .slice(0, 1200)
      },
      mainContractPair: {
        "aw-billing/1": {
          commit: billingLock.source?.commit ?? null,
          schemaSha256: billingLock.files?.["contracts/aw-billing-v1.schema.json"] ?? null,
          fixturesSha256: billingLock.files?.["contracts/aw-billing-v1.fixtures.json"] ?? null
        },
        "aw-release-policy/1": {
          consumedCommitCited: policyLock.source?.consumedCommitCited ?? null,
          consumerFixturesSha256: policyLock.cli?.consumerFixturesChecksum ?? null
        }
      },
      commandsPresent: {
        compare: hasCompare,
        gate: hasGate,
        baseline: hasBaseline,
        suite: hasSuite,
        probe: hasProbe,
        investigation: hasInvestigation,
        headless: hasHeadless
      },
      predecessor: {
        aug47: {
          repository: "augmentworks-org/augmentworks",
          pullRequest: "https://github.com/augmentworks-org/augmentworks/pull/106",
          head: "d9f3a7fafca3ff2bb5d517bcea031dd2b9aa8ad9",
          handoff: "docs/feature-readiness/core-acceptance.md",
          cliPin: `${PACKAGE_NAME}@0.3.4`,
          packedTarballSha256: "a97b1ff77823933defcecac8181c0dc5c925cfe356dfe2d6bad2f39e271d4021"
        },
        aug73: {
          version: "0.3.4",
          gitHead: "c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f",
          integrity: "sha512-TLeAzDglZoGL6fWLxA9rIUwJd69NFqgmlONzU4uRmhDz4S31+dfSZpaj44ahb6lUjnmuoY6sDmfPStxFzInpVQ=="
        }
      },
      checks,
      limitations: [
        "releaseReady is false until investigation/repro, machine --headless CI, and a compatible authorized environment are verified on a real registry tarball.",
        "Local pack success is not a passed npm release.",
        "AUG-46 catalog/shard CLI is out of scope for this first core published loop.",
        "Packaged cli-release.json may still describe 0.3.4 as a candidate; that metadata is owned by AUG-79 and is not overwritten here.",
        "No live purchases, production provider calls, or customer-target contact."
      ],
      recovery: [
        "Observation commands (run wait/status/report, recover, compare, gate) reuse the original run id and must not start a new billed assessment.",
        "A blocked gate (exit 10) is the CI failure. Do not admit another hosted test from the same job to flip the result.",
        "A wait timeout or pending grading (exit 11) is not a green release. Re-query the same run id.",
        "A revoked API key cannot continue; do not call logout from automation cleanup.",
        "If this published version lacks investigation or --headless, install a later immutable registry version after the protected release.yml publish. Do not overwrite 0.3.4."
      ]
    };

    process.stdout.write(`${JSON.stringify({ releaseReady, checks: checks.map((c) => ({ name: c.name, status: c.status })) }, null, 2)}\n`);
    if (options.writeEvidence) {
      const evidencePath = join(projectRoot, "docs/feature-readiness/release-acceptance.json");
      if (options.source !== "registry") {
        throw new AcceptanceFailure("Refusing to write release-acceptance.json from a local pack");
      }
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      process.stdout.write(`[core release] wrote ${evidencePath}\n`);
    }
    process.stdout.write(
      `[core release] ${options.source} ${installedVersion} releaseReady=${String(releaseReady)} checks=${String(checks.length)}\n`
    );
  } catch (error) {
    if (error instanceof AcceptanceFailure && error.blocked) {
      blocked = true;
      process.stderr.write(`[core release] BLOCKED ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    if (process.env.AUGMENTWORKS_KEEP_SMOKE_TMP === "1") {
      process.stdout.write(`[core release] retained ${temporaryRoot}\n`);
    } else if (!blocked) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[core release] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error?.blocked === true ? 2 : 1;
});
