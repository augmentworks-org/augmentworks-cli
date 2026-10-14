# AUG-138 / MT12 completion — explicit workspace login and hosted preflight guards

Issue: [AUG-138](https://linear.app/augmentworks/issue/AUG-138/cli-mt12-add-explicit-workspace-login-and-preflight-guards-to-every)

Owned repository: `augmentworks-org/augmentworks-cli`. Main (`augmentworks-org/augmentworks`) remains read-only.

This is **source integration** for `--workspace` / `AUGMENTWORKS_WORKSPACE_ID`
preflight. It is **not** npm publication, server deployment, feature
enablement, or customer use. Those remain MT14 / existing release policy.
Independently inspected npm `@augmentworks/cli@0.3.6` is unchanged by this
merge and does **not** expose the new flags.

## Identity

| Item | Value |
| --- | --- |
| CLI default main at start | `d379968632517e6351450bf77f1a5e407e2140f5` (includes merged MT11 PR #55; issue-cited audit head was `e36352fafb96e1ba4a7462bd571a4188befc962b`) |
| Working branch | `cursor/mt12-workspace-login-preflight-5190` |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/57 |
| Source head after verification | `89d18fe08634d25c068880e8cc88eabae4988040` |
| Frozen contract | [AW-MULTITENANCY-1](https://linear.app/augmentworks/document/aw-multitenancy-1-gap-analysis-contracts-and-implementation-plan-2026-09482fb6b45f) `aw-cli-workspace-selection/1` |
| Source package | `0.3.7` (unpublished; npm latest at ticket write was `0.3.6`) |
| Schema / artifact version | No new document kind. Hosted report pin remains `aw-run-report-export/1`; selection pin remains `aw-selection-execution/3` |
| Main repository | **Not modified.** |
| Billing / run-report contracts | Untouched (vendored hash checks only) |
| Migrations | None. This repository does not own SQL. Rollback is revert of the application change. |

## Owned implementation

- `src/auth/workspace-expectation.ts` — centralized parse/validate/compare.
  RFC 4122 UUID grammar matches billing. Flag/env conflict is
  `WORKSPACE_CONFIG_CONFLICT` (config, exit 2) before network. Invalid explicit
  values are `INVALID_WORKSPACE_ID` and are never ignored. Empty/whitespace env
  is treated as unset; empty `--workspace` is invalid.
- `src/auth/client.ts` / `src/auth/loopback.ts` — selected login sends
  `expected_workspace_id` on authorize query and device start body. OAuth
  `workspace_mismatch` maps to `WORKSPACE_MISMATCH` before a generic 403
  `SCOPE_DENIED`.
- `src/commands/login.ts` — parse expectation first; after exchange call
  `/auth/me`; save only on match; revoke unused grant and leave the previous
  origin slot unchanged on mismatch (compatibility explanation when the server
  may have ignored intent).
- `src/commands/hosted-auth.ts` — every hosted session parses expectation,
  calls `/auth/me`, then asserts before constructing the cloud client. Token
  refresh re-checks tenant pin **and** expected workspace. API-key mode does
  not fall back to stored login.
- Hosted command option plumbing: `login`, `whoami`, `usage`, `billing`,
  `selection compile`, `test`, `run status`/`wait`/`retry-evaluation`/`report`,
  `compare`, `gate`, `baseline status`/`promote`, `investigation fetch`,
  `recover`, unregistered `connect`.
- Human login/`whoami`/spend context print authenticated **name and UUID**.
  Overridden `AUGMENTWORKS_API_URL` origin is shown when present. JSON identity
  already included `workspace_id`; `api_origin` is additive only when
  overridden.
- Local: `test --local --workspace` is `LOCAL_WORKSPACE_UNSUPPORTED` (config,
  exit 2). Offline commands do not register the flag. `AUGMENTWORKS_WORKSPACE_ID`
  is ignored in local mode and does not open a hosted session.
- MT11 parent-session pin remains after this preflight. No second auth path
  bypasses `authenticateHostedSession`.

## Compatibility and recovery

| Case | Behavior |
| --- | --- |
| No `--workspace` / env | Existing single-workspace scripts keep working. Human output now includes UUID. |
| Flag and env disagree | `WORKSPACE_CONFIG_CONFLICT` before any network or store write. |
| API key for B + expected A | `WORKSPACE_MISMATCH` after `/auth/me`. No retarget, retry, or stored-login fallback. |
| Selected login `/auth/me` mismatch | Unused grant revoked best-effort; previous stored credential untouched. |
| Server ignores `expected_workspace_id` | Still fail-closed on `/auth/me`. Compatibility note in the error. |
| `test --local --workspace` | Rejected. Env ignored. Zero hosted network. |
| Published npm `0.3.6` | No `--workspace`. Source `0.3.7` is not evidence of publication. |

## Verification

No production credential, quote, reservation, run, or charge. Synthetic
fixtures and disposable temp directories only. Inherited hosted secrets were
unset (`AUGMENTWORKS_API_KEY`, `AUGMENTWORKS_TOKEN`, `AUGMENTWORKS_API_URL`)
so child CLI tests did not see `AUTH_ENV_CONFLICT`.

Negative authorization checks assert zero later tenant calls (no usage GET,
no quote/create/target) after mismatch or config conflict, and failed selected
login leaves the previous stored access token in place.

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` (`npm run typecheck`) | Pass |
| `npm test -- test/auth/workspace-expectation.test.ts test/auth/auth.test.ts test/auth/native-credential-store.test.ts test/auth/api-key-mode.test.ts test/auth/hosted-machine-ci.test.ts test/cloud/connect-auth.test.ts test/run-intent/boundary.test.ts test/selection/execution.test.ts` | Pass: 8 files / 117 tests |
| `npm test -- test/report/export.test.ts test/report/cli-report.test.ts test/local/command.test.ts test/commands/preview-mapping.test.ts test/demo/demo.test.ts test/billing/cli-usage.test.ts test/integration/cli-entry.test.ts test/docs/copy-contract.test.ts test/assessment/cli-flags.test.ts` | Pass: 9 files / 157 tests |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN -u AUGMENTWORKS_API_URL npm run check` | Pass: typecheck, **93 files / 938 tests**, `tsup` build, discovery `@augmentworks/cli@0.3.7 (development)` last independently inspected published `0.3.6`, billing/run-report contracts unchanged |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN -u AUGMENTWORKS_API_URL npm run smoke:pack` | Pass (68 packed files, 537087 compressed bytes). Packed help includes `login`/`whoami`/`usage`/`test --workspace` and omits it on `doctor`/`demo`. Local packed core-release `releaseReady=false` (registry-identity and live-authorized-environment not_run). Packed billing fixture: `creates=1 quotes=4 targets=1 polls=3 refreshes=1`. Packed report fixture: `requests=8`. |
| `check:billing-contract` / `check:run-report-contract` | Pass; prove vendored hashes only (`aw-billing/1` schema `3097c7aa…`, fixtures `a4b9234b…`; `aw-run-report/1` schema `7726ec27…`, fixtures `febd2626…`) |

Omitted: live registry install of unpublished `0.3.7`, production `/auth/me`,
and third-party chatbot tests (forbidden). Website pin not updated.

## Limitations / remaining external prerequisites (NAME only)

- **npm publication (MT14 / AUG-87)** — not assumed from merge. Do not claim
  new syntax works in independently inspected `0.3.6`.
- **Backend deploy of the MT10 CLI workspace-selection migration** — clients
  still fail closed on `/auth/me` if the server ignores `expected_workspace_id`.
- Production charges, provider purchases, permission changes, merge/deploy, and
  customer usage are out of scope.

## Rollback

Revert the application change. No server migration. Access revocation,
retention, and valid existing reads stay intact. There is no feature flag;
omitting `--workspace` and `AUGMENTWORKS_WORKSPACE_ID` restores the previous
single-workspace path with the additive name+UUID display.
