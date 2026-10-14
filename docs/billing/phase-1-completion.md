# Billing Stage 1B completion record

This is the CLI (`augmentworks-org/augmentworks-cli`) Stage 1B record. It is **code
complete** for authenticated usage display and identity-preserving refresh.

It is **not** npm-published, **not** integration-verified against a deployed
Stage 1A host, and **not** release-ready for live sales.

## Source and implementation identity

| Item | Value |
| --- | --- |
| CLI baseline | `origin/main` `d36ec8590b005445dba940d2df3abcb53971cea5` (source 0.3.2; published npm remains 0.3.1) |
| Working branch | `cursor/billing-stage-1b-91a7` |
| Implementation | `3d2bdfa32a727ac35c1b0ea49a9dfd376151b895` |
| Vendored main commit | `e037958ba3c9f38a436b6065cddb5fb8ee3943fa` |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified in this prompt |

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| Code completion (this repository) | **Complete.** Vendored aw-billing/1 schema/fixtures/lock, import/check commands, `usage` / `usage --json`, consumer validation, CloudClient billing GETs, exit 13 |
| Deterministic verification | **Passed** in this checkout. Commands and outcomes below |
| Live Stage 1A host | **Not run.** No deployed billing host was available to this CLI session |
| Stripe / production RLS / model provider | **Not applicable** to 1B. Not simulated as passing |
| Release readiness | **Not ready.** No npm publish, no live sales, no real charges |

## Changed files

Contract vendoring:

- `contracts/aw-billing-v1.schema.json`
- `contracts/aw-billing-v1.fixtures.json`
- `contracts/aw-billing-v1.lock.json`
- `src/billing/generated/contract.ts`
- `docs/billing/main-source-handoff.md` (imported main handoff; not CLI-owned)
- `scripts/import-aw-billing-contract.mjs`
- `scripts/aw-billing-contract.mjs`
- `scripts/check-aw-billing-contract.mjs`

CLI:

- `src/billing/*`
- `src/commands/usage.ts`
- `src/cloud/client.ts` (billing GET, lowercase error mapping, abort-signal forwarding)
- `src/cli.ts`
- `src/errors.ts` (`billing` category, `EXIT.BILLING = 13`)
- `src/release.ts` (`SOURCE_USAGE_COMMAND` / `SOURCE_USAGE_JSON_COMMAND`)
- `package.json` (`check:billing-contract`, `generate:billing-contract`)
- README, authentication, protocol, troubleshooting, changelog, agent-setup, agent-resources, smoke-pack inventory

Tests: `test/billing/*.test.ts` plus command-surface copy/entry updates.

No database migrations. This repository does not own SQL.

## Contract hashes

| File | SHA-256 |
| --- | --- |
| schema | `2ea0236b9fa1bac4a7e50dbd5d016c9b9b32a4b7b31298cfc53104308bdace8d` |
| fixtures | `6ef4e83f2dfa5f5ffc22dd97ec35c106ef7d012d7433e107cf551841b0eb7556` |

Verified by `npm run check:billing-contract` against
`contracts/aw-billing-v1.lock.json` sourced from main
`e037958ba3c9f38a436b6065cddb5fb8ee3943fa`.

The 200 granted / 10 reserved-then-consumed fixture is reused as **190**
available. The CLI does not reimplement the balance calculator.

## Verification actually run

Working directory: `/Users/jeffskafi/Desktop/augmentworks-cli-billing-1b`.

| Command | Outcome |
| --- | --- |
| `npm run check:billing-contract` | Pass. `aw-billing/1` from `e037958ba3c9f38a436b6065cddb5fb8ee3943fa`; schema and fixture hashes above |
| `npm run typecheck` | Pass (`tsc --noEmit`) |
| `npm test` | Pass. Vitest 4.1.11: **46 files, 360 tests** |
| `npm run build` | Pass. tsup ESM `dist/index.js` 1.58 MB |
| `npm run check:discovery` | Pass. `@augmentworks/cli@0.3.2` (development) |
| `npm run check` | Pass (typecheck + test + build + discovery + billing contract) |
| `npm run smoke:pack` | Pass. Packed tarball **20 files, 342396 compressed bytes**; init/offline doctor, bundled local packet, packaged demo from installed tarball |

Billing-focused tests in `test/billing/` cover: locked hashes and the 190-available fixture; reserved/consumed meanings; unknown capability + later non-null subscription; malformed reject; unknown `accessState` fail-closed; exit 13; usage without a config directory; JSON stdout purity; workspace mismatch (exit 3); revoked membership (exit 3, not a zero balance); wrong scope; unprovisioned profile recovery; capabilities without `usage_v1`; 404 unsupported; oversized/malformed/redirected responses; 503 retry-once; token refresh keeping `billingAccountId`; abort; account-free doctor/demo/schema/local-test isolation.

## Defects resolved during this prompt

- Restored `SOURCE_DEMO_COMMAND` / `SOURCE_DEMO_JSON_COMMAND` that Stage 1B wiring had dropped from `src/release.ts`.
- Usage dependency types no longer conflict with hosted-auth `stderr`.
- Cloud GET abort now fails closed when the caller signal is already aborted, instead of completing the read.
- Windows CI hashed CRLF working-tree copies of the vendored schema. Hashes are now canonical LF bytes, and `.gitattributes` locks those files to LF. Windows lock-directory `rmdir` retries `ENOTEMPTY`/`EBUSY` after owner-file unlink.

## Required configuration

Existing CLI auth config is sufficient:

- Trusted API origin (`https://augmentworks.ai` or loopback `AUGMENTWORKS_API_URL`)
- Connector bearer with `connector:identity` (`login` or `AUGMENTWORKS_TOKEN`)

No Stripe keys. No new OAuth scope. No Clerk.

## Activation checklist (human)

1. Main Stage 1A migrations and cutover must be applied on the target database.
2. Confirm `GET /v1/billing/usage` with a real connector against that host.
3. Do not publish npm or advertise purchases.
4. Stage 2A may add quotes/status; this CLI must not invent those APIs.
5. Do not document `npx @augmentworks/cli@0.3.2` until that tarball is published and independently verified. Source usage is `node dist/index.js usage`.

## Counterpart compatibility

Stage 1A advertised `usage_v1` only. This CLI treats only that capability as
available. A later non-null `subscription` object is ignored for sales
semantics. Unknown capability strings are ignored. Unknown `accessState`
values are not guessed active.

Primary routes used: `GET /v1/billing/capabilities` and `GET /v1/billing/usage`.
Server aliases `/api/v1/billing/*` are not called.

## Blocked / not run

- Live `GET /v1/billing/usage` against production or staging AugmentWorks
- npm publish (`npm publish` / `prepublishOnly` not executed as a release)
- Stripe test-mode or live charges (out of scope)
- Production database/RLS (owned by main 1A; not claimed here)

## Live activation state

**Disabled.** Stage 1B does not enable purchases, subscriptions, or a published
CLI billing release.
