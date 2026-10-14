# Billing Stage 2B completion record

This is the CLI (`augmentworks-org/augmentworks-cli`) Stage 2B record. It is **code
complete** for estimates, spending consent, quoted admission, and original-run
status/recovery.

It is **not** npm-published, **not** integration-verified against a deployed
Stage 2A host, and **not** release-ready for live sales.

## Source and implementation identity

| Item | Value |
| --- | --- |
| CLI 1B baseline | `b26927f679e634692b89c6c080a694b30d94b6bd` (`cursor/billing-stage-1b-91a7`) |
| Working branch | `cursor/billing-stage-2b-91a7` |
| Implementation | `901f82ea11a69a136364ea9c604629886c1cf878` (feature), `77b17f0514bfe9a06dc9eefefa01c2c5c6f30e9c` (verification record) |
| Vendored main commit | `67749b22f04bbb8d94c0309acd36be3cb3144400` |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified in this prompt |

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| Code completion (this repository) | **Complete.** Vendored Stage 2A schema/fixtures/lock, `test --estimate`, `--max-credits`, quoted `aw-relay/0.3` create, `run status` / `wait` / `retry-evaluation` |
| Deterministic verification | **Passed** in this checkout. Commands and outcomes below |
| Live Stage 2A host / Stripe / OpenAI | **Not run.** Missing external credentials are blockers, not passes |
| Release readiness | **Not ready.** No npm publish, no live sales, no real charges |

## Changed files

Contract vendoring:

- `contracts/aw-billing-v1.schema.json`
- `contracts/aw-billing-v1.fixtures.json`
- `contracts/aw-billing-v1.lock.json`
- `src/billing/generated/contract.ts`
- `docs/billing/main-source-handoff.md` (imported main 2A handoff; not CLI-owned)
- `scripts/import-aw-billing-contract.mjs`

CLI:

- `src/billing/consent.ts`, `src/billing/quote-request.ts`, `src/billing/errors.ts`, `src/billing/format.ts`, `src/billing/protocol.ts`, `src/billing/validate.ts`, `src/billing/index.ts`
- `src/commands/test.ts`, `src/commands/run.ts`, `src/cli.ts`
- `src/cloud/client.ts`, `src/cloud/protocol.ts`
- `src/relay/run-intent.ts`, `src/relay/runner.ts`
- `src/version.ts` (`RELAY_PROTOCOL_VERSION_V3`)
- `src/release.ts` (source estimate / max-credits / run command strings)
- README, authentication, protocol, troubleshooting, changelog, agent-setup, agent-resources

Tests: `test/billing/cli-quote.test.ts` plus contract, copy, entry, protocol, run-intent, and version updates.

No database migrations. This repository does not own SQL.

## Contract hashes

| File | SHA-256 |
| --- | --- |
| schema | `4816444925c39629d41fc6993b0206fa5db25641ce40aafc13af6fe1a89ef901` |
| fixtures | `cb26b6d36bf01d7c1957354f8982f20a6cfd8c8c47859f46e37d5270b75dd4a1` |

Sourced from main `67749b22f04bbb8d94c0309acd36be3cb3144400`.

## Behavior that must hold

- Estimate: zero create/reserve/target/provider calls.
- Rejected `--max-credits` below the quote: zero target or create calls.
- Successful quoted admission sends one `aw-relay/0.3` create with server
  `quote_id` and the consent ceiling.
- Dropped create resumes the same identity and original `quote_id`.
- Ambiguous create reconciles; it does not re-quote into another run.
- Proven-uncreated `QUOTE_EXPIRED` retires the intent; the next invocation
  may re-quote. A larger quoted quantity cannot pass a previously supplied
  numerical ceiling.
- Missing `quote_v1` is `UPDATE_REQUIRED`, not an `aw-relay/0.2` fallback.
- Packet-only `--packet` stays `aw-relay/0.1` and does not quote.
- `run status` / `run wait` / `run retry-evaluation` make zero target calls
  and zero new reservations. Retry reports `customer_units_debited: 0`.
- `--local` / `demo` / offline `doctor` / `schema` make no billing calls.

## Verification actually run

Working directory: `/Users/jeffskafi/Desktop/augmentworks-cli-billing-2b`.

| Command | Outcome |
| --- | --- |
| `npm run check:billing-contract` | Pass. `aw-billing/1` from `67749b22f04bbb8d94c0309acd36be3cb3144400`; schema `4816444925c39629d41fc6993b0206fa5db25641ce40aafc13af6fe1a89ef901`; fixtures `cb26b6d36bf01d7c1957354f8982f20a6cfd8c8c47859f46e37d5270b75dd4a1` |
| `npm run typecheck` | Pass (`tsc --noEmit`) |
| `npm test` | Pass. Vitest 4.1.11: **47 files, 379 tests** |
| `npm run build` | Pass. tsup ESM `dist/index.js` 1.63 MB |
| `npm run check:discovery` | Pass. `@augmentworks/cli@0.3.2` (development) |
| `npm run check` | Pass (typecheck + test + build + discovery + billing contract) |
| `npm run smoke:pack` | Pass. Packed tarball **20 files, 354301 compressed bytes**; init/offline doctor, bundled local packet, packaged demo from installed tarball |

Billing-focused tests in `test/billing/` cover Stage 1 usage fixtures plus Stage 2 quote/status: estimate has zero create/target calls; rejected ceilings do not start the target; dropped create resumes the same `quote_id`; proven-uncreated `QUOTE_EXPIRED` retires then requotes; a later larger quote cannot pass the previous numerical ceiling; missing `quote_v1` is `UPDATE_REQUIRED` with no 0.2 fallback; packet-only stays 0.1 and does not quote; `run status` / `wait` / `retry-evaluation` make zero target or reservation calls; `--yes` is not an unlimited budget.

Do not treat this file as evidence that a live Stage 2A host, Stripe, or OpenAI calibration ran.

## Required configuration

Existing CLI auth config is sufficient:

- Trusted API origin (`https://augmentworks.ai` or loopback `AUGMENTWORKS_API_URL`)
- Connector bearer with `connector:identity` and `connector:run`

No Stripe keys. No Clerk. No new OAuth client.

## Activation checklist (human)

1. Main Stage 2A migrations and quote/status handlers must be deployed.
2. Confirm `POST /v1/billing/quote` and quoted `POST /v1/relay/runs` with a
   real connector against that host.
3. Do not publish npm or advertise purchases.
4. Do not document `npx @augmentworks/cli@0.3.2` until that tarball is
   published and independently verified.
5. Stage 3A may add Checkout; this CLI must not invent payment APIs.

## Counterpart compatibility

Stage 2A advertised `usage_v1`, `quote_v1`, and `status_v1`. This CLI treats
those as available only when present. Reserved purchase/subscription names
are ignored. Unknown financial/access states fail closed.

Published CLI 0.3.1 cannot send `aw-relay/0.3`. After cutover it receives
`UPDATE_REQUIRED` for new billed `--assessment` work. Packet-only 0.1 and
authorized read/status access remain as the server rollout contract allows.

## Blocked / not run

- Live quote/create/status against production or staging AugmentWorks
- npm publish
- Stripe test-mode or live charges (out of scope for 2B)
- Live OpenAI calibration (owned by main 2A; UNVERIFIED there)

## Live activation state

**Disabled.** Stage 2B does not enable purchases, subscriptions, or a
published CLI billing release.
