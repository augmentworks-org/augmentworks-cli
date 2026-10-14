# Billing Stage 5B → main follow-on handoff

Owned by `augmentworks-org/augmentworks-cli`. Main owns the wire contract. This
repository vendors that contract; it does not change it.

Imported main 5A handoff is saved separately at
`docs/billing/main-source-handoff.md`. Do not treat that file as the CLI-owned
handoff.

## Identity

| Item | Value |
| --- | --- |
| CLI 4B baseline HEAD | `7d8cb08170b162d8c2dc66343df9499986742779` (`cursor/billing-stage-4b-91a7`) |
| Working branch | `cursor/billing-stage-5b-91a7` |
| Vendored main commit | `650472d91442a6866a7b6ef18e6dacc23a2a9260` (`cursor/billing-stage-5a-91a7`) |
| Source package | `0.3.3` (unpublished) |
| Website / npx pin | published `@augmentworks/cli@0.3.2` (`gitHead` `d36ec8590b005445dba940d2df3abcb53971cea5`) |
| Implementation | `4c46c41e944d18e1ae98d50e3724221b903675ca` (feature); `b92106de38e6207df5b5d001e84e94fbad0ae013` (copy-contract pin wording); `ea1cbf35dd6a1432efa738cbbe2f11f7e0a9d4e4` (verification evidence); `4e5fc1c863a4122db9c505d504979c76ca846509` (CI recover, retention display, fixture matrix) |

Verification evidence commit is `ea1cbf35dd6a1432efa738cbbe2f11f7e0a9d4e4`. Feature code is `4c46c41e944d18e1ae98d50e3724221b903675ca`. Matrix/CI close-out is `4e5fc1c863a4122db9c505d504979c76ca846509`.

## What Stage 5B implemented

CLI support for monthly subscriptions **plus** purchased packs, including
noninteractive CI and cancellation/renewal display. The CLI remains a
**read-only billing client** and a consent-bounded testing client.

- Re-imported main 5A `aw-billing/1` schema/fixtures/lock. Advertised
  capabilities now include `subscriptions_v1`. Reserved list is empty.
- `usage` / `usage --json` separate recurring, purchased, and
  trial/promotional lot balances from **server grant lots**. They show the
  server service period, cancel-at-period-end, monthly grant expiry, and next
  payment action when `subscriptions_v1` is advertised and the projection is
  interpretable.
- Pack-only servers (`subscription_unavailable`, no `subscriptions_v1`) omit
  recurring CTAs and do not invent monthly balances or $149.
- Processing renewal is displayed as reconciling, not as a granted allocation.
  Failed renewal keeps independently purchased credits when the server says
  `accessState` is `active`. Canceled workspaces keep pack credits and are not
  told to subscribe to recover historical results.
- Unknown future subscription status/nextPaymentAction strings preserve the
  usage read (server `availableUnits` and lots) and print an update message.
  They are not guessed active or safe.
- Quote/create still come from the server. `--max-credits` remains required
  for noninteractive hosted tests. Monthly status does not bypass that
  ceiling. `--yes` is not an unlimited budget.
- `billing` still opens only
  `https://augmentworks.ai/portal/billing?workspace=<uuid>`. No Stripe
  Customer Portal bearer URL, Checkout Session, subscribe, cancel, reactivate,
  refund, or payment-method mutation.
- Reservations may finish after monthly expiry. Released units return to their
  original lot; expired lots are not reported as newly available.
- Copy-pastable CI captures a run id, waits on that exact run if grading is
  pending, and runs inspect-only `recover --json` before a new admission when
  create returns no run id.
- `run status` displays server `retainUntil` timestamps and retry reasons. It
  does not decide report deletion from the local clock.

No package publication. No live subscription activation.

## Vendored contract

`schemaVersion`: `"aw-billing/1"`

SHA-256:

- `contracts/aw-billing-v1.schema.json` =
  `3097c7aa74233e97233dcc488ba7eaacb1be5c6af0554bc308ca1569d155b645`
- `contracts/aw-billing-v1.fixtures.json` =
  `a4b9234b426f98132ddbd8e82755caa0aa718c4ec1e3bf17064d1bf364a6cb84`

Lock: `contracts/aw-billing-v1.lock.json`
Generated bindings: `src/billing/generated/contract.ts`

```bash
node scripts/import-aw-billing-contract.mjs --from <path-to-augmentworks-org/augmentworks>
npm run check:billing-contract
```

The check fails when generated bindings or file hashes diverge.

### Routes used by this CLI

Unchanged from 4B:

- `GET /v1/billing/capabilities`
- `GET /v1/billing/usage`
- `POST /v1/billing/quote`
- `GET /v1/billing/status?runId=<uuid>`
- `POST /v1/relay/runs` (`aw-relay/0.3` quoted create, `0.1` packet-only)
- `GET /v1/relay/runs/{runId}`
- `POST /v1/relay/run-intents:reconcile`
- `POST /v1/relay/runs/{runId}:retry-evaluation`

There is **no** CLI order-status route and **no** CLI Customer Portal session
API. `billing` links to the first-party page; `usage` shows credit
fulfillment including optional `pendingCommerce` and the nullable
`subscription` projection.

### Authentication

Existing opaque CLI bearer. Usage/capabilities/billing navigation:
`connector:identity`. Quote, status, create, reconcile, and evaluation retry:
`connector:run`. Refresh-once after HTTP 401. Workspace comes from the
validated connector.

Read permission does not imply billing-management permission.

### Capabilities treated as available

Implemented when advertised: `usage_v1`, `quote_v1`, `status_v1`,
`billing_portal_link_v1`, `subscriptions_v1`.

`subscriptions_v1` means the CLI may render the server subscription
projection. It does **not** mean live $149 sales are on. A server without
that capability is pack-only.

A server without `quote_v1` fails new billed `--assessment` work as
`UPDATE_REQUIRED` (exit 13) with zero reservation.

### Subscription display rules

Do **not** calculate renewal dates or grant quantities locally. Do **not**
infer access from a Stripe subscription ID or wall-clock vs `expiresAt`.
`accessState` remains the workspace lifecycle projection.

Known `status` values: `active`, `canceling`, `past_due`, `unpaid`,
`incomplete`, `incomplete_expired`, `canceled`, `processing`, `unsupported`,
`unknown`. Known `nextPaymentAction` values: `none`, `authenticate`,
`update_payment_method`, `processing`.

Unknown enum strings: preserve usage read; print an update-required message;
do not guess active/safe. Quote and admission remain server decisions and
still require `--max-credits`.

### Billing URL allowlist

Unchanged. Path `/portal/billing`, query only `workspace=<uuid>`. Reject
Customer Portal session URLs, checkout secrets, and tokens.

### Errors (CLI mapping)

Unchanged from 4B. `EXIT.BILLING` stays **13**. Assessment failures remain
10. Incomplete grading remains 11. Grading errors remain 12. Interrupt remains
130.

## Local-mode independence

`demo`, `test --local`, offline `doctor`, `init`, and `schema` make no billing
calls.

## Copyable commands (source 0.3.3)

After `npm ci && npm run build`:

```bash
node dist/index.js usage
node dist/index.js usage --json
node dist/index.js billing --print
node dist/index.js test --assessment ./augmentworks.assessment.yaml --estimate --json
node dist/index.js test --assessment ./augmentworks.assessment.yaml --profile quick --max-credits 30 --yes --json
node dist/index.js run wait <run-id> --json --timeout-ms 60000
```

CI: see README and `docs/examples/github-actions-hosted-source.yml`. Do **not**
document an unpublished source `0.3.3` npm pin until independently verified.

## Packed tarball (this checkout)

| Item | Value |
| --- | --- |
| Filename | `augmentworks-cli-0.3.3.tgz` |
| Files | 31 |
| Compressed size | 377347 bytes |
| SHA-256 | `f3ede5377af4d9de7b8abbf8d65943850bea6ced1a3a23dd6069b2abcb8d7afe` |

Includes `dist/index.js`, packets, schemas, contracts, demo assets, and both
starters. Excludes `examples/`, tests, `.env` secrets, and billing docs.

## Verification

See `docs/billing/phase-5-completion.md`.

Summary:

- `npm run check` — pass (typecheck, vitest **54 files / 513 tests**, build,
  discovery, billing-contract)
- `npm run smoke:pack` — pass, including packed billing HTTP fixture through
  the installed binary (`creates=1 quotes=4 targets=1 polls=3 refreshes=1`)
- `npm run test:packed-billing-live` — **BLOCKED** exit 2 (no disposable
  main API/token)

The HTTP fixture is not evidence of atomic monthly allocation or tenant RLS.
Stripe Test Clocks belong to main. This CLI uses fixtures plus packed HTTP.

## Live activation

**Not enabled.** This prompt must not publish `@augmentworks/cli`, change
production feature flags, send customer messages, or create real charges.
Measured all-in grading costs, repeat customer use, verified subscription
pricing/terms, and successful test-mode lifecycle checks remain main's
operational gate. `subscriptions_v1` on this CLI is display support, not live
Pro sales.
