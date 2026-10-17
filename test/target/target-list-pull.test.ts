import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import { runDoctor } from "../../src/commands/doctor.js";
import {
  formatTargetListHuman,
  runTargetList,
  runTargetPull,
  type TargetDependencies
} from "../../src/commands/target.js";
import { AwError } from "../../src/errors.js";

const API = "http://127.0.0.1:8787/";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "12121212-1212-4121-8121-121212121212";
const PENDING_ID = "14141414-1414-4141-8141-141414141414";
const SCOPE_ID = "77777777-7777-4777-8777-777777777777";
const NOW = Date.parse("2026-10-16T19:00:00Z");
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function storedTarget(id: string, name: string, status: "pending" | "verified") {
  return {
    targetId: id,
    name,
    environment: "production",
    transport: "direct_http",
    effectBoundary: "no_tools",
    assessedIdentity: "https://bot.example.com",
    authorizationKind: "owned_target",
    permissionRef: "owned",
    verificationMethod: "https_challenge",
    status,
    currentRevision: 1,
    currentBoundaryHash: "a".repeat(64)
  };
}

const ENDPOINTS = [
  { method: "POST", path: "/api/chat" },
  { method: "GET", path: "/api/state" }
];

function harness(options: { scopesStatus?: number; scopeExpires?: string } = {}) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    const base = `/api/workspaces/${WORKSPACE}/execution-targets`;
    if (path === base) {
      return Response.json([storedTarget(TARGET_ID, "support", "verified"), storedTarget(PENDING_ID, "billing", "pending")]);
    }
    for (const [id, status] of [
      [TARGET_ID, "verified"],
      [PENDING_ID, "pending"]
    ] as const) {
      if (path === `${base}/${id}`) {
        return Response.json({
          schemaVersion: "aw-target-detail/1",
          target: storedTarget(id, id === TARGET_ID ? "support" : "billing", status),
          endpoints: ENDPOINTS,
          authority: {
            authorityId: "13131313-1313-4131-8131-131313131313",
            revision: 1,
            verificationStatus: status,
            expiresAt: "2027-01-14T19:00:00Z",
            renewalOpensAt: "2026-12-31T19:00:00Z"
          },
          challenge: null
        });
      }
      if (path === `${base}/${id}/scopes`) {
        if (options.scopesStatus !== undefined) {
          return Response.json(
            {
              schemaVersion: "aw-feature-error/1",
              documentKind: "feature_error",
              packageVersion: "1.0.0",
              error: { code: "insufficient_permission", message: "Owners only.", retryable: false, details: [] }
            },
            { status: options.scopesStatus }
          );
        }
        return Response.json({
          schemaVersion: "aw-target-scopes/1",
          targetId: id,
          scopes:
            id === TARGET_ID
              ? [
                  {
                    scopeId: SCOPE_ID,
                    revision: 1,
                    dataPolicy: { id: "15151515-1515-4151-8151-151515151515", revision: 2 },
                    environment: "production",
                    effects: "informational",
                    expiresAt: options.scopeExpires ?? "2026-10-19T23:59:59Z",
                    createdAt: "2026-10-01T00:00:00Z",
                    state: "ready"
                  }
                ]
              : []
        });
      }
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "missing" } }, { status: 404 });
  });
  const dependencies: TargetDependencies = {
    apiOrigin: () => new URL(API),
    accessToken: async () => "owner-token",
    identity: async () => ({
      subject: "user-1",
      workspaceId: WORKSPACE,
      connectorId: "connector-1",
      scopes: ["connector:identity", "connector:run"],
      principalKind: "user"
    }),
    cloud: ({ accessToken, accessTokenProvider }) =>
      new CloudClient({ apiUrl: API, accessToken, accessTokenProvider, fetch: fetchMock }),
    stderr: { write: () => true },
    verify: { now: () => NOW }
  };
  return { fetchMock, dependencies };
}

async function project(files: Record<string, string> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-target-pull-"));
  temporary.push(directory);
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(directory, name), text, "utf8")));
  return directory;
}

async function refusal(promise: Promise<unknown>): Promise<AwError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
  if (!(error instanceof AwError)) throw new Error(`expected an AwError, got ${String(error)}`);
  return error;
}

const EXISTING = `# Our support bot.
version: 1
target:
  name: old-name
  connector: http
  base_url: https://old.example.com   # moved
  auth:
    bearer_env: CHATBOT_API_KEY
  operations:
    send:
      method: POST
      path: /api/chat
      request:
        message: $input.message.content
      response:
        content: $.answer
`;

describe("augmentworks target list (AUG-365)", () => {
  it("shows each target's status, expiry and scopes, and flags a suite's scope close to expiring", async () => {
    const h = harness();
    const directory = await project({
      "refunds.suite.yaml": `schema_version: aw-suite/3\nexecution_scope:\n  schema_version: aw-execution-scope/1\n  scope_id: ${SCOPE_ID}\n  revision: 1\n`
    });
    const result = await runTargetList({ env: {}, cwd: directory, suite: "refunds.suite.yaml" }, h.dependencies);
    const output = formatTargetListHuman(result);
    expect(output).toContain("support (production)  verified until 2027-01-14  https://bot.example.com");
    expect(output).toContain(`scope ${SCOPE_ID} revision 1, informational, expires 2026-10-19 (ready), expires soon`);
    expect(output).toContain("billing (production)  waiting for verification");
    expect(output).toContain(
      "The scope in refunds.suite.yaml expires on 2026-10-19T23:59:59Z, in 4 days. Run `augmentworks scope create --target support --suite refunds.suite.yaml` for a new one."
    );
  });

  it("lists targets for a member, saying only owners see scopes", async () => {
    const h = harness({ scopesStatus: 403 });
    const result = await runTargetList({ env: {} }, h.dependencies);
    expect(formatTargetListHuman(result)).toContain("scopes: only a workspace owner can see them");
  });
});

describe("augmentworks target pull (AUG-365)", () => {
  it("merges the address and name into augmentworks.yaml, leaving mappings, auth and comments alone", async () => {
    const h = harness();
    const directory = await project({ "augmentworks.yaml": EXISTING });
    const result = await runTargetPull({ env: {}, cwd: directory, name: "support" }, h.dependencies);
    const written = await readFile(join(directory, "augmentworks.yaml"), "utf8");
    expect(written).toContain("# Our support bot.");
    expect(written).toContain("name: support");
    expect(written).toContain("base_url: https://bot.example.com");
    expect(written).toContain("bearer_env: CHATBOT_API_KEY");
    expect(written).toContain("content: $.answer");
    expect(result.changes).toEqual(["name set to support", "base_url set to https://bot.example.com"]);
    expect(result.notes).toEqual([
      "Also registered: GET /api/state. Add it under operations as prepare, observe or cleanup if it is one."
    ]);
    const doctor = await runDoctor({ cwd: directory, processEnv: { CHATBOT_API_KEY: "k" } });
    expect(doctor.diagnostics.filter((item) => item.level === "error")).toEqual([]);
  });

  it("creates augmentworks.yaml with marked placeholders, and doctor refuses them until filled in", async () => {
    const h = harness();
    const directory = await project();
    const result = await runTargetPull({ env: {}, cwd: directory, name: "support" }, h.dependencies);
    expect(result.created).toBe(true);
    const written = await readFile(join(directory, "augmentworks.yaml"), "utf8");
    expect(written).toContain("base_url: https://bot.example.com");
    expect(written).toContain("path: /api/chat");
    expect(written).toContain("content: $.FILL_IN_reply_field");

    const doctor = await runDoctor({ cwd: directory, processEnv: {} });
    expect(doctor.ok).toBe(false);
    expect(doctor.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "PLACEHOLDER_UNFILLED",
        path: "target.operations.send.response.content"
      })
    );

    await writeFile(join(directory, "augmentworks.yaml"), written.replace("$.FILL_IN_reply_field", "$.answer"), "utf8");
    const filled = await runDoctor({ cwd: directory, processEnv: {} });
    expect(filled.diagnostics.some((item) => item.code === "PLACEHOLDER_UNFILLED")).toBe(false);
  });

  it("refuses an operation that calls an endpoint the target doesn't have, and writes nothing", async () => {
    const h = harness();
    const conflicting = EXISTING.replace("path: /api/chat", "path: /chat");
    const directory = await project({ "augmentworks.yaml": conflicting });
    const error = await refusal(runTargetPull({ env: {}, cwd: directory, name: "support" }, h.dependencies));
    expect(error.code).toBe("TARGET_PULL_CONFLICT");
    expect(error.message).toContain("target.operations.send calls POST /chat");
    expect(error.message).toContain("POST /api/chat, GET /api/state");
    expect(await readFile(join(directory, "augmentworks.yaml"), "utf8")).toBe(conflicting);
  });

  it("leaves an env-driven base_url alone and says what to set", async () => {
    const h = harness();
    const directory = await project({
      "augmentworks.yaml": EXISTING.replace("name: old-name", "name: support").replace(
        "base_url: https://old.example.com   # moved",
        "base_url: ${CHATBOT_BASE_URL}"
      )
    });
    const result = await runTargetPull({ env: {}, cwd: directory, name: "support" }, h.dependencies);
    expect(result.changes).toEqual([]);
    expect(result.notes[0]).toBe("base_url reads ${CHATBOT_BASE_URL}. Set CHATBOT_BASE_URL to https://bot.example.com.");
  });
});
