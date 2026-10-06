#!/usr/bin/env node

/**
 * Packed-binary HTTP fixture for hosted report export completeness (AUG-54 / AUG-59),
 * producer-shaped criterion index/detail bodies (AUG-64), and consumer consistency
 * for internally contradictory exports (AUG-272).
 *
 * Invokes the installed CLI in an isolated HOME/state directory against a
 * loopback report API. This is not proof that the hosted report endpoint is
 * deployed; it proves the packed binary's command registration, JSON-only
 * stdout, API-key mode without a keychain, read-only GET export against the
 * actual producer criterion wire (items/nextCursor/document/inspection), and
 * fail-closed handling of omitted attempts and mixed-workspace pages.
 */

import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = "aw_api_packed_report_fixture_key_value";
const CANONICAL_ORIGIN = "https://augmentworks.ai";

class FixtureFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "FixtureFailure";
  }
}

function assert(condition, message) {
  if (!condition) throw new FixtureFailure(message);
}

function rewriteOrigin(value, origin) {
  if (typeof value === "string") return value.split(CANONICAL_ORIGIN).join(origin);
  if (Array.isArray(value)) return value.map((item) => rewriteOrigin(item, origin));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rewriteOrigin(child, origin)])
    );
  }
  return value;
}

async function loadFixtures() {
  return JSON.parse(
    await readFile(resolve(projectRoot, "contracts/aw-run-report-v1.fixtures.json"), "utf8")
  );
}

async function loadProducerFixtures() {
  return JSON.parse(
    await readFile(
      resolve(projectRoot, "contracts/aw-criterion-detail-read-v1.producer.fixtures.json"),
      "utf8"
    )
  );
}

function fixtureNamed(fixtures, name, origin) {
  const entry = fixtures.fixtures[name];
  if (entry === undefined) throw new FixtureFailure(`missing fixture ${name}`);
  return {
    status: entry.status,
    body: rewriteOrigin(entry.response, origin)
  };
}

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function cloneMutate(fixtures, name, origin, mutate) {
  const fixture = fixtureNamed(fixtures, name, origin);
  const body = JSON.parse(JSON.stringify(fixture.body));
  mutate(body);
  return { status: fixture.status, body };
}

function startFixtureServer(fixtures, producer) {
  const requests = [];
  const state = { scenario: "fail" };
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const origin = `http://127.0.0.1:${httpServer.address().port}`;
    requests.push(`${request.method ?? "GET"} ${url.pathname}`);
    if (request.method !== "GET") {
      send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "report fixture is GET-only" } });
      return;
    }
    if (url.pathname === "/api/v1/cli/auth/me") {
      send(response, 200, fixtures.identities.machine_report_only);
      return;
    }
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    if (url.pathname === `/v1/relay/runs/${runId}/report`) {
      if (state.scenario === "omitted") {
        const fixture = cloneMutate(fixtures, "report_all_pass_one_page", origin, (body) => {
          body.page.totalAttempts = 2;
          body.coverage.plannedAttempts = 2;
          body.coverage.completedAttempts = 2;
          body.coverage.requiredJudgmentsPlanned = 2;
          body.coverage.requiredJudgmentsComplete = 2;
          body.aggregate = { passed: 2, failed: 0, error: 0 };
        });
        send(response, fixture.status, fixture.body);
        return;
      }
      if (state.scenario === "mismatch") {
        const fixture = cloneMutate(fixtures, "report_all_pass_one_page", origin, (body) => {
          body.workspaceId = "22222222-2222-4222-8222-222222222222";
        });
        send(response, fixture.status, fixture.body);
        return;
      }
      if (state.scenario === "contradiction") {
        const fixture = cloneMutate(fixtures, "report_required_fail", origin, (body) => {
          body.outcome = "passed";
        });
        send(response, fixture.status, fixture.body);
        return;
      }
      if (state.scenario === "coverage") {
        const fixture = cloneMutate(fixtures, "report_all_pass_one_page", origin, (body) => {
          body.attempts = [];
          body.page.totalAttempts = 0;
        });
        send(response, fixture.status, fixture.body);
        return;
      }
      if (state.scenario === "required-count") {
        const fixture = cloneMutate(fixtures, "report_all_pass_one_page", origin, (body) => {
          body.coverage.requiredJudgmentsPlanned = 2;
          body.coverage.requiredJudgmentsComplete = 2;
        });
        send(response, fixture.status, fixture.body);
        return;
      }
      if (state.scenario === "aggregate") {
        const fixture = cloneMutate(fixtures, "report_all_pass_one_page", origin, (body) => {
          body.aggregate = { passed: 1, failed: 1, error: 0 };
        });
        send(response, fixture.status, fixture.body);
        return;
      }
      if (state.scenario === "attempt-outcome") {
        const fixture = cloneMutate(fixtures, "report_all_pass_one_page", origin, (body) => {
          body.attempts[0].outcome = "fail";
          body.attempts[0].cleanupState = "failed";
        });
        send(response, fixture.status, fixture.body);
        return;
      }
      if (state.scenario === "pass" || state.scenario === "advisory") {
        const fixture = fixtureNamed(fixtures, "report_all_pass_one_page", origin);
        send(response, fixture.status, fixture.body);
        return;
      }
      const fixture = fixtureNamed(fixtures, "report_required_fail", origin);
      send(response, fixture.status, fixture.body);
      return;
    }
    const passCriteria =
      state.scenario === "pass" ||
      state.scenario === "required-count" ||
      state.scenario === "aggregate" ||
      state.scenario === "advisory" ||
      state.scenario === "attempt-outcome";
    if (/\/criteria\/[^/]+$/u.test(url.pathname)) {
      const fixture = fixtureNamed(
        producer,
        passCriteria ? "producer_detail_pass" : "producer_detail_fail",
        origin
      );
      send(response, fixture.status, fixture.body);
      return;
    }
    if (url.pathname.includes("/criteria")) {
      if (state.scenario === "advisory") {
        const fixture = cloneMutate(producer, "producer_index_one_page_pass", origin, (body) => {
          body.totalInAttempt = 2;
          body.items.push({
            criterionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            criterionKey: "response-quality/0.1.0/R01/clarity",
            requirement: "advisory",
            verdict: "fail",
            evidence: {
              availability: "available",
              text: "Unused items in the synthetic catalog can be returned within 30 days.",
              sha256: "bd7d016faddf1a2ac2ff94925651800c0d7a790c8577b0d5756a8c893a286be7",
              truncated: false
            }
          });
        });
        send(response, fixture.status, fixture.body);
        return;
      }
      const fixture = fixtureNamed(
        producer,
        passCriteria ? "producer_index_one_page_pass" : "producer_index_one_page_fail",
        origin
      );
      send(response, fixture.status, fixture.body);
      return;
    }
    send(response, 404, { error: { code: "NOT_FOUND", message: "missing packed report fixture route" } });
  });
  return { httpServer, requests, state };
}

function startPacked(packedBin, args, env, cwd) {
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
  const closed = new Promise((resolveClose, reject) => {
    child.once("error", (error) => {
      reject(new FixtureFailure(`Could not run packed CLI ${args.join(" ")}: ${error.message}`));
    });
    child.once("close", (status, signal) => {
      resolveClose({ status, stdout, stderr, signal });
    });
  });
  return {
    closed,
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already have exited.
      }
    }
  };
}

function runPacked(packedBin, args, env, cwd, expectStatus, requests) {
  return new Promise((resolveRun, reject) => {
    const started = startPacked(packedBin, args, env, cwd);
    const timeout = setTimeout(() => {
      started.kill();
    }, 60_000);
    timeout.unref();
    started.closed.then(
      (result) => {
        clearTimeout(timeout);
        if (result.status !== expectStatus) {
          reject(
            new FixtureFailure(
              [
                `packed CLI ${args.join(" ")} exited ${String(result.status)}${result.signal ? ` signal=${result.signal}` : ""}, expected ${String(expectStatus)}`,
                result.stdout.trim(),
                result.stderr.trim(),
                requests === undefined ? "" : `requests=${requests.join(" | ")}`
              ]
                .filter(Boolean)
                .join("\n")
            )
          );
          return;
        }
        resolveRun(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
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

function assertInconsistency(payload, code) {
  assert(Array.isArray(payload.diagnostics), `${code} diagnostics missing`);
  const diagnostic = payload.diagnostics.find((item) => item.code === code);
  assert(diagnostic !== undefined, `missing ${code}`);
  const message = String(diagnostic.message ?? "");
  assert(!message.includes("365 days"), `${code} leaked evidence text`);
  assert(!message.includes("30 days"), `${code} leaked evidence text`);
  assert(!message.includes(API_KEY), `${code} leaked the API key`);
  assert(!/https?:\/\//u.test(message), `${code} leaked a URL`);
  assert(
    message.toLowerCase().includes("cannot be used as a passing release check"),
    `${code} omitted release-check recovery`
  );
  assert(
    message.toLowerCase().includes("do not start another billed assessment"),
    `${code} omitted same-read recovery`
  );
}

function assertReadOnly(label, result, requests) {
  assert(result.stdout.trim().startsWith("{"), `${label} stdout was not JSON-only`);
  assert(!result.stdout.includes(API_KEY), `${label} leaked the API key on stdout`);
  assert(!result.stderr.includes(API_KEY), `${label} leaked the API key on stderr`);
  assert(
    requests.every((item) => item.startsWith("GET ")),
    `${label} issued a non-GET: ${requests.join(" | ")}`
  );
  assert(!requests.some((item) => item.includes("quote")), `${label} quoted billing`);
  assert(!requests.some((item) => item.includes("retry-evaluation")), `${label} retried grading`);
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "aw-packed-report-"));
  const fixtures = await loadFixtures();
  const producer = await loadProducerFixtures();
  let httpServer;
  try {
    const packedBin = process.env.AUGMENTWORKS_PACKED_BIN;
    assert(
      typeof packedBin === "string" && packedBin.length > 0 && existsSync(packedBin),
      "AUGMENTWORKS_PACKED_BIN must point at the installed dist/index.js"
    );
    await access(packedBin, fsConstants.R_OK);

    const fixture = startFixtureServer(fixtures, producer);
    httpServer = fixture.httpServer;
    await new Promise((resolveListen) => httpServer.listen(0, "127.0.0.1", resolveListen));
    const port = httpServer.address().port;
    const origin = `http://127.0.0.1:${port}/`;
    const isolatedHome = join(temporaryRoot, "home");
    const isolatedState = join(temporaryRoot, "state");
    const cwd = join(temporaryRoot, "cwd");
    await Promise.all([
      mkdir(isolatedHome, { recursive: true }),
      mkdir(isolatedState, { recursive: true }),
      mkdir(cwd, { recursive: true })
    ]);

    const env = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      LOCALAPPDATA: join(isolatedHome, "AppData", "Local"),
      APPDATA: join(isolatedHome, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      XDG_STATE_HOME: join(isolatedState, "xdg"),
      AUGMENTWORKS_STATE_DIR: isolatedState,
      DBUS_SESSION_BUS_ADDRESS: "",
      AUGMENTWORKS_API_URL: origin,
      AUGMENTWORKS_API_KEY: API_KEY,
      AUGMENTWORKS_TOKEN: "",
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

    const help = await runPacked(packedBin, ["run", "report", "--help"], env, cwd, 0);
    assert(help.stdout.includes("--json"), "packed run report help omitted --json");
    assert(help.stdout.includes("aw-run-report-export/1") || help.stdout.includes("report"), "packed run report help omitted report export");

    const conflict = await runPacked(
      packedBin,
      ["run", "report", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--json"],
      { ...env, AUGMENTWORKS_TOKEN: "aw_connector_conflicting_token_value" },
      cwd,
      3
    );
    const conflictPayload = parseJsonStdout(conflict.stdout, "env conflict");
    assert(conflictPayload.schemaVersion === "aw-run-report-export/1", "conflict export schema is wrong");
    assert(conflictPayload.retrieved === false, "env conflict retrieved true");
    assert(conflictPayload.complete === false, "env conflict complete true");
    assert(conflictPayload.error?.code === "AUTH_ENV_CONFLICT", `conflict code was ${String(conflictPayload.error?.code)}`);
    assert(!conflict.stdout.includes(API_KEY), "API key leaked into conflict stdout");
    assert(
      fixture.requests.every((item) => !item.startsWith("POST ")),
      "env conflict issued a mutating request"
    );

    const failed = await runPacked(
      packedBin,
      ["run", "report", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--json"],
      env,
      cwd,
      10
    );
    const payload = parseJsonStdout(failed.stdout, "failed report");
    assert(payload.schemaVersion === "aw-run-report-export/1", "failed export schema is wrong");
    assert(payload.retrieved === true, "failed report was not retrieved");
    assert(payload.complete === true, "failed report was incomplete");
    assert(payload.report?.outcome === "failed", "negative-control outcome was not failed");
    assert(payload.criteria?.[0]?.verdict === "fail", "producer criterion verdict was not fail");
    assert(
      payload.criteria?.[0]?.evidence?.availability === "available",
      "producer criterion evidence was not retained"
    );
    assert(payload.criteria?.[0]?.evidence?.text?.includes("365 days"), "producer fail evidence text was dropped");
    assert(failed.stdout.trim().startsWith("{"), "report stdout was not JSON-only object");
    assert(!failed.stdout.includes(API_KEY), "API key leaked into report stdout");
    assert(
      fixture.requests.includes("GET /api/v1/cli/auth/me"),
      "packed report did not call /me"
    );
    assert(
      fixture.requests.includes("GET /v1/relay/runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/report"),
      "packed report did not GET the hosted report"
    );
    assert(
      fixture.requests.includes(
        "GET /v1/runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/evaluations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/attempts/cccccccc-cccc-4ccc-8ccc-cccccccccccc/criteria"
      ),
      "packed report did not GET the producer criterion index"
    );
    assert(
      fixture.requests.includes(
        "GET /v1/runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/evaluations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/attempts/cccccccc-cccc-4ccc-8ccc-cccccccccccc/criteria/dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      ),
      "packed report did not GET the nested producer criterion detail"
    );
    assert(
      fixture.requests.every((item) => item.startsWith("GET ")),
      `packed report issued a non-GET: ${fixture.requests.join(" | ")}`
    );
    assert(!fixture.requests.some((item) => item.includes("quote")), "packed report quoted billing");
    assert(!fixture.requests.some((item) => item.includes("retry-evaluation")), "packed report retried grading");

    fixture.state.scenario = "pass";
    const passed = await runPacked(
      packedBin,
      ["run", "report", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--json"],
      env,
      cwd,
      0,
      fixture.requests
    );
    const passedPayload = parseJsonStdout(passed.stdout, "coherent pass");
    assert(passedPayload.retrieved === true, "coherent pass was not retrieved");
    assert(passedPayload.complete === true, "coherent pass was incomplete");
    assert(passedPayload.report?.outcome === "passed", "coherent pass outcome changed");
    assert(passedPayload.criteria?.[0]?.verdict === "pass", "coherent pass verdict changed");
    assert(passedPayload.diagnostics.length === 0, "coherent pass gained diagnostics");
    assertReadOnly("coherent pass", passed, fixture.requests);

    fixture.state.scenario = "contradiction";
    const contradicted = await runPacked(
      packedBin,
      ["run", "report", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--json"],
      env,
      cwd,
      11,
      fixture.requests
    );
    const contradictedPayload = parseJsonStdout(contradicted.stdout, "claimed pass contradiction");
    assert(contradictedPayload.retrieved === true, "contradiction was not retrieved");
    assert(contradictedPayload.complete === false, "contradiction export was complete");
    assert(contradictedPayload.report?.outcome === "passed", "contradiction outcome was rewritten");
    assert(contradictedPayload.criteria?.[0]?.verdict === "fail", "required fail verdict was dropped");
    assert(
      contradictedPayload.criteria?.[0]?.evidence?.text?.includes("365 days"),
      "required fail evidence was rewritten"
    );
    assertInconsistency(contradictedPayload, "REPORT_EVIDENCE_CONTRADICTION");
    assert(
      !contradictedPayload.diagnostics.some((item) => item.code === "REPORT_COVERAGE_MISMATCH"),
      "contradiction was mislabeled as coverage mismatch"
    );
    assert(
      contradicted.stderr.toLowerCase().includes("cannot be used as a passing release check"),
      "contradiction stderr omitted the release-check explanation"
    );
    assert(
      contradicted.stderr.toLowerCase().includes("do not start another billed assessment"),
      "contradiction stderr omitted recovery guidance"
    );
    assertReadOnly("contradiction", contradicted, fixture.requests);

    fixture.state.scenario = "coverage";
    const coverage = await runPacked(
      packedBin,
      ["run", "report", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--json"],
      env,
      cwd,
      11,
      fixture.requests
    );
    const coveragePayload = parseJsonStdout(coverage.stdout, "coverage mismatch");
    assert(coveragePayload.retrieved === true, "coverage mismatch was not retrieved");
    assert(coveragePayload.complete === false, "coverage mismatch export was complete");
    assert(Array.isArray(coveragePayload.report?.attempts) && coveragePayload.report.attempts.length === 0, "empty attempts were invented");
    assert(coveragePayload.report?.coverage?.completedAttempts === 1, "coverage counters were rewritten");
    assert(coveragePayload.report?.page?.totalAttempts === 0, "agreeing page total was rewritten");
    assertInconsistency(coveragePayload, "REPORT_COVERAGE_MISMATCH");
    assert(
      !coveragePayload.diagnostics.some((item) => item.code === "REPORT_TOTAL_BOUNDS"),
      "zero page total was treated as a page-bounds failure"
    );
    assert(
      coverage.stderr.toLowerCase().includes("cannot be used as a passing release check"),
      "coverage stderr omitted the release-check explanation"
    );
    assertReadOnly("coverage mismatch", coverage, fixture.requests);

    fixture.state.scenario = "required-count";
    const requiredCount = await runPacked(
      packedBin,
      ["run", "report", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--json"],
      env,
      cwd,
      11,
      fixture.requests
    );
    const requiredCountPayload = parseJsonStdout(requiredCount.stdout, "required-count mismatch");
    assert(requiredCountPayload.complete === false, "required-count mismatch was complete");
    assert(requiredCountPayload.criteria?.length === 1, "required-count fixture did not keep the retrieved judgment");
    assertInconsistency(requiredCountPayload, "REPORT_COVERAGE_MISMATCH");
    assertReadOnly("required-count mismatch", requiredCount, fixture.requests);

    fixture.state.scenario = "aggregate";
    const aggregate = await runPacked(
      packedBin,
      ["run", "report", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--json"],
      env,
      cwd,
      11,
      fixture.requests
    );
    const aggregatePayload = parseJsonStdout(aggregate.stdout, "aggregate contradiction");
    assert(aggregatePayload.complete === false, "aggregate contradiction was complete");
    assert(aggregatePayload.report?.outcome === "passed", "aggregate contradiction rewrote outcome");
    assert(aggregatePayload.criteria?.[0]?.verdict === "pass", "aggregate contradiction rewrote the required pass");
    assertInconsistency(aggregatePayload, "REPORT_EVIDENCE_CONTRADICTION");
    assertReadOnly("aggregate contradiction", aggregate, fixture.requests);

    fixture.state.scenario = "advisory";
    const advisory = await runPacked(
      packedBin,
      ["run", "report", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--json"],
      env,
      cwd,
      0,
      fixture.requests
    );
    const advisoryPayload = parseJsonStdout(advisory.stdout, "advisory fail");
    assert(advisoryPayload.complete === true, "advisory fail became incomplete");
    assert(advisoryPayload.report?.outcome === "passed", "advisory fail changed the claimed pass");
    assert(
      advisoryPayload.criteria?.some((item) => item.required === true && item.verdict === "pass"),
      "advisory fixture lost the required pass"
    );
    assert(
      advisoryPayload.criteria?.some((item) => item.required === false && item.verdict === "fail"),
      "advisory fail was promoted to a required failure"
    );
    assert(advisoryPayload.diagnostics.length === 0, "advisory fail gained diagnostics");
    assertReadOnly("advisory fail", advisory, fixture.requests);

    fixture.state.scenario = "attempt-outcome";
    const attemptOutcome = await runPacked(
      packedBin,
      ["run", "report", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--json"],
      env,
      cwd,
      0,
      fixture.requests
    );
    const attemptOutcomePayload = parseJsonStdout(attemptOutcome.stdout, "attempt outcome");
    assert(attemptOutcomePayload.complete === true, "attempt execution outcome became incomplete");
    assert(attemptOutcomePayload.report?.outcome === "passed", "attempt execution outcome changed the report pass");
    assert(attemptOutcomePayload.report?.attempts?.[0]?.outcome === "fail", "attempt outcome was rewritten");
    assert(attemptOutcomePayload.criteria?.[0]?.verdict === "pass", "attempt outcome was treated as a semantic fail");
    assert(attemptOutcomePayload.diagnostics.length === 0, "attempt execution outcome gained diagnostics");
    assertReadOnly("attempt outcome", attemptOutcome, fixture.requests);

    fixture.state.scenario = "omitted";
    const omitted = await runPacked(
      packedBin,
      ["run", "report", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--json"],
      env,
      cwd,
      11
    );
    const omittedPayload = parseJsonStdout(omitted.stdout, "omitted attempt");
    assert(omittedPayload.schemaVersion === "aw-run-report-export/1", "omitted export schema is wrong");
    assert(omittedPayload.retrieved === true, "omitted report was not retrieved");
    assert(omittedPayload.complete === false, "omitted attempt export was complete");
    assert(
      Array.isArray(omittedPayload.diagnostics) &&
        omittedPayload.diagnostics.some((item) => item.code === "REPORT_TOTAL_BOUNDS"),
      "omitted attempt lacked REPORT_TOTAL_BOUNDS"
    );
    assert(omitted.stdout.trim().startsWith("{"), "omitted stdout was not JSON-only object");
    assert(!omitted.stdout.includes(API_KEY), "API key leaked into omitted stdout");
    assert(
      omitted.stderr.toLowerCase().includes("do not start another billed assessment"),
      "omitted stderr omitted recovery guidance"
    );
    assert(!omitted.stderr.includes(API_KEY), "API key leaked into omitted stderr");

    fixture.state.scenario = "mismatch";
    const mismatched = await runPacked(
      packedBin,
      ["run", "report", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--json"],
      env,
      cwd,
      4
    );
    const mismatchPayload = parseJsonStdout(mismatched.stdout, "workspace mismatch");
    assert(mismatchPayload.retrieved === false, "workspace mismatch retrieved true");
    assert(mismatchPayload.complete === false, "workspace mismatch complete true");
    assert(
      mismatchPayload.error?.code === "REPORT_WORKSPACE_MISMATCH",
      `workspace mismatch code was ${String(mismatchPayload.error?.code)}`
    );
    assert(!mismatched.stdout.includes(API_KEY), "API key leaked into mismatch stdout");
    assert(
      mismatched.stderr.toLowerCase().includes("do not start another billed assessment"),
      "mismatch stderr omitted recovery guidance"
    );
    assertReadOnly("packed report matrix", mismatched, fixture.requests);

    process.stdout.write(
      `[packed report fixture] passed (requests=${fixture.requests.length}, source=producer aw-criterion-detail-read/1 @ 8068a90 + AW-QA-1 report)\n`
    );
  } finally {
    if (httpServer !== undefined) {
      await new Promise((resolveClose) => httpServer.close(() => resolveClose()));
    }
    if (process.env.AUGMENTWORKS_KEEP_SMOKE_TMP === "1") {
      process.stdout.write(`[packed report fixture] retained ${temporaryRoot}\n`);
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[packed report fixture] ${message}\n`);
  process.exitCode = 1;
});
