import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import { resolveConfig } from "../../src/config/resolve.js";
import type { AugmentWorksConfig } from "../../src/config/types.js";
import { AW_REAL_DATA_CONTRACT } from "../../src/real-data/generated/contract.js";
import {
  parseCapabilities,
  parseExecutionScope,
  parseExecutionScopeResponse,
  parseLocalExecutionScope,
  looksLikeHostedExecutionScope,
  type ExecutionScopeResponse
} from "../../src/real-data/documents.js";
import {
  assertHostedRealDataRelease,
  capabilitiesReleaseEnabled,
  DISABLED_REAL_DATA_CAPABILITIES
} from "../../src/real-data/capabilities.js";
import { applyRedactionProfile, failClosedPrivacyService, minimizeForUpload, registerPrivacyService } from "../../src/real-data/privacy.js";
import { persistExecutionScopeBinding, loadExecutionScopeBinding, hostedBinding, assertBindingMatches } from "../../src/real-data/scope-store.js";
import {
  executionScopeRefFromNativeDocument,
  loadPersistedDispatchPolicy,
  requireHostedAuthorizedScope,
  resolveDispatchPolicyForBinding
} from "../../src/real-data/hosted.js";
import { consumeProbeAllowance } from "../../src/real-data/budget.js";
import {
  assertCommandAllowed,
  assertDispatchReadyForQuote,
  authorizedDispatchPolicy
} from "../../src/real-data/policy.js";
import { classifyRealDataFailure } from "../../src/real-data/classify.js";
import { realDataError } from "../../src/real-data/errors.js";
import { revokeLocalScope, loadRevokedLocalScopeIds } from "../../src/real-data/local-revoke.js";
import { assertLocalScopeNotRevoked, canonicalAssessedOrigin } from "../../src/real-data/boundary.js";
import { privacyContextFromDocuments } from "../../src/real-data/r06-service.js";
import { parseLocalPacket } from "../../src/local/packet.js";
import type { RelayCommand } from "../../src/cloud/protocol.js";
import { AwError } from "../../src/errors.js";
import {
  ADVERTISED_DISABLED_CAPABILITIES,
  ENABLED_CAPABILITIES,
  FUTURE,
  hostedScopeResponse,
  localAuthorizedPacketManifest,
  publicCredentialOnlyPolicy,
  canaryRedactionPolicy,
  sealedBoundary,
  sealedLocalScope,
  UUID_C,
  WORKSPACE_ID
} from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("aw-real-data-1 contract lock", () => {
  it("pins the server contract with release enabled", () => {
    expect(AW_REAL_DATA_CONTRACT.source.commit).toBe("16d767967c9d000b81f10ddb09800b0273277b68");
    expect(AW_REAL_DATA_CONTRACT.expected.schema).toBe(
      "485c58f0def045df6ab592c6814dfbe7b045fe522699fc5221a15e867808a5a4"
    );
    expect(AW_REAL_DATA_CONTRACT.expected.fixtures).toBe(
      "408ee99ee191892480a161e25b7196129d5dbd5ab2bf729ae95153d826cd550b"
    );
    expect(AW_REAL_DATA_CONTRACT.releaseEnabled).toBe(true);
    expect(AW_REAL_DATA_CONTRACT.runtimeEnforced).toBe(true);
    expect(AW_REAL_DATA_CONTRACT.imported).toBe(true);
    expect(AW_REAL_DATA_CONTRACT.files["contracts/aw-real-data-1.schema.json"]).toBe(
      AW_REAL_DATA_CONTRACT.expected.schema
    );
    expect(AW_REAL_DATA_CONTRACT.files["contracts/aw-real-data-1.fixtures.json"]).toBe(
      AW_REAL_DATA_CONTRACT.expected.fixtures
    );
  });

  it("vendors exact contract bytes retrieved from GitHub at the pinned commit", async () => {
    const retrieval = JSON.parse(
      await readFile(resolve("contracts/aw-real-data-1.retrieval.json"), "utf8")
    ) as {
      imported: boolean;
      verified: boolean;
      expected: { schema: string; fixtures: string; checksums: string };
      source: { commit: string; access?: { kind: string; ref: string } };
      files: Record<string, string>;
    };
    expect(retrieval.imported).toBe(true);
    expect(retrieval.verified).toBe(true);
    expect(retrieval.source.commit).toBe(AW_REAL_DATA_CONTRACT.source.commit);
    expect(retrieval.source.access).toMatchObject({ kind: "github", ref: AW_REAL_DATA_CONTRACT.source.commit });
    expect(retrieval.expected.schema).toBe(AW_REAL_DATA_CONTRACT.expected.schema);
    expect(retrieval.expected.fixtures).toBe(AW_REAL_DATA_CONTRACT.expected.fixtures);
    for (const [relative, expected] of Object.entries(retrieval.files)) {
      const raw = await readFile(resolve(relative));
      expect(createHash("sha256").update(raw).digest("hex")).toBe(expected);
    }
    expect(retrieval.files["contracts/aw-real-data-1.checksums.json"]).toBe(retrieval.expected.checksums);
  });
});

describe("execution scope documents", () => {
  it("parses a sealed hosted scope response", () => {
    const response = hostedScopeResponse();
    const parsed = parseExecutionScopeResponse(response);
    expect(parsed.scope.scopeId).toBe(response.scope.scopeId);
    expect(looksLikeHostedExecutionScope(parsed.scope)).toBe(true);
    expect(() => parseLocalExecutionScope(parsed.scope)).toThrowError(/cannot authorize local execution/);
  });

  it("rejects an unknown scope version instead of downgrading to synthetic", () => {
    expect(() =>
      parseExecutionScope({
        ...hostedScopeResponse().scope,
        schemaVersion: "aw-execution-scope/2"
      })
    ).toThrowError(/not a complete/);
  });
});

describe("hosted capabilities and release gate", () => {
  it("treats a server without /v1/capabilities as disabled", async () => {
    const cloud = new CloudClient({
      apiUrl: "http://127.0.0.1:8787",
      accessToken: "token",
      fetch: async () => Response.json({ error: "not_found" }, { status: 404 })
    });
    await expect(cloud.getRealDataCapabilities()).resolves.toEqual(DISABLED_REAL_DATA_CAPABILITIES);
    expect(capabilitiesReleaseEnabled(DISABLED_REAL_DATA_CAPABILITIES)).toBe(false);
  });

  it("reports a capabilities document it can't parse instead of treating it as disabled", async () => {
    const cloud = new CloudClient({
      apiUrl: "http://127.0.0.1:8787",
      accessToken: "token",
      fetch: async () =>
        Response.json({ ...ENABLED_CAPABILITIES, contractRevision: 2 }, { status: 200 })
    });
    await expect(cloud.getRealDataCapabilities()).rejects.toMatchObject({
      code: "UNSUPPORTED_EXECUTION_SCOPE",
      message: expect.stringContaining("not a valid aw-capabilities/1 document")
    });
    expect(parseCapabilities(ENABLED_CAPABILITIES).releaseEnabled).toBe(true);
  });

  it("fails closed when advertised but not released", () => {
    expect(() => assertHostedRealDataRelease(ADVERTISED_DISABLED_CAPABILITIES)).toThrow(
      expect.objectContaining({ code: "EXECUTION_RELEASE_UNAVAILABLE" })
    );
  });

  it("requireHostedAuthorizedScope fails before quote when release is disabled", async () => {
    const response = hostedScopeResponse();
    const cloud = {
      async getRealDataCapabilities() {
        return ADVERTISED_DISABLED_CAPABILITIES;
      },
      async getExecutionScope() {
        return response;
      }
    };
    await expect(
      requireHostedAuthorizedScope(cloud as never, {
        schemaVersion: "aw-execution-scope/1",
        scopeId: response.scope.scopeId
      }, { workspaceId: WORKSPACE_ID })
    ).rejects.toMatchObject({ code: "EXECUTION_RELEASE_UNAVAILABLE" });
  });
});

describe("privacy fail-closed default", () => {
  it("blocks personal content when the fail-closed service is registered", async () => {
    registerPrivacyService(failClosedPrivacyService);
    try {
      const { policy, profile } = publicCredentialOnlyPolicy();
      const personal = { ...policy, dataClass: "personal" as const };
      const result = await Promise.resolve(
        applyRedactionProfile({ document: { email: "a@example.com" } }, profile, personal, [])
      );
      expect(result.blocked).toBe(true);
      await expect(
        minimizeForUpload({ document: { email: "a@example.com" } }, profile, personal, [])
      ).rejects.toMatchObject({
        code: "DATA_POLICY_BLOCKED"
      });
    } finally {
      registerPrivacyService(undefined);
    }
  });

  it("uses landed R06 for minimized personal and business content", async () => {
    const { policy, profile } = canaryRedactionPolicy({ dataClass: "personal", contentHandling: "minimized" });
    expect(() => privacyContextFromDocuments(policy, profile, [])).not.toThrow();
    const result = await Promise.resolve(
      applyRedactionProfile(
        {
          document: {
            path: "relay.answer",
            content: {
              role: "assistant",
              content: "Hours 9. Contact canary.user@example.test",
              api_key: "sk-syntheticCanaryKey12"
            }
          }
        },
        profile,
        policy,
        []
      )
    );
    expect(result.blocked).toBe(false);
    const text = JSON.stringify(result.representation);
    expect(text).not.toContain("canary.user@example.test");
    expect(text).not.toContain("sk-syntheticCanaryKey12");
    expect(text).toContain("Hours 9");
  });

  it("redacts credentials for public verbatim content", async () => {
    const { policy, profile } = publicCredentialOnlyPolicy();
    const result = await Promise.resolve(
      applyRedactionProfile({ document: { token: "secret", answer: "ok" } }, profile, policy, ["secret"])
    );
    expect(result.blocked).toBe(false);
    expect(result.outcome).toBe("transformed");
  });
});

describe("persisted scope binding", () => {
  it("round-trips a hosted binding and rejects a stale config hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aw-scope-"));
    temporaryDirectories.push(directory);
    const response = hostedScopeResponse();
    await persistExecutionScopeBinding(
      hostedBinding({
        runId: "run-1",
        configSha256: "a".repeat(64),
        workspaceId: WORKSPACE_ID,
        scope: response.scope,
        quoteId: "quote-1"
      }),
      { stateDirectory: directory }
    );
    const loaded = await loadExecutionScopeBinding("run-1", { stateDirectory: directory });
    expect(loaded?.scopeId).toBe(response.scope.scopeId);
    expect(loaded?.quoteId).toBe("quote-1");
    expect(() =>
      assertBindingMatches({
        binding: loaded!,
        runId: "run-1",
        configSha256: "b".repeat(64)
      })
    ).toThrow(expect.objectContaining({ code: "TARGET_SCOPE_MISMATCH" }));
  });
});

describe("persisted private-target permission (AUG-399)", () => {
  const privateResponse = () =>
    hostedScopeResponse({
      boundary: { assessedIdentity: "http://127.0.0.1:8000" },
      verificationMethod: "connector_challenge"
    });

  async function persistRaw(directory: string, binding: Record<string, unknown>): Promise<void> {
    await mkdir(join(directory, "execution-scopes"), { recursive: true });
    await writeFile(
      join(directory, "execution-scopes", `${String(binding["runId"])}.json`),
      `${JSON.stringify(binding, null, 2)}\n`,
      "utf8"
    );
  }

  it("stores allowPrivate only when true, and still loads bindings written before the field existed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aw-scope-"));
    temporaryDirectories.push(directory);
    const resolved = resolvedTarget("https://support.example.com");
    const response = hostedScopeResponse();
    const legacy = hostedBinding({
      runId: "run-legacy",
      configSha256: resolved.configDigest,
      workspaceId: WORKSPACE_ID,
      scope: response.scope,
      boundary: response.targetBoundary
    });
    expect(legacy).not.toHaveProperty("allowPrivate");
    await persistRaw(directory, legacy);
    const loaded = await loadExecutionScopeBinding("run-legacy", { stateDirectory: directory });
    expect(loaded?.allowPrivate).toBeUndefined();
    await expect(
      loadPersistedDispatchPolicy({ runId: "run-legacy", configSha256: resolved.configDigest, resolved, stateDirectory: directory })
    ).resolves.toBeUndefined();
  });

  it("resumes a connector-verified private binding, and reads a binding without the field as public-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aw-scope-"));
    temporaryDirectories.push(directory);
    const resolved = resolvedTarget("http://127.0.0.1:8000");
    const response = privateResponse();
    const binding = hostedBinding({
      runId: "run-private",
      configSha256: resolved.configDigest,
      workspaceId: WORKSPACE_ID,
      scope: response.scope,
      boundary: response.targetBoundary,
      allowPrivate: true
    });
    await persistExecutionScopeBinding(binding, { stateDirectory: directory });
    expect((await loadExecutionScopeBinding("run-private", { stateDirectory: directory }))?.allowPrivate).toBe(true);
    await expect(
      loadPersistedDispatchPolicy({ runId: "run-private", configSha256: resolved.configDigest, resolved, stateDirectory: directory })
    ).resolves.toBeUndefined();

    const { allowPrivate: _dropped, ...withoutField } = { ...binding, runId: "run-private-legacy" };
    await persistRaw(directory, withoutField);
    await expect(
      loadPersistedDispatchPolicy({
        runId: "run-private-legacy",
        configSha256: resolved.configDigest,
        resolved,
        stateDirectory: directory
      })
    ).rejects.toMatchObject({ code: "TARGET_SCOPE_MISMATCH" });
  });

  it("lets a quote go ahead for a private origin only when the hosted authority passed connector challenge", () => {
    const resolved = resolvedTarget("http://127.0.0.1:8000");
    const verified = privateResponse();
    const policy = authorizedDispatchPolicy({
      scope: verified.scope,
      boundary: verified.targetBoundary,
      allowPrivate: true
    });
    expect(policy).toMatchObject({ local: false, allowPrivate: true, origin: "http://127.0.0.1:8000" });
    expect(() => assertDispatchReadyForQuote(policy, resolved)).not.toThrow();

    expect(() =>
      authorizedDispatchPolicy({ scope: verified.scope, boundary: verified.targetBoundary })
    ).toThrow(expect.objectContaining({ code: "TARGET_SCOPE_MISMATCH" }));
    const publicPolicy = authorizedDispatchPolicy({
      scope: hostedScopeResponse().scope,
      boundary: hostedScopeResponse().targetBoundary
    });
    expect(publicPolicy.allowPrivate).toBe(false);
    expect(() => assertDispatchReadyForQuote(publicPolicy, resolved)).toThrow(
      expect.objectContaining({ code: "TARGET_SCOPE_MISMATCH" })
    );
  });
});

describe("saved suite scope reference (AUG-402)", () => {
  const suite = (executionScope: unknown) => ({ schemaVersion: "aw-customer-suite/3", executionScope });

  it("projects a saved revision's full sealed scope to the reference fields", () => {
    const { scope } = hostedScopeResponse();
    expect(executionScopeRefFromNativeDocument(suite(scope))).toEqual({
      schemaVersion: scope.schemaVersion,
      scopeId: scope.scopeId,
      revision: scope.revision,
      scopeHash: scope.scopeHash
    });
  });

  it("still accepts a reference-only scope and rejects a scope with unknown fields", () => {
    const { scope } = hostedScopeResponse();
    const ref = { schemaVersion: scope.schemaVersion, scopeId: scope.scopeId, revision: scope.revision };
    expect(executionScopeRefFromNativeDocument(suite(ref))).toEqual(ref);
    expect(executionScopeRefFromNativeDocument(suite({ ...scope, unexpected: true }))).toBeUndefined();
    expect(executionScopeRefFromNativeDocument({ schemaVersion: "aw-customer-suite/2", executionScope: scope })).toBeUndefined();
  });
});

describe("dispatch policy", () => {
  it("rejects cleanup unless the admitted boundary allows it", () => {
    const response = hostedScopeResponse();
    const policy = authorizedDispatchPolicy({
      scope: response.scope,
      boundary: response.targetBoundary
    });
    const journal = {
      dispatchedSendCount: () => 0,
      dispatchedCommandCount: () => 0,
      dispatchedActionCount: () => 0,
      commandIds: () => [],
      state: () => undefined
    };
    const command = {
      kind: "cleanup",
      command_id: "cmd-1"
    } as RelayCommand;
    expect(() => assertCommandAllowed(command, policy, journal as never)).toThrow(
      expect.objectContaining({ code: "ACTION_NOT_ALLOWED" })
    );
  });

  it("charges a diagnostic probe against the finite budget", () => {
    expect(() =>
      consumeProbeAllowance(
        { maxMessages: 1, maxActions: 0, maxCommands: 1, maxRuntimeSeconds: 60, maxCredits: 1 },
        { messages: 1, commands: 1, actions: 0 }
      )
    ).toThrow(expect.objectContaining({ code: "EXECUTION_BUDGET_EXHAUSTED" }));
  });
});

describe("local revocation and UX classes", () => {
  it("revokes a local scope on this machine", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aw-revoke-"));
    temporaryDirectories.push(directory);
    const { policy } = publicCredentialOnlyPolicy();
    const scope = sealedLocalScope(sealedBoundary({ assessedIdentity: "http://127.0.0.1" }), policy);
    await revokeLocalScope(scope.scopeId, { stateDirectory: directory });
    const ids = await loadRevokedLocalScopeIds({ stateDirectory: directory });
    expect(() => assertLocalScopeNotRevoked(scope, ids)).toThrow(
      expect.objectContaining({ code: "LOCAL_SCOPE_REVOKED" })
    );
  });

  it("classifies revoked authority separately from a test failure", () => {
    const error = realDataError("TARGET_AUTHORITY_REVOKED", "revoked");
    expect(classifyRealDataFailure(error)).toMatchObject({
      class: "revoked_authority",
      fix: expect.stringContaining("run report")
    });
    expect(classifyRealDataFailure(error)?.fix).not.toMatch(/syntheticOnly/);
    const budget = realDataError("EXECUTION_BUDGET_EXHAUSTED", "cap");
    expect(classifyRealDataFailure(budget)?.class).toBe("budget_exhausted");
    const timeout = realDataError("ACTION_OUTCOME_INDETERMINATE", "timeout");
    expect(classifyRealDataFailure(timeout)?.class).toBe("execution_timeout");
    expect(classifyRealDataFailure(new AwError({ code: "ASSESSMENT_FAILED", category: "target", message: "failed" }))).toBeUndefined();
  });
});

describe("local authorized packets and private targets", () => {
  it("parses aw-packet/local-authorized-1 and rejects hosted interchange", () => {
    const packet = localAuthorizedPacketManifest();
    const parsed = parseLocalPacket(packet);
    expect(parsed.schema_version).toBe("aw-packet/local-authorized-1");
    expect(parsed.synthetic_only).toBe(false);
    expect(() => parseLocalExecutionScope(hostedScopeResponse().scope)).toThrow(
      expect.objectContaining({ code: "HOSTED_AUTHORITY_INTERCHANGE_FORBIDDEN" })
    );
  });

  it("allows a customer-private local origin without loosening hosted SSRF", () => {
    expect(canonicalAssessedOrigin("http://127.0.0.1:8000", { allowPrivate: true })).toBe(
      "http://127.0.0.1:8000"
    );
    expect(() => canonicalAssessedOrigin("http://127.0.0.1:8000", { allowPrivate: false })).toThrow(
      expect.objectContaining({ code: "TARGET_SCOPE_MISMATCH" })
    );
  });

  it("fails closed when an authorized packet has no persisted or server scope", async () => {
    const cloud = {
      async getRealDataCapabilities() {
        return ADVERTISED_DISABLED_CAPABILITIES;
      },
      async getExecutionScope() {
        return hostedScopeResponse();
      },
      async getRunExecutionScope() {
        return undefined;
      }
    };
    await expect(
      resolveDispatchPolicyForBinding({
        cloud: cloud as never,
        binding: {
          protocol_version: "aw-relay/0.1",
          create_request_id: "crq_aaaaaaaaaaaaaaaaaaaaaaaa",
          create_request_sha256: "c".repeat(64),
          create_disposition: "created",
          run_id: "run-missing-scope",
          session_id: "session-1",
          packet: { key: "aw-customer-suite", version: "3.0.0", sha256: "d".repeat(64) },
          config_sha256: "a".repeat(64),
          fencing_epoch: 1,
          status: "connected",
          dashboard_url: "https://example.test/runs/run-missing-scope",
          run_expires_at: FUTURE,
          credit_state: "reserved"
        },
        workspaceId: WORKSPACE_ID
      })
    ).rejects.toMatchObject({ code: "INVALID_EXECUTION_SCOPE" });
  });
});

const HTML_NOT_FOUND = "<!DOCTYPE html><html><body>404: This page could not be found.</body></html>";

function resolvedTarget(baseUrl: string, path = "/chat") {
  const config: AugmentWorksConfig = {
    version: 1,
    target: {
      name: "support",
      connector: "http",
      base_url: baseUrl,
      operations: {
        send: {
          method: "POST",
          path,
          request: { message: "$input.message" },
          response: { content: "$.answer" }
        }
      }
    }
  };
  const inspection = resolveConfig(config, "/tmp/augmentworks.yaml", "/tmp", {});
  if (inspection.resolvedConfig === undefined) {
    throw new Error(`test config did not resolve: ${JSON.stringify(inspection.diagnostics)}`);
  }
  return inspection.resolvedConfig;
}

function runBinding(packet: { readonly key: string; readonly version: string }, runId = "run-scope") {
  return {
    protocol_version: "aw-relay/0.1" as const,
    create_request_id: "crq_aaaaaaaaaaaaaaaaaaaaaaaa",
    create_request_sha256: "c".repeat(64),
    create_disposition: "created" as const,
    run_id: runId,
    session_id: "session-1",
    packet: { ...packet, sha256: "d".repeat(64) },
    config_sha256: "a".repeat(64),
    fencing_epoch: 1,
    status: "connected" as const,
    dashboard_url: `https://example.test/runs/${runId}`,
    run_expires_at: FUTURE,
    credit_state: "reserved" as const
  };
}

describe("hosted run scope lookup", () => {
  it("does not request a scope for a synthetic or v2 binding", async () => {
    const calls: string[] = [];
    const cloud = {
      async getRealDataCapabilities() {
        calls.push("capabilities");
        return ENABLED_CAPABILITIES;
      },
      async getRunExecutionScope() {
        calls.push("scope");
        return hostedScopeResponse();
      }
    };
    for (const packet of [
      { key: "support-refunds", version: "0.1.0" },
      { key: "aw-customer-suite", version: "2.0.0" }
    ]) {
      await expect(
        resolveDispatchPolicyForBinding({
          cloud: cloud as never,
          binding: runBinding(packet),
          workspaceId: WORKSPACE_ID
        })
      ).resolves.toBeUndefined();
    }
    expect(calls).toEqual([]);
  });

  it("uses a looked-up scope that passes the shared checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aw-scope-lookup-"));
    temporaryDirectories.push(directory);
    const response = hostedScopeResponse();
    const calls: string[] = [];
    const cloud = {
      async getRealDataCapabilities() {
        calls.push("capabilities");
        return ENABLED_CAPABILITIES;
      },
      async getRunExecutionScope() {
        calls.push("scope");
        return response;
      }
    };
    const policy = await resolveDispatchPolicyForBinding({
      cloud: cloud as never,
      binding: runBinding({ key: "aw-customer-suite", version: "3.0.0" }, "run-looked-up"),
      workspaceId: WORKSPACE_ID,
      resolved: resolvedTarget("https://support.example.com"),
      stateDirectory: directory
    });
    expect(calls).toEqual(["scope", "capabilities"]);
    expect(policy).toMatchObject({
      kind: "authorized",
      origin: "https://support.example.com"
    });
  });

  it.each([
    {
      name: "release capability",
      code: "EXECUTION_RELEASE_UNAVAILABLE",
      capabilities: ADVERTISED_DISABLED_CAPABILITIES,
      response: () => hostedScopeResponse()
    },
    {
      name: "workspace",
      code: "TARGET_SCOPE_MISMATCH",
      workspaceId: UUID_C,
      response: () => hostedScopeResponse()
    },
    {
      name: "revoked availability",
      code: "TARGET_AUTHORITY_REVOKED",
      response: () => ({ ...hostedScopeResponse(), availability: "revoked" as const })
    },
    {
      name: "expired availability",
      code: "TARGET_AUTHORITY_EXPIRED",
      response: () => ({ ...hostedScopeResponse(), availability: "expired" as const })
    },
    {
      name: "release-unavailable availability",
      code: "EXECUTION_RELEASE_UNAVAILABLE",
      response: () => ({ ...hostedScopeResponse(), availability: "release_unavailable" as const })
    },
    {
      name: "authority verification",
      code: "TARGET_AUTHORITY_REQUIRED",
      response: (): ExecutionScopeResponse => {
        const response = hostedScopeResponse();
        return {
          ...response,
          authority: { ...response.authority, verificationStatus: "pending" }
        };
      }
    },
    {
      name: "scope expiry",
      code: "TARGET_AUTHORITY_EXPIRED",
      response: (): ExecutionScopeResponse => {
        const response = hostedScopeResponse();
        return { ...response, scope: { ...response.scope, expiresAt: "2000-01-01T00:00:00Z" } };
      }
    },
    {
      name: "authority expiry",
      code: "TARGET_AUTHORITY_EXPIRED",
      response: (): ExecutionScopeResponse => {
        const response = hostedScopeResponse();
        return {
          ...response,
          authority: { ...response.authority, expiresAt: "2000-01-01T00:00:00Z" }
        };
      }
    },
    {
      name: "target boundary",
      code: "TARGET_SCOPE_MISMATCH",
      resolved: true,
      response: () => hostedScopeResponse()
    }
  ])("rejects a looked-up scope that fails $name", async (entry) => {
    const cloud = {
      async getRealDataCapabilities() {
        return entry.capabilities ?? ENABLED_CAPABILITIES;
      },
      async getRunExecutionScope() {
        return entry.response();
      }
    };
    await expect(
      resolveDispatchPolicyForBinding({
        cloud: cloud as never,
        binding: runBinding({ key: "aw-customer-suite", version: "3.0.0" }),
        workspaceId: entry.workspaceId ?? WORKSPACE_ID,
        ...(entry.resolved === true ? { resolved: resolvedTarget("https://other.example.com") } : {})
      })
    ).rejects.toMatchObject({ code: entry.code });
  });

  it("turns an HTML 404 from the lookup into INVALID_EXECUTION_SCOPE", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(HTML_NOT_FOUND, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" }
      })
    );
    const cloud = new CloudClient({
      apiUrl: "http://127.0.0.1:8787",
      accessToken: "token",
      fetch: fetchMock
    });
    await expect(
      resolveDispatchPolicyForBinding({
        cloud,
        binding: runBinding({ key: "aw-customer-suite", version: "3.0.0" }, "run-html-404"),
        workspaceId: WORKSPACE_ID
      })
    ).rejects.toMatchObject({ code: "INVALID_EXECUTION_SCOPE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/relay/runs/run-html-404/execution-scope");
  });

  it("propagates a 503 from the lookup", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "unavailable" }, { status: 503 })
    );
    const cloud = new CloudClient({
      apiUrl: "http://127.0.0.1:8787",
      accessToken: "token",
      fetch: fetchMock
    });
    await expect(
      resolveDispatchPolicyForBinding({
        cloud,
        binding: runBinding({ key: "aw-customer-suite", version: "3.0.0" }, "run-503"),
        workspaceId: WORKSPACE_ID
      })
    ).rejects.toMatchObject({
      code: "CLOUD_REQUEST_FAILED",
      details: { http_status: 503 }
    });
  });

  it("still rejects a stale pinned revision before availability", async () => {
    const response = hostedScopeResponse();
    const cloud = {
      async getRealDataCapabilities() {
        return ENABLED_CAPABILITIES;
      },
      async getExecutionScope() {
        return { ...response, availability: "revoked" as const };
      }
    };
    await expect(
      requireHostedAuthorizedScope(
        cloud as never,
        {
          schemaVersion: "aw-execution-scope/1",
          scopeId: response.scope.scopeId,
          revision: response.scope.revision + 1
        },
        { workspaceId: WORKSPACE_ID }
      )
    ).rejects.toMatchObject({ code: "EXECUTION_SCOPE_STALE" });
  });
});
