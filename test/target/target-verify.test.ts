import { describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import { runTargetVerify, type TargetDependencies, type TargetVerifyOptions } from "../../src/commands/target.js";
import type { ConnectionProbeReport } from "../../src/connector/connection-probe.js";
import { resolveConfig } from "../../src/config/resolve.js";
import { AwError, EXIT, exitCodeFor } from "../../src/errors.js";
import { LOCAL_CHECK_INTERVAL_MS } from "../../src/target/verify.js";

const API = "http://127.0.0.1:8787/";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "12121212-1212-4121-8121-121212121212";
const AUTHORITY_ID = "13131313-1313-4131-8131-131313131313";
const NONCE = "one-time-nonce";
const START = Date.parse("2026-10-16T19:00:00Z");
const CODE_EXPIRES = "2026-10-17T19:00:00Z";
const VERIFIED_UNTIL = "2027-01-14T19:00:00Z";

type Method = "https_challenge" | "dns_txt" | "connector_challenge" | "reviewed_permission";

function storedTarget(method: Method, overrides: Record<string, unknown> = {}) {
  const privateAddress = method === "connector_challenge";
  return {
    targetId: TARGET_ID,
    workspaceId: WORKSPACE,
    name: "support",
    environment: "production",
    transport: "direct_http",
    effectBoundary: "no_tools",
    assessedIdentity: privateAddress ? "http://127.0.0.1:8000" : "https://bot.example.com",
    identityFingerprint: "f".repeat(64),
    authorizationKind: method === "reviewed_permission" ? "written_permission" : "owned_target",
    permissionRef: method === "reviewed_permission" ? "MSA-2026-014" : "owned",
    verificationMethod: method,
    status: "pending",
    currentRevision: 1,
    currentBoundaryHash: "a".repeat(64),
    currentAuthorityId: AUTHORITY_ID,
    currentAuthorityRevision: 1,
    createdAt: "2026-10-16T18:00:00.000Z",
    updatedAt: "2026-10-16T18:00:00.000Z",
    revokedAt: null,
    attribution: null,
    ...overrides
  };
}

interface Stub {
  method: Method;
  target: ReturnType<typeof storedTarget>;
  challenge: { method: Method; nonce: string; expiresAt: string } | null;
  /** What the server's own check sees. */
  published: boolean;
}

function harness(stub: Stub, extra: { probeOk?: boolean; baseUrl?: string } = {}) {
  const verifyBodies: Array<Record<string, unknown>> = [];
  const registrations: Array<Record<string, unknown>> = [];
  const stderr: string[] = [];
  let clock = START;
  const sleeps: number[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const base = `/api/workspaces/${WORKSPACE}/execution-targets`;
    if (url.pathname === base && init?.method === "GET") return Response.json([stub.target]);
    if (url.pathname === base && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      registrations.push(body);
      stub.challenge = { method: stub.method, nonce: "fresh-nonce", expiresAt: CODE_EXPIRES };
      return Response.json({
        schemaVersion: "aw-target-registration/1",
        targetId: TARGET_ID,
        targetRevision: 1,
        status: "pending",
        challenge: stub.challenge
      });
    }
    if (url.pathname === `${base}/${TARGET_ID}` && init?.method === "GET") {
      return Response.json({
        schemaVersion: "aw-target-detail/1",
        target: stub.target,
        endpoints: [{ method: "POST", path: "/api/chat" }],
        authority: {
          authorityId: AUTHORITY_ID,
          revision: 1,
          verificationStatus: stub.target.status === "verified" ? "verified" : "pending",
          expiresAt: VERIFIED_UNTIL,
          renewalOpensAt: "2026-12-31T19:00:00Z"
        },
        challenge: stub.challenge
      });
    }
    if (url.pathname === `${base}/${TARGET_ID}/verify` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      verifyBodies.push(body);
      if (stub.method === "https_challenge" && !stub.published) {
        return Response.json(
          {
            schemaVersion: "aw-real-data-error/1",
            error: {
              code: "TARGET_AUTHORITY_REQUIRED",
              status: 403,
              retryable: false,
              message: "We fetched https://bot.example.com/.well-known/augmentworks-target and got HTTP 404, not 200.",
              correlationId: "c-1",
              details: []
            }
          },
          { status: 403 }
        );
      }
      return Response.json({
        targetId: TARGET_ID,
        authority: { verificationStatus: "verified", expiresAt: VERIFIED_UNTIL }
      });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "missing" } }, { status: 404 });
  });
  const config = (() => {
    const inspection = resolveConfig(
      {
        version: 1,
        target: {
          name: "support",
          connector: "http",
          base_url: extra.baseUrl ?? "http://127.0.0.1:8000",
          operations: {
            send: {
              method: "POST",
              path: "/api/chat",
              request: { message: "$input.message.content" },
              response: { content: "$.answer" }
            }
          }
        }
      },
      "/tmp/augmentworks.yaml",
      "/tmp",
      {}
    );
    if (inspection.resolvedConfig === undefined) throw new Error("config did not resolve");
    return inspection.resolvedConfig;
  })();
  const probe = vi.fn(async () => ({ ok: extra.probeOk ?? true, corrective_action: null, diagnostics: [] }) as unknown as ConnectionProbeReport);
  const localChecks: number[] = [];
  const publishedLocally = { value: false };
  const dependencies: TargetDependencies = {
    doctor: async () => ({ ok: true, configPath: config.configPath, offline: true, diagnostics: [], resolvedConfig: config }),
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
    stderr: { write: (chunk: string | Uint8Array) => stderr.push(String(chunk)) > 0 },
    verify: {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      fetch: async (input) => {
        localChecks.push(clock);
        expect(String(input)).toBe("https://bot.example.com/.well-known/augmentworks-target");
        return publishedLocally.value ? new Response(`${stub.challenge?.nonce ?? ""}\n`) : new Response("not here", { status: 404 });
      },
      resolveTxt: async (name) => {
        localChecks.push(clock);
        expect(name).toBe("_augmentworks-target.bot.example.com");
        return publishedLocally.value ? [stub.challenge?.nonce ?? ""] : [];
      },
      probe
    }
  };
  return {
    fetchMock,
    verifyBodies,
    registrations,
    stderr,
    sleeps,
    localChecks,
    probe,
    dependencies,
    publish: () => {
      publishedLocally.value = true;
      stub.published = true;
    },
    elapsed: () => clock - START
  };
}

function stub(method: Method, overrides: Partial<Stub> = {}): Stub {
  return {
    method,
    target: storedTarget(method),
    challenge: { method, nonce: NONCE, expiresAt: CODE_EXPIRES },
    published: false,
    ...overrides
  };
}

const verify = (options: Partial<TargetVerifyOptions>, dependencies: TargetDependencies) =>
  runTargetVerify({ env: {}, name: "support", handleSignals: false, ...options }, dependencies);

async function refusal(promise: Promise<unknown>): Promise<AwError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
  if (!(error instanceof AwError)) throw new Error(`expected an AwError, got ${String(error)}`);
  return error;
}

describe("augmentworks target verify (AUG-363)", () => {
  it("prints the file to serve, checks every 15 seconds, and asks the server once it's published", async () => {
    const h = harness(stub("https_challenge"));
    const sleep = h.dependencies.verify!.sleep!;
    let naps = 0;
    h.dependencies = {
      ...h.dependencies,
      verify: {
        ...h.dependencies.verify,
        sleep: async (ms: number, signal?: AbortSignal) => {
          naps += 1;
          if (naps === 3) h.publish();
          await sleep(ms, signal);
        }
      }
    };
    const result = await verify({}, h.dependencies);

    const output = h.stderr.join("");
    expect(output).toContain("Serve this exact value at https://bot.example.com/.well-known/augmentworks-target");
    expect(output).toContain(`  ${NONCE}\n`);
    expect(output).toContain(`The code expires at ${CODE_EXPIRES}`);
    expect(h.sleeps.every((ms) => ms === LOCAL_CHECK_INTERVAL_MS)).toBe(true);
    // One server check at the start, one as soon as the file is seen: no polling of the server.
    expect(h.verifyBodies).toEqual([
      { nonce: NONCE, expectedRevision: 1 },
      { nonce: NONCE, expectedRevision: 1 }
    ]);
    expect(h.localChecks).toHaveLength(4);
    expect(result).toMatchObject({ alreadyVerified: false, expiresAt: VERIFIED_UNTIL, method: "https_challenge" });
  });

  it("prints the TXT record for a DNS target", async () => {
    const h = harness(stub("dns_txt"));
    h.publish();
    const result = await verify({ method: "dns" }, h.dependencies);
    expect(h.stderr.join("")).toContain("Add a TXT record named _augmentworks-target.bot.example.com with this value");
    expect(h.verifyBodies).toHaveLength(1);
    expect(result.method).toBe("dns_txt");
  });

  it("confirms a private address from this machine with one probe and records it as the owner's statement", async () => {
    const h = harness(stub("connector_challenge"));
    const result = await verify({}, h.dependencies);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.verifyBodies).toEqual([{ nonce: NONCE, expectedRevision: 1, connectorAttestation: true }]);
    expect(result.ownerStatement).toBe(true);
  });

  it("records nothing when this machine can't reach the private address", async () => {
    const h = harness(stub("connector_challenge"), { probeOk: false });
    const error = await refusal(verify({}, h.dependencies));
    expect(error.code).toBe("TARGET_UNREACHABLE");
    expect(h.verifyBodies).toHaveLength(0);
  });

  it("won't confirm a private address with a configuration that points somewhere else", async () => {
    const h = harness(stub("connector_challenge"), { baseUrl: "http://127.0.0.1:9000" });
    const error = await refusal(verify({}, h.dependencies));
    expect(error.code).toBe("TARGET_SCOPE_MISMATCH");
    expect(h.probe).not.toHaveBeenCalled();
  });

  it("stops at the timeout with the same code still valid, without polling the server", async () => {
    const h = harness(stub("https_challenge"));
    const error = await refusal(verify({ timeoutMs: 5 * 60_000 }, h.dependencies));
    expect(error.code).toBe("TARGET_VERIFY_TIMEOUT");
    expect(error.message).toContain(`The code stays valid until ${CODE_EXPIRES}`);
    expect(exitCodeFor(error)).toBe(EXIT.TARGET);
    expect(h.verifyBodies).toHaveLength(1);
    expect(h.elapsed()).toBe(5 * 60_000);
  });

  it("stops on Ctrl+C and says running it again keeps the same code", async () => {
    const h = harness(stub("https_challenge"));
    const listeners: Array<() => void> = [];
    h.dependencies = {
      ...h.dependencies,
      signals: {
        on: (_event, listener) => listeners.push(listener),
        off: () => undefined
      },
      verify: {
        ...h.dependencies.verify,
        sleep: async () => {
          listeners.forEach((listener) => listener());
          throw new AwError({ code: "RELAY_REQUEST_CANCELLED", category: "relay", message: "cancelled" });
        }
      }
    };
    const error = await refusal(verify({ handleSignals: true }, h.dependencies));
    expect(error.code).toBe("INTERRUPTED");
    expect(error.message).toContain("again to keep checking with the same code");
    expect(exitCodeFor(error)).toBe(EXIT.INTERRUPTED);
  });

  it("resumes with the open code, and asks for a new one only when it expired", async () => {
    const open = harness(stub("dns_txt"));
    open.publish();
    await verify({}, open.dependencies);
    expect(open.registrations).toHaveLength(0);
    expect(open.verifyBodies[0]).toMatchObject({ nonce: NONCE });

    const expired = harness(stub("dns_txt", { challenge: null }));
    expired.publish();
    await verify({}, expired.dependencies);
    expect(expired.registrations[0]).toMatchObject({
      targetId: TARGET_ID,
      targetBoundaryHash: "a".repeat(64),
      verificationMethod: "dns_txt",
      endpoints: [{ method: "POST", path: "/api/chat" }]
    });
    expect(expired.verifyBodies[0]).toMatchObject({ nonce: "fresh-nonce" });
    expect(expired.stderr.join("")).toContain("The previous code expired");
  });

  it("says a verified target is already verified", async () => {
    const h = harness(stub("https_challenge", { target: storedTarget("https_challenge", { status: "verified" }), challenge: null }));
    const result = await verify({}, h.dependencies);
    expect(result).toMatchObject({ alreadyVerified: true, expiresAt: VERIFIED_UNTIL });
    expect(h.verifyBodies).toHaveLength(0);
  });

  it("refuses --method dns for a target added for the HTTPS file", async () => {
    const h = harness(stub("https_challenge"));
    const error = await refusal(verify({ method: "dns" }, h.dependencies));
    expect(error.code).toBe("TARGET_METHOD_UNAVAILABLE");
    expect(h.verifyBodies).toHaveLength(0);
  });

  it("records a client's written permission, naming the client when given", async () => {
    const h = harness(stub("reviewed_permission"));
    await verify({ clientRef: "acme" }, h.dependencies);
    expect(h.verifyBodies[0]).toMatchObject({
      permissionAttestation: { kind: "agency_written_permission", representedClientRef: "acme" }
    });
  });

  it("refuses a machine key before any request", async () => {
    const h = harness(stub("https_challenge"));
    const error = await refusal(verify({ env: { AUGMENTWORKS_API_KEY: "aw_api_test_key" } }, h.dependencies));
    expect(error.code).toBe("TARGET_OWNER_LOGIN_REQUIRED");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("names the environments when one name is registered twice", async () => {
    const h = harness(stub("https_challenge"));
    h.fetchMock.mockImplementationOnce(async () =>
      Response.json([
        storedTarget("https_challenge"),
        storedTarget("https_challenge", { targetId: "14141414-1414-4141-8141-141414141414", environment: "staging" })
      ])
    );
    const error = await refusal(verify({}, h.dependencies));
    expect(error.code).toBe("TARGET_AMBIGUOUS");
    expect(error.message).toContain("Pass --env");
  });
});
