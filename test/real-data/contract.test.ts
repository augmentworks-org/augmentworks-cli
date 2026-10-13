import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { assertHostedRealDataRelease, DISABLED_REAL_DATA_CAPABILITIES } from "../../src/real-data/capabilities.js";
import { applyRedactionProfile, failClosedPrivacyService, minimizeForUpload, registerPrivacyService } from "../../src/real-data/privacy.js";
import { persistExecutionScopeBinding, loadExecutionScopeBinding, hostedBinding, assertBindingMatches } from "../../src/real-data/scope-store.js";
import { requireHostedAuthorizedScope, resolveDispatchPolicyForBinding } from "../../src/real-data/hosted.js";
import { consumeProbeAllowance } from "../../src/real-data/budget.js";
import { assertCommandAllowed, authorizedDispatchPolicy } from "../../src/real-data/policy.js";
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
  UUID_A,
  UUID_C
} from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("aw-real-data-1 contract lock", () => {
  it("pins revision 1 expected hashes and keeps release disabled", () => {
    expect(AW_REAL_DATA_CONTRACT.source.commit).toBe("b198906188bab2dac9ae2a1ad539405807e46e1e");
    expect(AW_REAL_DATA_CONTRACT.expected.schema).toBe(
      "6a53d04f297eb4db275bb7074bf7705a08137d932be823a3f4087d84cfdf7121"
    );
    expect(AW_REAL_DATA_CONTRACT.expected.fixtures).toBe(
      "26033843d55dcb9b49ccf68fa96f7de9ec34aa6c299e8ab28b605cad37572230"
    );
    expect(AW_REAL_DATA_CONTRACT.releaseEnabled).toBe(false);
    expect(AW_REAL_DATA_CONTRACT.runtimeEnforced).toBe(false);
    expect(AW_REAL_DATA_CONTRACT.imported).toBe(true);
    expect(AW_REAL_DATA_CONTRACT.files["contracts/aw-real-data-1.schema.json"]).toBe(
      AW_REAL_DATA_CONTRACT.expected.schema
    );
    expect(AW_REAL_DATA_CONTRACT.files["contracts/aw-real-data-1.fixtures.json"]).toBe(
      AW_REAL_DATA_CONTRACT.expected.fixtures
    );
  });

  it("vendors exact frozen R01 bytes from the verified Linear attachment", async () => {
    const retrieval = JSON.parse(
      await readFile(resolve("contracts/aw-real-data-1.retrieval.json"), "utf8")
    ) as {
      imported: boolean;
      verified: boolean;
      expected: { schema: string; fixtures: string; checksums: string };
      source: {
        commit: string;
        access?: { kind: string; attachmentId: string; zipSha256: string; zipBytes: number };
      };
      files: Record<string, string>;
      extracted: Record<string, { sha256: string; bytes: number }>;
      attempts: Array<{ command: string; status: number | null }>;
    };
    expect(retrieval.imported).toBe(true);
    expect(retrieval.verified).toBe(true);
    expect(retrieval.source.commit).toBe(AW_REAL_DATA_CONTRACT.source.commit);
    expect(retrieval.expected.schema).toBe(AW_REAL_DATA_CONTRACT.expected.schema);
    expect(retrieval.expected.fixtures).toBe(AW_REAL_DATA_CONTRACT.expected.fixtures);
    expect(retrieval.source.access?.kind).toBe("linear_attachment");
    expect(retrieval.source.access?.attachmentId).toBe("f95225e8-badf-42fa-9a39-2373b851a584");
    expect(retrieval.source.access?.zipSha256).toBe(
      "f325c47d990f22ce6a9ccc1dde41b665fb7286c01d6e5693bf8e11e5521fb2f2"
    );
    expect(retrieval.source.access?.zipBytes).toBe(17169);
    expect(retrieval.extracted["aw-real-data-1.schema.json"]).toEqual({
      sha256: retrieval.expected.schema,
      bytes: 25842
    });
    expect(retrieval.extracted["aw-real-data-1.fixtures.json"]).toEqual({
      sha256: retrieval.expected.fixtures,
      bytes: 100138
    });
    expect(retrieval.extracted["aw-real-data-1.checksums.json"]).toEqual({
      sha256: retrieval.expected.checksums,
      bytes: 318
    });

    for (const [relative, expected] of Object.entries(retrieval.extracted)) {
      const raw = await readFile(resolve("contracts", relative));
      expect(raw.byteLength).toBe(expected.bytes);
      expect(createHash("sha256").update(raw).digest("hex")).toBe(expected.sha256);
    }
    expect(retrieval.attempts.some((attempt) => attempt.command.includes("linear get_attachment"))).toBe(true);
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
  it("treats missing capabilities as disabled", () => {
    expect(parseCapabilities(DISABLED_REAL_DATA_CAPABILITIES).releaseEnabled).toBe(false);
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
      }, { workspaceId: UUID_C })
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
            protocol_version: "aw-target/0.1",
            turn_id: "turn-1",
            message: { role: "assistant", content: "Hours 9. Contact canary.user@example.test" },
            events: [],
            finished: true,
            metadata: { api_key: "sk-syntheticCanaryKey12" }
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
        workspaceId: UUID_C,
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
    const scope = sealedLocalScope(sealedBoundary({ allowPrivateEndpoints: true, assessedOrigin: "http://127.0.0.1" }), policy);
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
        workspaceId: UUID_C
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
          workspaceId: UUID_C
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
      workspaceId: UUID_C,
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
      workspaceId: UUID_A,
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
        workspaceId: entry.workspaceId ?? UUID_C,
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
        workspaceId: UUID_C
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
        workspaceId: UUID_C
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
        { workspaceId: UUID_C }
      )
    ).rejects.toMatchObject({ code: "EXECUTION_SCOPE_STALE" });
  });
});
