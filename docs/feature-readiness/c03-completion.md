# C03 completion — scoped machine credentials and hosted GitHub Actions (AUG-45)

Issue: [AUG-45](https://linear.app/augmentworks/issue/AUG-45/cli-support-scoped-machine-credentials-and-a-complete-hosted-github)
Repository: `augmentworks-org/augmentworks-cli`
Work package: C03 · Audit coverage: F04

This file is issue-specific. It does not replace C01, C07, E06, E10, E12, or
AUG-54 completion records.

This is the CLI record for the first ordinary-suite hosted CI journey. It is
**code complete** in this repository. It is **not** npm-published. Source
integration is distinct from release acceptance under AUG-7.

## Source and implementation identity

| Item | Value |
| --- | --- |
| Audit / default-main baseline | `8a9f31a9fa6d99b2f0ea7e1530a4b73741592027` |
| Working base (`origin/main`) | `fa81ef16fdc6d3683737a9349692088fab77bf7f` (merge of PR #37 / AUG-44) |
| Working branch | `cursor/hosted-gha-machine-ci-edbb` |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/38 |
| AUG-54 | Merged PR #26 `1cb11978f9d2fc4a021a0b51a6c444152074ccba` (`6ef0edc` API-key mode, report export, conservative exits). AW-QA-1 identities consumed; auth/report/classifier modules were **not** reimplemented. |
| AUG-44 | Merged PR #37. Recipe documents `investigation inspect` after a blocked gate; it does not start another billed run. |
| AUG-40 | Merged PR #34. `gate` is the CI provenance call (`POST /v1/release-gates/evaluate`). |
| AUG-32 | Merged PR #31. Recipe uses `test --suite` / `suite validate`. |
| AUG-35 | Merged PR #32. Isolated synthetic target is `assets/starters/response-quality`. |
| AUG-24 | Merged PR #30. Starter remains single-turn; session advertisement is unchanged. |
| AUG-11 | Merged PR #18. Wait/gate classification: unfinished evaluation cannot be green. |
| AUG-13 / AUG-14 feature package | `aw-feature/1` schema SHA-256 `4f026740a349c736e98af95599736a92cb81246bea3a1673b26e7fa94cadc870`; AUG-13 fixtures SHA-256 `8f481f4c30fd4db165c738c3333c529a72904c8cf8b00780b40b64e391495f23` |
| Main repository fetch | **Blocked.** `GET https://api.github.com/repos/augmentworks-org/augmentworks` returns HTTP 404. No cross-repo edits. AUG-15 `own_target.ci_result_recorded` is a server emission on the existing gate API. |
| Billing contract (untouched) | `aw-billing/1` from `650472d91442a6866a7b6ef18e6dacc23a2a9260`; schema `3097c7aa74233e97233dcc488ba7eaacb1be5c6af0554bc308ca1569d155b645`; fixtures `a4b9234b426f98132ddbd8e82755caa0aa718c4ec1e3bf17064d1bf364a6cb84` |
| Run-report contract (untouched) | `aw-run-report/1` schema `7726ec277d33e435d2832e8be0898baf9337631d779f073a10c7795fc7de38ff`; fixtures `febd2626c96672d0e79afc4706b3a5136598b61bbebbdeb0f8ec1bdbc44cd806` (AW-QA-1) |
| Release-policy consumer fixtures (untouched) | `contracts/aw-release-policy-v1.fixtures.json` SHA-256 `dcc76898c8e89bf4e2e18c68f6882e7c9643f0fe2a612a88eae1167d5224c65f` |
| Migrations | None. This repository does not own SQL. |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified |
| Competing CLI PRs | None open at start besides this PR #38 |

Lock files were not rewritten. C12 / AUG-46 catalog/shard CLI is out of scope.

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| Code completion (this repository) | **Complete.** Headless machine admission, maintained Actions recipe, packed negative journey. |
| Deterministic verification | See Test evidence below. |
| Live hosted assessment / npm publish | **Not run / not done.** |
| GitHub-hosted ephemeral runner with a real workspace key | **Not run.** Packed binary + loopback API/target fixtures cover the command sequence. |
| Release readiness | **Not ready.** Published npm remains `@augmentworks/cli@0.3.2`. Candidate metadata is `0.3.4`. |

## Interfaces

Headless hosted authentication (`src/commands/hosted-auth.ts`):

- `test --headless`, `AUGMENTWORKS_HEADLESS=1|true`, or `CI=1|true` require
  `AUGMENTWORKS_API_KEY` (or compatible `AUGMENTWORKS_TOKEN`) **before**
  keychain, file store, or browser/device login.
- Missing credentials: `AUTH_REQUIRED` (exit 3). No invented workspace.
- Revoked API key: existing AUG-54 `API_KEY_REVOKED` (exit 3). No quote/create.
- Machine principal with advertised `actions` must include `run:execute`.
  `--suite` also requires `suite:read`. Report-only AW-QA-1 keys
  (`run:read`, `evaluation:read`, `criterion_detail:read`) fail with
  `MACHINE_ACTION_DENIED` (exit 3) before `POST /v1/suites` or quote.
- Legacy identities without `principalKind` / `actions` skip the local action
  check (server still authorizes).
- API-key `SCOPE_DENIED` remaps to a CI-actions message: cannot buy credits or
  administer the workspace.

Finite spend: existing `--max-credits` / `--yes`. Headless is noninteractive, so
suite/investigation admission without `--max-credits` remains `MAX_CREDITS_REQUIRED`.

CI provenance: `POST /v1/release-gates/evaluate` via existing `gate`. No extra
request fields (the evaluate schema is `.strict()`). The server owns
`own_target.ci_result_recorded` for a finalized machine-principal
`aw-release-policy/1` decision. The recipe never calls `gate` unless wait exits
`0` or `10`. Pending wait (`11`) cannot be a green release. No CLI analytics
vendor. Target URLs, secrets, and transcripts are not sent.

Observation-only: `run wait` / `run status` / `run report` / `recover` /
`gate` / `compare` do not `POST /v1/relay/runs` or quote.

`--headless` with `--local` is `HEADLESS_LOCAL_UNSUPPORTED` (exit 2).

Additive Commander change only: `--headless` on `test`. `src/cli.ts` was not
replaced.

## Recipe

Copy `docs/examples/github-actions-hosted.yml` into the **application**
repository after `init --starter response-quality`. Do not paste it into this
CLI repository's development CI.

Secrets: `AUGMENTWORKS_API_KEY`, `AUGMENTWORKS_BASELINE_ID`, optional
`AUGMENTWORKS_API_URL`. Generate `CHATBOT_API_KEY` on the runner.

Minimum machine actions: `suite:read`, `run:execute`, `run:cancel`, `run:read`,
`evaluation:read`, `criterion_detail:read`, `billing:read`. Do not grant
purchase, subscription administration, membership, publication, credential
issuance, or `baseline:promote`. Transport scopes `connector:identity` /
`connector:run` are not sufficient.

Job: `contents: read`; 20 minute timeout; concurrency per ref with
`cancel-in-progress: false`. Fork `pull_request` jobs are skipped. Do not use
`pull_request_target`. Artifacts: `.augmentworks/ci`, 7 days. Always stop the
target. Do not run `logout`. Do not auto-promote a baseline.

Install pin: `npx --yes @augmentworks/cli@0.3.4`. Registry verification of that
tarball is recorded in
`docs/feature-readiness/first-dollar-registry-acceptance.json` and is not
implied by the example. Do not pin `@latest` or overwrite npm `0.3.3`.

## Commands

Source tree (after `npm ci` && `npm run build`):

```bash
export AUGMENTWORKS_API_KEY=aw_api_...
export AUGMENTWORKS_HEADLESS=1
node dist/index.js whoami --json
node dist/index.js doctor --offline -c augmentworks.yaml
node dist/index.js preview-mapping -c augmentworks.yaml --operation send --fixture ./fixtures/send-response.json --json
node dist/index.js suite validate own-chatbot.suite.yaml --json
node dist/index.js test --suite own-chatbot.suite.yaml --estimate --json --headless
node dist/index.js test --suite own-chatbot.suite.yaml --max-credits 30 --yes --json --headless
node dist/index.js recover --json
node dist/index.js run wait <run-id> --json --timeout-ms 60000
node dist/index.js gate --run <run-id> --baseline <baseline-id> --json
```

Packed binary: `node dist/index.js` from a clean `npm pack` extract, or the
recipe's `npx --yes @augmentworks/cli@0.3.4`.

## Test evidence

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | Pass (`tsc --noEmit`) |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN -u AUGMENTWORKS_API_URL npx vitest run test/auth/hosted-machine-ci.test.ts test/ci/hosted-actions-journey.test.ts test/integration/cli-entry.test.ts` | Pass. **3 files, 31 tests** |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN -u AUGMENTWORKS_API_URL npm test` | Pass. **79 files, 744 tests** (vitest 4.1.11) |
| `npm run build` | Pass. `dist/index.js` 1.95 MB |
| `npm run check:discovery` | Pass. `@augmentworks/cli@0.3.4 (development)` |
| `npm run check:billing-contract` | Pass. Untouched `aw-billing/1` hashes above |
| `npm run check:run-report-contract` | Pass. Untouched `aw-run-report/1` hashes above |
| `npm run check` | Pass (typecheck + test + build + discovery + billing + run-report) |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN -u AUGMENTWORKS_API_URL npm run smoke:pack` | Pass. Packed tarball **60 files, 454993 compressed bytes**. Packed help includes `test --headless`. Packed billing fixture: `creates=1 quotes=4 targets=1 polls=3 refreshes=1`. Packed report fixture: `requests=8`. |
| Live hosted assessment / npm publish / GitHub-hosted runner with a real key | **Not run** |
| GitHub Actions on this branch | Recorded on the PR after push; not claimed here |

Injected Cloud Agent `AUGMENTWORKS_API_KEY` plus a configured
`AUGMENTWORKS_API_URL` is `AUTH_ENV_CONFLICT` (exit 3) if left in the
environment. The suite was run with those variables unset.

Behavior covered (synthetic fixtures only):

- Recipe documents fork-PR skip, no `pull_request_target` job, cleanup
  `if: always()`, `gate` provenance, `--max-credits`, `--headless`, and no
  `logout`.
- Packed offline `doctor` / `preview-mapping` / `suite validate` against
  `assets/starters/response-quality` with a live loopback fixture server.
  Preview JSON omits the target token and workspace API key.
- Headless estimate without credentials: exit 3 `AUTH_REQUIRED`, zero HTTP.
- Revoked key: exit 3 `API_KEY_REVOKED`, `GET /api/v1/cli/auth/me` only.
- AW-QA-1 `machine_report_only` identity: exit 3 `MACHINE_ACTION_DENIED`, no
  suite pin or quote.
- Billing denial `error_insufficient_credits`: exit 13, no `POST /v1/relay/runs`.
- Integration failure (500 on `POST /v1/suites`): non-zero, no quote/create.
- Gate `blocked_equal_pass_rate`: exit 10, `assessment: blocked`,
  `createsBillableRun: false`, original run id preserved.
- Gate `incomplete_pending`: exit 11, not 0.
- Gate `evaluator_error`: exit 12, no create.
- `run wait` pending grading with `--timeout-ms 1`: exit 11, original run id,
  no quote/create. `recover --json` idle inspect: exit 0, still no create.
- Cancelled original run via billing status overlay: exit 130, original run id,
  legacy `AUGMENTWORKS_TOKEN` still authenticates observation.
- `--headless --local` fails closed before network.
- Same Commander registry still lists login, whoami, test, suite,
  investigation, run, compare, gate, baseline, recover.

## Compatibility

- Existing `AUGMENTWORKS_API_KEY` mode, `run report`, and conservative exits
  remain AUG-54-owned. This ticket only remaps API-key `SCOPE_DENIED` copy and
  adds machine-action admission on hosted `test`.
- `AUGMENTWORKS_TOKEN` remains a compatible noninteractive injection when the
  API key is unset.
- `run wait` / `recover` / `gate` are not replaced.
- C12 catalog/shard CLI is not implemented.
- Published `@augmentworks/cli@0.3.2` does not include `--headless` or this
  recipe.

## Remaining release requirements

- Review/merge of PR https://github.com/augmentworks-org/augmentworks-cli/pull/38.
- AUG-7 / AUG-48 / AUG-58 verify deployed web commit and published CLI artifacts.
- A real GitHub-hosted ephemeral runner with a scoped workspace key is not
  claimed here.
- Do not mark Linear Done from source integration. Keep **In Review**.
