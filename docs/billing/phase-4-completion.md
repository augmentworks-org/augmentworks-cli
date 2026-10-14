# Billing Stage 4B completion record

This is the CLI (`augmentworks-org/augmentworks-cli`) Stage 4B record. It is **code
complete** for packaged empty-directory onboarding, packed-tarball smoke,
and the prepaid journey over the vendored `aw-billing/1` contract.

It is **not** npm-published, **not** integration-verified against a disposable
migrated main database, and **not** release-ready for live sales. It does
**not** create Stripe customers, Checkout Sessions, purchases, refunds, or
subscriptions.

## Source and implementation identity

| Item | Value |
| --- | --- |
| CLI 3B baseline | `d584f474bc3c043c33c6a5c75ef40d838bebafcb` (`cursor/billing-stage-3b-91a7`) |
| Working branch | `cursor/billing-stage-4b-91a7` |
| Implementation | `c9f079a3fe9b08ba743977115849e594462bbb3d` (packed journey); `7e213781a387292f634ea3df05800ef632e1f184` (rebuild stale packed dist) |
| Vendored main commit | `49806f0f52377bbca0fbe02f160668723c589fa7` |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified in this prompt |
| Working directory used for verification | `/Users/jeffskafi/Desktop/augmentworks-cli-billing-4b` |

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| Code completion (this repository) | **Complete.** Packaged starters, `init` overwrite rules, doctor wire bounds, packed HTTP fixture with target execution/refresh/recovery, live gate that fails closed without credentials and runs the packed binary against a loopback API when credentials are supplied |
| Deterministic verification | **Passed** in this checkout. Commands and outcomes below |
| Packed binary over HTTP fixtures | **Passed.** One synthetic `/chat` target, token refresh, dropped-create replay, process restart, pending grading wait. Not PostgreSQL/RLS proof |
| Live Stage 4A host / disposable DB | **Not run / BLOCKED.** Missing `AW_BILLING_LIVE_API_URL` and `AW_BILLING_LIVE_TOKEN` |
| Stripe test-mode pack purchase | **Not run.** Owned by main; credentials missing there |
| Release readiness | **Not ready.** No npm publish, no live sales, no real charges |

## Changed files

Contract vendoring from main 4A:

- `contracts/aw-billing-v1.schema.json`
- `contracts/aw-billing-v1.fixtures.json`
- `contracts/aw-billing-v1.lock.json`
- `src/billing/generated/contract.ts`
- `docs/billing/main-source-handoff.md` (imported main 4A handoff; not CLI-owned)

Onboarding and doctor:

- `assets/starters/response-quality/**`
- `assets/starters/workflow/**`
- `src/onboarding/starters.ts`
- `src/system/package-root.ts`
- `src/assessment/wire-bounds.ts`
- `src/commands/init.ts`
- `src/commands/doctor.ts`

Packed gates:

- `scripts/smoke-pack.mjs`
- `scripts/packed-billing-fixture.mjs`
- `scripts/packed-billing-live.mjs`
- `package.json` scripts `test:packed-billing-fixture` / `test:packed-billing-live`

Billing/quote additive fields and hosted JSON errors:

- `src/billing/protocol.ts`, `src/billing/validate.ts`, `src/billing/format.ts`
- `src/commands/test.ts`

Docs / release pin:

- `src/version.ts` (`0.3.3`), `src/release.ts`, `schemas/v1/cli-release.json`
- README, changelog, agent-resources, discovery, compatibility matrix,
  `docs/billing/phase-4a-cli-4b-scenario.md`, this file, CLI handoff,
  `docs/billing/phase-4-release-evidence.md`

Tests: `test/config/commands.test.ts`, `test/billing/contract.test.ts`,
`test/billing/cli-run-wait.test.ts`, `test/util/cli-process.ts` (rebuild
stale `dist/` before packed tests), copy/discovery tests.

No database migrations. This repository does not own SQL.

## Contract hashes

`schemaVersion`: `aw-billing/1`

| File | SHA-256 |
| --- | --- |
| schema | `e66d87fb48bd91ffbd125f1337b7978e4b60334be838fe46c40fce468cd8cc7b` |
| fixtures | `42da35022b78954ab214fa4e2f9a1bcb903790056f4dfb57cf1dece5e632ec3c` |

Sourced from main `49806f0f52377bbca0fbe02f160668723c589fa7`.

Advertised capabilities treated as available when present: `usage_v1`,
`quote_v1`, `status_v1`, `billing_portal_link_v1`. Reserved / ignored:
`subscriptions_v1`.

## Behavior that must hold

- Empty-directory `init` produces the advertised starter files before any
  assessment. Decorative labels without matching files are insufficient.
- Second `init` without `--force` is `INIT_FILE_EXISTS` (exit 2). `--force`
  still never replaces `.env`.
- Offline doctor validates assessment wire bounds and capability match and
  makes zero billing/target calls.
- Packed tarball includes starters, contracts, packets, schemas, and
  `dist/index.js`. It excludes secrets and development fixtures.
- Packed HTTP fixture: estimate causes zero creates and zero target calls;
  `--max-credits 0` is `BUDGET_EXCEEDED` with zero target calls; successful
  admission creates one run, executes one synthetic `/chat` target after a
  dropped create and process restart, leaves grading pending, then `run wait`
  completes a valid FAIL; exhausted usage opens only the first-party billing
  page; `run status` / `run wait` after target execution make zero additional
  target calls.
- `billing` / `usage` / estimate remain read-only for payment. No CLI request
  creates a Stripe Customer, Checkout Session, purchase, refund, or
  subscription.
- `npx --yes` is not `--max-credits`. Hosted noninteractive tests require an
  explicit ceiling.
- Account-free `demo` / `test --local` / offline doctor remain account-free.
- Website npx pin stays **0.3.2**. Do not advertise unpublished `0.3.3`.

## Verification actually run

| Command | Outcome |
| --- | --- |
| `npm run check:billing-contract` | Pass. schema `e66d87fb…cc7b`; fixtures `42da3502…ec3c`; source `49806f0` |
| `npm run check` | Pass. typecheck, vitest, build, discovery, billing-contract |
| `npx vitest run` | Pass. Vitest 4.1.11: **53 files, 468 tests** |
| `npm run build` | Pass. tsup ESM `dist/index.js` 1.68 MB |
| `AUGMENTWORKS_PACKED_BIN=$PWD/dist/index.js node scripts/packed-billing-fixture.mjs` | Pass. `creates=1 quotes=4 targets=1 polls=3 refreshes=1` |
| `npm run smoke:pack` | Pass. **31 files, 371282 compressed bytes**, packed billing fixture included |
| `npm run test:packed-billing-live` | **BLOCKED** exit 2 |

Do not treat the HTTP fixture as evidence that Stripe, PostgreSQL, or RLS was
exercised. Main 4A recorded Stripe test-mode as **BLOCKED** (missing
credentials). That remains an external blocker for payment proof.

## Required configuration

Existing CLI auth config is sufficient for code-complete work:

- Trusted API origin (`https://augmentworks.ai` or loopback `AUGMENTWORKS_API_URL`)
- Connector bearer with `connector:identity` and `connector:run`

No Stripe keys. No Clerk. No new OAuth client. No CLI wallet.

For the live packed gate (still blocked):

- `AW_BILLING_LIVE_API_URL` — disposable staging/main API, not production
- `AW_BILLING_LIVE_TOKEN` — scoped connector token for that environment
- Optional `AW_BILLING_LIVE_DATABASE_URL` plus
  `AW_BILLING_LIVE_DISPOSABLE_DB=1` if the URL is Supabase-hosted
- `AW_BILLING_LIVE_ALLOW_NON_LOOPBACK=1` for a designated staging host

## Activation checklist (human)

1. Publish `@augmentworks/cli@0.3.3` only after independent registry
   verification. Until then, website/docs stay on **0.3.2**.
2. Deploy main with ledger, quotes, Checkout (sales flag off), and the 4A
   readiness migration before enabling new paid admission for this package.
3. Run `npm run test:packed-billing-live` against a disposable migrated
   database. A mock usage payload is not that gate.
4. Main Stripe test-mode pack purchase remains a main-repo external gate.
5. Do not enable live purchases, send customer mail, or create real charges
   from this prompt.
6. Stage 5A may add `subscriptions_v1` additively. This CLI must keep reading
   usage/quote/status/billing-page without calculating renewals.

## Counterpart compatibility

See `docs/billing/compatibility-matrix.md`. Published 0.3.2 cannot send
quoted `aw-relay/0.3` create, generate assessment starters, or run `usage` /
`billing`. After paid cutover, older clients receive `UPDATE_REQUIRED` for
new billed `--assessment` work. Authorized read/status may continue.

## Blocked / not run

- Packed CLI against a disposable migrated main database (exit 2, credentials)
- Real Stripe test-mode Checkout/webhook/3DS (owned by main; **BLOCKED** there)
- npm publish
- Live OpenAI calibration (owned by main; UNVERIFIED there)
- Production webhook or live sales flags

## Live activation state

**Disabled.** Stage 4B does not enable purchases, subscriptions, or a
published CLI billing release. Kill switch and live-sales flags stay on the
main server.
