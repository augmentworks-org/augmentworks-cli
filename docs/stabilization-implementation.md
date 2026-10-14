# Stabilization implementation ledger (CLI)

Website work is tracked in `augmentworks-org/augmentworks`. This repository implements
only CLI-owned phases of the September 5, 2026 stabilization plan.

## Baseline (Phase 00)

| Field | Value |
| --- | --- |
| Audited main SHA | `27a6e20dc98ba5a354da2c3e37115c793a2df9e5` |
| Working branch | `cursor/cli-stabilization-recovery-8ae6` |
| Package manager | npm |
| Node requirement | `>=20` |
| Source package version | `0.2.1` |
| Verified published package | `@augmentworks/cli@0.2.1` (npm `latest`, 2026-09-05) |
| Hosted protocol | `aw-relay/0.1` |
| Recovery protocol | `aw-run-intent-reconcile/0.1` |
| Intent format | `aw-run-intent/0.2` with `0.1` tenant migration |

### Contracts reused (00.2)

- Frozen packet/config binding and create request hash remain in `CreateRunRequestSchema`.
- Target execution terminal states are `completed`, `failed`, and `cancelled`.
- Evaluation/grading is not part of `RunStatusResponseSchema`; recovery uses the
  reconcile envelope's optional `evaluation` field so pending grading cannot be
  mistaken for an active target slot.
- Create idempotency key is `create_request_id`; pending/bound intent phases and
  the secure lock are unchanged.
- Local `--local` still branches before auth, intent, and cloud.

### CLI command inventory (00.3)

`login`, `logout`, `whoami`, `init`, `doctor`, `test`, `test --local`, `schema`,
and `recover`. Dashboard URLs returned to the CLI remain query-free
`/portal/runs/<runId>` style strings; the CLI still rejects query/fragment.

## Finding status

| ID | Status | Owner | Changed files | Tests | Remaining deployment verification |
| --- | --- | --- | --- | --- | --- |
| B04 | verified locally | CLI | `src/commands/recover.ts`, `src/commands/test.ts`, `src/relay/recovery.ts`, `src/relay/run-intent.ts`, `src/cloud/client.ts`, `src/cloud/recovery-protocol.ts` | CLI-01–CLI-13 (see below) | Hosted `POST /v1/relay/run-intents:reconcile` must be deployed before `--retire` of an unbound create works against production |
| C01 | verified locally (Node redirect fixture) | CLI listener | `src/auth/loopback.ts`, `test/auth/loopback-callback.test.ts` | CSP-01–CSP-03 (Node HTTP + real listener) | Chromium/WebKit against production-equivalent website CSP (`form-action 'self'` + `upgrade-insecure-requests`) remains a website+browser check |
| B01–B03, B05–B10, B12–B14 | not in this repo | website | — | — | — |
| B11 | not in this repo (dashboard URLs) | website | CLI still rejects query/fragment on returned dashboard URLs | existing dashboard URL tests | — |
| B12 | not in this repo (label parser) | website | CLI continues to send `target.name` as `declaredTargetName` via create target.name | existing create-run tests | — |

### CLI regression map

| Test ID | Coverage |
| --- | --- |
| CLI-01 | `test/recovery/recovery.test.ts` typed rejection then corrected packet |
| CLI-02 | lost create response rebound by reconcile, same key |
| CLI-03 | 500 after create keeps pending intent |
| CLI-04 | server retirement race is a website DB test; CLI refuses local retire without reconcile proof (`RECOVERY_UNSUPPORTED` / unknown) |
| CLI-05 | bound terminal inspect/retire does not POST create |
| CLI-06 | outstanding prepare journal blocks `--retire` |
| CLI-07 | changed packet vs active run does not create |
| CLI-08 | 401 preserve pending intent |
| CLI-09 | archive-then-unlink; crash between archive and unlink; repeated `--retire` is idle; existing secure lock tests |
| CLI-10 | existing `test/run-intent/store.test.ts` and `test/run-intent/boundary.test.ts` |
| CLI-11 | terminal target + `evaluation: pending` retires locally without cancel |
| CLI-12 | old server 404 reconcile → `recovery_unsupported`, no journal clear |
| CLI-13 | default inspect `retire_if_uncreated: false`; flag conflict; `recover --help` |
| CSP-01–03 | `test/auth/loopback-callback.test.ts` (Node HTTP 303 + real 127.0.0.1 listener; replay 409) |
| CSP-04 | existing `AUTH_EXPIRED` / interrupt coverage in `src/auth/loopback.ts` |
| CSP-05 | no global CSP change; listener completion is `no-store` and `no-referrer` |

## Validation commands

See `docs/stabilization-rollout.md`.

| Command | Result (this branch) |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` | 34 files / 291 tests pass |
| `npm run build` | pass (`dist/index.js`) |
| `npm run test:integration:recovery` | 3 files / 21 tests pass |
| `npm run test:e2e:cli-auth` | 1 file / 4 tests pass |
| `npm run smoke:pack` | pass, packed `recover --help` includes `--retire`/`--resume`/`--cancel` |

Working commit after local verification is recorded in git history on `cursor/cli-stabilization-recovery-8ae6`. Release pins and the credential-lock reclaim fix landed on `main` via [PR #10](https://github.com/augmentworks-org/augmentworks-cli/pull/10).

Externally blocked: Chromium/WebKit against production-equivalent website CSP on a same-machine browser; website `POST /v1/relay/run-intents:reconcile` plus typed `rejected_uncreated` must be deployed before documenting `--retire` of unbound creates in production; website CLI pin in `augmentworks-org/augmentworks` should move to `0.2.1`.

## Publish evidence (0.2.1)

| Check | Result |
| --- | --- |
| GitHub Release | [v0.2.1](https://github.com/augmentworks-org/augmentworks-cli/releases/tag/v0.2.1) |
| Publish workflow | [success](https://github.com/augmentworks-org/augmentworks-cli/actions/runs/33988894523) |
| `npm view @augmentworks/cli version` | `0.2.1` |
| `npm view @augmentworks/cli@0.2.1 version` | `0.2.1` |
| Installed `augmentworks --version` | `0.2.1` |
| Packed `recover --help` | lists `--retire` / `--resume` / `--cancel`; does not list `--force-delete` |
| Provenance | [Sigstore log](https://search.sigstore.dev/?logIndex=2730171707) |
