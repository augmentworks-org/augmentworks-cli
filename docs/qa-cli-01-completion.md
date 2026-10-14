# QA-CLI-01 completion record — API-key mode, hosted report export, truthful exits

Issue: [AUG-54](https://linear.app/augmentworks/issue/AUG-54/cli-add-explicit-api-key-mode-full-hosted-report-export-and-truthful)

Owned repository: `augmentworks-org/augmentworks-cli`. Main (`augmentworks-org/augmentworks`) remains read-only.

This is source/fixture completion for work-package QA-CLI-01. It is not
publication, npm-registry, or deployed-API acceptance. Those belong to the
combined release gate ([AUG-58](https://linear.app/augmentworks/issue/AUG-58/main-verify-deployed-api-key-password-and-published-cli-qa-integration)).

## Identity

| Item | Value |
| --- | --- |
| Default main at start | `3db54a6` (merge of billing Stage 5B) |
| Audited CLI SHA in the ticket | `197bbf7689b120fbe5d190b575429e1de8128495` (older than current main) |
| Working branch | `cursor/aug-54-api-key-report-3f6d` |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/26 |
| Source package | `0.3.3` (not a published npm version) |
| Verified published npm | `@augmentworks/cli@0.3.2` |
| Contract | AW-QA-1 hosted authentication and report contract |
| Report schema | `aw-run-report/1` |
| Export schema | `aw-run-report-export/1` |
| Criterion schema | `aw-criterion-detail-read/1` |
| Schema SHA-256 | `7726ec277d33e435d2832e8be0898baf9337631d779f073a10c7795fc7de38ff` |
| Fixtures SHA-256 | `febd2626c96672d0e79afc4706b3a5136598b61bbebbdeb0f8ec1bdbc44cd806` |
| Fixture source | `compatibility-local` / producer [AUG-55](https://linear.app/augmentworks/issue/AUG-55/main-deliver-a-pinned-hosted-report-api-and-close-purged-evidence-read) |
| Migrations | none (CLI does not own SQL) |
| Competing PRs on write paths | none open at start |

Producer artifacts from `augmentworks-org/augmentworks` were not published when this
CLI work started. The CLI vendors the exact AW-QA-1 compatibility fixtures in
`contracts/aw-run-report-v1.{schema,fixtures,lock}.json`. Final integration
compares those files to the canonical copies once AUG-55 lands. Wire field
names were not renamed.

## Supported API surface (consumer)

| Path | Role |
| --- | --- |
| `GET /api/v1/cli/auth/me` | Existing required fields plus optional `principal_kind`, `credential_id`, `actions`, `expires_at` |
| `GET /v1/relay/runs/{runId}/report` | Pinned `aw-run-report/1` pages |
| `GET /v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria` | Existing `aw-criterion-detail-read/1` (and `/api/v1` alias) |

Production origin remains `https://augmentworks.ai`. The CLI refuses redirects
and off-origin criterion/report links while holding the bearer. Retry-After is
honored only for safe GET reads inside a 20s budget.

## Owned implementation

- Explicit `AUGMENTWORKS_API_KEY` mode in `src/auth/credential-store.ts`. Env
  conflict is detected before store or network access. Equal nonempty
  `AUGMENTWORKS_API_KEY` / `AUGMENTWORKS_TOKEN` values are the same key. Stale
  `AUGMENTWORKS_REFRESH_TOKEN` is ignored. TOKEN+REFRESH behavior is unchanged
  when the API key is absent.
- Compatible `/me` parsing and `whoami` metadata without bearer values.
  Invalid/expired/revoked keys remap to `API_KEY_REVOKED` (exit `3`).
- `augmentworks run report <run-id> [--json]` in `src/commands/run.ts` with
  client `src/report/client.ts`. Always JSON stdout
  (`aw-run-report-export/1`). Never quotes, creates, purchases, or regrades.
  Report-only keys at zero credits are not blocked by billing capability
  preflight.
- Shared classifier `src/outcome/classify.ts` used by hosted `test`,
  `run wait` / `run status`, and `run report`.
- Packed smoke `scripts/packed-report-fixture.mjs` plus inventory of vendored
  report contracts.

## Exit policy

| Code | Meaning |
| --- | --- |
| `0` | Fully passed, graded, known-coverage result (`reportReady` required on a complete report export) |
| `10` | Genuine assessed failure (complete failed export, including the R01 negative control) |
| `11` | Pending, partial, unknown, unsupported, null outcome, or incomplete retrieval |
| `12` | Evaluator error |
| `3` | Auth, including env conflict and revoked API keys |
| `4` | Protocol/relay, including hostile links, 410, 503, malformed schemas |
| `13` | Billing (unchanged; report path does not call billing) |
| `130` | Interrupt |

A completed run with a null outcome or an unrecognized evaluation status never
returns `0`. Retrieval success is not grading success.

## Tests run

Recorded on branch `cursor/aug-54-api-key-report-3f6d` after source
implementation. Source tests do not call a live AugmentWorks API. Exact
package version under test: **0.3.3** (unpublished).

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | Pass |
| `npx vitest run` | Pass. **59 files, 554 tests** |
| `node scripts/check-aw-run-report-contract.mjs` | Pass. schema `7726ec277d33e435d2832e8be0898baf9337631d779f073a10c7795fc7de38ff`, fixtures `febd2626c96672d0e79afc4706b3a5136598b61bbebbdeb0f8ec1bdbc44cd806`, source `AW-QA-1` |
| `npm run check` | Pass (typecheck, vitest 59/554, tsup, discovery, billing contract, run-report contract) |
| `npm run smoke:pack` | Pass. Packed tarball **34 files**, 393327 compressed bytes. Installed binary `@augmentworks/cli@0.3.3`. Packed billing fixture: `creates=1 quotes=4 targets=1 polls=3 refreshes=1`. Packed report fixture: `requests=3`, GET-only, JSON-only stdout, isolated HOME/state, empty D-Bus, `AUGMENTWORKS_API_KEY`, env-conflict exit `3`, negative-control exit `10`, no quote/create/retry-evaluation |
| GitHub Actions CI | Pass. Node 20/22/24 × ubuntu/macos/windows (`34097472114`) |

Sanitized packed-report fixture line (no secrets):

```text
[packed report fixture] passed (requests=3, source=AW-QA-1 compatibility fixtures)
[pack smoke] passed (34 files, 393327 compressed bytes)
```

Skipped / blocked:

- Live `GET /v1/relay/runs/{runId}/report` against production (AUG-55 / AUG-58).
- Published npm `0.3.3` installation (package.json is not publication).
- GitHub Actions / baseline / reproduction journeys ([AUG-45](https://linear.app/augmentworks/issue/AUG-45/cli-support-scoped-machine-credentials-and-a-complete-hosted-github)).

## Publication needs

Do not document `npx @augmentworks/cli@0.3.3` until that tarball is on the
registry and independently verified. Website and `npx` examples stay on
**0.3.2**. After merge, the release gate must install the published CLI,
compare vendored hashes to AUG-55 canonical files, and exercise a real
workspace API key against the deployed report API.
