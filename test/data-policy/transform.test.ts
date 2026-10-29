import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CLI_VERSION } from "../../src/version.js";
import {
  activeRedactionRules,
  applyRedactionProfile,
  inspectOutbound,
  PLACEHOLDERS,
  sealDataHandlingReceipt,
  type RedactionRule
} from "../../src/data-policy/index.js";
import { CANARIES, makePolicy, makeProfile } from "./helpers.js";

const canaryPath = resolve(fileURLToPath(new URL("../fixtures/data-policy/canary-document.json", import.meta.url)));

describe("applyRedactionProfile", () => {
  it("masks credentials in both minimized and verbatim modes", async () => {
    const document = JSON.parse(await readFile(canaryPath, "utf8")) as Record<string, unknown>;
    const profile = makeProfile();
    for (const contentHandling of ["minimized", "verbatim"] as const) {
      const policy = makePolicy(profile, { contentHandling, dataClass: "personal" });
      const result = applyRedactionProfile(document, profile, policy, [CANARIES.secret, CANARIES.token]);
      const text = JSON.stringify(result.representation);
      expect(text).not.toContain(CANARIES.secret);
      expect(text).not.toContain(CANARIES.token);
      expect(text).not.toContain(CANARIES.apiKey);
      expect(text).not.toContain(CANARIES.password);
      expect(text).toContain(PLACEHOLDERS.credential);
      expect(result.counts.masked).toBeGreaterThan(0);
    }
  });

  it("keeps expressly permitted personal content in verbatim mode but still drops credentials", async () => {
    const profile = makeProfile();
    const policy = makePolicy(profile, { contentHandling: "verbatim", dataClass: "personal" });
    const result = applyRedactionProfile(
      { note: `Contact ${CANARIES.email} secret ${CANARIES.secret}`, status: "passed" },
      profile,
      policy,
      [CANARIES.secret]
    );
    const text = JSON.stringify(result.representation);
    expect(text).toContain(CANARIES.email);
    expect(text).not.toContain(CANARIES.secret);
    expect(text).toContain("passed");
  });

  describe("rule selection by content handling (AUG-417)", () => {
    const phone = "+1 555 0197 4242";
    const rules: RedactionRule[] = [
      { id: "mask-credential-content", selector: "/content", action: "mask", detector: "credential" },
      { id: "mask-email-content", selector: "/content", action: "mask", detector: "email" },
      { id: "mask-phone-content", selector: "/content", action: "mask", detector: "phone" },
      { id: "mask-local-secret-content", selector: "/content", action: "mask", detector: "exact_local_secret" },
      { id: "drop-internal-notes", selector: "/internalNotes", action: "drop", detector: "field" }
    ];
    const document = {
      path: "message",
      content: { role: "assistant", content: `Write to ${CANARIES.email} or call ${phone}.` },
      apiNote: `api_key=${CANARIES.apiKey}`,
      localNote: `local ${CANARIES.secret}`,
      internalNotes: "kept under verbatim"
    };

    it("verbatim keeps email, phone and fields but masks credentials and exact local secrets", () => {
      const profile = makeProfile({ rules, allowedContentFields: ["/path", "/content"] });
      const policy = makePolicy(profile, { contentHandling: "verbatim", dataClass: "personal" });
      const result = applyRedactionProfile(document, profile, policy, [CANARIES.secret]);
      const text = JSON.stringify(result.representation);
      expect(text).toContain(CANARIES.email);
      expect(text).toContain(phone);
      expect(text).not.toContain(PLACEHOLDERS.email);
      expect(text).not.toContain(PLACEHOLDERS.phone);
      expect(text).not.toContain(CANARIES.apiKey);
      expect(text).not.toContain(CANARIES.secret);
      expect(text).toContain(PLACEHOLDERS.credential);
      expect(text).toContain(PLACEHOLDERS.exact_local_secret);
      expect((result.representation as { internalNotes?: string }).internalNotes).toBe("kept under verbatim");
    });

    it("verbatim still applies credential and exact-local-secret profile rules", () => {
      const profile = makeProfile({
        rules: [
          { id: "block-credential", selector: "/content", action: "block", detector: "credential" },
          { id: "mask-email-content", selector: "/content", action: "mask", detector: "email" }
        ]
      });
      const policy = makePolicy(profile, { contentHandling: "verbatim", dataClass: "personal" });
      const result = applyRedactionProfile(
        { content: `Mail ${CANARIES.email} key ${CANARIES.apiKey}` },
        profile,
        policy,
        []
      );
      expect(result.blockedPaths).toEqual([{ path: "/content", action: "block", ruleId: "block-credential" }]);
    });

    it("minimized masks email, phone and credentials and applies field rules", () => {
      const profile = makeProfile({ rules, allowedContentFields: ["/path", "/content", "/apiNote", "/localNote"] });
      const policy = makePolicy(profile, { contentHandling: "minimized", dataClass: "personal" });
      const result = applyRedactionProfile(document, profile, policy, [CANARIES.secret]);
      const text = JSON.stringify(result.representation);
      expect(text).not.toContain(CANARIES.email);
      expect(text).not.toContain(phone);
      expect(text).not.toContain(CANARIES.apiKey);
      expect(text).not.toContain(CANARIES.secret);
      expect(text).toContain(`Write to ${PLACEHOLDERS.email} or call ${PLACEHOLDERS.phone}.`);
      expect(text).toContain(PLACEHOLDERS.credential);
      expect(text).not.toContain("kept under verbatim");
    });

    it("selects the same rule kinds as the server contract", () => {
      const profile = makeProfile({ rules });
      expect(
        activeRedactionRules(profile, { contentHandling: "verbatim" }).map((rule) => rule.detector)
      ).toEqual(["credential", "exact_local_secret"]);
      expect(activeRedactionRules(profile, { contentHandling: "minimized" })).toEqual(rules);
    });
  });

  it("masks email and phone only when explicit rules request it", () => {
    const profile = makeProfile({
      rules: [
        { id: "mask-email", selector: "/note", action: "mask", detector: "email" },
        { id: "mask-phone", selector: "/note", action: "mask", detector: "phone" }
      ]
    });
    const policy = makePolicy(profile, { dataClass: "public", contentHandling: "minimized" });
    const result = applyRedactionProfile(
      { note: `Call ${CANARIES.phone} or ${CANARIES.email}` },
      profile,
      policy,
      []
    );
    const text = JSON.stringify(result.representation);
    expect(text).toContain(PLACEHOLDERS.email);
    expect(text).toContain(PLACEHOLDERS.phone);
    expect(text).not.toContain(CANARIES.email);
    expect(text).not.toContain(CANARIES.phone);
  });

  it("does not redact structural enums when a secret equals a status string", () => {
    const profile = makeProfile();
    const policy = makePolicy(profile);
    const result = applyRedactionProfile(
      { protocol_version: "aw-target/0.1", status: "passed", note: "passed" },
      profile,
      policy,
      ["passed"]
    );
    const representation = result.representation as Record<string, unknown>;
    expect(representation["status"]).toBe("passed");
    expect(representation["protocol_version"]).toBe("aw-target/0.1");
    expect(representation["note"]).toBe(PLACEHOLDERS.exact_local_secret);
  });

  it("drops non-allowlisted fields in minimized mode and keeps allowlisted paths", () => {
    const profile = makeProfile({
      allowedContentFields: ["/message", "/protocol_version"]
    });
    const policy = makePolicy(profile, { contentHandling: "minimized" });
    const result = applyRedactionProfile(
      {
        protocol_version: "aw-target/0.1",
        message: { role: "assistant", content: "ok" },
        extra: "drop-me",
        status: "passed"
      },
      profile,
      policy,
      []
    );
    const representation = result.representation as Record<string, unknown>;
    expect(representation["message"]).toEqual({ role: "assistant", content: "ok" });
    expect(representation["extra"]).toBeUndefined();
    expect(representation["status"]).toBe("passed");
    expect(result.counts.dropped).toBeGreaterThan(0);
  });

  it("applies block over drop over mask and omits raw values from blocked paths", () => {
    const profile = makeProfile({
      rules: [
        { id: "mask-note", selector: "/secret_field", action: "mask", detector: "field" },
        { id: "block-note", selector: "/secret_field", action: "block", detector: "field" },
        { id: "drop-other", selector: "/other", action: "drop", detector: "field" }
      ]
    });
    const policy = makePolicy(profile);
    const result = applyRedactionProfile(
      { secret_field: CANARIES.secret, other: "x", keep: true },
      profile,
      policy,
      []
    );
    const representation = result.representation as Record<string, unknown>;
    expect(representation["secret_field"]).toBeUndefined();
    expect(representation["other"]).toBeUndefined();
    expect(representation["keep"]).toBe(true);
    expect(result.blockedPaths).toEqual([
      { path: "/secret_field", action: "block", ruleId: "block-note" }
    ]);
    expect(JSON.stringify(result)).not.toContain(CANARIES.secret);
  });

  it("masks URL query secrets, nested tool arguments, and unicode content", async () => {
    const document = JSON.parse(await readFile(canaryPath, "utf8")) as Record<string, unknown>;
    const profile = makeProfile({
      rules: [{ id: "mask-content", selector: "/message/content", action: "mask", detector: "email" }]
    });
    const policy = makePolicy(profile, { dataClass: "public" });
    const result = applyRedactionProfile(document, profile, policy, [CANARIES.secret, CANARIES.token]);
    const text = JSON.stringify(result.representation);
    expect(text).not.toContain(CANARIES.token);
    expect(text).not.toContain(CANARIES.secret);
    expect(text).not.toContain(CANARIES.email);
    expect(text).not.toContain(CANARIES.password);
    expect(text).toContain("order-1");
    expect(text).toContain("café-日本語");
    expect(text).toContain("passed");
  });

  it("fails closed on a stale policy hash before transforming", () => {
    const profile = makeProfile();
    const policy = { ...makePolicy(profile), policyHash: "a".repeat(64) };
    expect(() => applyRedactionProfile({ ok: true }, profile, policy, [])).toThrowError(
      expect.objectContaining({ code: "DATA_POLICY_STALE", retryable: false })
    );
  });

  it("fails closed on an unknown selector", () => {
    const profile = makeProfile({
      rules: [{ id: "bad", selector: "$.email", action: "drop", detector: "field" }]
    });
    const policy = makePolicy(profile);
    expect(() => applyRedactionProfile({ email: "x" }, profile, policy, [])).toThrowError(
      expect.objectContaining({ code: "REDACTION_PROFILE_MISMATCH" })
    );
  });

  it("blocks oversized documents and overlong strings", () => {
    const profile = makeProfile({ maxDocumentBytes: 32, maxTextChars: 4 });
    const policy = makePolicy(profile);
    expect(() => applyRedactionProfile({ note: "toolong" }, profile, policy, [])).toThrowError(
      expect.objectContaining({ code: "DATA_POLICY_BLOCKED" })
    );
  });
});

describe("inspectOutbound and receipts", () => {
  it("returns metadata-only blocked paths and hashes only the retained representation", () => {
    const profile = makeProfile({
      rules: [{ id: "block-note", selector: "/note", action: "block", detector: "field" }]
    });
    const policy = makePolicy(profile);
    const inspected = inspectOutbound({ note: CANARIES.secret, keep: 1 }, policy, profile, []);
    expect(inspected.receipt.schemaVersion).toBe("aw-data-handling-receipt/1");
    expect(inspected.receipt.outcome).toBe("blocked");
    expect(inspected.receipt.processor).toBe("cli");
    expect(inspected.receipt.processorVersion).toBe(CLI_VERSION);
    expect(JSON.stringify(inspected)).not.toContain(CANARIES.secret);
    expect(inspected.blockedPaths[0]).toEqual({
      path: "/note",
      action: "block",
      ruleId: "block-note"
    });
    const sealed = sealDataHandlingReceipt({
      policy,
      profile,
      representation: inspected.representation,
      counts: inspected.receipt.counts
    });
    expect(sealed.representationHash).toBe(inspected.receipt.representationHash);
  });

  it("does not put reversal maps or raw-content hashes on the receipt", async () => {
    const { createLocalPseudonymizer } = await import("../../src/data-policy/pseudonyms.js");
    const store = createLocalPseudonymizer("run-nonce");
    const alias = store.alias("email", CANARIES.email);
    const profile = makeProfile();
    const policy = makePolicy(profile);
    const inspected = inspectOutbound({ note: "ok" }, policy, profile, []);
    const text = JSON.stringify(inspected.receipt);
    expect(text).not.toContain(CANARIES.email);
    expect(text).not.toContain(alias);
    expect(store.reversalMap().get(alias)).toBe(CANARIES.email);
    expect(Object.keys(inspected.receipt).sort()).toEqual([
      "counts",
      "outcome",
      "policyHash",
      "policyId",
      "processor",
      "processorVersion",
      "profileHash",
      "representationHash",
      "schemaVersion"
    ]);
  });
});
