# AUG-137 / MT11 completion — pin selection shards to one workspace and connector

Issue: [AUG-137](https://linear.app/augmentworks/issue/AUG-137/cli-mt11-pin-every-shard-and-resumed-selection-to-one-workspace-and)

Owned repository: `augmentworks-org/augmentworks-cli`. Main (`augmentworks-org/augmentworks`) remains read-only.

This is **source integration** for local selection-execution tenant pinning
(`aw-selection-execution/3`). It is **not** npm publication, server deployment,
feature enablement, or customer use. Those remain MT14 / existing release
policy. Independently inspected npm `@augmentworks/cli@0.3.6` is unchanged by
this merge.

## Identity

| Item | Value |
| --- | --- |
| CLI default main at start | `e36352fafb96e1ba4a7462bd571a4188befc962b` (issue-cited audit head) |
| Working branch | `cursor/mt11-selection-tenant-pin-b1f4` |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/55 |
| Source head after verification | recorded in git on this branch after the verification commit |
| Frozen contract | [AW-MULTITENANCY-1](https://linear.app/augmentworks/document/aw-multitenancy-1-gap-analysis-contracts-and-implementation-plan-2026-09482fb6b45f) |
| Source package | `0.3.7` (unpublished; npm latest at ticket write was `0.3.6`) |
| Schema / artifact version | `aw-selection-execution/3` and `aw-selection-execution-index/3` |
| Legacy fail-closed parsers | `aw-selection-execution/2`, `aw-selection-execution-index/2`, spent `aw-selection-progress/1` |
| Main repository | **Not modified.** |
| Billing / run-report contracts | Untouched (vendored hash checks only) |
| Migrations | None. This repository does not own SQL. Rollback is revert of the application change; local `/3` files remain readable by this parser, `/2` stays fail-closed. |

## Owned implementation

- `src/selection/schema.ts` — versioned tenant binding (`api_origin` + nested
  `RunIntentTenantBinding`); current `/3` and legacy `/2` document kinds.
- `src/selection/tenant.ts` — origin normalize, session pin, equality,
  manifest workspace assertion, original run-id listing.
- `src/selection/errors.ts` — `SELECTION_TENANT_MISMATCH` (auth) and
  `SELECTION_LEGACY_UNBOUND` (config). Safe expected/actual workspace IDs only.
- `src/selection/execution.ts` — authenticate-independent preflight; required
  tenant on create/resume; reject mismatch before quote; fail-closed `/2` and
  spent v1 progress (no relabel); persist tenant atomically with the execution
  and index. Storage path remains `selections/{manifestHash}/`; mismatched
  tenant is rejected on unfinished resume without breaking execution-id lookup.
- `src/selection/admit.ts` / `src/commands/test.ts` / `src/selection/gate-execute.ts`
  — parent session pin before quote/state mutation; re-auth each shard and
  assert origin/workspace/connector; foreign-workspace manifests denied
  including catalog shards; JSON codes, no fabricated verdict.
- Auth resolution (`HostedAuthSession`, `assertSameTenant`, run-intent
  identity) is consumed read-only. MT12 still owns hosted-command auth plumbing.

## Compatibility and recovery

| Local record | Behavior |
| --- | --- |
| `aw-selection-execution/3` | Resume only with the pinned origin/workspace/connector. Token refresh allowed only when identity is unchanged. |
| `aw-selection-execution/2` | `SELECTION_LEGACY_UNBOUND`. File left unchanged. Recorded run IDs are for authorized observation only. No automatic charge/replay. |
| Spent `aw-selection-progress/1` | Same fail-closed unbound recovery. |
| Unused all-pending v1 | Mark `v1Migrated` without quoting. |
| Published npm `0.3.6` | Still writes unbound `/2`. Source `0.3.7` is not evidence of publication. |

## Verification

No production credential, quote, reservation, run, or charge. Synthetic
fixtures and disposable temp directories only.

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | Pass |
| `npx vitest run test/selection/execution.test.ts` | Pass (43 tests), including credential-swap, resume mismatch, token-rotation connector switch, foreign-workspace manifest, unused v1, and fail-closed `/2` |
| `npm test -- test/selection/execution.test.ts test/selection/saved-suite.test.ts test/run-intent/boundary.test.ts test/billing/cli-quote.test.ts` | Pass: 4 files / 76 tests |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN -u AUGMENTWORKS_API_URL npm run check` | Pass: typecheck, 92 files / 910 tests, `tsup` build, discovery/billing/run-report contracts. Inherited hosted secrets were unset so child CLI tests did not see `AUTH_ENV_CONFLICT`. |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN -u AUGMENTWORKS_API_URL npm run smoke:pack` | Pass (68 packed files, 533062 compressed bytes). Local packed core-release `releaseReady=false` (registry-identity and live-authorized-environment not_run). |
| `check:billing-contract` / `check:run-report-contract` | Pass; prove vendored hashes only (`aw-billing/1` schema `3097c7aa…`, fixtures `a4b9234b…`; `aw-run-report/1` schema `7726ec27…`, fixtures `febd2626…`) |

Negative authorization checks assert zero later quotes/creates/target calls and
unchanged remaining credits after a credential swap (shard 1 completed, shard 2
pending). Same-tenant resume keeps the original admitted run/quote binding.

## Limitations / remaining external prerequisites (NAME only)

- **npm publication (MT14 / existing release policy)** — not assumed from merge.
- **Protected `v0.3.7` publish** — source package identity is not a live registry probe.
- **MT12** — explicit workspace login / preflight guards on every hosted command.
- **MT13** — main-repo multi-tenancy release gates on real database journeys.
- Production charges, provider purchases, permission changes, merge/deploy, and
  customer usage are out of scope.

## Rollback

Revert the application change. No server migration. Access revocation, retention,
and valid existing `/3` reads stay intact. There is no feature flag; `/2` and
spent v1 files already fail closed and must not be rewritten onto the current
login.
