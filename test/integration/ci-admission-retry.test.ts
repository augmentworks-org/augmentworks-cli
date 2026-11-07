import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { CreateRunRequestV3Schema } from "../../src/cloud/protocol.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import {
  CANONICAL_HASH,
  savedSuiteManifest,
  SUITE_ID,
  SUITE_REVISION,
  WORKSPACE
} from "../selection/saved-suite-fixtures.js";
import { runSourceCli } from "../util/cli-process.js";
import { listenLoopback, readJsonBody, sendJson } from "../util/http-server.js";

const billing = JSON.parse(
  await readFile(new URL("../../contracts/aw-billing-v1.fixtures.json", import.meta.url), "utf8")
) as { fixtures: Record<string, { response: Record<string, unknown> }> };
const quoteId = "55555555-5555-4555-8555-555555555555";
const runId = "88888888-8888-4888-8888-888888888888";
const key = "crq_ci_return_window_rehearsal_00001";
const cap = 8;
const admissionId = "00000000-0000-4000-8000-000000000016";

test("a fresh CI job recovers its admitted run after the server commits and drops the create response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aw-ci-retry-"));
  const targetServer = createServer();
  let targetConnections = 0;
  targetServer.on("connection", (socket) => {
    targetConnections++;
    socket.destroy();
  });
  const target = await listenLoopback(targetServer);
  const targetOrigin = target.baseUrl.replace("http:", "https:");
  const requests: string[] = [];
  let storedHash: string | undefined;
  let quoteUsable = true;
  let legacyRelay = true;
  let reservations = 0;
  const createHashes: string[] = [];
  const relayEvents: string[] = [];
  const fixtureErrors: unknown[] = [];
  let relayOrigin: string;

  const relay = await listenLoopback(
    createServer((request, response) => {
      async function handle() {
        const path = new URL(request.url!, "http://relay.invalid").pathname;
        requests.push(request.method + " " + path);
        expect(request.headers.authorization).toBe("Bearer ci-machine-key");
        if (path === "/api/v1/cli/auth/me") {
          return sendJson(response, 200, {
            subject: "machine-ci",
            principal_kind: "machine",
            credential_id: "fixture-ci",
            workspace_id: WORKSPACE,
            connector_id: "connector-ci",
            scopes: ["connector:identity", "connector:run"],
            actions: [
              "run:execute",
              "run:read",
              "suite:read",
              "billing:read",
              "evaluation:read",
              "criterion_detail:read"
            ]
          });
        }
        if (path === `/v1/suites/${SUITE_ID}/revisions/${SUITE_REVISION}`) {
          return sendJson(response, 200, {
            suiteId: SUITE_ID,
            revisionId: SUITE_REVISION,
            contentHash: CANONICAL_HASH,
            workspaceId: WORKSPACE,
            canonicalDocument: { schemaVersion: "aw-customer-suite/1" }
          });
        }
        if (path === "/v1/billing/capabilities")
          return sendJson(response, 200, billing.fixtures["eligible_trial"]!.response);
        if (path === "/v1/billing/quote") {
          expect(quoteUsable, "retry requested a replacement quote").toBe(true);
          return sendJson(response, 200, {
            ...billing.fixtures["quote_success_with_balance"]!.response,
            quoteId,
            executionUnits: 4,
            expiresAt: new Date(Date.now() + 120_000).toISOString()
          });
        }
        if (request.method === "POST" && path === "/v1/relay/run-intents:reconcile") {
          const body = (await readJsonBody(request)) as Record<string, unknown>;
          const hash = body["create_request_sha256"];
          expect(body).toEqual({
            create_request_id: key,
            create_request_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
          });
          if (storedHash !== undefined && hash !== storedHash) {
            relayEvents.push("conflict");
            return sendJson(response, 409, {
              error: { code: "CREATE_REQUEST_CONFLICT", message: "Intent conflict" }
            });
          }
          const found = storedHash !== undefined;
          relayEvents.push(found ? "lookup:bound" : "lookup:unknown");
          return sendJson(response, 200, {
            protocol_version: "aw-relay-recovery/0.1",
            outcome: found ? "bound" : "unknown",
            create_request_id: key,
            create_request_sha256: hash,
            run_id: found ? runId : null,
            next_action: found ? "inspect_or_resume_existing_run" : "preserve_local_intent_and_retry",
            dashboard_url: found ? `${relayOrigin}/portal/runs/${runId}` : null
          });
        }
        if (request.method === "POST" && path === "/v1/relay/runs") {
          const raw = await readJsonBody(request);
          if (legacyRelay && raw && typeof raw === "object" && "ci_admission_id" in raw) {
            // The pre-admission v0.3 relay rejects unknown fields before billing.
            relayEvents.push("legacy:rejected");
            return sendJson(response, 400, {
              error: { code: "INVALID_REQUEST", message: "Unsupported field" }
            });
          }
          const body = CreateRunRequestV3Schema.parse(raw);
          expect(request.headers["idempotency-key"]).toBe(key);
          expect(body).toMatchObject({
            create_request_id: key,
            ci_admission_id: admissionId,
            quote_id: quoteId,
            max_credits: cap,
            assessment: { suite_revision_id: SUITE_REVISION }
          });
          const hash = sha256(canonicalize(body));
          createHashes.push(hash);
          if (storedHash === undefined) {
            if (!quoteUsable)
              return sendJson(response, 409, {
                error: { code: "QUOTE_EXPIRED", message: "Quote expired" }
              });
            storedHash = hash;
            reservations++;
            quoteUsable = false;
            relayEvents.push("commit");
            // Server committed. The first process never sees a binding, even in memory.
            response.destroy();
            return;
          }
          expect(hash).toBe(storedHash);
          relayEvents.push("replay");
          return sendJson(response, 200, {
            protocol_version: "aw-relay/0.3",
            create_request_id: key,
            create_request_sha256: hash,
            create_disposition: "replayed",
            run_id: runId,
            session_id: "session-ci",
            packet: { ...body.packet, sha256: "2".repeat(64) },
            config_sha256: body.config_sha256,
            fencing_epoch: 1,
            // Idempotent replay can return the original acknowledgement, even after the run finishes.
            status: "queued",
            dashboard_url: `${relayOrigin}/portal/runs/${runId}`,
            run_expires_at: new Date(Date.now() + 60_000).toISOString(),
            credit_state: "released"
          });
        }
        if (path === `/v1/relay/runs/${runId}`) {
          return sendJson(response, 200, {
            protocol_version: "aw-relay/0.1",
            run_id: runId,
            status: "completed",
            outcome: "passed",
            credit_state: "released",
            evaluation_status: "complete",
            dashboard_url: `${relayOrigin}/portal/runs/${runId}`
          });
        }
        throw new Error(`Unexpected request ${request.method} ${path}`);
      }
      void handle().catch((error: unknown) => {
        fixtureErrors.push(error);
        if (!response.destroyed && !response.headersSent) {
          sendJson(response, 500, {
            error: { code: "FIXTURE_FAILED", message: "Unexpected fixture request" }
          });
        }
      });
    })
  );
  relayOrigin = relay.baseUrl;

  try {
    const base = ["test", "--manifest", "suite.json", "--shard", "shard-000", "--json", "--headless"];
    const linked = [...base, "--ci-admission", "admission.json", "--yes", "--max-credits"];
    const env = (state: string) => ({
      AUGMENTWORKS_API_KEY: "ci-machine-key",
      AUGMENTWORKS_TOKEN: "",
      AUGMENTWORKS_API_URL: relayOrigin,
      AUGMENTWORKS_STATE_DIR: join(dir, state),
      CHATBOT_BASE_URL: targetOrigin
    });
    await writeFile(
      join(dir, "augmentworks.yaml"),
      [
        "version: 1",
        "target:",
        "  name: ci",
        "  connector: http",
        "  base_url: ${CHATBOT_BASE_URL}",
        "  operations:",
        "    send:",
        "      method: POST",
        "      path: /chat",
        "      request: $input"
      ].join("\n")
    );
    await writeFile(join(dir, "suite.json"), JSON.stringify(savedSuiteManifest()));
    const estimated = await runSourceCli([...base, "--estimate"], { cwd: dir, env: env("estimate") });
    expect(estimated.exitCode, estimated.stderr + estimated.stdout).toBe(0);
    const estimate = JSON.parse(estimated.stdout);
    expect(estimate.execution_plan_digest).toMatch(/^[0-9a-f]{64}$/);
    const admission = {
      schemaVersion: "aw-github-integration/1",
      admissionId,
      bindingId: "00000000-0000-4000-8000-000000000001",
      createRequestId: key,
      suiteRevisionId: SUITE_REVISION,
      quoteId: estimate.quoteId,
      maxCredits: cap,
      executionPlanDigest: estimate.execution_plan_digest,
      target: { kind: "fixed", origin: targetOrigin },
      runId: null,
      baselineId: null,
      operationId: null
    };
    await writeFile(join(dir, "admission.json"), JSON.stringify(admission), { mode: 0o600 });
    // An unconfirmed run UUID from a handoff must never trigger a new create on an empty relay.
    await writeFile(join(dir, "admission.json"), JSON.stringify({ ...admission, runId }));
    const unconfirmed = await runSourceCli([...linked, String(cap)], {
      cwd: dir,
      env: env("unconfirmed-run")
    });
    expect(unconfirmed.exitCode).not.toBe(0);
    expect(relayEvents).toEqual(["lookup:unknown"]);
    expect(reservations).toBe(0);

    await writeFile(join(dir, "admission.json"), JSON.stringify(admission));
    const unsupported = await runSourceCli([...linked, String(cap)], {
      cwd: dir,
      env: env("old-relay")
    });
    expect(unsupported.exitCode).not.toBe(0);
    expect(relayEvents).toEqual(["lookup:unknown", "lookup:unknown", "legacy:rejected"]);
    expect(reservations).toBe(0);
    legacyRelay = false;
    relayEvents.length = 0;

    const interrupted = await runSourceCli([...linked, String(cap)], {
      cwd: dir,
      env: env("first")
    });
    expect(fixtureErrors).toEqual([]);
    expect(interrupted.exitCode, interrupted.stderr + interrupted.stdout).not.toBe(0);
    expect(relayEvents).toEqual(["lookup:unknown", "commit"]);
    expect(reservations).toBe(1);

    const resumed = await runSourceCli([...linked, String(cap)], { cwd: dir, env: env("clean") });
    expect(fixtureErrors).toEqual([]);
    expect(resumed.exitCode, resumed.stderr + resumed.stdout).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ run_id: runId, outcome: "passed" });
    expect(relayEvents).toEqual(["lookup:unknown", "commit", "lookup:bound", "replay"]);
    expect(createHashes).toHaveLength(2);
    expect(new Set(createHashes).size).toBe(1);

    const changedTarget = await runSourceCli([...linked, String(cap)], {
      cwd: dir,
      env: { ...env("different-target"), CHATBOT_BASE_URL: "https://other.example.test" }
    });
    expect(changedTarget.exitCode).not.toBe(0);
    const changedCap = await runSourceCli([...linked, String(cap + 1)], {
      cwd: dir,
      env: env("different-cap")
    });
    expect(changedCap.exitCode).not.toBe(0);
    expect(relayEvents).toHaveLength(4);

    // A run UUID from the handoff is only a hint. The relay must confirm that exact binding.
    await writeFile(join(dir, "admission.json"), JSON.stringify({ ...admission, runId: WORKSPACE }));
    const substitute = await runSourceCli([...linked, String(cap)], { cwd: dir, env: env("wrong-run") });
    expect(substitute.exitCode).not.toBe(0);
    expect(relayEvents.at(-1)).toBe("lookup:bound");
    expect(createHashes).toHaveLength(2);

    // Even a newly supplied admission with the same key cannot change the relay body.
    await writeFile(join(dir, "admission.json"), JSON.stringify({ ...admission, maxCredits: cap + 1 }));
    const collision = await runSourceCli([...linked, String(cap + 1)], {
      cwd: dir,
      env: env("collision")
    });
    expect(collision.exitCode).not.toBe(0);
    expect(relayEvents.at(-1)).toBe("conflict");
    expect(createHashes).toHaveLength(2);
    expect(reservations).toBe(1);
    expect(requests.filter((path) => path === "POST /v1/billing/quote")).toHaveLength(1);
    expect(targetConnections).toBe(0);
    expect(fixtureErrors).toEqual([]);
  } finally {
    await Promise.all([relay.close(), target.close()]);
    await rm(dir, { force: true, recursive: true });
  }
}, 60_000);
