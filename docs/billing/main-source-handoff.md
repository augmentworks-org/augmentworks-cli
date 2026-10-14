# Billing Stage 5A → CLI Stage 5B handoff

Owned by `augmentworks-org/augmentworks`. Do not implement Stage 5B in this
repository. The CLI counterpart must vendor this contract as published here.

## Identity

| Item | Value |
| --- | --- |
| Docs/contracts research baseline | `bc1bac16ee88aeece7cd7c58793abc0d611aa4bc` (`origin/main`) |
| Stage 4A base | `51fed762f96b63e24975376ead483caf5a009cc3` (`cursor/billing-stage-4a-91a7`) |
| Working branch | `cursor/billing-stage-5a-91a7` |
| Stage | **5A code complete.** Live pack and Pro sales **not enabled**. Local SQL/RLS **passed**. Real Stripe **BLOCKED** without credentials. `subscriptions_v1` is **advertised** and implemented; live $149 sales stay gated. |
| Counterpart repo | Not modified. CLI Stage 5B has not started |

Exact current commit is the git SHA that contains this file.

## What Stage 5B may do

Complete CLI support for subscriptions plus purchased packs, including
noninteractive CI and cancellation/renewal display. Re-import this schema,
fixtures, and handoff. Keep `docs/billing/main-source-handoff.md` separate
from the CLI-owned handoff.

The CLI remains a **read-only billing client** and a consent-bounded testing
client. It must **not** subscribe, cancel, reactivate, refund, or modify
payment methods. All financial changes happen on the authenticated first-party
billing page (`billingPageUrl`) and its Stripe Customer Portal flow after
browser authorization.

Do **not** expose Stripe Customer Portal bearer URLs, Checkout Session
secrets, or customer IDs in CLI JSON, logs, or printed URLs. Do **not**
publish the npm package or enable live billing unless separately authorized.

Keep **`EXIT.BILLING = 13`**. Keep evaluation-incomplete **11**,
evaluation-error **12**, and interrupted **130**.

## Wire contract

`schemaVersion`: `"aw-billing/1"`

SHA-256:

- `docs/contracts/aw-billing-v1.schema.json` =
  `3097c7aa74233e97233dcc488ba7eaacb1be5c6af0554bc308ca1569d155b645`
- `docs/contracts/aw-billing-v1.fixtures.json` =
  `a4b9234b426f98132ddbd8e82755caa0aa718c4ec1e3bf17064d1bf364a6cb84`

Canonical files:

- `docs/contracts/aw-billing-v1.schema.json`
- `docs/contracts/aw-billing-v1.fixtures.json`
- `docs/contracts/aw-billing-v1.checksums.json`

Stage 1–4 fields remain stable. Additive Stage 5A: advertised
`subscriptions_v1` and a non-null `subscription` projection when a local
subscription row exists. Consumers tolerate additive optional fields, ignore
unknown capability strings, and must not guess unknown financial/access
states as active or safe. Do not permanently validate `subscription` as
literal null.

### Routes and aliases

Unchanged from Stage 4A.

| Role | Path | Scope |
| --- | --- | --- |
| Primary capabilities | `GET /v1/billing/capabilities` | `connector:identity` |
| Primary usage | `GET /v1/billing/usage` | `connector:identity` |
| Primary quote | `POST /v1/billing/quote` | `connector:run` |
| Primary status | `GET /v1/billing/status?runId=<uuid>` | `connector:run` |
| Alias capabilities | `GET /api/v1/billing/capabilities` | same |
| Alias usage | `GET /api/v1/billing/usage` | same |
| Alias quote | `POST /api/v1/billing/quote` | same |
| Alias status | `GET /api/v1/billing/status?runId=<uuid>` | same |
| Canonical execution status | `GET /v1/relay/runs/{runId}` | `connector:run` |
| Evaluation-only retry | `POST /v1/relay/runs/{runId}:retry-evaluation` | `connector:run` |
| Ambiguous create lookup | `POST /v1/relay/run-intents/reconcile` | `connector:run` |
| Quoted create | `POST /v1/relay/runs` (`aw-relay/0.3`) | `connector:run` |

Workspace is always resolved from the validated connector. Query
`workspaceId` / `billingAccountId` must not switch tenants
(`workspace_mismatch`). Responses: `Cache-Control: private, no-store`.

There is **no** CLI order-status API and **no** CLI Customer Portal session
API. Order and payment-method management stay on
`/portal/billing` after browser auth.

### Capabilities

Advertised now:

```json
["usage_v1", "quote_v1", "status_v1", "billing_portal_link_v1", "subscriptions_v1"]
```

No capability names remain reserved. Consumers still ignore unknown strings.
Live Pro sales are an **operational gate**, not a missing capability.

A server without `subscriptions_v1` (Stage 4 and earlier) must be treated as
pack-only. Fixture `subscription_unavailable` is the consumer case: omit
recurring CTAs and do not invent monthly balances.

### Billing page URL (`billing_portal_link_v1`)

```text
https://augmentworks.ai/portal/billing?workspace=<workspace-uuid>
```

Local/dev may use the configured `NEXT_PUBLIC_SITE_URL` origin with the same
path and query. The URL contains **no** access token, refresh token, device
code, Stripe customer ID, Checkout Session ID, or Customer Portal session
URL. Opening it does not authorize payment. Ineligible cohort members must
not see a live Subscribe promise.

Return URLs after subscription Checkout:

```text
/portal/billing?workspace=<uuid>&subscription=processing
/portal/billing?workspace=<uuid>&subscription=cancelled
```

`processing` is not proof that a period grant exists. Read usage again.

### Usage `subscription` projection

Null means no local subscription row. When present, required fields are:

| Field | Meaning |
| --- | --- |
| `planCode` | Server catalog SKU, currently `pro_monthly_1000_v1` |
| `status` | Provider-neutral: `active`, `canceling`, `past_due`, `unpaid`, `incomplete`, `incomplete_expired`, `canceled`, `processing`, `unsupported`, `unknown` |
| `currentPeriodStart` / `currentPeriodEnd` | Provider UTC service-period bounds when known |
| `cancelAtPeriodEnd` | Scheduled cancellation; current monthly lot remains usable until period end |
| `nextPaymentAction` | `none`, `authenticate`, `update_payment_method`, `processing` |
| `monthlyGrant` | Current funded monthly lot summary, or null. Pack lots are never included |

Do **not** calculate renewal dates or grant quantities in the CLI. Do **not**
infer access from a Stripe subscription ID or wall-clock vs `expiresAt`.
`accessState` remains the workspace lifecycle projection and is independent
of monthly lot balance. `past_due` subscription status does **not** globally
lock the dashboard; independently purchased pack credits remain usable when
the account is otherwise active.

Unknown `status` / `nextPaymentAction` strings must not be guessed active or
safe: preserve supported read behavior and return a structured
unsupported/update response for operations whose semantics cannot be
interpreted.

### Subscription fixtures

| Fixture | Point |
| --- | --- |
| `subscription_active` | 1,000 monthly + 200 trial = 1,200 available |
| `subscription_canceling` | Cancel-at-period-end; current monthly lot still usable |
| `subscription_past_due_with_purchased` | Failed renewal; pack 300 remains; `accessState` stays `active`; `monthlyGrant` null |
| `subscription_canceled_retained_results` | Canceled; pack remains; historical results follow retention, not credit expiry |
| `subscription_new_period` | One new 1,000-unit period; prior monthly lot not rolled over |
| `subscription_late_payment_processing` | Paid renewal still reconciling; do not promise an allocation exists |
| `subscription_expired_monthly_grant` | Monthly lot expired, no rollover, not spendable |
| `subscription_unavailable` | Consumer: server without `subscriptions_v1` |

### Quote and admission (unchanged required fields)

Quote creation **must not** reserve or consume credits. Quotes record the
resulting run-retention policy. Mixed lots take the longest committed
window. Subscription lots select **365-day** Pro run-detail retention
(`aw-retention/pro-365d-v1`). Purchased pack credits still have **no
expiry**; pack-funded new run details default to 90 days unless a longer
promise applies. Cancellation does not retroactively shorten retention
already attached to a run.

Quoted create remains `aw-relay/0.3` with `quote_id` and optional
`max_credits`. Reservation of monthly units is bounded (72 hours or lot
`expires_at`, whichever is sooner). Released units return to their original
lot; if that lot has expired they are not spendable.

### Catalog (server-owned)

- Internal trial: `trial_200_v1` — 200 units once
- Sellable pack: `test_pack_300_v1` — 300 units, USD 4,900 cents, no expiry
- Sellable monthly (test-mode gated): `pro_monthly_1000_v1` — 1,000 units per
  funded Stripe service period, USD 14,900 cents, expires at provider period
  end, no initial rollover

CLI must not hard-code prices or allowances. Website pin: published CLI
**0.3.2**.

Packs remain available without a subscription and keep their own validity
when a subscription ends.

### Stable error mapping

Unchanged from Stage 4A.

| Stable | Wire `error.code` | Typical HTTP |
| --- | --- | --- |
| `BILLING_UNAVAILABLE` | `service_unavailable` (billing JSON) / `BILLING_UNAVAILABLE` (relay) | 503 |
| `INSUFFICIENT_CREDITS` | `insufficient_credits` | 409 |
| `QUOTE_EXPIRED` | `quote_expired` | 409 |
| `QUOTE_MISMATCH` | `quote_mismatch` | 409 |
| `BUDGET_EXCEEDED` | `budget_exceeded` | 409 |
| `UPDATE_REQUIRED` | `update_required` | 409 |
| `WORKSPACE_CLOSING` | `workspace_closing` | 409 |
| `MEMBERSHIP_REVOKED` | `membership_revoked` | 403 |

## Migrations

Forward only. After Stage 4A:

10. `20260910120001_billing_monthly_subscriptions.sql`
11. `20260910120002_billing_closure_hook_account.sql`

Cutover marker is still `aw-billing/1-cutover`.

Grants go through `billing_grant_lot` with origin `subscription`,
idempotency `grant:subscription:period:{account}:{sub}:{start_epoch}:{end_epoch}`.
Uniqueness is billing account + provider subscription + allowance type +
economic period. Policy version is payload, not a uniqueness dimension.
`customer.subscription.created` / `updated` never mint units. `invoice.paid`
does, once, when the invoice funds the expected Pro service.

## Independent switches (server)

See `docs/billing/launch-runbook.md`.

| Flag | Role |
| --- | --- |
| `AW_BILLING_SUBSCRIPTION_CATALOG_ENABLED` | Offer visibility |
| `AW_BILLING_SUBSCRIPTIONS_ENABLED` | New subscription Checkout (kill switch) |
| `AW_BILLING_SUBSCRIPTION_ROLLOUT` | `off` \| `allowlist` \| `all` |
| `AW_BILLING_LIVE_SUBSCRIPTIONS_ENABLED` | **Must remain false** until measured cost/retention evidence |

Disabling new subscription sales **must** continue renewals, fulfillment,
cancellation, recovery, and pack Checkout (unless those have their own
switches) for existing subscribers.

Pausing pack Checkout does not stop subscription event processing.

## Copyable CLI examples

Billing page (no secrets, no portal bearer URL):

```text
https://augmentworks.ai/portal/billing?workspace=11111111-1111-4111-8111-111111111111
```

Usage JSON includes `subscription` when present. Render monthly vs purchased
vs trial from `grantBalances[].origin` and `subscription.monthlyGrant`. Never
recompute `availableUnits`.

Noninteractive hosted test remains:

```text
augmentworks test --max-credits N --json
```

`--yes` is not an unlimited spending budget.

## Unresolved limitations

- Live OpenAI calibration and measured grading cost: **UNVERIFIED**
- Real Stripe test-mode Checkout / Test Clocks / Customer Portal / 3DS:
  **BLOCKED** until `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PRICE_TEST_PACK_300_V1`, and `STRIPE_PRICE_PRO_MONTHLY_1000_V1`
  are supplied
- Automatic tax: flag exists; off until accepted policy
- Live $149 sales: **activation pending**, not unfinished implementation
- Published CLI 0.3.2 cannot send `aw-relay/0.3`, open `billing`, or render
  `subscriptions_v1`
- Retention email adapter is implemented; sending is **not configured**
- Production worker heartbeats: `not_run` until a deployed schedule records rows
- Browser UX walkthrough: **not run** in this session (no browser tools)

## Live activation

Not enabled. No production deploy, no live pack or Pro sales, no real
charges/refunds, no customer messages, no npm publish.

`AW_BILLING_LIVE_PURCHASES_ENABLED` and
`AW_BILLING_LIVE_SUBSCRIPTIONS_ENABLED` must remain unset/false until
merchant/tax/cost review. Production subscription rollout defaults to
**allowlist** when unset.
