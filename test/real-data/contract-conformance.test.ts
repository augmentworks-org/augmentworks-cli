import { describe, expect, it } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";
import { resolveConfig } from "../../src/config/resolve.js";
import type { AugmentWorksConfig } from "../../src/config/types.js";
import { sealDocumentHash } from "../../src/real-data/canonical.js";
import {
  assertBoundaryMatchesConfig,
  assertScopeNotExpired,
  localTargetBoundary
} from "../../src/real-data/boundary.js";
import {
  ActionPolicySchema,
  DataHandlingReceiptSchema,
  parseAuthorizedReport,
  parseCapabilities,
  parseDataPolicy,
  parseExecutionScope,
  parseExecutionScopeResponse,
  parseLocalExecutionScope,
  parseRedactionProfile,
  parseTargetAuthority,
  parseTargetBoundary,
  type ExecutionScopeResponse,
  type LocalExecutionScope,
  type TargetBoundary
} from "../../src/real-data/documents.js";
import { requireHostedAuthorizedScope } from "../../src/real-data/hosted.js";
import { AuthorizedReportOverlaySchema } from "../../src/report/schema.js";
import { CONTRACT, contractFixture, contractResponse } from "./helpers.js";

/** Before every fixture's expiresAt and after execution_scope_expired's. */
const NOW = Date.parse("2026-06-01T00:00:00Z");

/** The CLI's parser for each contract document it reads, by schemaVersion. */
const PARSERS: Record<string, (value: unknown) => unknown> = {
  "aw-redaction-profile/1": parseRedactionProfile,
  "aw-data-policy/1": parseDataPolicy,
  "aw-data-handling-receipt/1": (value) => DataHandlingReceiptSchema.parse(value),
  "aw-target-boundary/1": parseTargetBoundary,
  "aw-target-authority/1": parseTargetAuthority,
  "aw-execution-scope/1": (value) => assertUnexpired(parseExecutionScope(value)),
  "aw-local-execution-scope/1": (value) => assertUnexpired(parseLocalExecutionScope(value)),
  "aw-action-policy/1": (value) => ActionPolicySchema.parse(value),
  "aw-capabilities/1": parseCapabilities,
  "aw-run-report-authorized-scope/1": parseAuthorizedReport
};

function assertUnexpired<T extends { readonly expiresAt: string }>(scope: T): T {
  assertScopeNotExpired(scope.expiresAt, NOW);
  return scope;
}

const fixtures = Object.entries(CONTRACT.fixtures).map(([name, fixture]) => {
  const document = fixture.document as Record<string, unknown>;
  const version = String(document["schemaVersion"] ?? document["schema_version"]);
  return { name, valid: fixture.valid, version, document };
});
const read = fixtures.filter((fixture) => PARSERS[fixture.version] !== undefined);

function resolvedTarget(baseUrl: string, operations: AugmentWorksConfig["target"]["operations"]) {
  const inspection = resolveConfig(
    { version: 1, target: { name: "support", connector: "http", base_url: baseUrl, operations } },
    "/tmp/augmentworks.yaml",
    "/tmp",
    {}
  );
  if (inspection.resolvedConfig === undefined) {
    throw new Error(`test config did not resolve: ${JSON.stringify(inspection.diagnostics)}`);
  }
  return inspection.resolvedConfig;
}

const send = (path: string) => ({
  method: "POST" as const,
  path,
  request: { message: "$input.message" },
  response: { content: "$.answer" }
});

describe("aw-real-data/1 contract conformance", () => {
  it("parses every server response the CLI reads", () => {
    expect(parseCapabilities(contractResponse("get_capabilities")).releaseEnabled).toBe(true);
    expect(parseExecutionScopeResponse(contractResponse("get_scope")).availability).toBe("ready");
    expect(parseAuthorizedReport(contractResponse("get_authorized_report")).v1ReportUnchanged).toBe(true);
    expect(
      AuthorizedReportOverlaySchema.parse(contractResponse("get_authorized_report")).independentlyVerifiedBusinessState
    ).toBe(false);
  });

  it("has a CLI parser for every invalid fixture, so none is skipped", () => {
    expect(fixtures.filter((fixture) => !fixture.valid && PARSERS[fixture.version] === undefined)).toEqual([]);
  });

  it.each(read.filter((fixture) => fixture.valid))("parses valid fixture $name", ({ version, document }) => {
    expect(() => PARSERS[version]!(document)).not.toThrow();
  });

  it.each(read.filter((fixture) => !fixture.valid))("rejects invalid fixture $name", ({ version, document }) => {
    expect(() => PARSERS[version]!(document)).toThrow();
  });

  it("accepts the server's scope through requireHostedAuthorizedScope", async () => {
    const http = CONTRACT.http;
    const scope = contractResponse<ExecutionScopeResponse>("get_scope").scope;
    const cloud = new CloudClient({
      apiUrl: "https://augmentworks.ai",
      accessToken: "aw_conformance_check_0123456789",
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        const body = path === "/v1/capabilities" ? http["get_capabilities"]!.response : http["get_scope"]!.response;
        return Response.json(body, { status: 200 });
      }
    });
    const response = await requireHostedAuthorizedScope(
      cloud,
      { schemaVersion: "aw-execution-scope/1", scopeId: scope.scopeId, revision: scope.revision, scopeHash: scope.scopeHash },
      {
        workspaceId: scope.workspaceId,
        resolved: resolvedTarget("https://support.example.com", { send: send("/chat") }),
        now: NOW
      }
    );
    expect(response.targetBoundary.boundaryHash).toBe(scope.targetBoundaryHash);
  });
});

describe("aw-target-boundary/1 bindings", () => {
  const response = () => contractResponse<ExecutionScopeResponse>("get_scope");

  it("rejects a scope response whose boundary is for another target revision", () => {
    const value = response();
    const boundary = sealDocumentHash({ ...value.targetBoundary, revision: 2 }, "boundaryHash");
    const rebound = sealDocumentHash(
      { ...value.scope, targetBoundaryHash: boundary.boundaryHash },
      "scopeHash"
    );
    expect(() => parseExecutionScopeResponse({ ...value, scope: rebound, targetBoundary: boundary })).toThrow(
      expect.objectContaining({ code: "TARGET_SCOPE_MISMATCH" })
    );
  });

  it("rejects a boundary whose hash doesn't match its document", () => {
    const value = response();
    const forged: TargetBoundary = { ...value.targetBoundary, endpoints: [{ method: "POST", path: "/admin" }] };
    expect(() => parseTargetBoundary(forged)).toThrow(expect.objectContaining({ code: "TARGET_SCOPE_MISMATCH" }));
    expect(() => parseExecutionScopeResponse({ ...value, targetBoundary: forged })).toThrow(
      expect.objectContaining({ code: "TARGET_SCOPE_MISMATCH" })
    );
  });

  it("rejects a configured operation outside the admitted endpoints", () => {
    const boundary = contractFixture<TargetBoundary>("target_boundary");
    expect(() =>
      assertBoundaryMatchesConfig(boundary, resolvedTarget("https://support.example.com", { send: send("/chat") }))
    ).not.toThrow();
    expect(() =>
      assertBoundaryMatchesConfig(boundary, resolvedTarget("https://support.example.com", { send: send("/v2/chat") }))
    ).toThrow(expect.objectContaining({ code: "TARGET_SCOPE_MISMATCH" }));
    expect(() =>
      assertBoundaryMatchesConfig(boundary, resolvedTarget("https://other.example.com", { send: send("/chat") }))
    ).toThrow(expect.objectContaining({ code: "TARGET_SCOPE_MISMATCH" }));
  });

  it("refuses a browser_bridge boundary", () => {
    const boundary = sealDocumentHash(
      { ...contractFixture<TargetBoundary>("target_boundary"), transport: "browser_bridge" as const },
      "boundaryHash"
    );
    expect(() =>
      assertBoundaryMatchesConfig(boundary, resolvedTarget("https://support.example.com", { send: send("/chat") }))
    ).toThrow(expect.objectContaining({ code: "TARGET_SCOPE_MISMATCH" }));
  });

  it("rebuilds a local scope's boundary from the configuration and checks its hash", () => {
    const local = contractFixture<LocalExecutionScope>("execution_scope_local");
    const resolved = resolvedTarget("http://127.0.0.1:8000", { send: send("/chat") });
    const boundary = sealDocumentHash(
      {
        schemaVersion: "aw-target-boundary/1" as const,
        targetId: local.targetId,
        revision: local.targetRevision,
        boundaryHash: "0".repeat(64),
        transport: "direct_http" as const,
        effectBoundary: "read_only_enforced" as const,
        assessedIdentity: "http://127.0.0.1:8000",
        endpoints: [{ method: "POST" as const, path: "/chat" }]
      },
      "boundaryHash"
    );
    const scope = sealDocumentHash({ ...local, targetBoundaryHash: boundary.boundaryHash }, "scopeHash");
    expect(localTargetBoundary(scope, resolved)).toEqual(boundary);
    expect(() =>
      localTargetBoundary(scope, resolvedTarget("http://127.0.0.1:8000", { send: send("/other") }))
    ).toThrow(expect.objectContaining({ code: "TARGET_SCOPE_MISMATCH" }));
  });
});
