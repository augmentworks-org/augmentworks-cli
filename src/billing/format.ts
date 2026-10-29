import { DEFAULT_API_ORIGIN } from "../auth/api-origin.js";
import { sanitizeTerminal } from "../errors.js";
import { classifyBillingRunStatus } from "./classify.js";
import { gradingStillPending, judgeJobsFromProgress } from "../outcome/classify.js";
import {
  grantOriginKind,
  type BillingGrantBalance,
  type BillingPendingCommerce,
  type BillingQuote,
  type BillingRunStatus,
  type BillingUsage
} from "./protocol.js";
import {
  earliestExpiringLot,
  interpretUsageSubscription,
  summarizeGrantCategories,
  type BillingSubscription
} from "./subscription.js";
import { assertSafeBillingPageUrl } from "./validate.js";

const ORIGIN_LABEL: Record<ReturnType<typeof grantOriginKind>, string> = {
  trial_promotional: "Trial/promotional",
  purchased: "Purchased",
  recurring: "Recurring",
  unrecognized: "Unrecognized origin"
};

export function formatUsageHuman(input: {
  readonly usage: BillingUsage;
  readonly workspaceLabel: string;
  readonly apiOrigin: URL;
}): string {
  const { usage, apiOrigin } = input;
  const workspace = sanitizeTerminal(input.workspaceLabel);
  const lines: string[] = [];
  lines.push(`Workspace: ${workspace}`);
  if (apiOrigin.origin !== DEFAULT_API_ORIGIN) {
    lines.push(`API origin: ${sanitizeTerminal(apiOrigin.origin)}`);
  }
  lines.push(`Available credits: ${String(usage.availableUnits)}`);
  lines.push("");
  lines.push(`Reserved credits: ${String(usage.reservedUnits)}`);
  lines.push(
    "Reserved credits are held for in-progress scenario attempts and are not yet consumed."
  );
  lines.push("");
  lines.push(`Consumed credits: ${String(usage.consumedUnits)}`);
  lines.push(
    "Consumed credits are the net units charged at the first durable target-command lease, after any approved compensation."
  );
  lines.push("");
  appendGrantCategories(lines, usage);
  lines.push("Grant lots:");
  if (usage.grantBalances.length === 0) {
    lines.push("  (none)");
  } else {
    for (const lot of usage.grantBalances) {
      lines.push(`  ${formatGrantLot(lot)}`);
    }
  }
  const earliest = earliestExpiringLot(usage.grantBalances);
  if (earliest?.expiresAt !== undefined && earliest.expiresAt !== null) {
    lines.push(
      `Earliest lot expiry in this snapshot: ${sanitizeTerminal(earliest.expiresAt)} (${ORIGIN_LABEL[grantOriginKind(earliest.origin)]}). The server allocates expiring lots first; this CLI does not recompute spendable credits from that timestamp.`
    );
  }
  lines.push("");
  lines.push(
    `These values are a server snapshot at ${sanitizeTerminal(usage.asOf)} (ledger revision ${String(usage.ledgerRevision)}), not a guaranteed future balance. Snapshots can change at a monthly period boundary.`
  );
  if (usage.releasedUnits !== undefined) {
    lines.push(
      `Released credits in this snapshot: ${String(usage.releasedUnits)}. Released units return to their original lot. If that lot has expired, they are not spendable again.`
    );
  }
  lines.push(`Workspace access: ${sanitizeTerminal(usage.accessState)}.`);
  if (usage.accessState === "closed" || usage.accessState === "closing" || usage.accessState === "suspended") {
    lines.push("New hosted tests are rejected in this access state. This snapshot remains readable.");
  } else if (usage.accessState === "past_due") {
    lines.push(
      "Workspace access is past_due. Quote and admission still come from the server; this CLI does not guess that new tests are blocked or allowed."
    );
  }
  appendSubscription(lines, usage);
  appendPendingCommerce(lines, usage.pendingCommerce);
  lines.push(
    "This command is read-only. It does not grant credits, reserve units, subscribe, cancel, reactivate, refund, open checkout, or manage payment methods. Billing changes require a signed-in browser session with billing permission."
  );
  if (usage.reservedUnits > 0) {
    lines.push(
      "An already accepted reservation can finish after a monthly grant expires. This CLI does not cancel target work because a grant timestamp has passed."
    );
  }
  try {
    const billingUrl = assertSafeBillingPageUrl(usage.billingPageUrl, apiOrigin, usage.workspaceId);
    lines.push(`Billing page: ${sanitizeTerminal(billingUrl.toString())}`);
  } catch {
    lines.push("Billing page: (omitted; the server URL was not a trusted first-party billing path.)");
  }
  return `${lines.join("\n")}\n`;
}

function appendPendingCommerce(
  lines: string[],
  pending: BillingPendingCommerce | null | undefined
): void {
  if (pending === undefined || pending === null) return;
  lines.push("");
  lines.push(
    `Purchase processing: ${sanitizeTerminal(pending.state)} for ${sanitizeTerminal(pending.skuCode)}.`
  );
  lines.push(
    "Processing is not spendable credit. Available credits above are the ledger snapshot only. Check usage later; do not treat a closed payment tab as success or failure."
  );
}

function formatGrantLot(lot: BillingGrantBalance): string {
  const kind = ORIGIN_LABEL[grantOriginKind(lot.origin)];
  const expiry =
    lot.expiresAt === null ? "no expiry" : `expires ${sanitizeTerminal(lot.expiresAt)}`;
  const extra: string[] = [];
  if (lot.forfeitedUnits !== undefined && lot.forfeitedUnits > 0) {
    extra.push(`${String(lot.forfeitedUnits)} forfeited (not spendable)`);
  }
  if (lot.frozenUnits !== undefined && lot.frozenUnits > 0) {
    extra.push(`${String(lot.frozenUnits)} frozen`);
  }
  const suffix = extra.length === 0 ? "" : `; ${extra.join("; ")}`;
  return `${kind}: ${String(lot.availableUnits)} available of ${String(lot.grantedUnits)} granted (${expiry})${suffix}`;
}

function appendGrantCategories(lines: string[], usage: BillingUsage): void {
  const categories = summarizeGrantCategories(usage.grantBalances);
  lines.push("Credit categories from grant lots (informational; available credits above are the server total):");
  lines.push(`  Recurring: ${String(categories.recurringAvailable)} available`);
  lines.push(`  Purchased: ${String(categories.purchasedAvailable)} available`);
  lines.push(`  Trial/promotional: ${String(categories.trialPromotionalAvailable)} available`);
  if (categories.unrecognizedAvailable > 0) {
    lines.push(`  Unrecognized origin: ${String(categories.unrecognizedAvailable)} available`);
  }
  lines.push("");
}

function appendSubscription(lines: string[], usage: BillingUsage): void {
  const interpretation = interpretUsageSubscription(usage);
  if (!interpretation.advertised) {
    lines.push(
      "This server does not advertise subscriptions_v1. Recurring-plan details are omitted. Purchased and trial credits follow the snapshot above."
    );
    return;
  }
  if (!interpretation.interpretable) {
    lines.push(
      "A subscription projection is present but this CLI cannot interpret its status or payment action. Update the CLI. Available credits above are the server snapshot. This CLI did not guess that a plan is active or safe, and it will not subscribe, cancel, or change payment methods."
    );
    return;
  }
  if (interpretation.projection === null) {
    lines.push("Subscription: none. Purchased packs remain usable without a monthly plan.");
    return;
  }
  appendKnownSubscription(lines, interpretation.projection);
}

function appendKnownSubscription(lines: string[], subscription: BillingSubscription): void {
  lines.push(`Subscription plan: ${sanitizeTerminal(subscription.planCode)}`);
  lines.push(`Subscription status: ${sanitizeTerminal(subscription.status)}`);
  if (subscription.currentPeriodStart !== undefined && subscription.currentPeriodStart !== null) {
    lines.push(`Current service period start: ${sanitizeTerminal(subscription.currentPeriodStart)} (server timestamp)`);
  }
  if (subscription.currentPeriodEnd !== undefined && subscription.currentPeriodEnd !== null) {
    lines.push(`Current service period end: ${sanitizeTerminal(subscription.currentPeriodEnd)} (server timestamp)`);
  }
  if (subscription.cancelAtPeriodEnd) {
    lines.push(
      "Cancellation is scheduled at the server period end. Current monthly allowance remains usable until then. This CLI does not cancel or reactivate a subscription."
    );
  }
  lines.push(`Next payment action: ${sanitizeTerminal(subscription.nextPaymentAction)}`);
  if (subscription.status === "processing" || subscription.nextPaymentAction === "processing") {
    lines.push(
      "A paid renewal is still reconciling. This snapshot does not promise that a new monthly allocation exists. Check usage later; do not treat processing as granted credits."
    );
  }
  if (subscription.status === "past_due" || subscription.status === "unpaid") {
    lines.push(
      "Renewal did not fund a new monthly period. This CLI did not mint an allowance. Independently purchased credits remain usable when the server snapshot allows it. Complete payment recovery on the signed-in billing page."
    );
  }
  if (subscription.status === "canceled" || subscription.status === "incomplete_expired") {
    lines.push(
      "There is no current monthly allowance. Purchased pack credits remain distinct. Historical results stay readable under the server retention policy. A zero monthly allocation is not a reason to buy a plan to restore reports."
    );
  }
  if (subscription.status === "incomplete" || subscription.nextPaymentAction === "authenticate") {
    lines.push(
      "Payment authentication is required on the signed-in billing page. This CLI does not collect cards or open a Stripe Customer Portal session."
    );
  }
  if (subscription.nextPaymentAction === "update_payment_method") {
    lines.push("Update the payment method on the signed-in first-party billing page.");
  }
  const monthly = subscription.monthlyGrant;
  if (monthly === undefined || monthly === null) {
    lines.push("Monthly grant: none in this snapshot. Do not invent a recurring balance.");
  } else {
    const expiry =
      monthly.expiresAt === null ? "no expiry" : `expires ${sanitizeTerminal(monthly.expiresAt)}`;
    lines.push(
      `Monthly grant: ${String(monthly.availableUnits)} available of ${String(monthly.grantedUnits)} granted (${expiry}). Monthly units do not roll over.`
    );
    if (monthly.availableUnits === 0 && monthly.grantedUnits > 0) {
      lines.push(
        "Expired or unused monthly units in this snapshot are not spendable and are not newly available credits."
      );
    }
  }
}

export function usageSuccessJson(usage: BillingUsage): string {
  const interpretation = interpretUsageSubscription(usage);
  const creditCategories = summarizeGrantCategories(usage.grantBalances);
  return `${JSON.stringify({
    ok: true,
    schemaVersion: usage.schemaVersion,
    workspaceId: usage.workspaceId,
    billingAccountId: usage.billingAccountId,
    asOf: usage.asOf,
    ledgerRevision: usage.ledgerRevision,
    accessState: usage.accessState,
    availableUnits: usage.availableUnits,
    reservedUnits: usage.reservedUnits,
    consumedUnits: usage.consumedUnits,
    grantBalances: usage.grantBalances,
    subscription: usage.subscription,
    subscriptionAdvertised: interpretation.advertised,
    subscriptionInterpretable: interpretation.interpretable,
    creditCategories,
    billingPageUrl: usage.billingPageUrl,
    capabilities: usage.capabilities,
    ...(usage.grossConsumedUnits === undefined ? {} : { grossConsumedUnits: usage.grossConsumedUnits }),
    ...(usage.compensatedUnits === undefined ? {} : { compensatedUnits: usage.compensatedUnits }),
    ...(usage.releasedUnits === undefined ? {} : { releasedUnits: usage.releasedUnits }),
    ...(usage.cutoverVersion === undefined ? {} : { cutoverVersion: usage.cutoverVersion }),
    ...(usage.pendingCommerce === undefined ? {} : { pendingCommerce: usage.pendingCommerce })
  })}\n`;
}

export function formatBillingHuman(input: {
  readonly usage: BillingUsage;
  readonly workspaceLabel: string;
  readonly billingPageUrl: URL;
  readonly openedBrowser: boolean;
  readonly apiOrigin?: URL;
}): string {
  const lines: string[] = [];
  lines.push(`Workspace: ${sanitizeTerminal(input.workspaceLabel)}`);
  if (input.apiOrigin !== undefined && input.apiOrigin.origin !== DEFAULT_API_ORIGIN) {
    lines.push(`API origin: ${sanitizeTerminal(input.apiOrigin.origin)}`);
  }
  lines.push(`Available credits: ${String(input.usage.availableUnits)}`);
  lines.push(`Billing page: ${sanitizeTerminal(input.billingPageUrl.toString())}`);
  lines.push(
    "This is a first-party AugmentWorks page. Opening it does not authorize payment. Sign in in the browser; only a workspace owner or billing manager can change payment methods, buy a pack, or manage a subscription. If you cannot change payment methods, contact a workspace owner."
  );
  lines.push(
    "A connector token is not billing-management permission. The workspace id in the URL is a navigation hint, not authorization."
  );
  lines.push(
    "A standard credit is one scenario attempt against one target. Catalog prices and terms are shown on the website, not by this CLI."
  );
  lines.push(
    "Purchasing is optional. Account-free local testing and demo do not need a pack or subscription and make no billing calls."
  );
  appendSubscription(lines, input.usage);
  appendPendingCommerce(lines, input.usage.pendingCommerce);
  if (input.openedBrowser) {
    lines.push("Opened the billing page in a browser.");
  } else {
    lines.push("Printed the billing URL without opening a browser.");
  }
  lines.push(
    "After fulfillment, run usage, then start a new hosted test explicitly with --max-credits. Do not wait here for a purchase."
  );
  return `${lines.join("\n")}\n`;
}

export function billingSuccessJson(input: {
  readonly usage: BillingUsage;
  readonly billingPageUrl: URL;
  readonly openedBrowser: boolean;
}): string {
  const { usage } = input;
  const interpretation = interpretUsageSubscription(usage);
  return `${JSON.stringify({
    ok: true,
    schemaVersion: usage.schemaVersion,
    workspaceId: usage.workspaceId,
    billingAccountId: usage.billingAccountId,
    billingPageUrl: input.billingPageUrl.toString(),
    availableUnits: usage.availableUnits,
    reservedUnits: usage.reservedUnits,
    consumedUnits: usage.consumedUnits,
    accessState: usage.accessState,
    asOf: usage.asOf,
    ledgerRevision: usage.ledgerRevision,
    capabilities: usage.capabilities,
    subscription: usage.subscription,
    subscriptionAdvertised: interpretation.advertised,
    subscriptionInterpretable: interpretation.interpretable,
    creditCategories: summarizeGrantCategories(usage.grantBalances),
    openedBrowser: input.openedBrowser,
    ...(usage.pendingCommerce === undefined ? {} : { pendingCommerce: usage.pendingCommerce })
  })}\n`;
}

export function formatEstimateHuman(input: {
  readonly quote: BillingQuote;
  readonly workspaceLabel: string;
  readonly localPlanHash: string;
  readonly apiOrigin?: URL;
}): string {
  const quote = input.quote;
  const lines: string[] = [];
  lines.push(`Workspace: ${sanitizeTerminal(input.workspaceLabel)}`);
  if (input.apiOrigin !== undefined && input.apiOrigin.origin !== DEFAULT_API_ORIGIN) {
    lines.push(`API origin: ${sanitizeTerminal(input.apiOrigin.origin)}`);
  }
  lines.push(`Quoted credits: ${String(quote.executionUnits)}`);
  const breakdown = formatQuoteBreakdown(quote);
  if (breakdown !== undefined) lines.push(breakdown);
  lines.push(`Available credits at quote: ${String(quote.availableUnitsAtQuote)} (server snapshot)`);
  if (quote.remainingUnitsEstimate !== undefined) {
    lines.push(
      `Estimated remaining after this run: ${String(quote.remainingUnitsEstimate)} (estimate only; not a reservation)`
    );
  }
  lines.push(
    "This quote is not a credit hold. Another run may use credits before this assessment starts."
  );
  lines.push(
    "AugmentWorks grading is included in standard credits. Your target provider may have separate costs."
  );
  lines.push(`Server assessment plan hash: ${quote.assessmentPlanHash}`);
  lines.push(
    `Local freeze hash: ${input.localPlanHash} (not interchangeable with the server assessmentPlanHash)`
  );
  lines.push(`Quote expires: ${sanitizeTerminal(quote.expiresAt)}`);
  lines.push(`Pricing version: ${sanitizeTerminal(quote.pricingVersion)}`);
  if (quote.retentionPolicyVersion !== undefined) {
    lines.push(`Run retention policy: ${sanitizeTerminal(quote.retentionPolicyVersion)}`);
  }
  if (quote.retainUntil !== undefined) {
    lines.push(
      `Saved-report retain until: ${sanitizeTerminal(quote.retainUntil)} (report lifetime, not credit expiry)`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatQuoteBreakdown(quote: BillingQuote): string | undefined {
  if (quote.scenarioCount === undefined || quote.repetitions === undefined) return undefined;
  return `  ${String(quote.scenarioCount)} scenarios × ${String(quote.repetitions)} repetitions = ${String(quote.executionUnits)} credits`;
}

export function estimateSuccessJson(input: {
  readonly quote: BillingQuote;
  readonly localPlanHash: string;
}): string {
  const { quote } = input;
  return `${JSON.stringify({
    ok: true,
    schemaVersion: quote.schemaVersion,
    quoteId: quote.quoteId,
    workspaceId: quote.workspaceId,
    assessmentPlanHash: quote.assessmentPlanHash,
    localPlanHash: input.localPlanHash,
    pricingVersion: quote.pricingVersion,
    executionUnits: quote.executionUnits,
    expiresAt: quote.expiresAt,
    availableUnitsAtQuote: quote.availableUnitsAtQuote,
    estimateOnly: true,
    ...(quote.scenarioCount === undefined ? {} : { scenarioCount: quote.scenarioCount }),
    ...(quote.repetitions === undefined ? {} : { repetitions: quote.repetitions }),
    ...(quote.remainingUnitsEstimate === undefined
      ? {}
      : { remainingUnitsEstimate: quote.remainingUnitsEstimate }),
    ...(quote.retentionPolicyVersion === undefined
      ? {}
      : { retentionPolicyVersion: quote.retentionPolicyVersion }),
    ...(quote.retainUntil === undefined ? {} : { retainUntil: quote.retainUntil })
  })}\n`;
}

export function formatRunStatusHuman(status: BillingRunStatus): string {
  const classification = classifyBillingRunStatus(status);
  const lines: string[] = [];
  lines.push(`Original run: ${sanitizeTerminal(status.originalRunId)}`);
  if (status.runId !== status.originalRunId) {
    lines.push(`Status run: ${sanitizeTerminal(status.runId)}`);
  }
  lines.push(`Target execution: ${sanitizeTerminal(status.executionStatus)}`);
  lines.push(`Grading: ${sanitizeTerminal(status.evaluationStatus)}`);
  lines.push(
    `Credits: reserved ${String(status.credit.reservedUnits)}, consumed ${String(status.credit.consumedUnits)}, released ${String(status.credit.releasedUnits)}, compensated ${String(status.credit.compensatedUnits)}`
  );
  lines.push(
    `Progress: ${String(status.progress.completedAttempts)}/${String(status.progress.plannedAttempts)} attempts, ${String(status.progress.completedJudgeJobs)}/${String(status.progress.plannedJudgeJobs)} grading jobs`
  );
  if (status.savedEvidence) {
    lines.push("Your test evidence is saved.");
  }
  if (classification.assessment !== "passed") {
    lines.push(
      "This snapshot is a successful status query, not a passing release assessment."
    );
  }
  if (!classification.waitTerminal) {
    if (gradingStillPending(status.evaluationStatus, judgeJobsFromProgress(status.progress))) {
      lines.push(
        `Grading is pending on the original run. Wait with: augmentworks run wait ${status.originalRunId}`
      );
    } else {
      lines.push(
        `Target work is still in progress on the original run. Wait with: augmentworks run wait ${status.originalRunId}`
      );
    }
    lines.push(`Inspect with: augmentworks run status ${status.originalRunId}`);
  }
  if (status.retryEligible) {
    lines.push(
      `Server-approved grading retry is available without another test credit. Use: augmentworks run retry-evaluation ${status.originalRunId}`
    );
  }
  if (status.retryReason !== null) {
    lines.push(`Retry reason: ${sanitizeTerminal(status.retryReason)}`);
  }
  lines.push(`Next actions: ${status.nextActions.map((action) => sanitizeTerminal(action)).join(", ")}`);
  lines.push(`Dashboard: ${sanitizeTerminal(status.dashboardUrl)}`);
  if (status.retentionPolicyVersion !== undefined) {
    lines.push(`Run retention policy: ${sanitizeTerminal(status.retentionPolicyVersion)}`);
  }
  if (status.retainUntil !== undefined) {
    lines.push(
      `Saved-report retain until: ${sanitizeTerminal(status.retainUntil)} (server timestamp). This CLI does not decide deletion from the local clock.`
    );
  }
  lines.push(`Snapshot at ${sanitizeTerminal(status.asOf)}`);
  return `${lines.join("\n")}\n`;
}

export function runStatusSuccessJson(status: BillingRunStatus): string {
  const classification = classifyBillingRunStatus(status);
  return `${JSON.stringify({
    ok: true,
    observation: classification.observation,
    work: classification.work,
    assessment: classification.assessment,
    exit_code: classification.exitCode,
    schemaVersion: status.schemaVersion,
    runId: status.runId,
    workspaceId: status.workspaceId,
    originalRunId: status.originalRunId,
    executionStatus: status.executionStatus,
    evaluationStatus: status.evaluationStatus,
    credit: status.credit,
    progress: status.progress,
    savedEvidence: status.savedEvidence,
    retryEligible: status.retryEligible,
    retryReason: status.retryReason,
    nextActions: status.nextActions,
    dashboardUrl: status.dashboardUrl,
    asOf: status.asOf,
    ...(status.outcome === undefined ? {} : { outcome: status.outcome }),
    ...(status.retentionPolicyVersion === undefined
      ? {}
      : { retentionPolicyVersion: status.retentionPolicyVersion }),
    ...(status.retainUntil === undefined ? {} : { retainUntil: status.retainUntil })
  })}\n`;
}

export function retryEvaluationSuccessJson(result: {
  readonly protocolVersion: string;
  readonly runId: string;
  readonly evaluationId: string;
}): string {
  return `${JSON.stringify({
    ok: true,
    protocol_version: result.protocolVersion,
    run_id: result.runId,
    evaluation_id: result.evaluationId,
    reused_target_evidence: true,
    customer_units_debited: 0
  })}\n`;
}
