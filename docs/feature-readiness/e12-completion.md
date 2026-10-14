# E12 completion — inspect and reproduce an exported failure (AUG-44)

Issue: [AUG-44](https://linear.app/augmentworks/issue/AUG-44/cli-inspect-and-reproduce-an-exported-failure-with-pinned-case)
Repository: `augmentworks-org/augmentworks-cli`
Work package: E12 · Audit coverage: F07

This file is issue-specific. It does not replace E06, E10, C07, or other
completion records.

This is the CLI consumer of main-owned `aw-investigation-export/1`. It is
**code complete** in this repository. It is **not** npm-published. Source
integration is distinct from release acceptance under AUG-7.

## Source and implementation identity

| Item | Value |
| --- | --- |
| Audit / default-main baseline | `8a9f31a9fa6d99b2f0ea7e1530a4b73741592027` |
| Working base (`origin/main`) | `e14dd09261630c2937c173ea6148657256943b2d` (includes merged AUG-32 PR #31 and AUG-40 PR #34) |
| Working branch | `cursor/inspect-reproduce-failure-c6ea` |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/37 |
| AUG-33 (main E11) | Done. PR https://github.com/augmentworks-org/augmentworks/pull/73. Cited head `a8e5ad17ce60f9b199d6a45f34188546d075e4bf` on `cursor/investigation-export-0a0c`. Handoff `docs/feature-readiness/e11-completion.md` on main. Schema `aw-investigation-export/1`; issue-proposal `aw-issue-proposal/1`. |
| AUG-32 (CLI E06) | Merged PR #31. `test --suite` selection is reused, not duplicated. |
| AUG-40 (CLI E10) | Merged PR #34. Reproduction compare uses `compare` against `aw-release-policy/1` fixtures. |
| AUG-13 / AUG-14 feature package | `aw-feature/1` schema SHA-256 `4f026740a349c736e98af95599736a92cb81246bea3a1673b26e7fa94cadc870`; AUG-13 fixtures SHA-256 `8f481f4c30fd4db165c738c3333c529a72904c8cf8b00780b40b64e391495f23` |
| Main repository fetch | **Blocked.** `GET https://api.github.com/repos/augmentworks-org/augmentworks` returns HTTP 404 for this agent. Source schema files were **not** byte-copied. Checksums above are Linear-published identities. |
| Live API probe (configured origin, unauthenticated) | `GET` and `POST /v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria/{criterionId}/investigation` exist (401 JSON, `aw-feature-error/1`, `unauthenticated`). `GET /v1/suites/{id}/revisions/{id}` and `/latest` exist (401). No credential was sent. |
| Billing contract (untouched) | `aw-billing/1` from `650472d91442a6866a7b6ef18e6dacc23a2a9260`; schema `3097c7aa74233e97233dcc488ba7eaacb1be5c6af0554bc308ca1569d155b645`; fixtures `a4b9234b426f98132ddbd8e82755caa0aa718c4ec1e3bf17064d1bf364a6cb84` |
| Run-report contract (untouched) | `aw-run-report/1` schema `7726ec277d33e435d2832e8be0898baf9337631d779f073a10c7795fc7de38ff`; fixtures `febd2626c96672d0e79afc4706b3a5136598b61bbebbdeb0f8ec1bdbc44cd806` |
| Migrations | None. This repository does not own SQL. |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified |
| Competing CLI PR | None open besides this PR #37 |

Lock file: `contracts/aw-investigation-export-v1.lock.json`.
Consumer fixtures: `contracts/aw-investigation-export-v1.fixtures.json` SHA-256
`48422512afa62dbac67bf634a58cfa5821b035db9d58c9d1fb44ca5b9decbdbc`.

Consumed HTTP path (GET and POST):

`/v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria/{criterionId}/investigation`

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| Code completion (this repository) | **Complete.** `investigation inspect` / `fetch` / `export-regression` and `test --investigation` consume hosted investigation documents. |
| Deterministic verification | See Test evidence below. |
| Live hosted assessment / npm publish | **Not run / not done.** |
| Release readiness | **Not ready.** Published npm remains `@augmentworks/cli@0.3.2`. Candidate metadata is `0.3.4`. |

## Interfaces

- Schema constants: `src/investigation/schema.ts` (`aw-investigation-export/1`, `aw-feature/1`).
- Wire parse: `src/investigation/protocol.ts` (camelCase canonical; snake_case rewrite). Rejects `createsBillableRun: true`, share-link audience, credentials, and `suiteRevisionId: latest`.
- Load: `src/investigation/load.ts` (path safety, `O_NOFOLLOW`, UTF-8 JSON).
- Prerequisites: `src/investigation/prerequisites.ts`. Response-only does not block on prepare/observe/cleanup/session. Stateful missing mappings and artifact `missing[].blocking === true` block **before** quote. Local observe capability is `ResolvedConfig.capabilities.observation`.
- Pin: `src/investigation/pin.ts` GETs `CloudClient.getSuiteRevision(suiteId, revisionId)` only. Never `/revisions/latest` or `POST /v1/suites`. Admission `selected_scenario_ids: [caseId]`. Hash mismatch and missing case fail closed. Quote is followed by a second GET; a swapped revision refuses the consumed quote.
- Regression export: `src/investigation/export-regression.ts` writes `aw-suite/1` YAML from **original expected facts**. Failing chatbot output is not the expected answer.
- Format: `src/investigation/format.ts`. `--json` is one object on stdout. Copied `commandFragment` is `kind: "data_not_executed"`.
- Command: `src/commands/investigation.ts` (`inspect` / `fetch` / `export-regression`). Dedicated top-level command so `run` copy-contract stays `status|wait|retry-evaluation|report`.
- Client: `CloudClient.exportInvestigation` (POST) / `getInvestigation` (GET).
- CLI: additive Commander registration in `src/cli.ts`. `src/commands/test.ts` `--investigation` is exclusive vs `--suite` / `--assessment` / `--packet` / `--local`.
- JSON Schema dump: `src/commands/schema.ts --kind investigation-export`. The on-disk `$id` is relative (`schemas/v1/investigation-export.schema.json`), matching customer-suite. `readBundledSchema` rewrites the host prefix from the config schema at dump time.

`--json` writes one object on stdout (`ok: true` means the artifact parsed). Diagnostics
go to stderr. Inspect/fetch never call `POST /v1/relay/runs`.

| Outcome | Exit |
| --- | --- |
| Inspect/fetch/export-regression success | `0` |
| Stale schema, missing file, invalid artifact, missing expected facts | `2` |
| Auth / cross-workspace | `3` |
| Protocol / `createsBillableRun` / credential / share-link publication | `4` |
| Missing reproduction prerequisites before quote | `2` (`REPRODUCTION_PREREQUISITES_MISSING`) |
| Unavailable pinned revision or case, hash mismatch | `2` |
| `--investigation` with `--local` | `2` (`HOSTED_INVESTIGATION_UNSUPPORTED_LOCAL`) |
| Selection conflict (`--investigation` plus `--suite` / `--assessment` / `--packet`) | `2` (`INVESTIGATION_SELECTION_CONFLICT`) |
| Noninteractive reproduce without `--max-credits` | existing `MAX_CREDITS_REQUIRED` |

Unknown selectors never fall through to `/latest`. Copied shell fragments are never spawned.

## Commands

Source tree (after `npm ci` && `npm run build`):

```bash
node dist/index.js investigation inspect examples/investigations/response-only.json
node dist/index.js investigation inspect examples/investigations/stateful.json --json
node dist/index.js investigation fetch --run <run-id> --evaluation <evaluation-id> --attempt <attempt-id> --criterion <criterion-id> --json
node dist/index.js investigation export-regression examples/investigations/response-only.json --out regression.yaml --json
node dist/index.js schema --kind investigation-export
node dist/index.js test --investigation examples/investigations/response-only.json --max-credits 30 --yes
```

Do not document `npx @augmentworks/cli@0.3.3`. Packed binary: `node dist/index.js`
from a clean `npm pack` extract. Packed samples live under
`assets/investigations/` because `examples/` is forbidden in the tarball.

## Examples (this ticket owns these paths only)

- `docs/investigation.md`
- `examples/investigations/response-only.json`
- `examples/investigations/stateful.json`
- Packed copies: `assets/investigations/`
- Negative fixtures: `test/fixtures/investigations/`
- Authoring schema: `schemas/v1/investigation-export.schema.json`

C07-owned starter paths (`examples/basic-chat/`, `examples/response-agent/`,
`examples/refund-agent/`, `docs/configuration.md`, `docs/agent-setup.md`,
`init.ts`) were not rewritten.

## Test evidence

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | Pass (`tsc --noEmit`) |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN -u AUGMENTWORKS_API_URL npx vitest run test/investigation test/docs/copy-contract.test.ts test/integration/cli-entry.test.ts test/assessment/cli-flags.test.ts test/config/commands.test.ts` | Pass. **7 files, 115 tests** |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN -u AUGMENTWORKS_API_URL npm test` | Pass. **77 files, 725 tests** (vitest 4.1.11) |
| `npm run build` | Pass. `dist/index.js` 1.95 MB |
| `npm run check:discovery` | Pass. `@augmentworks/cli@0.3.4 (development)` |
| `npm run check:billing-contract` | Pass. Untouched `aw-billing/1` hashes above |
| `npm run check:run-report-contract` | Pass. Untouched `aw-run-report/1` hashes above |
| `npm run check` | Pass (typecheck + test + build + discovery + billing + run-report) |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN -u AUGMENTWORKS_API_URL npm run smoke:pack` | Pass. Packed tarball **60 files, 453652 compressed bytes**. Packed help includes `investigation` and `test --investigation`. Packed inventory includes `assets/investigations/*`, investigation lock/fixtures, and `schema --kind investigation-export`. Packed inspect of both samples with poisoned token: `ok: true`, `admissionCalls: 0`, no target/shell/evaluator. Packed billing fixture: `creates=1 quotes=4 targets=1 polls=3 refreshes=1`. Packed report fixture: `requests=8`. |
| Live hosted assessment / npm publish | **Not run** |
| GitHub Actions on this branch | Recorded on the PR after push; not claimed here |

Injected Cloud Agent `AUGMENTWORKS_API_KEY` plus a configured `AUGMENTWORKS_API_URL`
is `AUTH_ENV_CONFLICT` (exit 3) if left in the environment. The suite was run
with those variables unset, matching previous CLI completion records.

Behavior covered (synthetic fixtures only):

- Packed/source inspect of response-only and stateful samples: zero admission, poisoned token unused, `commandFragment` printed as data (`argv`, never executed). A `touch` fragment does not create the marker file.
- Fetch POSTs the investigation path only; no quote and no `POST /v1/relay/runs`.
- Reproduce GETs the exact suite revision, sends `selected_scenario_ids: [faq.status-page]`, creates a **new** quote, then a new run id. Original run id is never reused. `/revisions/latest` and `POST /v1/suites` throw if contacted.
- Changed pin after quote, `latest` revision, missing case, hash mismatch, and cross-workspace identity fail closed before admission.
- Stateful sample with missing prepare/observe/cleanup blocks with `REPRODUCTION_PREREQUISITES_MISSING` and zero fetch calls. `stateful-ready.json` plus local prepare/observe/cleanup reproduces.
- Cancel after quote does not `POST /v1/relay/runs`.
- Stale schema, `createsBillableRun: true`, credentials, and share-link audience fail JSON-mode inspect with `admissionCalls: 0` and no secrets on stdout.
- Export-regression YAML keeps original expected facts; failing chatbot copy is absent. JSON includes `admissionCalls: 0`.
- Fix-and-rerun: inspect original (`admissionCalls: 0`) → new compatible candidate run → `compare` against AUG-40 fixtures. Original-run compare stays `blocked_equal_pass_rate`; new candidate compare is rewritten to that run id so identity matches. Original credits unchanged during read-only operations.
- Help wrapping: Commander line-wraps inspect/fetch descriptions; tests assert substrings. Additive `src/cli.ts` registration only.

## Compatibility

- Existing local packets, hosted quote/`--max-credits`/`--yes`, `run wait`/`status`/`report`, `suite`, `compare` / `gate` / `baseline` still dispatch from the same Commander registry.
- Observation/inspect/fetch/export-regression cause no admission, target execution, reservation, or credit consumption.
- Reproduction is a new quoted hosted run. It cannot be combined with `--local`.
- Published `@augmentworks/cli@0.3.2` does not include these commands.

## Remaining release requirements

- Review/merge of this PR.
- AUG-45 owns machine credentials and a complete hosted GitHub Actions journey.
- AUG-7 / release-acceptance tickets verify deployed web commit and published CLI artifacts.
- Do not mark Linear Done from source integration. Keep **In Review**.
