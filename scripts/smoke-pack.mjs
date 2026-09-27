#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parsePackReport } from "./npm-pack-report.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commandTimeoutMs = 120_000;

class SmokeFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeFailure";
  }
}

function assert(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}

function assertNpmCustomerCliCopy(text, pin, label) {
  assert(
    !text.includes("node dist/index.js"),
    `${label} must not tell npm-installed customers to run node dist/index.js`
  );
  assert(!text.includes("{{AW_CLI}}"), `${label} must replace the customer CLI placeholder`);
  assert(
    text.includes(`npx --yes @augmentworks/cli@${pin}`),
    `${label} must invoke the published pin`
  );
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
  if (cli !== undefined) {
    return run(process.execPath, [cli, ...args], options);
  }
  // Node 22+ on Windows rejects spawn of .cmd shims without a shell (EINVAL).
  return run(process.platform === "win32" ? `${binName}.cmd` : binName, args, {
    ...options,
    shell: process.platform === "win32"
  });
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, ...options.env, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: commandTimeoutMs,
    windowsHide: true,
    ...(options.shell === true ? { shell: true } : {})
  });

  if (result.error !== undefined) {
    throw new SmokeFailure(
      `Could not run ${executable} ${args.join(" ")}: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new SmokeFailure(
      [
        `Command failed (${String(result.status)}): ${executable} ${args.join(" ")}`,
        result.stdout.trim(),
        result.stderr.trim()
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

function runAsync(executable, args, options = {}) {
  return new Promise((fulfill, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? projectRoot,
      env: { ...process.env, ...options.env, NO_COLOR: "1" },
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
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new SmokeFailure(`Timed out: ${executable} ${args.join(" ")}`));
    }, options.timeoutMs ?? commandTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new SmokeFailure(`Could not run ${executable} ${args.join(" ")}: ${error.message}`));
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (options.allowFailure === true) {
        fulfill({ status, stdout, stderr });
        return;
      }
      if (status !== 0) {
        reject(
          new SmokeFailure(
            [
              `Command failed (${String(status ?? signal)}): ${executable} ${args.join(" ")}`,
              stdout.trim(),
              stderr.trim()
            ]
              .filter(Boolean)
              .join("\n")
          )
        );
        return;
      }
      fulfill({ status: 0, stdout, stderr });
    });
  });
}

async function walkFiles(root) {
  const files = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
    }
  }

  await visit(root);
  return files;
}

function normalizePath(path) {
  return path.split(sep).join("/").replace(/^package\//, "");
}

function assertInventory(report) {
  const files = report.files.map((entry) => normalizePath(String(entry.path)));
  const fileSet = new Set(files);
  const required = [
    "package.json",
    "dist/index.js",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md"
  ];

  for (const path of required) {
    assert(fileSet.has(path), `published tarball is missing ${path}`);
  }
  assert(
    files.some((path) => path.startsWith("schemas/") && path.endsWith(".schema.json")),
    "published tarball is missing its versioned JSON Schema"
  );
  for (const path of [
    "schemas/v1/local-packet.schema.json",
    "schemas/v1/local-result.schema.json",
    "schemas/v1/customer-suite.schema.json",
    "schemas/v1/investigation-export.schema.json",
    "packets/support-refunds-starter/0.1.0/packet.json",
    "schemas/v1/cli-release.json",
    "assets/demo/packet.json",
    "assets/demo/augmentworks.yaml",
    "assets/starters/response-quality/augmentworks.yaml",
    "assets/starters/response-quality/augmentworks.assessment.yaml",
    "assets/starters/response-quality/augmentworks.session.yaml",
    "assets/starters/response-quality/own-chatbot.suite.yaml",
    "assets/starters/response-quality/OWN-TARGET.md",
    "assets/starters/response-quality/.env.example",
    "assets/starters/response-quality/server.mjs",
    "assets/starters/response-quality/session-server.mjs",
    "assets/starters/response-quality/fixtures/send-response.json",
    "assets/starters/response-quality/fixtures/session-send-response.json",
    "assets/starters/response-quality/references/faq.md",
    "assets/starters/response-quality/references/restocking.md",
    "assets/starters/response-quality/references/warranty.md",
    "assets/starters/response-quality/references/old-returns.md",
    "assets/starters/workflow/augmentworks.yaml",
    "assets/starters/workflow/augmentworks.assessment.yaml",
    "assets/starters/workflow/.env.example",
    "assets/starters/workflow/OWN-TARGET.md",
    "assets/starters/workflow/server.mjs",
    "assets/starters/workflow/fixtures/send-response.json",
    "assets/starters/workflow/fixtures/observe-response.json",
    "assets/starters/workflow/fixtures/prepare-response.json",
    "assets/starters/workflow/references/refund-policy.md",
    "assets/customer-suites/faq-non-commerce.yaml",
    "assets/customer-suites/returns-14-day.yaml",
    "assets/customer-suites/references/faq.md",
    "assets/customer-suites/references/returns-14-day.md",
    "contracts/discovery-manifest.json",
    "contracts/discovery-manifest.schema.json",
    "contracts/aw-billing-v1.schema.json",
    "contracts/aw-billing-v1.fixtures.json",
    "contracts/aw-billing-v1.lock.json",
    "contracts/aw-run-report-v1.schema.json",
    "contracts/aw-run-report-v1.fixtures.json",
    "contracts/aw-run-report-v1.lock.json",
    "contracts/aw-real-data-1.lock.json",
    "contracts/aw-real-data-1.schema.json",
    "contracts/aw-real-data-1.fixtures.json",
    "contracts/aw-real-data-1.checksums.json",
    "contracts/aw-real-data-1.retrieval.json",
    "contracts/aw-suite-v1.lock.json",
    "contracts/aw-release-policy-v1.lock.json",
    "contracts/aw-release-policy-v1.fixtures.json",
    "contracts/aw-investigation-export-v1.lock.json",
    "contracts/aw-investigation-export-v1.fixtures.json",
    "assets/investigations/response-only.json",
    "assets/investigations/stateful.json"
  ]) {
    assert(fileSet.has(path), `published tarball is missing ${path}`);
  }

  const forbiddenPrefixes = ["src/", "test/", "tests/", "scripts/", "examples/", ".github/", "docs/", "agent-resources/"];
  for (const path of files) {
    assert(
      !forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
      `development-only path leaked into the tarball: ${path}`
    );
    const basename = path.slice(path.lastIndexOf("/") + 1);
    assert(basename !== ".env", `secret-bearing .env file leaked into the tarball: ${path}`);
    assert(!/\.(?:pem|key|p12|pfx)$/i.test(path), `private-key-shaped file leaked into the tarball: ${path}`);
    assert(!path.endsWith(".ts") || path.endsWith(".d.ts"), `TypeScript source leaked into the tarball: ${path}`);
  }
}

async function assertNoEmbeddedSecrets(packageRoot) {
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bnpm_[A-Za-z0-9]{30,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bAKIA[A-Z0-9]{16}\b/,
    /\baw_(?:project|connector)_[A-Za-z0-9_-]{16,}\b/
  ];

  for (const path of await walkFiles(packageRoot)) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > 5 * 1024 * 1024) continue;
    const content = await readFile(path, "utf8");
    for (const pattern of secretPatterns) {
      assert(!pattern.test(content), `possible credential embedded in ${normalizePath(relative(packageRoot, path))}`);
    }
  }
}

async function assertNoHostedJudgeClient(packageRoot) {
  const forbidden = [
    /@anthropic-ai(?:\/sdk)?/,
    /ANTHROPIC_API_KEY/,
    /from ["']@anthropic-ai/
  ];
  for (const path of await walkFiles(packageRoot)) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > 5 * 1024 * 1024) continue;
    const normalized = normalizePath(relative(packageRoot, path));
    assert(
      !normalized.includes("anthropic"),
      `hosted judge client path leaked into the tarball: ${normalized}`
    );
    const content = await readFile(path, "utf8");
    for (const pattern of forbidden) {
      assert(
        !pattern.test(content),
        `hosted judge client or ANTHROPIC credential leaked into ${normalized}`
      );
    }
  }
}

async function assertBundledLicenseCoverage(packageRoot) {
  const bundle = await readFile(join(packageRoot, "dist", "index.js"), "utf8");
  const notices = await readFile(join(packageRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  const embeddedPackages = new Set(
    [...bundle.matchAll(/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g)].map(
      (match) => match[1]
    )
  );
  assert(
    embeddedPackages.size > 0,
    "could not detect bundled runtime packages for license validation"
  );

  for (const packageName of [...embeddedPackages].sort()) {
    const documentedAsHeading = notices.includes(`## ${packageName} `);
    const documentedAsListItem = notices.includes(`\`${packageName}\` `);
    assert(
      documentedAsHeading || documentedAsListItem,
      `THIRD_PARTY_NOTICES.md is missing bundled package ${packageName}`
    );
  }
}

const ACTION_COMPILE_CAPABILITIES = {
  prepare: true,
  observation: true,
  toolEvents: true,
  cleanup: true,
  multiTurn: false,
  observationKeys: ["order.refundable", "order.refunded_amount", "order.status"]
};

const ACTION_CONNECTOR_YAML = `version: 1
target:
  name: refunds-staging
  connector: http
  base_url: http://127.0.0.1:9
  operations:
    prepare:
      method: POST
      path: /__augmentworks/prepare
      idempotent: true
      request:
        attempt_id: $input.attempt_id
        fixture: $input.fixture
    send:
      method: POST
      path: /chat
      request:
        message: $input.message.content
      response:
        content: $.answer
        tool_events: $.events
    observe:
      method: POST
      path: /__augmentworks/observe
      idempotent: true
      request:
        attempt_id: $input.attempt_id
        probe_keys: $input.probe_keys
      response:
        order.status: $.order.status
        order.refunded_amount: $.order.refunded_amount
        order.refundable: $.order.refundable
    cleanup:
      method: POST
      path: /__augmentworks/cleanup
      idempotent: true
      request:
        attempt_id: $input.attempt_id
telemetry:
  allow_tool_events: true
  allow_observations:
    - order.status
    - order.refunded_amount
    - order.refundable
`;

function packedSelectionManifest(included) {
  const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const caseId = "support-refunds/0.2.0/S01";
  return {
    schemaVersion: "aw-suite-selection/1",
    documentKind: "suite_selection_manifest",
    selectionVersion: "1.0.0",
    createsBillableRun: false,
    catalogChecksum: hash,
    inventoryHash: hash,
    normalizedSelection: {
      profile: "smoke",
      includeTags: [],
      excludeTags: [],
      conversationMode: "single_turn",
      excludedCaseIds: [],
      requestedCaseIds: []
    },
    requestedCaseCount: 1,
    includedCaseCount: included ? 1 : 0,
    plannedExecutions: included ? 2 : 0,
    plannedCommands: included ? 8 : 0,
    perRunLimits: { maxCases: 20, maxExecutions: 60, maxCommands: 512 },
    quoteIsAuthoritative: true,
    aggregateReleaseRequiresCompleteCoverage: true,
    executable: included,
    unexecutableReason: included ? null : "No compatible cases remain after filters and capability checks.",
    included: included
      ? [{ caseId, reasonCode: "included", message: "included" }]
      : [],
    excluded: [],
    incompatible: included
      ? []
      : [{ caseId, reasonCode: "capability_prepare", message: "missing prepare" }],
    shards: included
      ? [
          {
            shardId: "shard-000",
            shardIndex: 0,
            shardIdentityHash: hash,
            caseIds: [caseId],
            plannedExecutions: 2,
            plannedCommands: 8,
            planHash: hash,
            packetBindings: [{ key: "support-refunds", version: "0.2.0" }],
            compileOk: true
          }
        ]
      : [],
    manifestHash: hash
  };
}

async function assertPackedSelectionCompile(packedBin, consumerDirectory) {
  const workDirectory = join(consumerDirectory, "selection-capabilities");
  await mkdir(workDirectory, { recursive: true });
  await writeFile(join(workDirectory, "augmentworks.yaml"), ACTION_CONNECTOR_YAML, "utf8");
  await writeFile(join(workDirectory, "broken.yaml"), "version: [\n", "utf8");

  const requests = [];
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed = raw === "" ? undefined : JSON.parse(raw);
      requests.push({ method: request.method ?? "GET", path: url.pathname, body: parsed });
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        const body = JSON.stringify({
          subject: "user_test",
          email: "developer@example.com",
          workspace_id: "11111111-1111-4111-8111-111111111111",
          workspace_name: "Test Workspace",
          connector_id: "connector_test",
          connector_name: "Refunds Staging",
          scopes: ["connector:identity", "connector:run"]
        });
        response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        response.end(body);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/suite-selections/compile") {
        const capabilities = parsed?.capabilities ?? {};
        const included =
          capabilities.prepare === true &&
          capabilities.observation === true &&
          capabilities.toolEvents === true &&
          capabilities.cleanup === true &&
          Array.isArray(capabilities.observationKeys) &&
          capabilities.observationKeys.join(",") === ACTION_COMPILE_CAPABILITIES.observationKeys.join(",");
        const payload = JSON.stringify(packedSelectionManifest(included));
        response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
        response.end(payload);
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "missing" } }));
    });
  });

  const baseUrl = await new Promise((fulfill, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      fulfill(`http://127.0.0.1:${String(address.port)}`);
    });
  });

  try {
    const env = {
      AUGMENTWORKS_API_URL: baseUrl,
      AUGMENTWORKS_TOKEN: "aw_connector_test_access_token_selection",
      AUGMENTWORKS_API_KEY: "",
      AUGMENTWORKS_REFRESH_TOKEN: "",
      CI: "1"
    };
    const compiled = await runAsync(process.execPath, [packedBin, "selection", "compile", "--profile", "smoke", "--include-catalog", "--json"], {
      cwd: workDirectory,
      env
    });
    const compileRequest = requests.find((entry) => entry.method === "POST" && entry.path === "/v1/suite-selections/compile");
    assert(compileRequest !== undefined, "packed selection compile did not POST /v1/suite-selections/compile");
    const capabilities = compileRequest.body?.capabilities ?? {};
    assert(capabilities.prepare === true, "packed compile omitted prepare");
    assert(capabilities.observation === true, "packed compile omitted observation");
    assert(capabilities.toolEvents === true, "packed compile omitted toolEvents");
    assert(capabilities.cleanup === true, "packed compile omitted cleanup");
    assert(capabilities.multiTurn === false, "packed compile overstated multiTurn");
    assert(
      Array.isArray(capabilities.observationKeys) &&
        capabilities.observationKeys.join(",") === ACTION_COMPILE_CAPABILITIES.observationKeys.join(","),
      `packed compile observationKeys were ${JSON.stringify(capabilities.observationKeys)}`
    );
    const payload = JSON.parse(compiled.stdout);
    assert(payload.includedCaseCount === 1, "packed action compile did not include the action case");
    assert(payload.createsBillableRun === false, "packed compile advertised a billable run");
    assert(
      !requests.some((entry) => entry.path === "/v1/billing/quote" || entry.path.startsWith("/v1/relay/runs")),
      "packed selection compile created a quote or run"
    );

    const beforeFailure = requests.length;
    const failed = await runAsync(
      process.execPath,
      [packedBin, "selection", "compile", "--config", "broken.yaml", "--profile", "smoke", "--include-catalog"],
      {
        cwd: workDirectory,
        env,
        allowFailure: true
      }
    );
    assert(failed.status === 2, `packed malformed config exited ${String(failed.status)}: ${failed.stderr}`);
    assert(/Error \[[A-Z0-9_]+\]:/.test(failed.stderr), "packed malformed config omitted the config diagnostic");
    assert(requests.length === beforeFailure, "packed malformed config reached authentication or compile");
  } finally {
    await new Promise((fulfill, reject) => {
      httpServer.close((error) => {
        if (error) reject(error);
        else fulfill();
      });
    });
  }
}

async function assertPackedActionRecovery(consumerDirectory, execCli) {
  const stateDir = join(consumerDirectory, "action-intent-ledger");
  const intentId = "a".repeat(64);
  const receiptBytes = "fabricated-signed-receipt-bytes";
  const scriptPath = join(consumerDirectory, "prepare-action-ledger.mjs");
  await writeFile(
    scriptPath,
    [
      "import { ActionIntentLedger } from './node_modules/@augmentworks/cli/dist/index.js';",
      "const hash = 'b'.repeat(64);",
      "const ledger = new ActionIntentLedger(process.argv[2]);",
      "await ledger.createPrepared({",
      "  schemaVersion: 'aw-action-intent/1',",
      `  intentId: '${intentId}',`,
      "  state: 'receipt_pending',",
      "  mode: 'local-offline',",
      "  workspaceId: '11111111-1111-4111-8111-111111111111',",
      "  receiverId: '22222222-2222-4222-8222-222222222222',",
      "  scopeHash: hash,",
      "  policyHash: hash,",
      "  runId: '33333333-3333-4333-8333-333333333333',",
      "  attemptId: '44444444-4444-4444-8444-444444444444',",
      "  commandId: 'cmd_fabricated_1',",
      "  actionName: 'issue_refund',",
      "  resourceId: 'order_fabricated_001',",
      "  argumentRepresentationHash: hash,",
      "  argumentCommitment: { algorithm: 'hmac-sha256', value: hash, keyId: 'receiver-local-hmac-1' },",
      "  amount: { currency: 'USD', minorUnits: 2500 },",
      "  permit: null,",
      "  receipt: null,",
      `  receiptBytes: '${receiptBytes}',`,
      "  toolInvocations: 1,",
      "  platformSignature: false",
      "});"
    ].join("\n"),
    "utf8"
  );
  run(process.execPath, [scriptPath, stateDir], { cwd: consumerDirectory });
  const intentFile = join(stateDir, `${intentId}.json`);
  const before = await readFile(intentFile, "utf8");
  assert(before.includes(receiptBytes), "packed ledger did not persist the pending receipt");
  if (process.platform !== "win32") {
    assert(((await lstat(stateDir)).mode & 0o777) === 0o700, "packed ledger directory is not mode 0700");
    assert(((await lstat(intentFile)).mode & 0o777) === 0o600, "packed intent file is not mode 0600");
  }
  const recovered = execCli(["action", "recover", "--state-dir", stateDir, "--json"]);
  assert(!recovered.stdout.includes(receiptBytes), "packed action recover printed receipt bytes");
  assert(!recovered.stderr.includes(receiptBytes), "packed action recover printed receipt bytes on stderr");
  const report = JSON.parse(recovered.stdout);
  assert(report.controlledActionsAvailable === false, "packed recovery enabled controlled actions");
  assert(report.retried === 1, "packed recovery did not retry the pending receipt");
  assert(report.results?.[0]?.toolInvocations === 1, "packed recovery changed the stored tool invocation count");
  assert(report.results?.[0]?.receiptAccepted === false, "packed offline recovery claimed an accepted receipt");
  assert(report.results?.[0]?.platformSignature === false, "packed recovery claimed a platform signature");
  assert(await readFile(intentFile, "utf8") === before, "packed recovery changed stored receipt bytes");
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "augmentworks-cli-pack-"));
  const packDirectory = join(temporaryRoot, "pack");
  const consumerDirectory = join(temporaryRoot, "consumer");
  const assessmentDirectory = join(consumerDirectory, "assessment");
  let targetProcess;

  try {
    await writeFile(join(temporaryRoot, "README"), "Temporary npm pack smoke workspace.\n", "utf8");
    await Promise.all([
      mkdir(packDirectory, { recursive: true }),
      mkdir(consumerDirectory, { recursive: true }),
      mkdir(assessmentDirectory, { recursive: true })
    ]);

    process.stdout.write("[pack smoke] building package\n");
    runJsCli("npm", ["run", "build"]);

    process.stdout.write("[pack smoke] creating and inspecting tarball\n");
    const packed = runJsCli("npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packDirectory
    ]);
    const report = parsePackReport(packed.stdout);
    assertInventory(report);

    const tarballPath = join(packDirectory, report.filename);
    await access(tarballPath, fsConstants.R_OK);

    const rootManifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    assert(report.name === rootManifest.name, "tarball package name differs from package.json");
    assert(report.version === rootManifest.version, "tarball version differs from package.json");

    process.stdout.write("[pack smoke] executing tarball through npx\n");
    const directVersion = runJsCli(
      "npx",
      ["--yes", "--package", tarballPath, "augmentworks", "--version"],
      {
        cwd: consumerDirectory
      }
    );
    assert(
      directVersion.stdout.trim() === rootManifest.version,
      `npx --version returned ${JSON.stringify(directVersion.stdout.trim())}, expected ${rootManifest.version}`
    );

    await writeFile(
      join(consumerDirectory, "package.json"),
      JSON.stringify({ name: "augmentworks-cli-pack-smoke", private: true, version: "0.0.0" }, null, 2) + "\n",
      "utf8"
    );
    runJsCli(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballPath],
      { cwd: consumerDirectory }
    );

    const installedRoot = join(consumerDirectory, "node_modules", "@augmentworks", "cli");
    const installedManifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
    assert(installedManifest.name === "@augmentworks/cli", "installed package has the wrong name");
    assert(installedManifest.version === rootManifest.version, "installed package has the wrong version");
    assert(installedManifest.bin?.augmentworks === "dist/index.js", "installed package has the wrong bin mapping");
    await assertNoEmbeddedSecrets(installedRoot);
    await assertNoHostedJudgeClient(installedRoot);
    await assertBundledLicenseCoverage(installedRoot);

    const installedBin = join(
      consumerDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "augmentworks.cmd" : "augmentworks"
    );
    await access(installedBin, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    if (process.platform !== "win32") {
      const executable = await stat(join(installedRoot, "dist", "index.js"));
      assert((executable.mode & 0o111) !== 0, "published CLI entrypoint is not executable");
    }

    const execCli = (args, options = {}) =>
      runJsCli("npm", ["exec", "--", "augmentworks", ...args], {
        cwd: options.cwd ?? consumerDirectory,
        env: options.env
      });

    const installedVersion = execCli(["--version"]);
    assert(installedVersion.stdout.trim() === rootManifest.version, "installed CLI version is inconsistent");

    const packedRelease = JSON.parse(
      await readFile(join(installedRoot, "schemas", "v1", "cli-release.json"), "utf8")
    );
    assert(
      packedRelease.published_package_version === rootManifest.version,
      "packed cli-release version differs from package.json"
    );
    assert(
      packedRelease.published_package_verified === true,
      "packed cli-release must not claim unverified candidate identity"
    );
    assert(
      !String(packedRelease.notes).includes("Candidate 0.3.4"),
      "packed notes still describe 0.3.4 as a candidate"
    );
    assert(
      !String(packedRelease.notes).includes(
        "Last independently verified published tarball remains @augmentworks/cli@0.3.2"
      ),
      "packed notes still claim last verified is 0.3.2"
    );

    const packedReadme = await readFile(join(installedRoot, "README.md"), "utf8");
    assert(!/That candidate includes/.test(packedReadme), "packed README still calls this package a candidate");
    assert(
      !/last independently verified npm remains [`*_]*0\.3\.2/i.test(packedReadme),
      "packed README still claims last verified is 0.3.2"
    );

    const testHelp = execCli(["test", "--help"]);
    assert(testHelp.stdout.includes("quoted aw-relay/0.3"), "packed test --help must advertise current quoted protocol");
    assert(!testHelp.stdout.includes("source 0.3.3"), "packed test --help still mentions source 0.3.3");
    assert(
      !testHelp.stdout.includes("published 0.3.2 uses aw-relay/0.2"),
      "packed test --help still claims published 0.3.2 protocol"
    );
    assert(testHelp.stdout.includes("--suite"), "packed CLI is missing test --suite");
    assert(testHelp.stdout.includes("--workspace"), "packed CLI is missing test --workspace");

    const loginHelp = execCli(["login", "--help"]);
    assert(loginHelp.stdout.includes("--workspace"), "packed CLI is missing login --workspace");
    const whoamiHelp = execCli(["whoami", "--help"]);
    assert(whoamiHelp.stdout.includes("--workspace"), "packed CLI is missing whoami --workspace");
    const usageHelp = execCli(["usage", "--help"]);
    assert(usageHelp.stdout.includes("--workspace"), "packed CLI is missing usage --workspace");
    const doctorHelpWorkspace = execCli(["doctor", "--help"]);
    assert(!doctorHelpWorkspace.stdout.includes("--workspace"), "packed doctor --help advertised --workspace");
    const demoHelpWorkspace = execCli(["demo", "--help"]);
    assert(!demoHelpWorkspace.stdout.includes("--workspace"), "packed demo --help advertised --workspace");

    const actionHelp = execCli(["action", "recover", "--help"]);
    assert(actionHelp.stdout.includes("--state-dir"), "packed CLI is missing action recover --state-dir");
    assert(actionHelp.stdout.includes("without rerunning"), "packed action recover help dropped the no-replay contract");
    const actionProbe = run(process.execPath, [
      "--input-type=module",
      "-e",
      [
        "import { CONTROLLED_ACTIONS_PUBLICLY_AVAILABLE, runCustomerBoundary, ActionIntentLedger } from './node_modules/@augmentworks/cli/dist/index.js';",
        "if (CONTROLLED_ACTIONS_PUBLICLY_AVAILABLE !== false) throw new Error('controlled actions must stay unavailable');",
        "if (typeof runCustomerBoundary !== 'function' || typeof ActionIntentLedger !== 'function') throw new Error('action gate exports missing');"
      ].join(" ")
    ], { cwd: consumerDirectory });
    assert(actionProbe.stderr === "" || actionProbe.stderr.includes("npm"), "packed action-gate import failed");
    await assertPackedActionRecovery(consumerDirectory, execCli);

    process.stdout.write("[pack smoke] packed action-gate permit retry\n");
    const actionGateFixture = spawnSync(
      process.execPath,
      [join(projectRoot, "scripts", "packed-action-gate-permit.mjs")],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          AUGMENTWORKS_PACKED_BIN: join(installedRoot, "dist", "index.js"),
          NO_COLOR: "1"
        },
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true
      }
    );
    if (actionGateFixture.error !== undefined) {
      throw new SmokeFailure(`packed action-gate fixture failed to start: ${actionGateFixture.error.message}`);
    }
    if (actionGateFixture.status !== 0) {
      throw new SmokeFailure(
        ["packed action-gate permit retry failed", actionGateFixture.stdout.trim(), actionGateFixture.stderr.trim()]
          .filter(Boolean)
          .join("\n")
      );
    }
    process.stdout.write(actionGateFixture.stdout);

    const recoverHelp = execCli(["recover", "--help"]);
    assert(recoverHelp.stdout.includes("--retire"), "packed CLI is missing recover --retire");
    assert(recoverHelp.stdout.includes("--resume"), "packed CLI is missing recover --resume");
    assert(recoverHelp.stdout.includes("--cancel"), "packed CLI is missing recover --cancel");
    assert(!recoverHelp.stdout.includes("--force-delete"), "packed CLI advertised --force-delete");

    const packedHelp = execCli(["--help"]);
    for (const command of [
      "login",
      "logout",
      "whoami",
      "usage",
      "billing",
      "init",
      "doctor",
      "preview-mapping",
      "probe",
      "demo",
      "catalog",
      "selection",
      "test",
      "suite",
      "run",
      "compare",
      "gate",
      "baseline",
      "investigation",
      "recover",
      "action",
      "schema"
    ]) {
      assert(
        new RegExp(`^  ${command}(?: \\[options\\])?`, "m").test(packedHelp.stdout),
        `packed CLI --help is missing ${command}`
      );
    }
    const probeHelp = execCli(["probe", "--help"]);
    assert(probeHelp.stdout.includes("bounded connection probe"), "packed CLI is missing probe description");
    assert(probeHelp.stdout.includes("consumes real target allowance"), "packed CLI is missing probe allowance copy");
    assert(probeHelp.stdout.includes("--yes"), "packed CLI is missing probe --yes");
    assert(probeHelp.stdout.includes("Never runs during doctor or init"), "packed probe help omitted doctor/init boundary");

    const runHelp = execCli(["run", "--help"]);
    assert(runHelp.stdout.includes("report"), "packed CLI is missing run report");
    const reportHelp = execCli(["run", "report", "--help"]);
    assert(reportHelp.stdout.includes("--json"), "packed CLI is missing run report --json");

    const compareHelp = execCli(["compare", "--help"]);
    assert(compareHelp.stdout.includes("--run"), "packed CLI is missing compare --run");
    assert(compareHelp.stdout.includes("--baseline"), "packed CLI is missing compare --baseline");
    assert(compareHelp.stdout.includes("--json"), "packed CLI is missing compare --json");
    const gateHelp = execCli(["gate", "--help"]);
    assert(gateHelp.stdout.includes("--wait"), "packed CLI is missing gate --wait");
    assert(gateHelp.stdout.includes("--timeout-ms"), "packed CLI is missing gate --timeout-ms");
    assert(gateHelp.stdout.includes("--manifest-file"), "packed CLI is missing gate --manifest-file");
    assert(
      gateHelp.stdout.includes("aw-manifest-release-policy/2"),
      "packed CLI is missing v2 whole-suite gate contract"
    );
    const catalogHelp = execCli(["catalog", "--help"]);
    assert(catalogHelp.stdout.includes("list"), "packed CLI is missing catalog list");
    assert(catalogHelp.stdout.includes("show"), "packed CLI is missing catalog show");
    const selectionHelp = execCli(["selection", "--help"]);
    assert(selectionHelp.stdout.includes("compile"), "packed CLI is missing selection compile");
    process.stdout.write("[pack smoke] checking packed selection compile capability snapshot\n");
    await assertPackedSelectionCompile(join(installedRoot, "dist", "index.js"), consumerDirectory);
    const testHelpSelection = execCli(["test", "--help"]);
    assert(testHelpSelection.stdout.includes("--manifest"), "packed CLI is missing test --manifest");
    assert(testHelpSelection.stdout.includes("--execution-id"), "packed CLI is missing test --execution-id");
    const baselineHelp = execCli(["baseline", "--help"]);
    assert(baselineHelp.stdout.includes("status"), "packed CLI is missing baseline status");
    assert(baselineHelp.stdout.includes("promote"), "packed CLI is missing baseline promote");
    const investigationHelp = execCli(["investigation", "--help"]);
    assert(investigationHelp.stdout.includes("inspect"), "packed CLI is missing investigation inspect");
    assert(investigationHelp.stdout.includes("fetch"), "packed CLI is missing investigation fetch");
    assert(investigationHelp.stdout.includes("export-regression"), "packed CLI is missing investigation export-regression");
    const testHelpInvestigation = execCli(["test", "--help"]);
    assert(testHelpInvestigation.stdout.includes("--investigation"), "packed CLI is missing test --investigation");
    assert(testHelpInvestigation.stdout.includes("--headless"), "packed CLI is missing test --headless");

    process.stdout.write("[pack smoke] checking schema, init, and offline doctor\n");
    const schemaResult = execCli(["schema"]);
    let schema;
    try {
      schema = JSON.parse(schemaResult.stdout);
    } catch (error) {
      throw new SmokeFailure(
        `augmentworks schema did not print JSON: ${error instanceof Error ? error.message : String(error)}\n${schemaResult.stdout}`
      );
    }
    assert(schema !== null && typeof schema === "object", "schema command returned a non-object");
    assert(schema.type === "object", "schema command returned an unexpected root schema");
    for (const kind of ["local-packet", "local-result", "customer-suite", "investigation-export"]) {
      const localSchema = JSON.parse(execCli(["schema", "--kind", kind, "--compact"]).stdout);
      assert(localSchema.type === "object", `${kind} schema command returned an unexpected root`);
      if (kind === "customer-suite") {
        assert(
          Array.isArray(localSchema.oneOf) && localSchema.oneOf.length === 3,
          "customer-suite schema is missing the v1/v2/v3 oneOf"
        );
        const versions = localSchema.oneOf.map((choice) => choice?.properties?.schema_version?.const);
        assert(
          versions.includes("aw-suite/1") && versions.includes("aw-suite/2") && versions.includes("aw-suite/3"),
          "customer-suite schema does not advertise aw-suite/1, aw-suite/2, and aw-suite/3"
        );
      }
      if (kind === "local-packet") {
        assert(
          Array.isArray(localSchema.oneOf) && localSchema.oneOf.length === 2,
          "local-packet schema is missing the synthetic/local-authorized oneOf"
        );
        const versions = localSchema.oneOf.map((choice) => choice?.properties?.schema_version?.const);
        assert(
          versions.includes("aw-packet/0.1") && versions.includes("aw-packet/local-authorized-1"),
          "local-packet schema does not advertise aw-packet/0.1 and aw-packet/local-authorized-1"
        );
      }
    }

    const workflowInit = execCli(["init", "--starter", "workflow"], { cwd: assessmentDirectory });
    assertNpmCustomerCliCopy(workflowInit.stdout, rootManifest.version, "packed workflow init stdout");
    await Promise.all([
      access(join(assessmentDirectory, "augmentworks.yaml"), fsConstants.R_OK),
      access(join(assessmentDirectory, "augmentworks.assessment.yaml"), fsConstants.R_OK),
      access(join(assessmentDirectory, "references", "refund-policy.md"), fsConstants.R_OK),
      access(join(assessmentDirectory, ".env.example"), fsConstants.R_OK),
      access(join(assessmentDirectory, ".env"), fsConstants.R_OK),
      access(join(assessmentDirectory, "server.mjs"), fsConstants.R_OK),
      access(join(assessmentDirectory, "OWN-TARGET.md"), fsConstants.R_OK),
      access(join(assessmentDirectory, "fixtures", "send-response.json"), fsConstants.R_OK)
    ]);
    assert(
      (await readFile(join(assessmentDirectory, "augmentworks.assessment.yaml"), "utf8")).includes(
        "support-refunds"
      ),
      "workflow starter must generate the support-refunds assessment"
    );
    assertNpmCustomerCliCopy(
      await readFile(join(assessmentDirectory, "OWN-TARGET.md"), "utf8"),
      rootManifest.version,
      "generated workflow OWN-TARGET.md"
    );
    const generatedEnvironment = await readFile(join(assessmentDirectory, ".env"), "utf8");
    assert(
      /^CHATBOT_API_KEY=\s*$/m.test(generatedEnvironment),
      "init must leave the target API key empty for the user to supply"
    );
    assert(
      (await readFile(join(assessmentDirectory, ".gitignore"), "utf8"))
        .split(/\r?\n/)
        .includes(".env"),
      "init must add .env to .gitignore"
    );
    if (process.platform !== "win32") {
      const environmentMode = (await stat(join(assessmentDirectory, ".env"))).mode & 0o777;
      assert(environmentMode === 0o600, `init created .env with unsafe mode ${environmentMode.toString(8)}`);
    }

    const doctorOffline = execCli(["doctor", "-c", "augmentworks.yaml", "--offline"], {
      cwd: assessmentDirectory,
      env: {
        CHATBOT_BASE_URL: "http://127.0.0.1:65535",
        CHATBOT_API_KEY: "pack-smoke-placeholder"
      }
    });
    assert(
      doctorOffline.stdout.includes("CONNECTION_PROBE_AVAILABLE"),
      "packed doctor must advertise probe without calling the target"
    );
    assert(
      doctorOffline.stdout.includes("OFFLINE_CHECK_COMPLETE"),
      "packed doctor skipped the offline marker"
    );

    process.stdout.write("[pack smoke] checking probe preflight does not call the target\n");
    const probePlan = execCli(["probe", "-c", "augmentworks.yaml", "--json"], {
      cwd: assessmentDirectory,
      env: {
        CHATBOT_BASE_URL: "http://127.0.0.1:1",
        CHATBOT_API_KEY: "pack-smoke-probe-secret",
        AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
      }
    });
    let probePlanReport;
    try {
      probePlanReport = JSON.parse(probePlan.stdout);
    } catch (error) {
      throw new SmokeFailure(
        `packed probe --json was not parseable JSON: ${error instanceof Error ? error.message : String(error)}\n${probePlan.stdout}`
      );
    }
    assert(probePlanReport.schema_version === "AW-CONNECTION-PROBE-1", "probe schema is wrong");
    assert(probePlanReport.executed === false, "probe without --yes executed target calls");
    assert(probePlanReport.ok === true, "probe preflight should succeed");
    assert(probePlanReport.credits_consumed === 0, "probe preflight consumed credits");
    assert(probePlanReport.hosted_contacted === false, "probe preflight contacted hosted API");
    assert(probePlanReport.pattern === "stateful", "workflow probe pattern was not stateful");
    assert(probePlanReport.preflight?.call_count === 4, "stateful probe plan should be 4 calls");
    assert(
      !probePlan.stdout.includes("pack-smoke-probe-secret"),
      "target credential leaked into probe preflight stdout"
    );
    assert(
      !probePlan.stdout.includes("poison-hosted-token-must-not-be-used"),
      "hosted credential leaked into probe preflight stdout"
    );

    process.stdout.write("[pack smoke] checking init --config custom filename\n");
    const customDirectory = join(consumerDirectory, "custom-config");
    await mkdir(customDirectory, { recursive: true });
    await writeFile(join(customDirectory, "augmentworks.yaml"), "# sibling-default-must-remain\n", "utf8");
    const customInit = execCli(["init", "-c", "custom.yaml", "--no-env"], { cwd: customDirectory });
    assertNpmCustomerCliCopy(customInit.stdout, rootManifest.version, "packed custom-config init stdout");
    assert(
      customInit.stdout.includes("custom.yaml"),
      "init --config must mention the requested filename"
    );
    assert(
      !customInit.stdout.includes("created augmentworks.yaml, augmentworks.assessment.yaml"),
      "init --config must not claim it created the default connector filename"
    );
    await Promise.all([
      access(join(customDirectory, "custom.yaml"), fsConstants.R_OK),
      access(join(customDirectory, "augmentworks.assessment.yaml"), fsConstants.R_OK),
      access(join(customDirectory, "references", "faq.md"), fsConstants.R_OK),
      access(join(customDirectory, ".env.example"), fsConstants.R_OK)
    ]);
    assert(
      (await readFile(join(customDirectory, "augmentworks.yaml"), "utf8")) ===
        "# sibling-default-must-remain\n",
      "init --config must not replace a sibling default connector"
    );
    assert(!existsSync(join(customDirectory, ".env")), "init --no-env must not create .env");
    execCli(["doctor", "-c", "custom.yaml", "--offline"], {
      cwd: customDirectory,
      env: {
        CHATBOT_BASE_URL: "http://127.0.0.1:65535",
        CHATBOT_API_KEY: "pack-smoke-placeholder"
      }
    });

    process.stdout.write("[pack smoke] checking offline preview-mapping from packed CLI\n");
    const previewHelp = execCli(["preview-mapping", "--help"]);
    assert(previewHelp.stdout.includes("--fixture"), "packed CLI is missing preview-mapping --fixture");
    assert(previewHelp.stdout.includes("--operation"), "packed CLI is missing preview-mapping --operation");
    assert(previewHelp.stdout.includes("--json"), "packed CLI is missing preview-mapping --json");
    await writeFile(
      join(assessmentDirectory, "send-fixture.json"),
      `${JSON.stringify({ answer: "Packed preview says hello.", finished: true, events: [] })}\n`,
      "utf8"
    );
    const previewRun = execCli(
      [
        "preview-mapping",
        "-c",
        "augmentworks.yaml",
        "--operation",
        "send",
        "--fixture",
        "send-fixture.json",
        "--json"
      ],
      {
        cwd: assessmentDirectory,
        env: {
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used",
          CHATBOT_API_KEY: "ambient-secret-must-not-be-used"
        }
      }
    );
    let previewReport;
    try {
      previewReport = JSON.parse(previewRun.stdout);
    } catch (error) {
      throw new SmokeFailure(
        `packed preview-mapping --json was not parseable JSON: ${error instanceof Error ? error.message : String(error)}\n${previewRun.stdout}`
      );
    }
    assert(previewReport.schema_version === "AW-MAPPING-PREVIEW-1", "preview schema is wrong");
    assert(previewReport.ok === true, "packed preview-mapping did not succeed");
    assert(previewReport.offline === true, "packed preview-mapping was not marked offline");
    assert(previewReport.credits_consumed === 0, "packed preview-mapping consumed credits");
    assert(typeof previewReport.evidence?.canonical === "string", "packed preview omitted canonical evidence");
    assert(
      !previewRun.stdout.includes("poison-hosted-token-must-not-be-used"),
      "hosted credential leaked into preview stdout"
    );
    assert(
      !previewRun.stdout.includes("ambient-secret-must-not-be-used"),
      "ambient target credential leaked into preview stdout"
    );

    process.stdout.write("[pack smoke] checking offline customer suite validate/preview from packed CLI\n");
    const suiteHelp = execCli(["suite", "--help"]);
    assert(suiteHelp.stdout.includes("validate"), "packed CLI is missing suite validate");
    assert(suiteHelp.stdout.includes("preview"), "packed CLI is missing suite preview");
    const packedSuites = join(installedRoot, "assets", "customer-suites");
    for (const sample of ["faq-non-commerce.yaml", "returns-14-day.yaml"]) {
      const suitePath = join(packedSuites, sample);
      const validateRun = execCli(["suite", "validate", suitePath, "--json"], {
        env: {
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
        }
      });
      let validateReport;
      try {
        validateReport = JSON.parse(validateRun.stdout);
      } catch (error) {
        throw new SmokeFailure(
          `packed suite validate --json was not parseable JSON: ${error instanceof Error ? error.message : String(error)}\n${validateRun.stdout}`
        );
      }
      assert(validateReport.ok === true, `packed suite validate failed for ${sample}`);
      assert(validateReport.localPreview?.authoritativePrice === false, "suite validate claimed an authoritative price");
      assert(validateReport.localPreview?.executesTarget === false, "suite validate claimed target execution");
      assert(validateReport.localPreview?.callsLlm === false, "suite validate claimed an LLM call");
      const previewSuite = execCli(["suite", "preview", suitePath], {
        env: {
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
        }
      });
      assert(previewSuite.stdout.includes("not a price"), `packed suite preview omitted the price disclaimer for ${sample}`);
      assert(previewSuite.stdout.includes("executes_target: no"), `packed suite preview omitted executes_target for ${sample}`);
      assert(
        !validateRun.stdout.includes("poison-hosted-token-must-not-be-used"),
        "hosted credential leaked into suite validate stdout"
      );
    }

    process.stdout.write("[pack smoke] checking offline live-informational preflight from source fixture\n");
    assert(suiteHelp.stdout.includes("preflight"), "packed CLI is missing suite preflight");
    const liveFixture = join(projectRoot, "test", "fixtures", "customer-suites", "live-informational.yaml");
    const liveValidate = execCli(["suite", "validate", liveFixture, "--json"], {
      env: {
        AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
        AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
      }
    });
    const liveValidateReport = JSON.parse(liveValidate.stdout);
    assert(liveValidateReport.ok === true, "source live-informational suite validate failed");
    assert(liveValidateReport.schemaVersion === "aw-suite/2", "live fixture schema was not aw-suite/2");
    assert(liveValidateReport.syntheticOnly === false, "live fixture was marked synthetic_only");
    const livePreflight = execCli(["suite", "preflight", liveFixture, "--json"], {
      env: {
        AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
        AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used",
        AUGMENTWORKS_QA_WORKSPACE_ID: "ws_pack_smoke_live"
      }
    });
    const livePreflightReport = JSON.parse(livePreflight.stdout);
    assert(livePreflightReport.ok === true, "source live-informational suite preflight failed");
    assert(livePreflightReport.buysCredits === false, "live preflight bought credits");
    assert(livePreflightReport.localPreview?.executesTarget === false, "live preflight executed a target");
    assert(livePreflightReport.overlay === "aw-packet/live-informational-1", "live preflight omitted the packet overlay");
    assert(livePreflightReport.liveTarget?.origin === "https://support.example.com", "live preflight omitted the approved origin");
    assert(
      !livePreflight.stdout.includes("poison-hosted-token-must-not-be-used"),
      "hosted credential leaked into live preflight stdout"
    );

    process.stdout.write("[pack smoke] checking offline investigation inspect from packed CLI\n");
    const packedInvestigations = join(installedRoot, "assets", "investigations");
    for (const sample of ["response-only.json", "stateful.json"]) {
      const investigationPath = join(packedInvestigations, sample);
      const inspectRun = execCli(["investigation", "inspect", investigationPath, "--json"], {
        env: {
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
        }
      });
      let inspectReport;
      try {
        inspectReport = JSON.parse(inspectRun.stdout);
      } catch (error) {
        throw new SmokeFailure(
          `packed investigation inspect --json was not parseable JSON: ${error instanceof Error ? error.message : String(error)}\n${inspectRun.stdout}`
        );
      }
      assert(inspectReport.ok === true, `packed investigation inspect failed for ${sample}`);
      assert(inspectReport.admissionCalls === 0, "investigation inspect must not admit a run");
      assert(inspectReport.executesTarget === false, "investigation inspect claimed target execution");
      assert(inspectReport.executesShell === false, "investigation inspect claimed shell execution");
      assert(inspectReport.callsEvaluator === false, "investigation inspect claimed an evaluator");
      assert(inspectReport.copiedCommandsAreData === true, "investigation inspect must treat command fragments as data");
      assert(
        !inspectRun.stdout.includes("poison-hosted-token-must-not-be-used"),
        "hosted credential leaked into investigation inspect stdout"
      );
    }

    process.stdout.write("[pack smoke] running generated workflow fixture through packed CLI\n");
    const targetOrigin = "http://127.0.0.1:18473";
    targetProcess = spawn(
      process.execPath,
      [join(assessmentDirectory, "server.mjs")],
      {
        cwd: assessmentDirectory,
        env: {
          ...process.env,
          CHATBOT_BASE_URL: targetOrigin,
          CHATBOT_API_KEY: "pack-smoke-target-key"
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
    await waitForTarget(targetOrigin, targetProcess);
    const probeYes = execCli(["probe", "-c", "augmentworks.yaml", "--yes", "--json"], {
      cwd: assessmentDirectory,
      env: {
        CHATBOT_BASE_URL: targetOrigin,
        CHATBOT_API_KEY: "pack-smoke-target-key",
        AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
        AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
      }
    });
    let probeYesReport;
    try {
      probeYesReport = JSON.parse(probeYes.stdout);
    } catch (error) {
      throw new SmokeFailure(
        `packed probe --yes --json was not parseable JSON: ${error instanceof Error ? error.message : String(error)}\n${probeYes.stdout}`
      );
    }
    assert(probeYesReport.ok === true, "packed workflow probe --yes failed");
    assert(probeYesReport.executed === true, "packed probe --yes did not execute");
    assert(probeYesReport.credits_consumed === 0, "packed probe consumed credits");
    assert(Array.isArray(probeYesReport.calls) && probeYesReport.calls.length === 4, "workflow probe did not make 4 calls");
    assert(
      (probeYesReport.calls ?? []).map((call) => call.phase).join(",") === "prepare,send,observe,cleanup",
      "workflow probe phases were not prepare/send/observe/cleanup"
    );
    assert(
      !probeYes.stdout.includes("pack-smoke-target-key"),
      "target credential leaked into probe --yes stdout"
    );
    const localOutput = join(assessmentDirectory, "packed-local-report");
    const localRun = execCli(
      [
        "test",
        "--local",
        "-c",
        "augmentworks.yaml",
        "--packet",
        "support-refunds-starter@0.1.0",
        "--output-dir",
        localOutput,
        "--json"
      ],
      {
        cwd: assessmentDirectory,
        env: {
          CHATBOT_BASE_URL: targetOrigin,
          CHATBOT_API_KEY: "pack-smoke-target-key",
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
        }
      }
    );
    const localResult = JSON.parse(localRun.stdout);
    assert(localResult.schema_version === "AW-LOCAL-RESULT-1", "local result schema is wrong");
    assert(localResult.outcome === "passed", `packed local assessment was ${localResult.outcome}`);
    assert(localResult.provenance?.cloud_contacted === false, "local result claims cloud contact");
    assert(localResult.provenance?.platform_received === false, "local result claims upload");
    assert(
      !localRun.stdout.includes("poison-hosted-token-must-not-be-used"),
      "hosted credential leaked into local output"
    );
    await Promise.all(
      ["report.json", "junit.xml", "report.html"].map((name) =>
        access(join(localOutput, name), fsConstants.R_OK)
      )
    );
    await stopTarget(targetProcess);
    targetProcess = undefined;

    process.stdout.write("[pack smoke] checking packed response-only starter, suite, and probe\n");
    const responseDirectory = join(consumerDirectory, "response-only");
    await mkdir(responseDirectory, { recursive: true });
    const responseInit = execCli(["init", "--starter", "response-only"], { cwd: responseDirectory });
    assertNpmCustomerCliCopy(responseInit.stdout, rootManifest.version, "packed response-only init stdout");
    const responseYaml = await readFile(join(responseDirectory, "augmentworks.yaml"), "utf8");
    assert(!/^ {4}prepare:/m.test(responseYaml), "response-only starter must not generate unused prepare hooks");
    assert(!/^ {4}observe:/m.test(responseYaml), "response-only starter must not generate unused observe hooks");
    assert(!/^ {4}cleanup:/m.test(responseYaml), "response-only starter must not generate unused cleanup hooks");
    await Promise.all([
      access(join(responseDirectory, "server.mjs"), fsConstants.R_OK),
      access(join(responseDirectory, "session-server.mjs"), fsConstants.R_OK),
      access(join(responseDirectory, "own-chatbot.suite.yaml"), fsConstants.R_OK),
      access(join(responseDirectory, "OWN-TARGET.md"), fsConstants.R_OK),
      access(join(responseDirectory, "fixtures", "send-response.json"), fsConstants.R_OK)
    ]);
    const generatedOwnTarget = await readFile(join(responseDirectory, "OWN-TARGET.md"), "utf8");
    assertNpmCustomerCliCopy(generatedOwnTarget, rootManifest.version, "generated response-only OWN-TARGET.md");
    assert(
      !/^(?:cp(?:\s+-f)?\s+\.env\.example\s+\.env|copy(?:\s+\/Y)?\s+\.env\.example\s+\.env)\s*$/m.test(
        generatedOwnTarget
      ),
      "generated OWN-TARGET.md must not unconditionally overwrite .env"
    );
    const sentinelDirectory = join(consumerDirectory, "env-sentinel");
    await mkdir(sentinelDirectory, { recursive: true });
    const sentinelPath = join(sentinelDirectory, ".env");
    await writeFile(sentinelPath, "CHATBOT_API_KEY=sentinel-existing-value\n", { mode: 0o600 });
    const sentinelBefore = createHash("sha256").update(await readFile(sentinelPath)).digest("hex");
    const sentinelInit = execCli(["init", "--agent"], { cwd: sentinelDirectory });
    assertNpmCustomerCliCopy(sentinelInit.stdout, rootManifest.version, "packed init --agent stdout");
    const sentinelAfterInit = createHash("sha256").update(await readFile(sentinelPath)).digest("hex");
    assert(sentinelAfterInit === sentinelBefore, "init --agent must preserve an existing .env");
    const sentinelGuide = await readFile(join(sentinelDirectory, "OWN-TARGET.md"), "utf8");
    assert(
      !/^(?:cp(?:\s+-f)?\s+\.env\.example\s+\.env|copy(?:\s+\/Y)?\s+\.env\.example\s+\.env)\s*$/m.test(
        sentinelGuide
      ),
      "init-generated OWN-TARGET.md must not instruct an unconditional .env overwrite"
    );
    const responseDoctor = execCli(["doctor", "-c", "augmentworks.yaml", "--offline"], {
      cwd: responseDirectory,
      env: {
        CHATBOT_BASE_URL: "http://127.0.0.1:65535",
        CHATBOT_API_KEY: "pack-smoke-response-key"
      }
    });
    assert(
      responseDoctor.stdout.includes("CONNECTION_PROBE_AVAILABLE"),
      "response-only doctor must advertise probe without calling the target"
    );
    const suiteValidate = execCli(["suite", "validate", "own-chatbot.suite.yaml", "--json"], {
      cwd: responseDirectory,
      env: {
        AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
        AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
      }
    });
    const suiteReport = JSON.parse(suiteValidate.stdout);
    assert(suiteReport.ok === true, "packed own-chatbot suite validate failed");
    assert(suiteReport.caseCount === 5, "own-chatbot suite must have five cases");
    const responsePreview = execCli(
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
      { cwd: responseDirectory }
    );
    const responsePreviewReport = JSON.parse(responsePreview.stdout);
    assert(responsePreviewReport.ok === true, "packed response-only preview-mapping failed");
    const responseOrigin = "http://127.0.0.1:18474";
    targetProcess = spawn(process.execPath, [join(responseDirectory, "server.mjs")], {
      cwd: responseDirectory,
      env: {
        ...process.env,
        CHATBOT_BASE_URL: responseOrigin,
        CHATBOT_API_KEY: "pack-smoke-response-key"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    await waitForTarget(responseOrigin, targetProcess);
    const responseProbe = execCli(["probe", "-c", "augmentworks.yaml", "--yes", "--json"], {
      cwd: responseDirectory,
      env: {
        CHATBOT_BASE_URL: responseOrigin,
        CHATBOT_API_KEY: "pack-smoke-response-key"
      }
    });
    const responseProbeReport = JSON.parse(responseProbe.stdout);
    assert(responseProbeReport.ok === true, "packed response-only probe --yes failed");
    assert(responseProbeReport.pattern === "response-only", "response-only probe pattern was wrong");
    assert(responseProbeReport.calls?.length === 1, "response-only probe should make one send call");
    assert(
      !responseProbe.stdout.includes("pack-smoke-response-key"),
      "target credential leaked into response-only probe stdout"
    );
    await stopTarget(targetProcess);
    targetProcess = undefined;

    process.stdout.write("[pack smoke] running packaged demo from installed tarball\n");
    const demoDirectory = join(consumerDirectory, "demo space", "run");
    await mkdir(demoDirectory, { recursive: true });
    await writeFile(
      join(demoDirectory, "augmentworks.yaml"),
      "version: 1\ntarget:\n  name: must-not-be-used\n  connector: http\n  base_url: ${CHATBOT_BASE_URL}\n  operations:\n    send:\n      method: POST\n      path: /chat\n",
      "utf8"
    );
    const demoOutput = join(demoDirectory, "demo-output");
    const packedCli = join(installedRoot, "dist", "index.js");
    const demoRun = run(
      process.execPath,
      [packedCli, "demo", "--json", "--output-dir", demoOutput],
      {
        cwd: demoDirectory,
        env: {
          CHATBOT_BASE_URL: "https://poisoned.example",
          CHATBOT_API_KEY: "ambient-secret-must-not-be-used",
          AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
          AUGMENTWORKS_TOKEN: "poison-hosted-token-must-not-be-used"
        }
      }
    );
    let demoSummary;
    try {
      demoSummary = JSON.parse(demoRun.stdout);
    } catch (error) {
      throw new SmokeFailure(
        `packed demo --json was not parseable JSON: ${error instanceof Error ? error.message : String(error)}\n${demoRun.stdout}`
      );
    }
    assert(demoSummary.schema_version === "AW-DEMO-SUMMARY-1", "demo summary schema is wrong");
    assert(demoSummary.kind === "synthetic_local_demo", "demo summary kind is wrong");
    assert(demoSummary.ok === true, "packed demo story did not succeed");
    assert(demoSummary.runs?.faulty?.exit_code === 10, "faulty demo exit was not preserved as 10");
    assert(demoSummary.runs?.corrected?.exit_code === 0, "corrected demo exit was not 0");
    assert(
      !demoRun.stdout.includes("poison-hosted-token-must-not-be-used"),
      "hosted credential leaked into demo stdout"
    );
    assert(
      !demoRun.stdout.includes("ambient-secret-must-not-be-used"),
      "ambient target credential leaked into demo stdout"
    );
    await Promise.all(
      ["failing/report.json", "passing/report.json", "failing/junit.xml", "passing/report.html"].map((name) =>
        access(join(demoOutput, name), fsConstants.R_OK)
      )
    );
    const demoHelp = execCli(["demo", "--help"]);
    assert(demoHelp.stdout.includes("--json"), "packed CLI is missing demo --json");
    assert(demoHelp.stdout.includes("--mode"), "packed CLI is missing demo --mode");

    process.stdout.write("[pack smoke] packed billing HTTP fixture through installed binary\n");
    const fixture = spawnSync(process.execPath, [join(projectRoot, "scripts", "packed-billing-fixture.mjs")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AUGMENTWORKS_PACKED_BIN: packedCli,
        NO_COLOR: "1"
      },
      encoding: "utf8",
      timeout: 240_000,
      windowsHide: true
    });
    if (fixture.error !== undefined) {
      throw new SmokeFailure(`packed billing fixture failed to start: ${fixture.error.message}`);
    }
    if (fixture.status !== 0) {
      throw new SmokeFailure(
        [
          "packed billing HTTP fixture failed",
          fixture.stdout.trim(),
          fixture.stderr.trim()
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    process.stdout.write(fixture.stdout);

    process.stdout.write("[pack smoke] packed report HTTP fixture through installed binary\n");
    const reportFixture = spawnSync(process.execPath, [join(projectRoot, "scripts", "packed-report-fixture.mjs")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AUGMENTWORKS_PACKED_BIN: packedCli,
        NO_COLOR: "1"
      },
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true
    });
    if (reportFixture.error !== undefined) {
      throw new SmokeFailure(`packed report fixture failed to start: ${reportFixture.error.message}`);
    }
    if (reportFixture.status !== 0) {
      throw new SmokeFailure(
        [
          "packed report HTTP fixture failed",
          reportFixture.stdout.trim(),
          reportFixture.stderr.trim()
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    process.stdout.write(reportFixture.stdout);

    process.stdout.write("[pack smoke] packed saved-suite release fixture through installed binary\n");
    const savedSuiteFixture = spawnSync(
      process.execPath,
      [join(projectRoot, "scripts", "packed-saved-suite-release.mjs")],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          AUGMENTWORKS_PACKED_BIN: packedCli,
          NO_COLOR: "1"
        },
        encoding: "utf8",
        timeout: 180_000,
        windowsHide: true
      }
    );
    if (savedSuiteFixture.error !== undefined) {
      throw new SmokeFailure(`packed saved-suite fixture failed to start: ${savedSuiteFixture.error.message}`);
    }
    if (savedSuiteFixture.status !== 0) {
      throw new SmokeFailure(
        [
          "packed saved-suite release fixture failed",
          savedSuiteFixture.stdout.trim(),
          savedSuiteFixture.stderr.trim()
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    process.stdout.write(savedSuiteFixture.stdout);

    process.stdout.write("[pack smoke] packed real-data privacy canaries through installed binary\n");
    const privacyFixture = spawnSync(process.execPath, [join(projectRoot, "scripts", "packed-real-data-privacy.mjs")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AUGMENTWORKS_PACKED_BIN: packedCli,
        NO_COLOR: "1"
      },
      encoding: "utf8",
      timeout: 180_000,
      windowsHide: true
    });
    if (privacyFixture.error !== undefined) {
      throw new SmokeFailure(`packed real-data privacy fixture failed to start: ${privacyFixture.error.message}`);
    }
    if (privacyFixture.status !== 0) {
      throw new SmokeFailure(
        [
          "packed real-data privacy fixture failed",
          privacyFixture.stdout.trim(),
          privacyFixture.stderr.trim()
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    process.stdout.write(privacyFixture.stdout);

    process.stdout.write("[pack smoke] core customer release-acceptance (local packed binary, not registry)\n");
    const coreAcceptance = spawnSync(
      process.execPath,
      [join(projectRoot, "scripts", "packed-core-release-acceptance.mjs"), "--source", "local"],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          AUGMENTWORKS_PACKED_BIN: packedCli,
          NO_COLOR: "1"
        },
        encoding: "utf8",
        timeout: 180_000,
        windowsHide: true
      }
    );
    if (coreAcceptance.error !== undefined) {
      throw new SmokeFailure(`core release-acceptance failed to start: ${coreAcceptance.error.message}`);
    }
    if (coreAcceptance.status !== 0) {
      throw new SmokeFailure(
        [
          "core customer release-acceptance (local packed binary) failed",
          coreAcceptance.stdout.trim(),
          coreAcceptance.stderr.trim()
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    process.stdout.write(coreAcceptance.stdout);

    process.stdout.write(
      `[pack smoke] passed (${String(report.entryCount)} files, ${String(report.size)} compressed bytes)\n`
    );
  } finally {
    if (targetProcess !== undefined) await stopTarget(targetProcess);
    if (process.env.AUGMENTWORKS_KEEP_SMOKE_TMP === "1") {
      process.stdout.write(`[pack smoke] retained ${temporaryRoot}\n`);
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

async function waitForTarget(origin, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const stderr = await streamText(child.stderr);
      throw new SmokeFailure(`fixture server exited before startup: ${stderr.trim()}`);
    }
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Target startup is bounded by the deadline below.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new SmokeFailure("fixture server did not become healthy within 10 seconds");
}

async function stopTarget(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function streamText(stream) {
  if (stream === null) return "";
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[pack smoke] ${message}\n`);
  process.exitCode = 1;
});
