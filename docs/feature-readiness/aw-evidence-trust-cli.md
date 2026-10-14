# AW-EVIDENCE-TRUST-1 / CLI-COMPLETENESS — completion record

Issue: [AUG-59](https://linear.app/augmentworks/issue/AUG-59/cli-reject-incomplete-or-mixed-workspace-hosted-report-exports)

Owned repository: `augmentworks-org/augmentworks-cli`. Main (`augmentworks-org/augmentworks`) remains read-only.

This is source/fixture completion for CLI retrieval completeness. It is not
publication, npm-registry, or deployed-API acceptance. Those belong to
[AUG-48](https://linear.app/augmentworks/issue/AUG-48/cli-verify-the-published-cli-core-customer-workflow) /
[AUG-58](https://linear.app/augmentworks/issue/AUG-58/main-verify-deployed-api-key-password-and-published-cli-qa-integration).

## Identity

| Item | Value |
| --- | --- |
| Default main at start | `1cb11978f9d2fc4a021a0b51a6c444152074ccba` (AUG-54 PR #26 merged) |
| Working branch | `cursor/aug-59-report-completeness-5a5a` |
| Implementation commit | `64271b1fe65e9f4f75a5d8b88dbff39eca705513` |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/28 |
| Source package | `0.3.3` (not a published npm version) |
| Verified published npm | `@augmentworks/cli@0.3.2` |
| Report schema | `aw-run-report/1` |
| Export schema | `aw-run-report-export/1` |
| Criterion schema | `aw-criterion-detail-read/1` |
| Schema SHA-256 | `7726ec277d33e435d2832e8be0898baf9337631d779f073a10c7795fc7de38ff` |
| Fixtures SHA-256 | `febd2626c96672d0e79afc4706b3a5136598b61bbebbdeb0f8ec1bdbc44cd806` |
| Fixture source | `compatibility-local` / producer [AUG-55](https://linear.app/augmentworks/issue/AUG-55/main-deliver-a-pinned-hosted-report-api-and-close-purged-evidence-read) |
| Migrations | none (CLI does not own SQL) |
| Competing PRs on write paths | none open at start |

Canonical producer fixtures were not modified. Adversarial variants (omitted
attempt, omitted criterion, contradictory totals, mixed workspace, unknown
totals) are constructed inside owned tests.

## Problem

Static source-proven hole in the AUG-54 exporter, not an observed production
failure:

1. Copy `report_all_pass_one_page` + `criterion_index_r01_pass`, set only
   `page.totalAttempts` from `1` to `2`, keep the single passing attempt and
   terminal `hasMore: false`. `exportRun`'s missing-attempt guard required
   `merged.page.hasMore`, but `mergePages` always set that false, so
   `complete: true` / exit `0` survived. Coverage counters set to `2` cannot
   prove retrieved completeness.
2. `run report` passed origin/token but not `session.identity.workspaceId`.
   Defense in depth against mixed evidence, not a demonstrated server tenant
   leak.

## Frozen contract kept

- Wire field names and schemas unchanged: `aw-run-report/1`,
  `aw-run-report-export/1`, `aw-criterion-detail-read/1`.
- Complete valid pass remains exit `0`. Complete valid failed assessment
  remains exit `10`. Missing/mixed evidence uses the existing incomplete
  (exit `11`) or protocol/error (exit `4`) nonzero paths.
- Reads remain GET-only, `createsBillableRun: false`, no quote / create /
  regrade / refund / publication.
- Bearer is never sent to a response-provided foreign origin.

## Implementation

- `src/report/client.ts`: immutable claimed totals separate from flattened
  page metadata; unique collected attempts must equal a known
  `totalAttempts` when pagination terminates, including `hasMore: false`.
  Equivalent per-attempt `totalCriteria` reconciliation. Null totals are
  unknown, never zero. Coverage counters cannot establish retrieval
  completeness. Optional absent criterion `workspaceId` remains compatible;
  any present mismatch is rejected.
- `src/commands/run.ts`: threads `expectedWorkspaceId` from the existing
  authenticated session. JSON-only stdout. Stderr recovery tells the operator
  to retry a bounded read of that original run and not start another billed
  assessment. Diagnostics carry count/binding class only — no tokens, URL
  query secrets, evidence text, or raw responses.
- `scripts/packed-report-fixture.mjs`: packed `run report` exercises the
  premature terminal page and a mixed-workspace page.

## Verification

Working directory: this checkout. Commands and real outcomes:

| Command | Outcome |
| --- | --- |
| `npx tsc --noEmit` | Pass |
| `npx vitest run test/report/export.test.ts test/report/cli-report.test.ts test/outcome/classify.test.ts` | Pass. **3 files, 44 tests** |
| `npm run check:run-report-contract` | Pass. schema `7726ec277d33e435d2832e8be0898baf9337631d779f073a10c7795fc7de38ff`, fixtures `febd2626c96672d0e79afc4706b3a5136598b61bbebbdeb0f8ec1bdbc44cd806`, source `AW-QA-1` |
| `npm run check` | Pass (typecheck + vitest **59 files, 573 tests** + tsup + discovery + billing contract + run-report contract) |
| `npm run smoke:pack` | Pass. Packed tarball **34 files**, 394331 compressed bytes. Packed report fixture: `requests=7`, GET-only, JSON-only stdout, isolated HOME/state, empty D-Bus, `AUGMENTWORKS_API_KEY`, env-conflict exit `3`, negative-control exit `10`, omitted-attempt exit `11`, mixed-workspace exit `4`, no quote/create/retry-evaluation |

Sanitized packed-report fixture line (no secrets):

```text
[packed report fixture] passed (requests=7, source=AW-QA-1 compatibility fixtures)
[pack smoke] passed (34 files, 394331 compressed bytes)
```

Covered in owned tests:

- Positive one-page pass and multi-page pass retain exit `0`.
- Complete failed assessment retains exit `10`.
- Terminal `hasMore: false` with 1/2 attempts, 1/2 criteria, contradictory
  totals, duplicate attempt IDs, and unknown totals never exit `0`.
- Consistent coverage counters cannot hide omitted retrieved items.
- Unknown coverage, pending grading, purge `410`, evaluator error, truncated
  evidence, revoked credential, abort/timeout, 429 retry, and JSON-only
  stdout remain fail-closed.
- Wrong workspace on first page, later page, criterion index, and criterion
  detail is rejected; optional absent criterion workspace remains compatible.
- Zero-balance / no-billing read path: passing export issues no `/v1/billing`
  or POST routes.

Skipped / blocked:

- Live `GET /v1/relay/runs/{runId}/report` against production (AUG-55 / AUG-58).
- Published npm `0.3.3` installation (package.json is not publication).
- Public quickstart pin remains published `0.3.2`.

## Rollback

Retain fail-closed behavior. Do not restore the previous false-success path
(`complete: true` / exit `0` on omitted attempts). Hold report-command
release and use the supported read path until a corrected consumer is
published. No DB migration, new external service, or product analytics event
to reverse.

## Limitations

- Source merge / local tarball is not customer-facing release. Record actual
  registry version/integrity and compatible deployed API evidence under
  AUG-48 / AUG-58 before calling the fix released.
- Workspace pinning is defense in depth against mixed evidence in the
  consumer; it is not proof of a server tenant leak.
- Criterion indexes that omit `totalCriteria` (`null`) cannot prove
  completeness. A URL that returns a single detail document (not an index)
  remains a singleton resource and is not treated as an unknown list.
- No new producer, SQL retention, or shared auth resolver was added.
