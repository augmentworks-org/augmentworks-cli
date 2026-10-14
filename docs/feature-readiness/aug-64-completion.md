# AUG-64 completion record — parse producer criterion index and detail wire formats

Issue: [AUG-64](https://linear.app/augmentworks/issue/AUG-64/cli-parse-the-servers-actual-criterion-index-and-detail-wire-formats)

Owned repository: `augmentworks-org/augmentworks-cli`. Main (`augmentworks-org/augmentworks`) remains read-only.

This is source/fixture completion for criterion wire compatibility. It is **not**
publication, npm-registry, or deployed-API acceptance. Those belong to
[AUG-48](https://linear.app/augmentworks/issue/AUG-48/cli-verify-the-published-cli-core-customer-workflow) /
[AUG-58](https://linear.app/augmentworks/issue/AUG-58/main-verify-deployed-api-key-password-and-published-cli-qa-integration).

## Identity

| Item | Value |
| --- | --- |
| CLI default main at start | `1cb11978f9d2fc4a021a0b51a6c444152074ccba` (ticket audit) |
| PR base | `origin/main` after `eb6632a` (init `--config` filename fix; report paths unchanged) |
| Working branch | `cursor/criterion-wire-adapter-a6b3` |
| Source package | `0.3.3` (not a published npm version) |
| Producer commit compared | `8068a90f557f7b88e3355212f2b5459cfc03fe3e` |
| HTTP wrapper schema | `aw-criterion-detail-read/1` |
| Document schema | `aw-criterion-detail/1` |
| AW-QA-1 lock (untouched) | schema `7726ec277d33e435d2832e8be0898baf9337631d779f073a10c7795fc7de38ff`, fixtures `febd2626c96672d0e79afc4706b3a5136598b61bbebbdeb0f8ec1bdbc44cd806` |
| Migrations | none |

## Problem

The CLI export client required invented index fields `runId`, `criteria`, and
`page`, plus flat detail records. The main producer returns `items`,
`nextCursor`, `limit`, `totalInAttempt`, and nested `document`/`inspection`.
Compatibility-fixture tests therefore passed while an actual producer page
failed with `CRITERION_SCHEMA_INVALID` (complete:false, exit 11).

## Owned implementation

- `src/report/criterion-wire.ts` — bounded consumer adapter. Converts producer
  projections to the existing internal `CriterionIndex` / `CriterionDetail`
  export types. Fills `runId` from the pinned request when the producer omits
  it. Maps `totalInAttempt` onto `page.totalCriteria` and derives `hasMore`
  from `nextCursor`. Retains `null` / `inconclusive` / `not_applicable` via
  `wireVerdict`. Never invents available evidence or infers pass from absence.
- `contracts/aw-criterion-detail-read-v1.producer.fixtures.json` — producer-shaped
  fixtures labeled against main `@ 8068a90`. Not a second invented schema using
  the AW-QA-1 version string.
- `src/report/client.ts` — narrow parse-boundary swap only:
  `parseCriterionWirePage` / `parseCriterionWireDetail` replace the two
  `safeParse` calls in `#collectAttemptCriteria`. Pagination, same-origin,
  GET-only retries, and count/workspace hardening remain outside this ticket.
- Packed fixture serves producer index + nested fail detail while keeping the
  complete failed-assessment packed outcome (exit 10).

## AUG-59 coordination

Call boundary posted on AUG-64 and AUG-59. Count reconciliation and
session-pinned workspace checks remain with AUG-59. This adapter verifies
identities that are actually present (`evaluationId` / revision / hash /
attemptId, and `workspaceId` when both the wire and pinned report name one)
and exposes `page.totalCriteria` from `totalInAttempt` for later count checks.

## Conservative mappings

| Producer | Export |
| --- | --- |
| `requirement: required` / `advisory` | `required: true` / `false` |
| `verdict: pass\|fail\|error` | same |
| `verdict: null` / `not_judged` / `not_applicable` | `not_judged` (`wireVerdict` retained); required items keep the export incomplete |
| `verdict: inconclusive` | `uncertain` (`wireVerdict: inconclusive`); required items incomplete |
| unsupported verdict | `CRITERION_VERDICT_UNSUPPORTED`, not pass |
| omitted evidence / unknown availability | `availability: missing`, no invented text |
| `createsBillableRun: true` | `CRITERION_BILLABLE_CLAIM` |
| omitted `runId` | filled from the already-pinned request |

## Verification

| Command | Outcome |
| --- | --- |
| `npx vitest run test/report/criterion-wire.test.ts test/report/export-producer.test.ts test/report/export.test.ts test/report/cli-report.test.ts test/report/contract.test.ts` | Pass. 5 files, 40 tests |
| `npm run check` | Pass. typecheck; 61 files / 581 tests; build; discovery; billing contract; run-report contract hashes unchanged (`7726ec27…` / `febd2626…`) |
| `npm run smoke:pack` | Pass. Packed report fixture: `requests=4, source=producer aw-criterion-detail-read/1 @ 8068a90 + AW-QA-1 report` (GET `/me`, report, producer index, nested detail). Exit 10 complete failed assessment with retained fail evidence |
| Live hosted assessment / npm publish | **Not run.** Release compatibility remains AUG-48 / AUG-58 |

Behavior covered:

- Producer one-page pass/fail and multi-page `nextCursor` / nested `document`+`inspection` export complete retained evidence with exit 0 / 10
- Required `null` / `inconclusive` / `not_applicable` stay incomplete (exit 11), never pass
- Missing/purged/truncated evidence kept exactly; unsupported verdicts and `createsBillableRun: true` fail closed
- Wrong revision/hash/workspace identities that are present are rejected
- Legacy AW-QA-1 `criteria`+`page` fixtures still parse
- Packed tarball exercises the producer criterion wire without quoting, regrading, or POST

## Remaining

- Deployed producer + published CLI gate remains AUG-58 / AUG-48.
- AUG-59 still owns omitted-count and mixed-workspace export rejection.
- Do not infer production compatibility from this source merge.
