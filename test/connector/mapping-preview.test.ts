import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { SINGLE_TURN_CONVERSATION } from "../../src/config/conversation.js";
import type { AugmentWorksConfig } from "../../src/config/types.js";
import { HttpConnector } from "../../src/connector/http.js";
import { previewMapping } from "../../src/connector/mapping-preview.js";
import { normalizeConnectorResult } from "../../src/connector/normalize.js";
import type { ConnectorExecutionContext } from "../../src/connector/types.js";
import { AwError } from "../../src/errors.js";
import { canonicalize, sha256 } from "../../src/util/canonical.js";
import { LIMITS } from "../../src/util/limits.js";

const fixtures = resolve(fileURLToPath(new URL("../fixtures/mapping-preview", import.meta.url)));

const EXCLUDED_SECRETS = [
  "synthetic-preview-bearer-token",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature123456",
  "nested-synthetic-password-value",
  "nested-synthetic-api-key-value",
  "SYNTHETIC_EXCLUDED_SECRET_do_not_leak",
  "should-never-appear-unmapped-secret",
  "SYNTHETIC_OBSERVE_EXCLUDED_SECRET_do_not_leak",
  "SYNTHETIC_OBSERVE_MISSING_SECRET_do_not_leak",
  "missing-content-must-not-leak-SYNTHETIC"
] as const;

function chatConfig(): AugmentWorksConfig {
  return {
    version: 1,
    target: {
      name: "preview-chat",
      connector: "http",
      base_url: "http://127.0.0.1:9",
      operations: {
        send: {
          method: "POST",
          path: "/chat",
          response: {
            content: "$.answer",
            finish_reason: "$.finish_reason",
            finished: "$.finished",
            tool_events: "$.events"
          }
        }
      }
    },
    telemetry: {
      allow_tool_events: false,
      allow_observations: []
    }
  };
}

function statefulConfig(): AugmentWorksConfig {
  return {
    version: 1,
    target: {
      name: "preview-stateful",
      connector: "http",
      base_url: "http://127.0.0.1:9",
      operations: {
        prepare: { method: "POST", path: "/prepare", idempotent: true },
        send: {
          method: "POST",
          path: "/chat",
          response: {
            content: "$.answer",
            finish_reason: "$.finish_reason",
            finished: "$.finished",
            tool_events: "$.events"
          }
        },
        observe: {
          method: "POST",
          path: "/observe",
          idempotent: true,
          response: {
            "order.status": "$.order.status",
            "order.refunded_amount": "$.order.refunded_amount",
            "order.refundable": "$.order.refundable"
          }
        },
        cleanup: { method: "POST", path: "/cleanup", idempotent: true }
      }
    },
    telemetry: {
      allow_tool_events: true,
      allow_observations: ["order.status", "order.refunded_amount", "order.refundable"]
    }
  };
}

async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(fixtures, name), "utf8"));
}

function leakText(value: unknown): string {
  return JSON.stringify(value);
}

function expectNoExcludedSecrets(value: unknown): void {
  const text = leakText(value);
  for (const secret of EXCLUDED_SECRETS) {
    expect(text).not.toContain(secret);
  }
}

function previewContext(): ConnectorExecutionContext {
  return {
    commandId: "preview_command",
    idempotencyKey: "preview_idempotency",
    turnId: "preview_turn",
    attemptId: "preview_attempt",
    requestId: "preview_request"
  };
}

describe("mapping preview service", () => {
  it("projects send evidence with the production normalizer and matching canonical bytes", async () => {
    const response = (await readFixture("send-valid.json")) as {
      answer: string;
      finished: boolean;
      finish_reason: string;
      events: unknown[];
    };
    const config = chatConfig();
    const report = previewMapping({
      config,
      operation: "send",
      response: response as never
    });

    expect(report.ok).toBe(true);
    expect(report.offline).toBe(true);
    expect(report.credits_consumed).toBe(0);
    expect(report.extracted.map((item) => item.field)).toEqual(["content", "finish_reason", "finished"]);
    expect(report.omitted.map((item) => item.field)).toEqual(["tool_events"]);
    expect(report.missing).toEqual([]);
    expect(report.evidence).not.toBeNull();

    const production = normalizeConnectorResult({
      kind: "send",
      input: { turn_id: "preview_turn" },
      context: previewContext(),
      response: response as never,
      responseMap: config.target.operations.send.response,
      allowToolEvents: false,
      allowedObservations: new Set(),
      secrets: []
    });
    expect(report.evidence?.canonical).toBe(canonicalize(production));
    expect(report.evidence?.sha256).toBe(sha256(canonicalize(production)));
    expect(report.evidence?.bytes).toBe(Buffer.byteLength(canonicalize(production), "utf8"));
  });

  it("matches HttpConnector relay evidence bytes for the same fixture", async () => {
    const response = (await readFixture("send-valid.json")) as never;
    const config = statefulConfig();
    const resolved = {
      config,
      configPath: "/project/augmentworks.yaml",
      configDirectory: "/project",
      configDigest: "digest",
      baseUrl: new URL("http://127.0.0.1:9"),
      authHeaders: {},
      secrets: [] as const,
      capabilities: {
        level: "stateful" as const,
        prepare: true,
        observation: true,
        cleanup: true,
        tool_events: true
      },
      conversation: SINGLE_TURN_CONVERSATION,
      warnings: []
    };
    const connector = new HttpConnector(resolved, {
      fetch: async () => Response.json(response)
    });
    const result = await connector.execute("send", { turn_id: "preview_turn" }, previewContext());
    const report = previewMapping({ config, operation: "send", response });
    expect(report.ok).toBe(true);
    expect(report.evidence?.canonical).toBe(canonicalize(result));
  });

  it("redacts mapped secrets and never emits excluded nested values", async () => {
    const response = (await readFixture("send-nested-secrets.json")) as never;
    const report = previewMapping({
      config: statefulConfig(),
      operation: "send",
      response
    });

    expect(report.ok).toBe(true);
    expect(report.redacted.some((item) => item.field === "content")).toBe(true);
    expect(report.extracted.find((item) => item.field === "content")?.preview).toContain("[REDACTED]");
    expect(report.evidence?.canonical).toContain("[REDACTED]");
    expectNoExcludedSecrets(report);
    expect(report.disclaimer).toContain("does not guarantee that future responses are secret-free");
  });

  it("explains a missing required mapped field without dumping the fixture", async () => {
    const response = (await readFixture("send-missing-content.json")) as never;
    const report = previewMapping({
      config: chatConfig(),
      operation: "send",
      response
    });

    expect(report.ok).toBe(false);
    expect(report.evidence).toBeNull();
    expect(report.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "content",
          selector: "$.answer",
          path: "target.operations.send.response.content",
          code: "MAPPING_VALUE_MISSING"
        })
      ])
    );
    expect(report.diagnostics.map((item) => item.code)).toContain("MAPPING_VALUE_MISSING");
    expectNoExcludedSecrets(report);
  });

  it("reports invalid selector offsets with the configuration path", () => {
    const config = chatConfig();
    config.target.operations.send.response = { content: "$.answer[" };
    const report = previewMapping({
      config,
      operation: "send",
      response: { answer: "hidden-secret-must-not-leak" }
    });

    expect(report.ok).toBe(false);
    const diagnostic = report.diagnostics.find((item) => item.code === "INVALID_SELECTOR");
    expect(diagnostic?.path).toBe("target.operations.send.response.content");
    expect(diagnostic?.message).toContain("offset");
    expect(leakText(report)).not.toContain("hidden-secret-must-not-leak");
  });

  it("rejects prototype selectors without leaking fixture values", () => {
    const config = chatConfig();
    config.target.operations.send.response = { content: "$.__proto__.polluted" };
    const report = previewMapping({
      config,
      operation: "send",
      response: { answer: "proto-secret-must-not-leak" }
    });
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((item) => item.code)).toContain("UNSAFE_SELECTOR");
    expect(leakText(report)).not.toContain("proto-secret-must-not-leak");
  });

  it("makes oversized assistant content truncation visible and omits the body", () => {
    const oversized = "x".repeat(LIMITS.maxMessageBytes + 8);
    const report = previewMapping({
      config: chatConfig(),
      operation: "send",
      response: { answer: oversized, finished: true, finish_reason: "stop" }
    });

    expect(report.ok).toBe(false);
    expect(report.evidence).toBeNull();
    expect(report.truncation).toEqual([
      expect.objectContaining({
        field: "content",
        decision: "rejected",
        actual_bytes: LIMITS.maxMessageBytes + 8,
        limit_bytes: LIMITS.maxMessageBytes,
        code: "TARGET_MESSAGE_TOO_LARGE"
      })
    ]);
    expect(leakText(report)).not.toContain(oversized);
    expect(report.extracted.find((item) => item.field === "content")?.display_truncated).toBe(true);
    expect(report.extracted.find((item) => item.field === "content")?.preview).toContain("TRUNCATED");
  });

  it("previews observe allowlisted fields and omits excluded nested secrets", async () => {
    const response = (await readFixture("observe-valid.json")) as never;
    const report = previewMapping({
      config: statefulConfig(),
      operation: "observe",
      response
    });

    expect(report.ok).toBe(true);
    expect(report.extracted.map((item) => item.field)).toEqual([
      "order.refundable",
      "order.refunded_amount",
      "order.status"
    ]);
    expect(report.evidence?.result).toMatchObject({
      protocol_version: "aw-target/0.1",
      observations: expect.arrayContaining([
        expect.objectContaining({ key: "order.status", value: "paid" })
      ])
    });
    expectNoExcludedSecrets(report);
  });

  it("explains missing observe fields without printing excluded source values", async () => {
    const response = (await readFixture("observe-missing.json")) as never;
    const report = previewMapping({
      config: statefulConfig(),
      operation: "observe",
      response
    });

    expect(report.ok).toBe(false);
    expect(report.missing.map((item) => item.field)).toEqual(
      expect.arrayContaining(["order.refunded_amount", "order.status"])
    );
    expectNoExcludedSecrets(report);
  });

  it("previews cleanup evidence without a response fixture or extra hooks", () => {
    const report = previewMapping({
      config: statefulConfig(),
      operation: "cleanup"
    });
    expect(report.ok).toBe(true);
    expect(report.evidence?.result).toEqual({
      protocol_version: "aw-target/0.1",
      status: "cleaned",
      attempt_id: "preview_attempt"
    });
    expect(report.evidence?.canonical).toBe(
      canonicalize({
        protocol_version: "aw-target/0.1",
        status: "cleaned",
        attempt_id: "preview_attempt"
      })
    );
  });

  it("does not require observe or cleanup hooks for a send-only preview", () => {
    const report = previewMapping({
      config: chatConfig(),
      operation: "observe",
      response: { order: { status: "paid" } }
    });
    expect(report.ok).toBe(false);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CONNECTOR_OPERATION_NOT_CONFIGURED",
          path: "target.operations.observe"
        })
      ])
    );
  });

  it("applies inspectOutbound when a frozen policy is supplied without calling the network", async () => {
    const { CANARIES, makePolicy, makeProfile } = await import("../data-policy/helpers.js");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const profile = makeProfile({
      rules: [{ id: "mask-email", selector: "/content/content", action: "mask", detector: "email" }]
    });
    const policy = makePolicy(profile, { dataClass: "public" });
    const report = previewMapping({
      config: chatConfig(),
      operation: "send",
      response: {
        answer: `Hello ${CANARIES.email} token ${CANARIES.secret}`,
        finished: true,
        finish_reason: "stop"
      },
      secrets: [CANARIES.secret],
      policy,
      profile
    });
    expect(report.offline).toBe(true);
    expect(report.credits_consumed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(report.privacy?.effective.dataClass).toBe("public");
    expect(report.privacy?.hosted_real_data_release).toBe("unavailable");
    expect(report.privacy?.receipt.representationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(leakText(report)).not.toContain(CANARIES.secret);
    expect(leakText(report)).not.toContain(CANARIES.email);
    expect(report.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it("previews a verbatim policy the way it uploads: email kept, secret masked (AUG-417)", async () => {
    const { CANARIES, makePolicy, makeProfile } = await import("../data-policy/helpers.js");
    const profile = makeProfile({
      rules: [{ id: "mask-email", selector: "/content/content", action: "mask", detector: "email" }]
    });
    const policy = makePolicy(profile, { dataClass: "personal", contentHandling: "verbatim" });
    const report = previewMapping({
      config: chatConfig(),
      operation: "send",
      response: {
        answer: `Hello ${CANARIES.email} token ${CANARIES.secret}`,
        finished: true,
        finish_reason: "stop"
      },
      secrets: [CANARIES.secret],
      policy,
      profile
    });
    const answer = report.extracted.find((field) => field.preview?.includes("Hello"));
    expect(answer?.preview).toContain(CANARIES.email);
    expect(leakText(report)).not.toContain(CANARIES.secret);
    expect(report.ok).toBe(true);
  });
});

describe("mapping selector locations", () => {
  it("includes the selector offset on invalid syntax", async () => {
    const { selectResponse } = await import("../../src/connector/mapping.js");
    try {
      selectResponse({ answer: "x" }, "$.answer[");
      throw new Error("expected INVALID_SELECTOR");
    } catch (error) {
      expect(error).toBeInstanceOf(AwError);
      expect(error).toMatchObject({
        code: "INVALID_SELECTOR",
        details: { selector: "$.answer[", offset: 8 }
      });
      expect((error as AwError).message).toContain("offset 8");
    }
  });
});
