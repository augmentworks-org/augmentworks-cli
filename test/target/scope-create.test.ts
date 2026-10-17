import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import { runScopeCreate, type ScopeCreateOptions, type ScopeDependencies } from "../../src/commands/scope.js";
import { AwError, exitCodeFor, EXIT } from "../../src/errors.js";
import { sealDocumentHash } from "../../src/real-data/canonical.js";
import { loadCustomerSuiteFile } from "../../src/suite/load.js";
import { writeSuiteScope } from "../../src/target/suite-scope.js";
import { sealedAuthority, sealedBoundary, sealedPolicy, sealedScope, WORKSPACE_ID } from "../real-data/helpers.js";

const API = "http://127.0.0.1:8787/";
const NEW_SCOPE = "77777777-7777-4777-8777-777777777777";
const NOW = Date.parse("2026-10-16T19:00:00Z");
const AUTHORITY_EXPIRES = "2027-01-14T19:00:00Z";

const boundary = sealedBoundary();
const authority = sealedAuthority(boundary);
const policy = sealedPolicy();
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const SUITE = `# Real-data refunds suite. Keep the scope block near the top.
schema_version: aw-suite/3
suite_id: refunds.real   # stable id
title: "Refunds, with real records"
execution_scope:
  schema_version: aw-execution-scope/1
  scope_id: 66666666-6666-4666-8666-666666666666   # replaced by scope create
  revision: 1
tags:
  - authorized
references:
  - id: records.kb
    kind: reference_facts
    content: |
      Support hours are 9:00-17:00 UTC on weekdays.
cases:
  - case_id: authorized.hours
    name: Support hours
    turns:
      - content: What are your weekday support hours?
    expected:
      facts:
        - Weekday support hours are 9:00-17:00 UTC.
    criteria:
      - criterion_id: authorized.hours.required
        requirement: required
        kind: llm_rubric
        statement: The answer must state weekday support hours of 9:00-17:00 UTC.
        reference_ids:
          - records.kb
`;

function storedTarget(status: "pending" | "verified") {
  return {
    targetId: boundary.targetId,
    workspaceId: WORKSPACE_ID,
    name: "refunds",
    environment: "production",
    transport: "direct_http",
    effectBoundary: "no_tools",
    assessedIdentity: "https://bot.example.com",
    authorizationKind: "owned_target",
    permissionRef: "owned",
    verificationMethod: "https_challenge",
    status,
    currentRevision: boundary.revision,
    currentBoundaryHash: boundary.boundaryHash
  };
}

async function harness(options: { status?: "pending" | "verified"; accepted?: boolean; suite?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aw-scope-create-"));
  temporary.push(directory);
  await writeFile(join(directory, "refunds.suite.yaml"), options.suite ?? SUITE, "utf8");
  const scopeRequests: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const base = `/api/workspaces/${WORKSPACE_ID}`;
    if (path === `${base}/real-data-statement`) {
      return Response.json({
        schemaVersion: "aw-real-data-statement/1",
        version: 1,
        text: "statement",
        hash: createHash("sha256").update("statement", "utf8").digest("hex"),
        accepted: options.accepted ?? true,
        acceptedAt: null
      });
    }
    if (path === `${base}/execution-targets`) return Response.json([storedTarget(options.status ?? "verified")]);
    if (path === `${base}/execution-targets/${boundary.targetId}`) {
      return Response.json({
        schemaVersion: "aw-target-detail/1",
        target: storedTarget(options.status ?? "verified"),
        endpoints: boundary.endpoints,
        authority: {
          authorityId: authority.authorityId,
          revision: authority.revision,
          verificationStatus: "verified",
          expiresAt: AUTHORITY_EXPIRES,
          renewalOpensAt: "2026-12-31T19:00:00Z"
        },
        challenge: null
      });
    }
    if (path === `${base}/data-policies`) {
      return Response.json({
        schemaVersion: "aw-data-policy-collection/1",
        policies: [
          { policy: { ...policy, revision: 1 } },
          { policy },
          { policy: { ...policy, policyId: "88888888-8888-4888-8888-888888888888", revision: 1 } }
        ]
      });
    }
    if (path === `${base}/execution-scopes` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      scopeRequests.push(body);
      const base = sealedScope(boundary, authority, policy);
      return Response.json(
        sealDocumentHash({ ...base, scopeId: NEW_SCOPE, revision: 1, expiresAt: body["expiresAt"] as string }, "scopeHash")
      );
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "missing" } }, { status: 404 });
  });
  const stderr: string[] = [];
  const dependencies: ScopeDependencies = {
    apiOrigin: () => new URL(API),
    accessToken: async () => "owner-token",
    identity: async () => ({
      subject: "user-1",
      workspaceId: WORKSPACE_ID,
      connectorId: "connector-1",
      scopes: ["connector:identity", "connector:run"],
      principalKind: "user"
    }),
    cloud: ({ accessToken, accessTokenProvider }) =>
      new CloudClient({ apiUrl: API, accessToken, accessTokenProvider, fetch: fetchMock }),
    interactive: false,
    now: () => NOW,
    stderr: { write: (chunk: string | Uint8Array) => stderr.push(String(chunk)) > 0 }
  };
  return { directory, fetchMock, scopeRequests, stderr, dependencies };
}

const create = (options: Partial<ScopeCreateOptions>, h: Awaited<ReturnType<typeof harness>>) =>
  runScopeCreate(
    { env: {}, cwd: h.directory, target: "refunds", suite: "refunds.suite.yaml", yes: true, ...options },
    h.dependencies
  );

async function refusal(promise: Promise<unknown>): Promise<AwError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
  if (!(error instanceof AwError)) throw new Error(`expected an AwError, got ${String(error)}`);
  return error;
}

describe("augmentworks scope create (AUG-364)", () => {
  it("creates the scope and changes only the scope id in the suite file", async () => {
    const h = await harness();
    const result = await create({}, h);

    const written = await readFile(join(h.directory, "refunds.suite.yaml"), "utf8");
    expect(written).toBe(SUITE.replace("66666666-6666-4666-8666-666666666666", NEW_SCOPE));
    const loaded = await loadCustomerSuiteFile(join(h.directory, "refunds.suite.yaml"));
    expect(JSON.stringify(loaded)).toContain(NEW_SCOPE);
    expect(h.scopeRequests[0]).toEqual({
      targetId: boundary.targetId,
      authorityId: authority.authorityId,
      authorityRevision: authority.revision,
      dataPolicyId: policy.policyId,
      dataPolicyRevision: policy.revision,
      environment: "production",
      dataOrigin: "constructed",
      effects: "informational",
      actionPolicyId: null,
      budget: { maxMessages: 1, maxActions: 0, maxCommands: 2, maxRuntimeSeconds: 600, maxCredits: 1 },
      expiresAt: "2026-11-15T19:00:00Z"
    });
    const plan = h.stderr.join("");
    expect(plan).toContain(`Data policy:  ${policy.policyId} revision ${policy.revision}`);
    expect(plan).toContain("Data origin:  constructed");
    expect(plan).toContain("Expires:      2026-11-15T19:00:00Z");
    expect(plan).toContain("Budget:       1 message, 0 actions, 2 commands, 600 seconds, 1 credit per run,");
    expect(plan).toContain("sized to one run of this suite (1 case)");
    expect(result.next).toBe("augmentworks test --suite refunds.suite.yaml");
  });

  it("caps the expiry at the end of the target's verification", async () => {
    const h = await harness();
    await create({ expires: "2027-06-30" }, h);
    expect(h.scopeRequests[0]?.["expiresAt"]).toBe(AUTHORITY_EXPIRES);
  });

  it("stops when the workspace hasn't accepted the statement", async () => {
    const h = await harness({ accepted: false });
    const error = await refusal(create({}, h));
    expect(error.code).toBe("STATEMENT_NOT_ACCEPTED");
    expect(error.message).toContain("augmentworks target add");
    expect(h.scopeRequests).toHaveLength(0);
    expect(await readFile(join(h.directory, "refunds.suite.yaml"), "utf8")).toBe(SUITE);
  });

  it("stops when the target isn't verified and names the step", async () => {
    const h = await harness({ status: "pending" });
    const error = await refusal(create({}, h));
    expect(error.code).toBe("TARGET_NOT_VERIFIED");
    expect(error.message).toContain("augmentworks target verify refunds");
    expect(h.scopeRequests).toHaveLength(0);
  });

  it("refuses a machine key before any request", async () => {
    const h = await harness();
    const error = await refusal(create({ env: { AUGMENTWORKS_API_KEY: "aw_api_test_key" } }, h));
    expect(error.code).toBe("TARGET_OWNER_LOGIN_REQUIRED");
    expect(exitCodeFor(error)).toBe(EXIT.AUTH);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("asks before creating without --yes, and creates nothing in CI", async () => {
    const h = await harness();
    const error = await refusal(create({ yes: false }, h));
    expect(error.code).toBe("SCOPE_CONFIRMATION_REQUIRED");
    expect(h.scopeRequests).toHaveLength(0);
  });

  it("refuses a suite that isn't aw-suite/3 before contacting the server", async () => {
    const h = await harness({ suite: SUITE.replace("aw-suite/3", "aw-suite/2") });
    const error = await refusal(create({}, h));
    expect(error.code).toBe("SUITE_SCOPE_WRITE_FAILED");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe("writing a scope into a suite file", () => {
  it("adds the block after schema_version when the suite has none", () => {
    const source = "schema_version: aw-suite/3 # v3\nsuite_id: x\n";
    expect(writeSuiteScope(source, { scopeId: NEW_SCOPE, revision: 2 })).toBe(
      `schema_version: aw-suite/3 # v3\nexecution_scope:\n  schema_version: aw-execution-scope/1\n  scope_id: ${NEW_SCOPE}\n  revision: 2\nsuite_id: x\n`
    );
  });

  it("adds a missing revision under the block's last key", () => {
    const source = `schema_version: aw-suite/3\nexecution_scope:\n  schema_version: aw-execution-scope/1\n  scope_id: "old"\nsuite_id: x\n`;
    expect(writeSuiteScope(source, { scopeId: NEW_SCOPE, revision: 3 })).toBe(
      `schema_version: aw-suite/3\nexecution_scope:\n  schema_version: aw-execution-scope/1\n  scope_id: ${NEW_SCOPE}\n  revision: 3\nsuite_id: x\n`
    );
  });
});
