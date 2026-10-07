import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AW_BILLING_CONTRACT } from "../../src/billing/generated/contract.js";
import { classifyBillingRunStatus } from "../../src/billing/classify.js";
import { EXIT, exitCodeFor, AwError } from "../../src/errors.js";
import { formatEstimateHuman, formatRunStatusHuman, formatUsageHuman } from "../../src/billing/format.js";
import {
  interpretUsageSubscription,
  summarizeGrantCategories
} from "../../src/billing/subscription.js";
import {
  parseBillingCapabilitiesResponse,
  parseBillingQuoteResponse,
  parseBillingRunStatusResponse,
  parseBillingUsageResponse
} from "../../src/billing/validate.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function readJson(relative: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(root, relative), "utf8"));
}

function canonicalLfBytes(buffer: Buffer): Buffer {
  return Buffer.from(buffer.toString("utf8").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n"), "utf8");
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(canonicalLfBytes(buffer)).digest("hex");
}

describe("vendored aw-billing/1 contract", () => {
  it("matches the locked main-repository SHA-256 digests", async () => {
    const schema = await readFile(resolve(root, "contracts/aw-billing-v1.schema.json"));
    const fixtures = await readFile(resolve(root, "contracts/aw-billing-v1.fixtures.json"));
    expect(sha256(schema)).toBe(AW_BILLING_CONTRACT.files["contracts/aw-billing-v1.schema.json"]);
    expect(sha256(fixtures)).toBe(AW_BILLING_CONTRACT.files["contracts/aw-billing-v1.fixtures.json"]);
    expect(AW_BILLING_CONTRACT.files["contracts/aw-billing-v1.schema.json"]).toBe(
      "1c0929d4f15b6b3b2017d7416e1eff50c9116b0b50fe7b82b5d96d732d807941"
    );
    expect(AW_BILLING_CONTRACT.files["contracts/aw-billing-v1.fixtures.json"]).toBe(
      "a4b9234b426f98132ddbd8e82755caa0aa718c4ec1e3bf17064d1bf364a6cb84"
    );
    expect(AW_BILLING_CONTRACT.source.commit).toBe("650472d91442a6866a7b6ef18e6dacc23a2a9260");
  });

  it("hashes a CRLF working-tree copy to the same locked LF digest", async () => {
    const schema = await readFile(resolve(root, "contracts/aw-billing-v1.schema.json"));
    const lf = schema.toString("utf8").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
    const crlf = Buffer.from(lf.replace(/\n/gu, "\r\n"), "utf8");
    expect(crlf.includes(0x0d)).toBe(true);
    expect(sha256(crlf)).toBe("1c0929d4f15b6b3b2017d7416e1eff50c9116b0b50fe7b82b5d96d732d807941");
    expect(sha256(crlf)).toBe(sha256(schema));
  });

  it("reuses the 200 granted / 10 reserved-then-consumed fixture as 190 available", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const usage = parseBillingUsageResponse(document.fixtures["partially_consumed_trial"]?.response);
    expect(usage.availableUnits).toBe(190);
    expect(usage.reservedUnits).toBe(0);
    expect(usage.consumedUnits).toBe(10);
    expect(usage.availableUnits).not.toBe(180);
    const human = formatUsageHuman({
      usage,
      workspaceLabel: "Fixture workspace",
      apiOrigin: new URL("https://augmentworks.ai/")
    });
    expect(human).toContain("Available credits: 190");
    expect(human).toContain("Reserved credits: 0");
    expect(human).toContain("Consumed credits: 10");
    expect(human).not.toContain("180");
    expect(human).toContain("server snapshot");
    expect(human).not.toMatch(/expires 20\d{2}-09-07/u);
  });

  it("displays reserved and consumed fields with their contract meanings", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const usage = parseBillingUsageResponse(document.fixtures["active_reservation"]?.response);
    expect(usage.availableUnits).toBe(190);
    expect(usage.reservedUnits).toBe(7);
    expect(usage.consumedUnits).toBe(3);
    const human = formatUsageHuman({
      usage,
      workspaceLabel: "Fixture workspace",
      apiOrigin: new URL("https://augmentworks.ai/")
    });
    expect(human).toContain("held for in-progress scenario attempts");
    expect(human).toContain("first durable target-command lease");
    expect(human).toContain("Trial/promotional");
    expect(human).toContain("no expiry");
  });

  it("tolerates unknown capabilities and a later non-null subscription object", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const usage = parseBillingUsageResponse(
      document.fixtures["unknown_capability_ignored"]?.response
    );
    expect(usage.availableUnits).toBe(200);
    expect(usage.subscription).toEqual({
      status: "future_stage",
      unsupportedDetail: "ignore"
    });
    expect(usage.capabilities).toContain("future_unreleased_v9");
    const human = formatUsageHuman({
      usage,
      workspaceLabel: "Fixture workspace",
      apiOrigin: new URL("https://augmentworks.ai/")
    });
    expect(human).not.toContain("future_stage");
    expect(human).toContain("does not grant credits");
  });

  it("rejects the malformed producer fixture", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    expect(() => parseBillingUsageResponse(document.fixtures["malformed_data"]?.response)).toThrow(
      expect.objectContaining({ code: "INVALID_CLOUD_RESPONSE" })
    );
  });

  it("accepts the absent reserved-capability document", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const capabilities = parseBillingCapabilitiesResponse(
      document.fixtures["absent_capability"]?.response
    );
    expect(capabilities.capabilities).toEqual([
      "usage_v1",
      "quote_v1",
      "status_v1",
      "billing_portal_link_v1",
      "subscriptions_v1"
    ]);
    expect(capabilities.capabilities).toContain("billing_portal_link_v1");
    expect(capabilities.capabilities).toContain("subscriptions_v1");
    expect(AW_BILLING_CONTRACT.contract.reservedCapabilities).toEqual([]);
  });

  it("fails closed on an unknown access state", () => {
    const document = {
      schemaVersion: "aw-billing/1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      billingAccountId: "22222222-2222-4222-8222-222222222222",
      asOf: "2026-09-06T17:00:00.000Z",
      ledgerRevision: 1,
      accessState: "time_travel",
      availableUnits: 200,
      reservedUnits: 0,
      consumedUnits: 0,
      grantBalances: [],
      subscription: null,
      billingPageUrl: "https://augmentworks.ai/portal/billing?workspace=11111111-1111-4111-8111-111111111111",
      capabilities: ["usage_v1"]
    };
    expect(() => parseBillingUsageResponse(document)).toThrow(
      expect.objectContaining({ code: "BILLING_UNSUPPORTED_STATE", category: "billing" })
    );
  });

  it("keeps closed-workspace usage readable without inventing spendable access", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const usage = parseBillingUsageResponse(
      document.fixtures["closed_workspace_readable"]?.response
    );
    expect(usage.accessState).toBe("closed");
    expect(usage.availableUnits).toBe(197);
    const human = formatUsageHuman({
      usage,
      workspaceLabel: "Fixture workspace",
      apiOrigin: new URL("https://augmentworks.ai/")
    });
    expect(human).toContain("Workspace access: closed.");
    expect(human).toContain("New hosted tests are rejected");
    expect(human).toContain("Available credits: 197");
  });

  it("assigns unused exit code 13 to billing errors", () => {
    expect(EXIT.BILLING).toBe(13);
    expect(
      exitCodeFor(
        new AwError({
          code: "USAGE_UNSUPPORTED",
          category: "billing",
          message: "unsupported"
        })
      )
    ).toBe(13);
    expect(
      exitCodeFor(
        new AwError({
          code: "INSUFFICIENT_CREDITS",
          category: "billing",
          message: "insufficient"
        })
      )
    ).toBe(13);
    expect(
      exitCodeFor(
        new AwError({
          code: "MEMBERSHIP_REVOKED",
          category: "auth",
          message: "revoked"
        })
      )
    ).toBe(3);
  });

  it("parses Stage 2 quote fixtures without treating a quote as a reservation", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const quote = parseBillingQuoteResponse(document.fixtures["quote_success_with_balance"]?.response);
    expect(quote.executionUnits).toBe(30);
    expect(quote.estimateOnly).toBe(true);
    expect(quote.availableUnitsAtQuote).toBe(190);
    expect(quote.scenarioCount).toBe(10);
    expect(quote.repetitions).toBe(3);
    const human = formatEstimateHuman({
      quote,
      workspaceLabel: "Fixture workspace",
      localPlanHash: "c".repeat(64)
    });
    expect(human).toContain("10 scenarios × 3 repetitions = 30 credits");
    expect(human).toContain("not a reservation");
    expect(human).toContain("not interchangeable");
    const insufficient = parseBillingQuoteResponse(
      document.fixtures["quote_success_insufficient_balance"]?.response
    );
    expect(insufficient.executionUnits).toBe(30);
    expect(insufficient.availableUnitsAtQuote).toBe(5);
    expect(insufficient.estimateOnly).toBe(true);
  });

  it("parses pending-grading status without implying a new run", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const status = parseBillingRunStatusResponse(
      document.fixtures["status_pending_grading"]?.response
    );
    expect(status.originalRunId).toBe(status.runId);
    expect(status.evaluationStatus).toBe("pending");
    expect(status.savedEvidence).toBe(true);
    expect(status.credit.consumedUnits).toBe(10);
    expect(status.retryEligible).toBe(false);
    const human = formatRunStatusHuman(status);
    expect(human).toContain("Your test evidence is saved.");
    expect(human).toContain("run wait");
    expect(human).not.toContain("Re-run the same test command");
    const classified = classifyBillingRunStatus(status);
    expect(classified.observation).toBe("succeeded");
    expect(classified.waitTerminal).toBe(false);
    expect(classified.assessment).toBe("incomplete");
    expect(classified.exitCode).toBe(EXIT.EVALUATION_INCOMPLETE);
  });

  it("treats pendingCommerce as processing metadata, not spendable credit", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const usage = parseBillingUsageResponse(document.fixtures["pending_pack_purchase"]?.response);
    expect(usage.availableUnits).toBe(200);
    expect(usage.pendingCommerce).toEqual({
      orderId: "44444444-4444-4444-8444-444444444444",
      state: "paid_unfulfilled",
      skuCode: "test_pack_300_v1"
    });
    const human = formatUsageHuman({
      usage,
      workspaceLabel: "Fixture workspace",
      apiOrigin: new URL("https://augmentworks.ai/")
    });
    expect(human).toContain("Available credits: 200");
    expect(human).toContain("paid_unfulfilled");
    expect(human).toContain("not spendable");
    expect(human).not.toContain("Available credits: 500");
  });

  it("tolerates additive pack-retention quote fields without treating them as credit expiry", async () => {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    const quote = parseBillingQuoteResponse(document.fixtures["quote_pack_retention"]?.response);
    expect(quote.executionUnits).toBe(10);
    expect(quote.estimateOnly).toBe(true);
    expect(quote.retentionPolicyVersion).toBe("aw-retention/pack-90d-v1");
    expect(quote.retainUntil).toBe("2026-12-05T17:00:00.000Z");
    const human = formatEstimateHuman({
      quote,
      workspaceLabel: "Fixture workspace",
      localPlanHash: "c".repeat(64)
    });
    expect(human).toContain("aw-retention/pack-90d-v1");
    expect(human).toContain("report lifetime, not credit expiry");
  });
});

describe("Stage 5 subscription usage fixtures", () => {
  const apiOrigin = new URL("https://augmentworks.ai/");

  async function fixtureUsage(name: string) {
    const document = (await readJson("contracts/aw-billing-v1.fixtures.json")) as {
      fixtures: Record<string, { response: unknown }>;
    };
    return parseBillingUsageResponse(document.fixtures[name]?.response);
  }

  function human(usage: ReturnType<typeof parseBillingUsageResponse>): string {
    return formatUsageHuman({ usage, workspaceLabel: "Fixture workspace", apiOrigin });
  }

  it("renders an active monthly grant without inventing $149 or recomputing availableUnits", async () => {
    const usage = await fixtureUsage("subscription_active");
    expect(usage.availableUnits).toBe(1200);
    expect(summarizeGrantCategories(usage.grantBalances)).toEqual(
      expect.objectContaining({
        recurringAvailable: 1000,
        trialPromotionalAvailable: 200,
        purchasedAvailable: 0
      })
    );
    const interpretation = interpretUsageSubscription(usage);
    expect(interpretation.advertised).toBe(true);
    expect(interpretation.interpretable).toBe(true);
    expect(interpretation.projection?.status).toBe("active");
    const text = human(usage);
    expect(text).toContain("Available credits: 1200");
    expect(text).toContain("Recurring: 1000 available");
    expect(text).toContain("Trial/promotional: 200 available");
    expect(text).toContain("pro_monthly_1000_v1");
    expect(text).toContain("Subscription status: active");
    expect(text).toContain("2026-10-06T17:00:00.000Z");
    expect(text).toContain("do not roll over");
    expect(text).not.toContain("149");
    expect(text).not.toMatch(/\$49|\$149/u);
  });

  it("shows cancel-at-period-end while the current monthly allowance remains usable", async () => {
    const usage = await fixtureUsage("subscription_canceling");
    expect(usage.availableUnits).toBe(850);
    const text = human(usage);
    expect(text).toContain("cancel");
    expect(text).toContain("Current monthly allowance remains usable");
    expect(text).toContain("Recurring: 850 available");
    expect(text).not.toMatch(/subscribe to recover your results/i);
    expect(text).not.toContain("149");
  });

  it("keeps purchased credits usable after a failed renewal without locking the snapshot", async () => {
    const usage = await fixtureUsage("subscription_past_due_with_purchased");
    expect(usage.accessState).toBe("active");
    expect(usage.availableUnits).toBe(300);
    const text = human(usage);
    expect(text).toContain("Purchased: 300 available");
    expect(text).toContain("Recurring: 0 available");
    expect(text).toContain("past_due");
    expect(text).toContain("Independently purchased credits remain usable");
    expect(text).toContain("Workspace access: active");
    expect(text).not.toContain("New hosted tests are rejected");
    expect(text).not.toMatch(/subscribe to recover your results/i);
  });

  it("does not tell a canceled workspace to subscribe to recover historical results", async () => {
    const usage = await fixtureUsage("subscription_canceled_retained_results");
    const text = human(usage);
    expect(text).toContain("Purchased: 300 available");
    expect(text).toContain("Historical results stay readable");
    expect(text).not.toMatch(/subscribe to recover your results/i);
    expect(text).not.toContain("149");
  });

  it("treats a successful renewal as one new period without rollover copy", async () => {
    const usage = await fixtureUsage("subscription_new_period");
    expect(usage.availableUnits).toBe(1000);
    expect(usage.grantBalances).toHaveLength(1);
    const text = human(usage);
    expect(text).toContain("Recurring: 1000 available");
    expect(text).toContain("do not roll over");
    expect(text).toContain("2026-11-06T17:00:00.000Z");
  });

  it("does not promise an allocation while a paid renewal is processing", async () => {
    const usage = await fixtureUsage("subscription_late_payment_processing");
    expect(usage.availableUnits).toBe(0);
    const interpretation = interpretUsageSubscription(usage);
    expect(interpretation.projection?.monthlyGrant).toBeNull();
    const text = human(usage);
    expect(text).toContain("still reconciling");
    expect(text).toContain("does not promise that a new monthly allocation exists");
    expect(text).toContain("Monthly grant: none");
    expect(text).not.toContain("Available credits: 1000");
  });

  it("does not treat an expired monthly grant as newly available credits", async () => {
    const usage = await fixtureUsage("subscription_expired_monthly_grant");
    expect(usage.availableUnits).toBe(0);
    const text = human(usage);
    expect(text).toContain("1000 forfeited (not spendable)");
    expect(text).toContain("not spendable and are not newly available");
    expect(text).not.toContain("Available credits: 1000");
  });

  it("omits recurring CTAs on a pack-only server without subscriptions_v1", async () => {
    const usage = await fixtureUsage("subscription_unavailable");
    expect(interpretUsageSubscription(usage).advertised).toBe(false);
    const text = human(usage);
    expect(text).toContain("does not advertise subscriptions_v1");
    expect(text).toContain("Trial/promotional: 200 available");
    expect(text).not.toContain("Subscription plan:");
    expect(text).not.toContain("149");
    expect(text).not.toContain("pro_monthly_1000_v1");
  });

  it("displays mixed monthly and purchased lots using server timestamps for earliest expiry", () => {
    const usage = parseBillingUsageResponse({
      schemaVersion: "aw-billing/1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      billingAccountId: "22222222-2222-4222-8222-222222222222",
      asOf: "2026-09-06T17:00:00.000Z",
      ledgerRevision: 6,
      accessState: "active",
      availableUnits: 1150,
      reservedUnits: 0,
      consumedUnits: 50,
      grantBalances: [
        {
          lotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
          origin: "purchased",
          grantedUnits: 300,
          availableUnits: 300,
          reservedUnits: 0,
          consumedUnits: 0,
          expiresAt: null,
          grantedAt: "2026-08-01T16:00:00.000Z"
        },
        {
          lotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
          origin: "subscription",
          grantedUnits: 1000,
          availableUnits: 850,
          reservedUnits: 0,
          consumedUnits: 150,
          expiresAt: "2026-10-01T17:00:00.000Z",
          grantedAt: "2026-09-01T16:00:00.000Z"
        }
      ],
      subscription: {
        planCode: "pro_monthly_1000_v1",
        status: "active",
        currentPeriodStart: "2026-09-06T17:00:00.000Z",
        currentPeriodEnd: "2026-10-01T17:00:00.000Z",
        cancelAtPeriodEnd: false,
        nextPaymentAction: "none",
        monthlyGrant: {
          grantedUnits: 1000,
          availableUnits: 850,
          reservedUnits: 0,
          consumedUnits: 150,
          expiresAt: "2026-10-01T17:00:00.000Z"
        }
      },
      billingPageUrl:
        "https://augmentworks.ai/portal/billing?workspace=11111111-1111-4111-8111-111111111111",
      capabilities: [
        "usage_v1",
        "quote_v1",
        "status_v1",
        "billing_portal_link_v1",
        "subscriptions_v1"
      ]
    });
    expect(usage.availableUnits).toBe(1150);
    expect(summarizeGrantCategories(usage.grantBalances).purchasedAvailable).toBe(300);
    expect(summarizeGrantCategories(usage.grantBalances).recurringAvailable).toBe(850);
    const text = human(usage);
    expect(text).toContain("Earliest lot expiry in this snapshot: 2026-10-01T17:00:00.000Z");
    expect(text).toContain("Purchased: 300 available");
    expect(text).toContain("Recurring: 850 available");
    expect(text).not.toContain("1151");
  });

  it("does not locally cancel a reservation that spans monthly expiry", () => {
    const usage = parseBillingUsageResponse({
      schemaVersion: "aw-billing/1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      billingAccountId: "22222222-2222-4222-8222-222222222222",
      asOf: "2026-10-07T00:00:00.000Z",
      ledgerRevision: 7,
      accessState: "active",
      availableUnits: 0,
      reservedUnits: 10,
      consumedUnits: 0,
      releasedUnits: 0,
      grantBalances: [
        {
          lotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
          origin: "subscription",
          grantedUnits: 1000,
          availableUnits: 0,
          reservedUnits: 10,
          consumedUnits: 0,
          expiresAt: "2026-10-06T17:00:00.000Z",
          grantedAt: "2026-09-06T16:00:00.000Z"
        }
      ],
      subscription: {
        planCode: "pro_monthly_1000_v1",
        status: "active",
        currentPeriodStart: "2026-09-06T17:00:00.000Z",
        currentPeriodEnd: "2026-10-06T17:00:00.000Z",
        cancelAtPeriodEnd: false,
        nextPaymentAction: "none",
        monthlyGrant: {
          grantedUnits: 1000,
          availableUnits: 0,
          reservedUnits: 10,
          consumedUnits: 0,
          expiresAt: "2026-10-06T17:00:00.000Z"
        }
      },
      billingPageUrl:
        "https://augmentworks.ai/portal/billing?workspace=11111111-1111-4111-8111-111111111111",
      capabilities: ["usage_v1", "quote_v1", "status_v1", "billing_portal_link_v1", "subscriptions_v1"]
    });
    const text = human(usage);
    expect(text).toContain("Reserved credits: 10");
    expect(text).toContain("does not cancel target work");
    expect(text).not.toContain("cancelled locally");
    expect(text).not.toContain("cancel this run");
  });

  it("does not report a release onto an expired lot as newly available credits", () => {
    const usage = parseBillingUsageResponse({
      schemaVersion: "aw-billing/1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      billingAccountId: "22222222-2222-4222-8222-222222222222",
      asOf: "2026-10-07T00:00:00.000Z",
      ledgerRevision: 8,
      accessState: "active",
      availableUnits: 0,
      reservedUnits: 0,
      consumedUnits: 0,
      releasedUnits: 10,
      grantBalances: [
        {
          lotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
          origin: "subscription",
          grantedUnits: 1000,
          availableUnits: 0,
          reservedUnits: 0,
          consumedUnits: 0,
          expiresAt: "2026-10-06T17:00:00.000Z",
          grantedAt: "2026-09-06T16:00:00.000Z",
          forfeitedUnits: 1000
        }
      ],
      subscription: {
        planCode: "pro_monthly_1000_v1",
        status: "canceled",
        currentPeriodStart: "2026-09-06T17:00:00.000Z",
        currentPeriodEnd: "2026-10-06T17:00:00.000Z",
        cancelAtPeriodEnd: false,
        nextPaymentAction: "none",
        monthlyGrant: null
      },
      billingPageUrl:
        "https://augmentworks.ai/portal/billing?workspace=11111111-1111-4111-8111-111111111111",
      capabilities: ["usage_v1", "quote_v1", "status_v1", "billing_portal_link_v1", "subscriptions_v1"]
    });
    const text = human(usage);
    expect(text).toContain("Released credits in this snapshot: 10");
    expect(text).toContain("If that lot has expired, they are not spendable again");
    expect(text).toContain("Available credits: 0");
    expect(text).not.toContain("Available credits: 10");
    expect(text).not.toContain("newly available credits: 10");
  });

  it("preserves usage reads for an uninterpreted future subscription enum and asks for a CLI update", () => {
    const usage = parseBillingUsageResponse({
      schemaVersion: "aw-billing/1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      billingAccountId: "22222222-2222-4222-8222-222222222222",
      asOf: "2026-09-06T17:00:00.000Z",
      ledgerRevision: 1,
      accessState: "active",
      availableUnits: 300,
      reservedUnits: 0,
      consumedUnits: 0,
      grantBalances: [
        {
          lotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
          origin: "purchased",
          grantedUnits: 300,
          availableUnits: 300,
          reservedUnits: 0,
          consumedUnits: 0,
          expiresAt: null,
          grantedAt: "2026-08-01T16:00:00.000Z"
        }
      ],
      subscription: {
        planCode: "pro_monthly_1000_v1",
        status: "quantum_renewing",
        cancelAtPeriodEnd: false,
        nextPaymentAction: "teleport"
      },
      billingPageUrl:
        "https://augmentworks.ai/portal/billing?workspace=11111111-1111-4111-8111-111111111111",
      capabilities: ["usage_v1", "quote_v1", "status_v1", "billing_portal_link_v1", "subscriptions_v1"]
    });
    expect(usage.availableUnits).toBe(300);
    expect(interpretUsageSubscription(usage)).toMatchObject({
      advertised: true,
      interpretable: false,
      reason: "uninterpreted_enum"
    });
    const text = human(usage);
    expect(text).toContain("Available credits: 300");
    expect(text).toContain("Update the CLI");
    expect(text).not.toContain("Subscription status: active");
    expect(text).not.toContain("quantum_renewing");
    expect(text).not.toContain("teleport");
  });
});
