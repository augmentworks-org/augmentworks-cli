#!/usr/bin/env node

/**
 * Installed-package proof for the saved-suite customer release (AUG-87).
 *
 * Drives the npm-installed CLI against loopback HTTP. Proves exact saved-suite
 * revision/hash forwarding, declared connector capabilities, estimate without a
 * run, explicit --max-credits execution, original-run status/report retrieval,
 * and npm init guidance. Reuses the owned billing, report, and criterion
 * fixtures. Does not call production, create a quote on a real workspace, or
 * publish a package.
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
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SUITE_ID = "policy-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUITE_REVISION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CANONICAL_HASH = "c".repeat(64);
const SEMANTIC_HASH = "d".repeat(64);
const INVENTORY_HASH = "e".repeat(64);
const SHARD_IDENTITY_HASH = "f".repeat(64);
const PLAN_HASH = "1".repeat(64);
const PACKET_SHA = "2".repeat(64);
const QUOTE_ID = "55555555-5555-4555-8555-555555555555";
const TOKEN = "aw_connector_test_access_token_saved_suite_pack";
const SCENARIOS = [
  "aw-customer-suite/1.0.0/policy-p01",
  "aw-customer-suite/1.0.0/policy-p02"
];
const OBSERVATION_KEYS = ["order.refundable", "order.refunded_amount", "order.status"];

class FixtureFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "FixtureFailure";
  }
}

function assert(condition, message) {
  if (!condition) throw new FixtureFailure(message);
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function unsignedManifest(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    documentKind: manifest.documentKind,
    selectionVersion: manifest.selectionVersion,
    createsBillableRun: manifest.createsBillableRun,
    workspaceId: manifest.workspaceId ?? null,
    suiteRevisionId: manifest.suiteRevisionId ?? null,
    suiteId: manifest.suiteId ?? null,
    semanticRevisionHash: manifest.semanticRevisionHash ?? null,
    catalogChecksum: manifest.catalogChecksum,
    inventoryHash: manifest.inventoryHash,
    normalizedSelection: manifest.normalizedSelection,
    requestedCaseCount: manifest.requestedCaseCount,
    includedCaseCount: manifest.includedCaseCount,
    plannedExecutions: manifest.plannedExecutions,
    plannedCommands: manifest.plannedCommands,
    perRunLimits: manifest.perRunLimits,
    quoteIsAuthoritative: manifest.quoteIsAuthoritative,
    aggregateReleaseRequiresCompleteCoverage: manifest.aggregateReleaseRequiresCompleteCoverage,
    executable: manifest.executable,
    unexecutableReason: manifest.unexecutableReason ?? null,
    included: manifest.included,
    excluded: manifest.excluded,
    incompatible: manifest.incompatible,
    shards: manifest.shards,
    suiteBinding: manifest.suiteBinding
  };
}

function savedSuiteManifest(executable) {
  const binding = {
    schemaVersion: "aw-saved-suite-binding/1",
    suiteId: SUITE_ID,
    suiteRevisionId: SUITE_REVISION,
    canonicalHash: CANONICAL_HASH,
    semanticRevisionHash: SEMANTIC_HASH,
    cases: [
      { caseId: "policy-p01", scenarioId: SCENARIOS[0], repetitions: 1 },
      { caseId: "policy-p02", scenarioId: SCENARIOS[1], repetitions: 1 }
    ]
  };
  const included = SCENARIOS.map((caseId) => ({
    caseId,
    reasonCode: "included",
    message: `Case ${caseId} is included once in the normalized selection.`
  }));
  const draft = {
    schemaVersion: "aw-suite-selection/2",
    documentKind: "suite_selection_manifest",
    selectionVersion: "2.0.0",
    createsBillableRun: false,
    workspaceId: WORKSPACE,
    suiteRevisionId: SUITE_REVISION,
    suiteId: SUITE_ID,
    semanticRevisionHash: SEMANTIC_HASH,
    catalogChecksum: null,
    inventoryHash: INVENTORY_HASH,
    normalizedSelection: {
      profile: "release",
      includeTags: [],
      excludeTags: [],
      conversationMode: "single_turn",
      excludedCaseIds: [],
      requestedCaseIds: [...SCENARIOS]
    },
    requestedCaseCount: SCENARIOS.length,
    includedCaseCount: SCENARIOS.length,
    plannedExecutions: SCENARIOS.length,
    plannedCommands: SCENARIOS.length,
    perRunLimits: { maxCases: 20, maxExecutions: 60, maxCommands: 512 },
    quoteIsAuthoritative: true,
    aggregateReleaseRequiresCompleteCoverage: true,
    executable,
    unexecutableReason: executable ? null : "missing prepare",
    included,
    excluded: [],
    incompatible: executable
      ? []
      : [{ caseId: SCENARIOS[0], reasonCode: "capability_prepare", message: "missing prepare" }],
    shards: [
      {
        shardId: "shard-000",
        shardIndex: 0,
        shardIdentityHash: SHARD_IDENTITY_HASH,
        caseIds: [...SCENARIOS],
        plannedExecutions: SCENARIOS.length,
        plannedCommands: SCENARIOS.length,
        planHash: PLAN_HASH,
        packetBindings: [{ key: "aw-customer-suite", version: "1.0.0", sha256: PACKET_SHA }],
        compileOk: true,
        compileReasonCode: null,
        compileMessage: null
      }
    ],
    suiteBinding: binding
  };
  return { ...draft, manifestHash: sha256(canonicalize(unsignedManifest(draft))) };
}

function connectorYaml(includeLifecycle) {
  const lifecycle = includeLifecycle
    ? `    prepare:
      method: POST
      path: /__augmentworks/prepare
      idempotent: true
      request:
        attempt_id: $input.attempt_id
        fixture: $input.fixture
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
`
    : "";
  const observations = includeLifecycle
    ? `  allow_observations:
    - order.status
    - order.refunded_amount
    - order.refundable
`
    : "";
  return `version: 1
target:
  name: refunds-staging
  connector: http
  base_url: http://127.0.0.1:9
  operations:
${lifecycle}    send:
      method: POST
      path: /chat
      request:
        message: $input.message.content
      response:
        content: $.answer
        tool_events: $.events
telemetry:
  allow_tool_events: true
${observations}`;
}

function assessmentYaml() {
  return `schema_version: aw-assessment-file/1
profile: custom
evaluation_mode: hybrid
packets:
  - key: aw-customer-suite
    version: 1.0.0
    scenarios:
      - ${SCENARIOS[0]}
      - ${SCENARIOS[1]}
target_already_configured: true
selection:
  profile: release
  suite_version: 2.0.0
  suite_revision_id: ${SUITE_REVISION}
  requested_case_ids:
    - ${SCENARIOS[0]}
    - ${SCENARIOS[1]}
`;
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
  const executable = cli === undefined ? binName : process.execPath;
  const cliArgs = cli === undefined ? args : [cli, ...args];
  return spawnSync(executable, cliArgs, {
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, ...options.env, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true
  });
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function rewriteOrigin(value, from, to) {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((item) => rewriteOrigin(item, from, to));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rewriteOrigin(child, from, to)])
    );
  }
  return value;
}

function fixtureOrigin(document) {
  const match = JSON.stringify(document).match(/https:\/\/[^"/]+/);
  assert(match !== null, "owned report fixture did not contain an absolute origin to rewrite");
  return match[0];
}

function expectSuiteTriple(assessment, label) {
  assert(assessment?.suite_id === SUITE_ID, `${label} suite_id was ${JSON.stringify(assessment?.suite_id)}`);
  assert(
    assessment?.suite_revision_id === SUITE_REVISION,
    `${label} suite_revision_id was ${JSON.stringify(assessment?.suite_revision_id)}`
  );
  assert(
    assessment?.suite_content_hash === CANONICAL_HASH,
    `${label} suite_content_hash was ${JSON.stringify(assessment?.suite_content_hash)}`
  );
}

function expectDeclaredCapabilities(capabilities, label) {
  assert(capabilities?.prepare === true, `${label} omitted prepare`);
  assert(capabilities?.observation === true, `${label} omitted observation`);
  assert(capabilities?.toolEvents === true, `${label} omitted toolEvents`);
  assert(capabilities?.cleanup === true, `${label} omitted cleanup`);
  assert(capabilities?.multiTurn === false, `${label} overstated multiTurn`);
  assert(
    Array.isArray(capabilities?.observationKeys) &&
      capabilities.observationKeys.join(",") === OBSERVATION_KEYS.join(","),
    `${label} observationKeys were ${JSON.stringify(capabilities?.observationKeys)}`
  );
}

async function ensurePackedBin(temporaryRoot) {
  const provided = process.env.AUGMENTWORKS_PACKED_BIN?.trim();
  if (provided) {
    await access(provided, fsConstants.R_OK);
    return provided;
  }
  process.stdout.write("[packed saved-suite] packing tarball because AUGMENTWORKS_PACKED_BIN is unset\n");
  const packDirectory = join(temporaryRoot, "pack");
  const consumerDirectory = join(temporaryRoot, "install");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  const built = runJsCli("npm", ["run", "build"]);
  assert(built.status === 0, `npm run build failed\n${built.stderr}`);
  const packed = runJsCli("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory]);
  assert(packed.status === 0, `npm pack failed\n${packed.stderr}`);
  const report = parsePackReport(packed.stdout);
  const tarballPath = join(packDirectory, report.filename);
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "augmentworks-cli-packed-saved-suite", private: true, version: "0.0.0" }, null, 2)}\n`,
    "utf8"
  );
  const installed = runJsCli(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballPath],
    { cwd: consumerDirectory }
  );
  assert(installed.status === 0, `npm install tarball failed\n${installed.stderr}`);
  return join(consumerDirectory, "node_modules", "@augmentworks", "cli", "dist", "index.js");
}

function startServer(billing, reports, producer) {
  const requests = [];
  const counts = { quote: 0, create: 0 };
  const executableManifest = savedSuiteManifest(true);
  const incompatibleManifest = savedSuiteManifest(false);
  const reportOrigin = fixtureOrigin(reports);
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    void readBody(request).then((raw) => {
      const body = raw === "" ? undefined : JSON.parse(raw);
      requests.push({ method: request.method ?? "GET", path: url.pathname, body });
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, {
          subject: "user_test",
          email: "developer@example.com",
          workspace_id: WORKSPACE,
          workspace_name: "Test Workspace",
          connector_id: "connector_test",
          connector_name: "Policy Staging",
          scopes: ["connector:identity", "connector:run"]
        });
        return;
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/v1/billing/capabilities" || url.pathname === "/api/v1/billing/capabilities")
      ) {
        send(response, 200, billing.fixtures.eligible_trial.response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/suite-selections/compile") {
        const prepare = body?.capabilities?.prepare === true;
        send(response, 200, prepare ? executableManifest : incompatibleManifest);
        return;
      }
      if (
        request.method === "POST" &&
        (url.pathname === "/v1/billing/quote" || url.pathname === "/api/v1/billing/quote")
      ) {
        counts.quote += 1;
        send(response, 200, billing.fixtures.quote_success_with_balance.response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/relay/runs") {
        counts.create += 1;
        send(response, 200, {
          protocol_version: "aw-relay/0.3",
          create_request_id: body.create_request_id,
          create_request_sha256: sha256(canonicalize(body)),
          create_disposition: "created",
          run_id: RUN_ID,
          session_id: "session-saved-suite",
          packet: { key: "aw-customer-suite", version: "1.0.0", sha256: PACKET_SHA },
          config_sha256: body.config_sha256,
          fencing_epoch: 1,
          status: "completed",
          dashboard_url: `http://127.0.0.1:${httpServer.address().port}/portal/runs/${RUN_ID}`,
          run_expires_at: "2099-09-11T00:00:00.000Z",
          credit_state: "reserved"
        });
        return;
      }
      if (request.method === "GET" && url.pathname === `/v1/relay/runs/${RUN_ID}`) {
        send(response, 200, {
          protocol_version: "aw-relay/0.1",
          run_id: RUN_ID,
          status: "completed",
          credit_state: "reserved",
          outcome: "passed",
          evaluation_status: "complete"
        });
        return;
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/v1/billing/status" || url.pathname === "/api/v1/billing/status")
      ) {
        assert(url.searchParams.get("runId") === RUN_ID, `status queried ${url.search}`);
        send(response, 200, {
          schemaVersion: "aw-billing/1",
          runId: RUN_ID,
          workspaceId: WORKSPACE,
          originalRunId: RUN_ID,
          executionStatus: "completed",
          evaluationStatus: "complete",
          credit: { reservedUnits: 0, consumedUnits: 30, releasedUnits: 0, compensatedUnits: 0 },
          progress: {
            completedAttempts: 2,
            plannedAttempts: 2,
            completedJudgeJobs: 2,
            plannedJudgeJobs: 2
          },
          savedEvidence: true,
          retryEligible: false,
          retryReason: null,
          nextActions: ["inspect", "open_dashboard"],
          dashboardUrl: `http://127.0.0.1:${httpServer.address().port}/portal/runs/${RUN_ID}`,
          asOf: "2026-09-27T20:00:00.000Z",
          outcome: "passed"
        });
        return;
      }
      if (request.method === "GET" && url.pathname === `/v1/relay/runs/${RUN_ID}/report`) {
        const origin = `http://127.0.0.1:${httpServer.address().port}`;
        send(response, 200, rewriteOrigin(reports.fixtures.report_all_pass_one_page.response, reportOrigin, origin));
        return;
      }
      if (request.method === "GET" && /\/criteria\/[^/]+$/u.test(url.pathname)) {
        const origin = `http://127.0.0.1:${httpServer.address().port}`;
        send(response, 200, rewriteOrigin(producer.fixtures.producer_detail_pass.response, reportOrigin, origin));
        return;
      }
      if (request.method === "GET" && url.pathname.includes("/criteria")) {
        const origin = `http://127.0.0.1:${httpServer.address().port}`;
        send(
          response,
          200,
          rewriteOrigin(producer.fixtures.producer_index_one_page_pass.response, reportOrigin, origin)
        );
        return;
      }
      send(response, 404, { error: { code: "NOT_FOUND", message: `${request.method} ${url.pathname}` } });
    });
  });
  return { httpServer, requests, counts };
}

function runPacked(packedBin, args, env, cwd, expectStatus) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [packedBin, ...args], {
      cwd,
      env,
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
      child.kill("SIGKILL");
    }, 60_000);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new FixtureFailure(`Could not run packed CLI ${args.join(" ")}: ${error.message}`));
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (status !== expectStatus) {
        reject(
          new FixtureFailure(
            [
              `packed CLI ${args.join(" ")} exited ${String(status)}${signal ? ` signal=${signal}` : ""}, expected ${String(expectStatus)}`,
              stdout.trim(),
              stderr.trim()
            ]
              .filter(Boolean)
              .join("\n")
          )
        );
        return;
      }
      resolveRun({ status, stdout, stderr });
    });
  });
}

function parseJsonStdout(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new FixtureFailure(
      `${label} stdout was not JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}`
    );
  }
}

function customerEnv(origin, stateDirectory) {
  return {
    ...process.env,
    HOME: stateDirectory,
    USERPROFILE: stateDirectory,
    AUGMENTWORKS_STATE_DIR: stateDirectory,
    AUGMENTWORKS_API_URL: origin,
    AUGMENTWORKS_TOKEN: TOKEN,
    AUGMENTWORKS_API_KEY: "",
    AUGMENTWORKS_REFRESH_TOKEN: "",
    CI: "1",
    NO_COLOR: "1",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    ALL_PROXY: "",
    all_proxy: "",
    NO_PROXY: "*",
    no_proxy: "*"
  };
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "aw-packed-saved-suite-"));
  let httpServer;
  try {
    const packedBin = await ensurePackedBin(temporaryRoot);
    const installedRoot = dirname(dirname(packedBin));
    const installed = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
    const billing = JSON.parse(await readFile(join(projectRoot, "contracts", "aw-billing-v1.fixtures.json"), "utf8"));
    const reports = JSON.parse(await readFile(join(projectRoot, "contracts", "aw-run-report-v1.fixtures.json"), "utf8"));
    const producer = JSON.parse(
      await readFile(join(projectRoot, "contracts", "aw-criterion-detail-read-v1.producer.fixtures.json"), "utf8")
    );
    const fixture = startServer(billing, reports, producer);
    httpServer = fixture.httpServer;
    await new Promise((resolveListen, rejectListen) => {
      httpServer.once("error", rejectListen);
      httpServer.listen(0, "127.0.0.1", resolveListen);
    });
    const origin = `http://127.0.0.1:${httpServer.address().port}`;
    const work = join(temporaryRoot, "work");
    await mkdir(work, { recursive: true });
    await writeFile(join(work, "augmentworks.yaml"), connectorYaml(true), "utf8");
    await writeFile(join(work, "reduced.yaml"), connectorYaml(false), "utf8");
    await writeFile(join(work, "policy.assessment.yaml"), assessmentYaml(), "utf8");

    const initDir = join(temporaryRoot, "init");
    await mkdir(initDir, { recursive: true });
    const init = await runPacked(
      packedBin,
      ["init", "--agent"],
      customerEnv(origin, join(temporaryRoot, "state-init")),
      initDir,
      0
    );
    assert(!init.stdout.includes("node dist/index.js"), "packed init --agent told customers to run node dist/index.js");
    assert(
      init.stdout.includes(`npx --yes @augmentworks/cli@${installed.version}`),
      `packed init --agent did not pin @augmentworks/cli@${installed.version}`
    );
    assert(fixture.counts.create === 0 && fixture.counts.quote === 0, "init --agent quoted or created a run");

    const compiled = await runPacked(
      packedBin,
      ["selection", "compile", "--assessment", "policy.assessment.yaml", "--json"],
      customerEnv(origin, join(temporaryRoot, "state-compile")),
      work,
      0
    );
    const compileRequest = fixture.requests.find(
      (entry) => entry.method === "POST" && entry.path === "/v1/suite-selections/compile"
    );
    assert(compileRequest !== undefined, "packed saved-suite compile did not POST /v1/suite-selections/compile");
    assert(
      compileRequest.body?.acceptedManifestVersions?.join(",") === "aw-suite-selection/2",
      `acceptedManifestVersions were ${JSON.stringify(compileRequest.body?.acceptedManifestVersions)}`
    );
    assert(compileRequest.body?.suiteRevisionId === SUITE_REVISION, "compile omitted the exact suite revision");
    assert(!Object.hasOwn(compileRequest.body ?? {}, "includeCatalog"), "saved-suite compile sent includeCatalog");
    expectDeclaredCapabilities(compileRequest.body?.capabilities, "saved-suite compile");
    const compileJson = parseJsonStdout(compiled.stdout, "compile");
    assert(compileJson.schemaVersion === "aw-suite-selection/2", "compile stdout was not aw-suite-selection/2");
    assert(compileJson.catalogChecksum === null, "saved-suite compile advertised a catalog checksum");
    assert(compileJson.createsBillableRun === false, "compile advertised a billable run");
    assert(fixture.counts.quote === 0 && fixture.counts.create === 0, "compile quoted or created a run");

    const beforeReduced = fixture.requests.length;
    const reduced = await runPacked(
      packedBin,
      ["selection", "compile", "--config", "reduced.yaml", "--assessment", "policy.assessment.yaml", "--json"],
      customerEnv(origin, join(temporaryRoot, "state-reduced")),
      work,
      2
    );
    const reducedRequest = fixture.requests
      .slice(beforeReduced)
      .find((entry) => entry.method === "POST" && entry.path === "/v1/suite-selections/compile");
    assert(
      reducedRequest !== undefined,
      `reduced-capability compile did not reach the server\n${reduced.stderr}`
    );
    assert(reducedRequest.body?.capabilities?.prepare === false, "reduced connector overstated prepare");
    assert(reducedRequest.body?.capabilities?.observation === false, "reduced connector overstated observation");
    assert(reducedRequest.body?.capabilities?.cleanup === false, "reduced connector overstated cleanup");
    assert(
      Array.isArray(reducedRequest.body?.capabilities?.observationKeys) &&
        reducedRequest.body.capabilities.observationKeys.length === 0,
      "reduced connector advertised observation keys"
    );
    assert(
      reduced.stderr.includes("SELECTION_UNEXECUTABLE"),
      "missing prepare did not surface SELECTION_UNEXECUTABLE"
    );
    assert(fixture.counts.quote === 0 && fixture.counts.create === 0, "incompatible compile quoted or created a run");

    const estimate = await runPacked(
      packedBin,
      ["test", "--assessment", "policy.assessment.yaml", "--estimate", "--json"],
      customerEnv(origin, join(temporaryRoot, "state-estimate")),
      work,
      0
    );
    const estimateJson = parseJsonStdout(estimate.stdout, "estimate");
    assert(estimateJson.estimateOnly === true, "estimate was not estimate-only");
    assert(fixture.counts.quote === 1, `estimate created ${String(fixture.counts.quote)} quotes`);
    assert(fixture.counts.create === 0, "estimate created a run");
    const quoteBody = fixture.requests.filter((entry) => entry.path.endsWith("/billing/quote")).at(-1);
    expectSuiteTriple(quoteBody?.body?.assessment, "estimate quote");

    const created = await runPacked(
      packedBin,
      ["test", "--assessment", "policy.assessment.yaml", "--max-credits", "30", "--yes", "--json"],
      customerEnv(origin, join(temporaryRoot, "state-create")),
      work,
      0
    );
    const createdJson = parseJsonStdout(created.stdout, "bounded create");
    assert(createdJson.run_id === RUN_ID, `bounded execution run_id was ${String(createdJson.run_id)}`);
    assert(fixture.counts.quote === 2, `bounded execution used ${String(fixture.counts.quote)} quotes`);
    assert(fixture.counts.create === 1, `bounded execution created ${String(fixture.counts.create)} runs`);
    const createBody = fixture.requests.find((entry) => entry.method === "POST" && entry.path === "/v1/relay/runs");
    expectSuiteTriple(createBody?.body?.assessment, "create");
    assert(createBody?.body?.quote_id === QUOTE_ID, `create quote_id was ${String(createBody?.body?.quote_id)}`);
    assert(createBody?.body?.max_credits === 30, `create max_credits was ${String(createBody?.body?.max_credits)}`);
    assert(
      canonicalize(quoteBody.body.assessment) === canonicalize(createBody.body.assessment),
      "estimate and create did not forward the same suite triple"
    );

    const createsBeforeRead = fixture.counts.create;
    const quotesBeforeRead = fixture.counts.quote;
    const status = await runPacked(
      packedBin,
      ["run", "status", RUN_ID, "--json"],
      customerEnv(origin, join(temporaryRoot, "state-status")),
      work,
      0
    );
    const statusJson = parseJsonStdout(status.stdout, "run status");
    assert(statusJson.originalRunId === RUN_ID, "run status did not keep the original run");
    assert(statusJson.runId === RUN_ID, "run status runId mismatch");
    assert(statusJson.evaluationStatus === "complete", "run status evaluation was not complete");
    assert(statusJson.outcome === "passed", "run status outcome was not passed");

    const report = await runPacked(
      packedBin,
      ["run", "report", RUN_ID, "--json"],
      customerEnv(origin, join(temporaryRoot, "state-report")),
      work,
      0
    );
    const reportJson = parseJsonStdout(report.stdout, "run report");
    assert(reportJson.retrieved === true, "run report was not retrieved");
    assert(reportJson.complete === true, "run report was incomplete");
    assert(reportJson.report?.runId === RUN_ID, "run report did not return the original run");
    assert(reportJson.createsBillableRun !== true, "run report advertised a billable run");
    assert(
      fixture.requests.some((entry) => entry.method === "GET" && entry.path === `/v1/relay/runs/${RUN_ID}/report`),
      "run report did not GET the original report"
    );
    assert(fixture.counts.create === createsBeforeRead, "status/report created another run");
    assert(fixture.counts.quote === quotesBeforeRead, "status/report requested another quote");
    assert(!compiled.stdout.includes(TOKEN) && !report.stdout.includes(TOKEN), "fixture token leaked into stdout");

    process.stdout.write(
      `[packed saved-suite] installed @augmentworks/cli@${installed.version} forwarded revision ${SUITE_REVISION} hash ${CANONICAL_HASH}, estimate-only, max-credits 30, and original run ${RUN_ID}\n`
    );
  } finally {
    if (httpServer !== undefined) {
      await new Promise((resolveClose) => httpServer.close(() => resolveClose()));
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
