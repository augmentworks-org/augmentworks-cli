import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { AuthIdentity } from "../../src/auth/types.js";
import { CloudClient } from "../../src/cloud/client.js";
import { createTargetCommand, runTargetAdd, type TargetAddOptions, type TargetDependencies } from "../../src/commands/target.js";
import { resolveConfig } from "../../src/config/resolve.js";
import { AwError, EXIT, exitCodeFor } from "../../src/errors.js";
import { parseTargetBoundary } from "../../src/real-data/documents.js";

const API = "http://127.0.0.1:8787/";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "12121212-1212-4121-8121-121212121212";
const STATEMENT_TEXT =
  "I'm an owner of this workspace. We'll only run real-data tests against agents we own or operate, or have written permission to test, and only in the environments we register. I accept responsibility for the tests this workspace runs, on behalf of the workspace.";
const STATEMENT_HASH = createHash("sha256").update(STATEMENT_TEXT, "utf8").digest("hex");

function resolved(baseUrl = "https://bot.example.com") {
  const inspection = resolveConfig(
    {
      version: 1,
      target: {
        name: "support",
        connector: "http",
        base_url: baseUrl,
        operations: {
          send: {
            method: "POST",
            path: "/api/chat",
            request: { message: "$input.message.content" },
            response: { content: "$.answer" }
          },
          observe: {
            method: "GET",
            path: "/api/state",
            response: { state: "$.state" }
          }
        }
      }
    },
    "/tmp/augmentworks.yaml",
    "/tmp",
    {}
  );
  if (inspection.resolvedConfig === undefined) {
    throw new Error(`test config did not resolve: ${JSON.stringify(inspection.diagnostics)}`);
  }
  return inspection.resolvedConfig;
}

interface Harness {
  readonly fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly posts: Array<{ body: Record<string, unknown>; headers: Headers }>;
  readonly questions: string[];
  readonly stderr: string[];
  readonly stdout: string[];
  readonly dependencies: TargetDependencies;
}

function harness(
  options: {
    readonly accepted?: boolean;
    readonly answers?: readonly string[];
    readonly interactive?: boolean;
    readonly principalKind?: AuthIdentity["principalKind"];
    readonly baseUrl?: string;
    readonly statement?: Record<string, unknown>;
    readonly registerStatus?: number;
    readonly registerResponse?: unknown;
  } = {}
): Harness {
  const posts: Harness["posts"] = [];
  const questions: string[] = [];
  const stderr: string[] = [];
  const stdout: string[] = [];
  const answers = [...(options.answers ?? [])];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === `/api/workspaces/${WORKSPACE}/real-data-statement` && init?.method === "GET") {
      return Response.json(
        options.statement ?? {
          schemaVersion: "aw-real-data-statement/1",
          version: 1,
          text: STATEMENT_TEXT,
          hash: STATEMENT_HASH,
          accepted: options.accepted ?? false,
          acceptedAt: options.accepted === true ? "2026-10-16T12:00:00.000Z" : null
        }
      );
    }
    if (url.pathname === `/api/workspaces/${WORKSPACE}/execution-targets` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ body, headers: new Headers(init.headers) });
      if (options.registerStatus !== undefined) {
        return Response.json(options.registerResponse, { status: options.registerStatus });
      }
      return Response.json({
        schemaVersion: "aw-target-registration/1",
        targetId: body["targetId"],
        targetRevision: 1,
        status: "pending",
        challenge: {
          method: body["verificationMethod"],
          nonce: "one-time-nonce",
          expiresAt: "2026-10-17T19:00:00Z"
        }
      });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "missing" } }, { status: 404 });
  });
  const config = resolved(options.baseUrl);
  let ids = 0;
  const dependencies: TargetDependencies = {
    doctor: async () => ({ ok: true, configPath: config.configPath, offline: true, diagnostics: [], resolvedConfig: config }),
    apiOrigin: () => new URL(API),
    accessToken: async () => "owner-token",
    identity: async () => ({
      subject: "user-1",
      workspaceId: WORKSPACE,
      connectorId: "connector-1",
      scopes: ["connector:identity", "connector:run"],
      principalKind: options.principalKind ?? "user"
    }),
    cloud: ({ accessToken, accessTokenProvider }) =>
      new CloudClient({ apiUrl: API, accessToken, accessTokenProvider, fetch: fetchMock }),
    interactive: options.interactive ?? true,
    ask: async (question) => {
      questions.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected question: ${question}`);
      return answer;
    },
    newId: () => (ids++ === 0 ? TARGET_ID : "99999999-9999-4999-8999-999999999999"),
    stdout: { write: (chunk: string | Uint8Array) => stdout.push(String(chunk)) > 0 },
    stderr: { write: (chunk: string | Uint8Array) => stderr.push(String(chunk)) > 0 }
  };
  return { fetchMock, posts, questions, stderr, stdout, dependencies };
}

const add = (options: Partial<TargetAddOptions>, h: Harness) =>
  runTargetAdd({ env: {}, environment: "production", ...options }, h.dependencies);

async function refusal(promise: Promise<unknown>): Promise<AwError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
  if (!(error instanceof AwError)) throw new Error(`expected an AwError, got ${String(error)}`);
  return error;
}

describe("augmentworks target add (AUG-362)", () => {
  it("asks whose agent it is, shows the statement once, and registers what augmentworks.yaml describes", async () => {
    const h = harness({ answers: ["1", "yes"] });
    const result = await add({}, h);

    expect(h.questions).toHaveLength(2);
    expect(h.questions[0]).toContain("Whose agent is this?");
    expect(h.questions[1]).toContain("Type yes");
    expect(h.stderr.join("").split(STATEMENT_TEXT)).toHaveLength(2);
    expect(h.posts).toHaveLength(1);
    const { body, headers } = h.posts[0]!;
    expect(body).toMatchObject({
      targetId: TARGET_ID,
      name: "support",
      environment: "production",
      transport: "direct_http",
      effectBoundary: "no_tools",
      authorizationKind: "owned_target",
      permissionRef: "owned",
      verificationMethod: "https_challenge",
      assessedIdentity: "https://bot.example.com",
      endpoints: [
        { method: "POST", path: "/api/chat" },
        { method: "GET", path: "/api/state" }
      ],
      attestation: { statementVersion: 1, statementHash: STATEMENT_HASH }
    });
    expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/u);
    // The hash is the server's aw-target-boundary/1 hash for exactly this boundary.
    expect(() =>
      parseTargetBoundary({
        schemaVersion: "aw-target-boundary/1",
        targetId: TARGET_ID,
        revision: 1,
        boundaryHash: body["targetBoundaryHash"],
        transport: "direct_http",
        effectBoundary: "no_tools",
        assessedIdentity: "https://bot.example.com",
        endpoints: body["endpoints"]
      })
    ).not.toThrow();
    expect(result).toMatchObject({ statementAccepted: true, next: "augmentworks target verify support" });
  });

  it("records a client's agent with its permission reference and skips a statement already accepted", async () => {
    const h = harness({ accepted: true, answers: ["2", "MSA-2026-014"] });
    const result = await add({}, h);
    expect(h.questions).toHaveLength(2);
    expect(h.stderr.join("")).not.toContain(STATEMENT_TEXT);
    expect(h.posts[0]?.body).toMatchObject({
      authorizationKind: "written_permission",
      permissionRef: "MSA-2026-014",
      verificationMethod: "reviewed_permission"
    });
    expect(h.posts[0]?.body).not.toHaveProperty("attestation");
    expect(result.verificationMethod).toBe("reviewed_permission");
  });

  it("registers nothing unless the statement is accepted with a typed yes", async () => {
    const h = harness({ answers: ["1", "y"] });
    const error = await refusal(add({}, h));
    expect(error.code).toBe("STATEMENT_NOT_ACCEPTED");
    expect(h.posts).toHaveLength(0);
  });

  it("registers in CI from --attest without asking, with a DNS check when asked for", async () => {
    const h = harness({ accepted: true, interactive: false });
    const result = await add({ attest: "owned", method: "dns", json: true }, h);
    expect(h.questions).toHaveLength(0);
    expect(h.posts[0]?.body).toMatchObject({ authorizationKind: "owned_target", verificationMethod: "dns_txt" });
    expect(result.registration.status).toBe("pending");
  });

  it("in CI, --yes alone never says whose agent it is", async () => {
    const h = harness({ accepted: true, interactive: false });
    const error = await refusal(add({ yes: true }, h));
    expect(error.code).toBe("ATTESTATION_REQUIRED");
    expect(error.message).toContain("--attest owned, or --attest written --permission-ref <ref>");
    expect(error.message).toContain("--yes doesn't answer this");
    expect(exitCodeFor(error)).toBe(EXIT.CONFIG);
    expect(h.posts).toHaveLength(0);
  });

  it("in CI, stops and points to the portal when the workspace hasn't accepted the statement", async () => {
    const h = harness({ accepted: false, interactive: false });
    const error = await refusal(add({ attest: "written", permissionRef: "MSA-2026-014" }, h));
    expect(error.code).toBe("STATEMENT_NOT_ACCEPTED");
    expect(error.message).toContain(`${API}portal/settings/targets`);
    expect(exitCodeFor(error)).toBe(EXIT.AUTH);
    expect(h.questions).toHaveLength(0);
    expect(h.posts).toHaveLength(0);
  });

  it("refuses a machine key before any request", async () => {
    const h = harness({ accepted: true, interactive: false });
    const error = await refusal(add({ attest: "owned", env: { AUGMENTWORKS_API_KEY: "aw_api_test_key" } }, h));
    expect(error.code).toBe("TARGET_OWNER_LOGIN_REQUIRED");
    expect(exitCodeFor(error)).toBe(EXIT.AUTH);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a machine credential passed as a token before reading the statement", async () => {
    const h = harness({ accepted: true, interactive: false, principalKind: "machine" });
    const error = await refusal(add({ attest: "owned" }, h));
    expect(error.code).toBe("TARGET_OWNER_LOGIN_REQUIRED");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("tells a member that only an owner can register", async () => {
    const h = harness({
      accepted: true,
      interactive: false,
      registerStatus: 403,
      registerResponse: {
        schemaVersion: "aw-feature-error/1",
        documentKind: "feature_error",
        packageVersion: "1.0.0",
        error: {
          code: "insufficient_permission",
          message: "The current principal cannot administer or read execution targets.",
          retryable: false,
          details: []
        }
      }
    });
    const error = await refusal(add({ attest: "owned" }, h));
    expect(error.code).toBe("TARGET_OWNER_LOGIN_REQUIRED");
    expect(error.message).toContain("Only a workspace owner");
  });

  it("verifies a private address from this machine and won't use DNS for it", async () => {
    const h = harness({ accepted: true, interactive: false, baseUrl: "http://127.0.0.1:8000" });
    await add({ attest: "owned" }, h);
    expect(h.posts[0]?.body).toMatchObject({
      assessedIdentity: "http://127.0.0.1:8000",
      verificationMethod: "connector_challenge"
    });
    const dns = harness({ accepted: true, interactive: false, baseUrl: "http://127.0.0.1:8000" });
    const error = await refusal(add({ attest: "owned", method: "dns" }, dns));
    expect(error.code).toBe("TARGET_METHOD_UNAVAILABLE");
    expect(dns.fetchMock).not.toHaveBeenCalled();
  });

  it("won't accept a statement whose hash doesn't match its text", async () => {
    const h = harness({
      answers: ["1"],
      statement: {
        schemaVersion: "aw-real-data-statement/1",
        version: 1,
        text: STATEMENT_TEXT,
        hash: "0".repeat(64),
        accepted: false,
        acceptedAt: null
      }
    });
    const error = await refusal(add({}, h));
    expect(error.code).toBe("INVALID_CLOUD_RESPONSE");
    expect(h.posts).toHaveLength(0);
  });

  it("requires --env, and reads it from the command line", async () => {
    const missing = harness({ accepted: true, interactive: false });
    const error = await refusal(runTargetAdd({ env: {}, attest: "owned" }, missing.dependencies));
    expect(error.code).toBe("TARGET_ENVIRONMENT_REQUIRED");

    const h = harness({ accepted: true, interactive: false });
    const command = createTargetCommand(h.dependencies);
    await command.parseAsync(["add", "--env", "staging", "--attest", "owned"], { from: "user" });
    expect(h.posts[0]?.body).toMatchObject({ environment: "staging" });
    expect(h.stdout.join("")).toContain("Next: augmentworks target verify support");
  });
});
