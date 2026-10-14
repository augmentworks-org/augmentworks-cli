# E10 completion — consume authoritative baseline comparisons (AUG-40)

Issue: [AUG-40](https://linear.app/augmentworks/issue/AUG-40/cli-consume-authoritative-baseline-comparisons-and-fail-ci-on-semantic)
Repository: `augmentworks-org/augmentworks-cli`
Work package: E10 · Audit coverage: F03

This file is issue-specific. It does not replace C01, C07, E06, or other
completion records.

This is the CLI consumer of main-owned `aw-release-policy/1`. It is **code
complete** in this repository. It is **not** npm-published. Source integration
is distinct from release acceptance under AUG-7.

## Source and implementation identity

| Item | Value |
| --- | --- |
| Audit / default-main baseline | `8a9f31a9fa6d99b2f0ea7e1530a4b73741592027` |
| Working base (`origin/main`) | `b8c3e7c3d71d9bef2cb07ddf3771c0822934208d` (merge of PR #32; includes merged AUG-32 PR #31 and AUG-11 PR #18) |
| Working branch | `cursor/baseline-compare-release-gate-61dc` (`057d541`) |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/34 |
| AUG-23 (main E08) | Done. Cited head `235d39074cab1c57ada2cc015192dc129697683c` on PR https://github.com/augmentworks-org/augmentworks/pull/58. Later portal consumer AUG-27 cited `0fd19ef`. Handoff `docs/feature-readiness/e08-completion.md` on main. Migration `20260911120001_application_environment_baselines.sql`. |
| AUG-27 (main E09) | Done. PR https://github.com/augmentworks-org/augmentworks/pull/70. Fixtures checksum published as prefix `be0cc3f54…` (not completed here). |
| AUG-32 (CLI E06) | Merged PR #31. `src/commands/test.ts` was **not** edited. |
| AUG-11 (CLI C01) | Merged PR #18. Gate wait reuses `classifyBillingRunStatus`. |
| AUG-35 (CLI C07) | Merged PR #32. Additive CLI registration only. |
| AUG-13 / AUG-14 feature package | `aw-feature/1` schema SHA-256 `4f026740a349c736e98af95599736a92cb81246bea3a1673b26e7fa94cadc870`; AUG-13 fixtures SHA-256 `8f481f4c30fd4db165c738c3333c529a72904c8cf8b00780b40b64e391495f23` |
| Main repository fetch | **Blocked.** `GET https://api.github.com/repos/augmentworks-org/augmentworks` returns HTTP 404 for this agent. Source schema files were **not** byte-copied. Checksums above are Linear-published identities. |
| Live API probe (configured origin, unauthenticated) | `GET /v1/applications`, `POST /v1/comparisons/evaluate`, `POST /v1/release-gates/evaluate`, `POST /v1/baselines/{id}/promote` exist (401 JSON). |
| Billing contract (untouched) | `aw-billing/1` from `650472d91442a6866a7b6ef18e6dacc23a2a9260`; schema `3097c7aa74233e97233dcc488ba7eaacb1be5c6af0554bc308ca1569d155b645`; fixtures `a4b9234b426f98132ddbd8e82755caa0aa718c4ec1e3bf17064d1bf364a6cb84` |
| Migrations | None. This repository does not own SQL. |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified |
| Competing CLI PR | Open draft [PR #33](https://github.com/augmentworks-org/augmentworks-cli/pull/33) (AUG-73 0.3.4 candidate) edits README/copy/release metadata. This ticket’s edits to those files are additive command rows and constants only. |

Lock file: `contracts/aw-release-policy-v1.lock.json`.
Consumer fixtures: `contracts/aw-release-policy-v1.fixtures.json` SHA-256
`dcc76898c8e89bf4e2e18c68f6882e7c9643f0fe2a612a88eae1167d5224c65f`.

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| Code completion (this repository) | **Complete.** `compare` / `gate` / `baseline status` / `baseline promote` consume hosted policy documents. |
| Deterministic verification | See Test evidence below. |
| Live hosted assessment / npm publish | **Not run / not done.** |
| Release readiness | **Not ready.** Published npm remains `@augmentworks/cli@0.3.2`. |

## Interfaces

- Schema constants: `src/baseline/schema.ts` (`aw-release-policy/1`, `aw-comparison/1`, `aw-feature/1`).
- Wire parse: `src/baseline/protocol.ts` (camelCase canonical; snake_case rewrite; decision at top-level or `gate.decision`).
- Classifier: `src/baseline/classify.ts`. Observation success is not a pass. Exit `0` only for `decision=pass` + `comparability=compatible` + `evaluationStatus=complete` with no fail-closed coverage/regression signals.
- Wait: `src/baseline/wait.ts` GETs `/v1/billing/capabilities` and `/v1/billing/status?runId=` for the **original** run ID only.
- Client: `CloudClient.listApplications` / `evaluateComparison` / `evaluateReleaseGate` / `promoteBaseline`.
- CLI: additive Commander registration in `src/cli.ts`. Dedicated modules `src/commands/compare.ts`, `gate.ts`, `baseline.ts`. `src/commands/test.ts` unchanged.

Request bodies:

```json
{
  "schemaVersion": "aw-comparison/1",
  "packageVersion": "aw-feature/1",
  "candidateRunId": "<run-id>",
  "baselineId": "<baseline-id>"
}
```

Gate uses `schemaVersion: "aw-release-policy/1"` on `POST /v1/release-gates/evaluate`.
Promote sends `expectedPromotionRevision` to `POST /v1/baselines/{baselineId}/promote`.

`--json` writes one object on stdout (`ok: true` means the query parsed). Diagnostics
go to stderr. Process exit follows `exit_code` / classification.

| Server / local outcome | Exit |
| --- | --- |
| Policy `pass`, compatible, complete | `0` |
| Policy `block` or new required regression (including equal aggregate pass rates) | `10` |
| Pending / partial / absent / unknown / unsupported / missing required coverage / wait timeout | `11` |
| Evaluator error | `12` |
| Incompatible scope or missing baseline / ambiguous identity | `2` |
| Auth, including `PROMOTION_FORBIDDEN` | `3` |
| Protocol, `createsBillableRun: true`, promotion 409 | `4` |
| Billing capability/status failures while `--wait` | `13` |

Unknown or mystery `decision` values never default to pass.

## Commands

Source tree (after `npm ci` && `npm run build`):

```bash
node dist/index.js compare --run <run-id> --baseline <baseline-id> --json
node dist/index.js gate --run <run-id> --baseline <baseline-id> --json
node dist/index.js gate --run <run-id> --baseline <baseline-id> --wait --timeout-ms 60000 --json
node dist/index.js baseline status --json
node dist/index.js baseline promote --run <run-id> --baseline <baseline-id> --expected-revision <n> --json
```

Do not document `npx @augmentworks/cli@0.3.3`. Packed binary: `node dist/index.js`
from a clean `npm pack` extract.

## Examples (this ticket owns these paths only)

- `docs/examples/github-actions-hosted-gate.yml` — quoted `--max-credits --yes` execution, `run wait` on the original ID, then read-only `gate`. Explicit `AUGMENTWORKS_BASELINE_ID`. No auto-promote. Machine credentials remain AUG-45.

## Test evidence

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | Pass (`tsc --noEmit`) |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN -u AUGMENTWORKS_API_URL npm test` | Pass. **73 files, 693 tests** (vitest 4.1.11) |
| `npm run build` | Pass. `dist/index.js` 1.90 MB |
| `npm run check:discovery` | Pass. `@augmentworks/cli@0.3.3 (development)` |
| `npm run check:billing-contract` | Pass. Untouched `aw-billing/1` hashes above |
| `npm run check:run-report-contract` | Pass. Untouched `aw-run-report/1` hashes above |
| `npm run check` | Pass locally. GitHub Actions on `057d541` (run [34172973673](https://github.com/augmentworks-org/augmentworks-cli/actions/runs/34172973673)): **9/9 passed** — Node 20/22/24 on ubuntu-latest, macos-latest, and windows-latest. Earlier Windows failure on `862faf8` was CRLF hashing of `contracts/aw-release-policy-v1.fixtures.json` (`db12c3cd…` vs locked LF `dcc76898…`); packed gate tests had already passed on those jobs. |
| `npm run smoke:pack` | Pass. Packed tarball **55 files, 440048 compressed bytes**. Includes packed `compare` / `gate` / `baseline` help and lock/fixture inventory. Packed billing fixture: `creates=1 quotes=4 targets=1 polls=3 refreshes=1`. Packed report fixture: `requests=8`. |
| Live hosted assessment / npm publish | **Not run** |

Injected Cloud Agent `AUGMENTWORKS_API_KEY` plus a test `AUGMENTWORKS_TOKEN` is
`AUTH_ENV_CONFLICT` (exit 3). The suite was therefore run with those variables
unset, matching previous CLI completion records. Packed gate tests also clear
`AUGMENTWORKS_API_KEY` in the child environment.

Focused slice after the Windows checksum follow-up: `npx vitest run test/baseline/classify.test.ts` → **9 passed** (includes CRLF digest case). Packed gate behavior tests still pass.

Behavior covered (synthetic fixtures only):

- Equal 1/2 pass rates with one new required failure → packed `compare --json` HTTP 200, `ok: true`, `assessment: blocked`, process exit `10`. No `POST /v1/relay/runs`, quote, or retry-evaluation.
- Compatible pass → stable JSON with policy/candidate/baseline evaluation revisions; stderr empty.
- Pending, evaluator error, incompatible scope, missing required coverage, unknown `decision` → nonzero, never `0`.
- Missing baseline 404 → exit `2` `MISSING_BASELINE`. Auth 401 → exit `3`, not billing `13`.
- `gate --wait --timeout-ms 1` on pending grading → exit `11`, original run ID retained, no evaluate POST.
- Authorized promote 409 → exit `4` `PROMOTION_CONFLICT`. Machine principal without `baseline:promote` → exit `3` locally, no promote POST.
- `createsBillableRun: true` on an otherwise passing document → exit `4`, not a green gate.

## Compatibility

- Existing local packets, hosted quote/`--max-credits`/`--yes`, `run wait`/`status`/`report`, and `suite` commands still dispatch from the same Commander registry.
- Comparison/status/gate cause no admission, target execution, reservation, or credit consumption.
- Promotion is never automatic and is not on the default machine allowlist.
- Published `@augmentworks/cli@0.3.2` does not include these commands.

## Remaining release requirements

- Review/merge of this PR. Rebase if AUG-73 PR #33 lands first on README/copy-contract.
- AUG-45 owns machine credentials and a complete hosted GitHub Actions journey.
- AUG-7 / release-acceptance tickets verify deployed web commit and published CLI artifacts.
- Do not mark Linear Done from source integration. Keep **In Review**.
