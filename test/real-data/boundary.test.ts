import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../../src/config/resolve.js";
import type { AugmentWorksConfig } from "../../src/config/types.js";
import { sealDocumentHash } from "../../src/real-data/canonical.js";
import { assertBoundaryMatchesConfig, localTargetBoundary } from "../../src/real-data/boundary.js";
import type { TargetBoundary } from "../../src/real-data/documents.js";
import { loadPersistedDispatchPolicy } from "../../src/real-data/hosted.js";
import { localBinding, persistExecutionScopeBinding } from "../../src/real-data/scope-store.js";
import { sealedBoundary, sealedLocalScope, sealedPolicy } from "./helpers.js";

type Operations = AugmentWorksConfig["target"]["operations"];

function resolvedTarget(baseUrl: string, operations: Operations) {
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
const observe = (path: string) => ({
  method: "POST" as const,
  path,
  idempotent: true,
  request: { attempt_id: "$input.attempt_id" },
  response: { "order.status": "$.order.status" }
});
const prepare = (path: string) => ({
  method: "POST" as const,
  path,
  idempotent: true,
  request: { run_id: "$input.run_id" }
});

function failure(run: () => unknown): { code?: string; message: string } {
  try {
    run();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("expected a failure");
}

describe("target boundary rules (AUG-355)", () => {
  const boundary = sealedBoundary({
    endpoints: [
      { method: "POST", path: "/chat" },
      { method: "POST", path: "/observe" },
      { method: "POST", path: "/prepare" }
    ]
  });

  it("requires direct_http transport", () => {
    const config = resolvedTarget("https://support.example.com", { send: send("/chat") });
    expect(() => assertBoundaryMatchesConfig(boundary, config)).not.toThrow();
    const bridged = sealedBoundary({ transport: "browser_bridge" });
    const error = failure(() => assertBoundaryMatchesConfig(bridged, config));
    expect(error.code).toBe("TARGET_SCOPE_MISMATCH");
    expect(error.message).toContain("browser_bridge");
    expect(error.message).toContain("direct HTTP");
  });

  it("requires base_url's canonical origin to be the registered address", () => {
    for (const baseUrl of ["https://support.example.com", "https://SUPPORT.example.com:443/", "https://support.example.com/api"]) {
      expect(() =>
        assertBoundaryMatchesConfig(boundary, resolvedTarget(baseUrl, { send: send("/chat") }))
      ).not.toThrow();
    }
    const schemeless = sealedBoundary({ assessedIdentity: "support.example.com" });
    expect(() =>
      assertBoundaryMatchesConfig(schemeless, resolvedTarget("https://support.example.com", { send: send("/chat") }))
    ).not.toThrow();

    const error = failure(() =>
      assertBoundaryMatchesConfig(boundary, resolvedTarget("https://staging.example.com", { send: send("/chat") }))
    );
    expect(error.code).toBe("TARGET_SCOPE_MISMATCH");
    expect(error.message).toContain("https://staging.example.com");
    expect(error.message).toContain("Set base_url to https://support.example.com");
  });

  it("requires every configured operation to resolve to a registered endpoint", () => {
    expect(() =>
      assertBoundaryMatchesConfig(
        boundary,
        resolvedTarget("https://support.example.com", { send: send("/chat"), observe: observe("/observe") })
      )
    ).not.toThrow();
    // Paths resolve against base_url, as the HTTP connector calls them.
    expect(() =>
      assertBoundaryMatchesConfig(boundary, resolvedTarget("https://support.example.com/v2/", { send: send("chat") }))
    ).toThrow(expect.objectContaining({ code: "TARGET_SCOPE_MISMATCH" }));

    const error = failure(() =>
      assertBoundaryMatchesConfig(
        boundary,
        resolvedTarget("https://support.example.com", { send: send("/chat"), observe: observe("/status") })
      )
    );
    expect(error.code).toBe("TARGET_SCOPE_MISMATCH");
    expect(error.message).toContain("observe operation in augmentworks.yaml calls POST /status");
    expect(error.message).toContain("POST /chat, POST /observe, POST /prepare");
  });

  it("allows only send and observe for informational scopes", () => {
    const withPrepare = resolvedTarget("https://support.example.com", {
      prepare: prepare("/prepare"),
      send: send("/chat"),
      observe: observe("/observe")
    });
    expect(() =>
      assertBoundaryMatchesConfig(
        boundary,
        resolvedTarget("https://support.example.com", { send: send("/chat"), observe: observe("/observe") }),
        { effects: "informational" }
      )
    ).not.toThrow();
    expect(() => assertBoundaryMatchesConfig(boundary, withPrepare, { effects: "sandbox_actions" })).not.toThrow();
    const error = failure(() => assertBoundaryMatchesConfig(boundary, withPrepare, { effects: "informational" }));
    expect(error.code).toBe("ACTION_NOT_ALLOWED");
    expect(error.message).toContain("Remove target.operations.prepare");
  });

  it("accepts the effect boundary whose rebuilt hash matches a local scope", () => {
    const resolved = resolvedTarget("http://127.0.0.1:8000", { send: send("/chat") });
    const local: TargetBoundary = sealDocumentHash(
      {
        ...sealedBoundary(),
        effectBoundary: "action_gateway" as const,
        assessedIdentity: "http://127.0.0.1:8000",
        endpoints: [{ method: "POST" as const, path: "/chat" }]
      },
      "boundaryHash"
    );
    const scope = sealedLocalScope(local, sealedPolicy());
    expect(localTargetBoundary(scope, resolved)).toEqual(local);

    const error = failure(() =>
      localTargetBoundary(scope, resolvedTarget("http://127.0.0.1:8000", { send: send("/other") }))
    );
    expect(error.code).toBe("TARGET_SCOPE_MISMATCH");
    expect(error.message).toContain("http://127.0.0.1:8000: POST /other");
  });

  it("resumes a local run from the boundary stored with its scope", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "aw-boundary-"));
    const resolved = resolvedTarget("http://127.0.0.1:8000", { send: send("/chat") });
    const local: TargetBoundary = sealDocumentHash(
      {
        ...sealedBoundary(),
        assessedIdentity: "http://127.0.0.1:8000",
        endpoints: [{ method: "POST" as const, path: "/chat" }]
      },
      "boundaryHash"
    );
    const scope = sealedLocalScope(local, sealedPolicy());
    const binding = localBinding({
      runId: "run-local-1",
      configSha256: resolved.configDigest,
      scope,
      boundary: localTargetBoundary(scope, resolved)
    });
    expect(binding.targetBoundary).toEqual(local);
    await persistExecutionScopeBinding(binding, { stateDirectory });

    const policy = await loadPersistedDispatchPolicy({
      runId: "run-local-1",
      configSha256: resolved.configDigest,
      stateDirectory
    });
    expect(policy?.kind === "authorized" && policy.boundary).toEqual(local);

    await persistExecutionScopeBinding(
      { ...binding, runId: "run-local-2", targetBoundary: sealedBoundary() },
      { stateDirectory }
    );
    await expect(
      loadPersistedDispatchPolicy({ runId: "run-local-2", configSha256: resolved.configDigest, stateDirectory })
    ).rejects.toMatchObject({ code: "TARGET_SCOPE_MISMATCH" });
  });
});
