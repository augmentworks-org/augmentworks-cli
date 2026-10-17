import { describe, expect, it } from "vitest";

import { projectAssessmentReferencePayload, projectRelayResult } from "../../src/data-policy/index.js";
import { CANARIES, makeContext } from "./helpers.js";

describe("projection hooks", () => {
  it("persists only a sanitized failure when a send result is blocked", () => {
    const context = makeContext("business", "minimized", [
      { id: "block-content", selector: "/content/content", action: "block", detector: "field" }
    ]);
    const projected = projectRelayResult(
      "send",
      {
        protocol_version: "aw-target/0.1",
        turn_id: "turn-1",
        message: { role: "assistant", content: CANARIES.secret },
        events: [],
        finished: true,
        metadata: {}
      },
      context
    );
    expect(projected.disposition).toBe("blocked");
    expect(projected.result).toBeUndefined();
    expect(projected.failure).toMatchObject({
      code: "DATA_POLICY_BLOCKED",
      retryable: false
    });
    expect(JSON.stringify(projected)).not.toContain(CANARIES.secret);
  });

  it("keeps a send reply under an ingress profile that allows only /path and /content (AUG-357)", () => {
    const context = makeContext(
      "business",
      "minimized",
      [
        { id: "mask-credential-content", selector: "/content", action: "mask", detector: "credential" },
        { id: "mask-local-secret-content", selector: "/content", action: "mask", detector: "exact_local_secret" }
      ],
      ["/path", "/content"]
    );
    const projected = projectRelayResult(
      "send",
      {
        protocol_version: "aw-target/0.1",
        turn_id: "turn-1",
        message: { role: "assistant", content: `Weekday support hours are 9:00-17:00 UTC. ${CANARIES.secret}` },
        events: [
          {
            event_id: "event-1",
            type: "tool_result",
            tool_name: "lookup_hours",
            call_id: "call-1",
            output: { hours: "9-17", password: CANARIES.password },
            success: true
          }
        ],
        finished: true,
        metadata: {}
      },
      context
    );
    expect(projected.disposition).toBe("completed");
    expect(projected.result).toMatchObject({
      turn_id: "turn-1",
      finished: true,
      message: { role: "assistant" },
      events: [{ type: "tool_result", call_id: "call-1", output: { hours: "9-17" } }]
    });
    expect(JSON.stringify(projected.result)).toContain("Weekday support hours are 9:00-17:00 UTC.");
    expect(JSON.stringify(projected)).not.toContain(CANARIES.secret);
    expect(JSON.stringify(projected)).not.toContain(CANARIES.password);
  });

  it("marks insufficient evidence instead of letting a placeholder pass", () => {
    const context = makeContext("public", "minimized", [
      { id: "mask-content", selector: "/content/content", action: "mask", detector: "field" }
    ]);
    const projected = projectRelayResult(
      "send",
      {
        protocol_version: "aw-target/0.1",
        turn_id: "turn-1",
        message: { role: "assistant", content: "Keep the 14-day window" },
        events: [],
        finished: true,
        metadata: {}
      },
      context,
      ["14-day window"]
    );
    expect(projected.disposition).toBe("insufficient_evidence");
    expect(projected.receipt.outcome).toBe("insufficient_evidence");
    expect(projected.failure?.code).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("rehashes assessment reference content after masking and never echoes secrets", () => {
    const context = makeContext("public", "minimized", [
      { id: "mask-content", selector: "/entries/*/content", action: "mask", detector: "email" }
    ]);
    const payload = projectAssessmentReferencePayload(
      {
        bundleId: "bundle_test",
        entries: [
          {
            id: "faq",
            kind: "reference_facts",
            sourceLabel: "references/faq.md",
            scope: "local",
            content: `Email ${CANARIES.email} about returns.`,
            contentHash: "a".repeat(64),
            complete: true
          }
        ],
        refundPolicy: null,
        knowledgeBoundary: "local",
        targetAlreadyConfigured: true
      },
      context
    );
    expect(payload.entries[0]?.content).not.toContain(CANARIES.email);
    expect(payload.entries[0]?.contentHash).not.toBe("a".repeat(64));
    expect(payload.entries[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
