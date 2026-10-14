# Billing Stage 3B completion record

This is the CLI (`augmentworks-org/augmentworks-cli`) Stage 3B record. It is **code
complete** for first-party billing-page navigation, insufficient-credit
recovery copy, and pending-purchase display.

It is **not** npm-published, **not** integration-verified against a deployed
Stage 3A host, and **not** release-ready for live sales. It does **not**
create Stripe customers, Checkout Sessions, purchases, refunds, or
subscriptions.

## Source and implementation identity

| Item | Value |
| --- | --- |
| CLI 2B baseline | `a442527e3e95826c4a474cbe5b8769f66e4e1237` (`cursor/billing-stage-2b-91a7`; feature `901f82ea`, verification `77b17f05`) |
| Working branch | `cursor/billing-stage-3b-91a7` |
| Implementation | `7fef4e9463a7c7baaf5f2f5873c0a95b0f37a45c` (billing command `4b0f06a49c158feaef152473cd78013a5d5064ef`) |
| Vendored main commit | `931838f29ee04fc018ef6359c22abd8d3e8da4c8` (`cursor/billing-stage-3a-91a7`) |
| Main 3A feature commit (hashes frozen) | `926ae72f1e8bba959cd2d5e54c3996236960b8c6` |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified in this prompt |

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| Code completion (this repository) | **Complete.** Vendored Stage 3A schema/fixtures/lock, `billing` / `billing --json` / `billing --print`, strict first-party URL allowlist, post-usage identity confirmation, insufficient-credit billing-page hint, `pendingCommerce` display |
| Deterministic verification | **Passed** in this checkout. Commands and outcomes below |
| Live Stage 3A host / Stripe Checkout | **Not run.** Missing external credentials are blockers, not passes |
| Release readiness | **Not ready.** No npm publish, no live sales, no real charges |

## Changed files

Contract vendoring:

- `contracts/aw-billing-v1.schema.json`
- `contracts/aw-billing-v1.fixtures.json`
- `contracts/aw-billing-v1.lock.json`
- `src/billing/generated/contract.ts`
- `docs/billing/main-source-handoff.md` (imported main 3A handoff; not CLI-owned)

CLI:

- `src/billing/protocol.ts`, `src/billing/validate.ts`, `src/billing/errors.ts`, `src/billing/format.ts`, `src/billing/index.ts`
- `src/commands/billing.ts`, `src/commands/usage.ts`, `src/commands/test.ts`, `src/cli.ts`
- `src/release.ts`
- README, authentication, protocol, troubleshooting, agent-setup, changelog, agent-resources

Tests: `test/billing/cli-billing.test.ts`, `test/billing/billing-url.test.ts`, plus contract, quote, isolation, copy, and CLI-entry updates.

No database migrations. This repository does not own SQL. There is **no** CLI
order-status API; purchase history stays on the website.

## Contract hashes

`schemaVersion`: `aw-billing/1`

| File | SHA-256 |
| --- | --- |
| schema | `e08fd3ee7766e615b64024f416d72ac012fb829610a3a9f5efcdd1ec4b3c0f6a` |
| fixtures | `3513887cc25d404d695ce1ca4e5f5b6cc60b138438ccfb24b9f9a3d0f5e4794a` |

Sourced from main `931838f29ee04fc018ef6359c22abd8d3e8da4c8`. Hashes match the
3A freeze since `926ae72`.

Advertised capabilities treated as available when present: `usage_v1`,
`quote_v1`, `status_v1`, `billing_portal_link_v1`. Reserved / ignored:
`subscriptions_v1`.

## Behavior that must hold

- `billing` retrieves `GET /v1/billing/capabilities` and `GET /v1/billing/usage`
  only. Zero Checkout, Stripe customer, refund, grant, reserve, or create-run
  calls.
- After the usage snapshot, `billing` re-authenticates. A changed workspace or
  connector is `WORKSPACE_MISMATCH` and does not open a billing page.
- Owner-like and member-like identities for the same workspace receive the
  same first-party URL. The workspace id is a navigation hint, not a billing
  role.
- The opened/printed URL is the server `billingPageUrl` after the allowlist:
  trusted HTTPS first-party origin (or matching loopback API origin), path
  `/portal/billing`, query `workspace=<authenticated-uuid>` only. Userinfo,
  protocol-relative URLs, lookalike hosts, unexpected ports, fragments, and
  sensitive query parameters are rejected.
- `--json` and `--print` never open a browser. Default `billing` without those
  flags is print-only in CI and when stderr is not a TTY. GUI opener failure
  still prints the safe URL and does not invalidate credentials or claim a
  purchase. The opener is given only the allowlisted URL; no token.
- Missing `billing_portal_link_v1` is `UPDATE_REQUIRED` (exit 13), not a zero
  balance and not a CLI price list.
- `pendingCommerce` is processing metadata. Fixture `pending_pack_purchase`
  keeps `availableUnits` at 200.
- Insufficient credits report required vs available units when known, keep the
  rejected/uncreated intent, and point at the first-party billing page. The
  CLI does not wait for a purchase or restart a billable run.
- After fulfillment, `usage` shows the new purchased lot; the user must start
  the next test explicitly with `--max-credits`.
- Catalog prices are not CLI constants. The $149 monthly offer is not
  advertised. `EXIT.BILLING` remains 13. Evaluation-incomplete 11,
  evaluation-error 12, and interrupted 130 are unchanged.
- Quote, `--max-credits`, quoted `aw-relay/0.3` create, and `run status` /
  `wait` / `retry-evaluation` remain as Stage 2B implemented them.

## Verification actually run

Working directory: `/Users/jeffskafi/Desktop/augmentworks-cli-billing-3b`.

| Command | Outcome |
| --- | --- |
| `node scripts/import-aw-billing-contract.mjs --from <3A worktree>` | Pass. Imported `931838f29ee04fc018ef6359c22abd8d3e8da4c8` |
| `npm run check:billing-contract` | Pass. schema `e08fd3ee7766e615b64024f416d72ac012fb829610a3a9f5efcdd1ec4b3c0f6a`; fixtures `3513887cc25d404d695ce1ca4e5f5b6cc60b138438ccfb24b9f9a3d0f5e4794a` |
| `npm run check` | Pass. typecheck, vitest, build, discovery, billing-contract |
| `npx tsc --noEmit` | Pass (via `npm run check`) |
| `npx vitest run` | Pass. Vitest 4.1.11: **49 files, 414 tests** |
| `npm run build` | Pass. tsup ESM `dist/index.js` 1.64 MB |
| `npx tsx scripts/check-discovery-manifest.mjs` | Pass. `@augmentworks/cli@0.3.2` (development) |
| `node scripts/smoke-pack.mjs` | Pass. Packed tarball **20 files, 357981 compressed bytes** |

Do not treat this file as evidence that live Stripe Checkout, webhook
fulfillment, or a deployed Stage 3A host was exercised. Main 3A recorded
`pnpm test:stripe` exit 2 (missing credentials). That remains an external
blocker for payment proof. The CLI simulator/HTTP fixtures are not Stripe
proof.

## Required configuration

Existing CLI auth config is sufficient:

- Trusted API origin (`https://augmentworks.ai` or loopback `AUGMENTWORKS_API_URL`)
- Connector bearer with `connector:identity` (billing/usage) and `connector:run` (quoted tests)

No Stripe keys. No Clerk. No new OAuth client. No CLI wallet.

## Activation checklist (human)

1. Main Stage 3A must be deployed with `billing_portal_link_v1` and the
   first-party `/portal/billing` page.
2. Confirm `GET /v1/billing/usage` returns a trusted `billingPageUrl`.
3. Do not publish npm or enable live purchases.
4. Do not document `npx @augmentworks/cli@0.3.2` until that tarball is
   published and independently verified.
5. Stripe test-mode Checkout remains a main-repo external gate
   (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_TEST_PACK_300_V1`).
6. Stage 4A may use this CLI artifact for joint journeys. Stage 4B owns
   packaged onboarding file generation.

## Counterpart compatibility

Stage 3A advertises `usage_v1`, `quote_v1`, `status_v1`, and
`billing_portal_link_v1`. This CLI treats `billing_portal_link_v1` as
available only when present. `subscriptions_v1` remains reserved.

There is no CLI order-status endpoint. Purchase history is browser-only.
Optional usage `pendingCommerce` is displayed and never added to
`availableUnits`.

Published CLI 0.3.1 cannot send `aw-relay/0.3` or open `billing`. After
cutover it receives `UPDATE_REQUIRED` for new billed `--assessment` work.

## Blocked / not run

- Live billing-page open against production or staging AugmentWorks
- Real Stripe test-mode Checkout/webhook/3DS (owned by main 3A; **BLOCKED**
  there for missing credentials)
- npm publish
- Live OpenAI calibration (owned by main; UNVERIFIED there)

## Live activation state

**Disabled.** Stage 3B does not enable purchases, subscriptions, or a
published CLI billing release. Kill switch and live-sales flags stay on the
main server.
