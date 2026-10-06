# Report export consistency — completion record

Issue: [AUG-272](https://linear.app/augmentworks/issue/AUG-272/cli-reject-internally-contradictory-hosted-report-exports-before)

Owned repository: `augmentworks-org/augmentworks-cli`. This is a source-only consumer fix. It is not publication, npm-registry replacement, or deployed-API acceptance.

Cursor session: https://cursor.com/agents/bc-85684afa-fb75-4b9b-9283-29b5b3c92b92

## Identity

| Item | Value |
| --- | --- |
| Base | `349d66c7a5d9989ede62da52e96d8a2133892847` (`main`, package 0.3.7 source) |
| Contract | `aw-report-consistency/1` |
| Wire schemas kept | `aw-run-report/1`, `aw-run-report-export/1` |
| Published 0.3.7 | unchanged. Registry gitHead `876454878a31a897aec1d722fa838c9c0ecea2aa`, published `2026-09-27T21:06:12.276Z`, tarball SHA256 `37b448b4db2c195b5c361daab10604d57476fa4d9e441916f7bfe2054f81b313` |
| Publication | pending a later immutable artifact. Customers do not have this fix because 0.3.7 was not overwritten. |
| [AUG-253](https://linear.app/augmentworks/issue/AUG-253/cliux-second-pass-verify-and-close-the-saved-suite-publication-gap) | historical 0.3.7 receipt was not edited |
| Migrations | none |
| New dependencies | none |
| Billable runs | none. Reads stay GET-only and `createsBillableRun: false` |

## Problem

At the reviewed source SHA, a retrieved hosted report could exit 0 when the document was internally contradictory:

1. Coherent required failure (`report_required_fail` plus the producer fail index and detail) stayed complete and exited 10.
2. Changing only `outcome` to `passed` stayed complete, with empty diagnostics, and exited 0 even though `aggregate.failed` was 1 and a completed required criterion verdict was `fail`.
3. Clearing `attempts` and setting `page.totalAttempts` to 0, while leaving completed/planned coverage and required-judgment coverage at 1/1, stayed complete and exited 0.
4. One retrieved row with `totalAttempts` 2 stayed incomplete with `REPORT_TOTAL_BOUNDS` and exited 11.

Attempt `outcome` describes execution, not grading, and is not used as a semantic failure.

## Behavior

Validation runs after bounded report and criterion reads, before success classification. Original evidence is not rewritten.

| Input | Result |
| --- | --- |
| Complete, internally coherent pass | `complete: true`, exit 0 |
| Complete, internally coherent assessed failure | `complete: true`, exit 10 |
| Claimed pass plus a completed required verdict `fail`, or a known aggregate `failed` count above zero | `retrieved: true`, `complete: false`, exit 11, `REPORT_EVIDENCE_CONTRADICTION` |
| Known completed-attempt or finished required-judgment coverage greater than the distinct evidence retrieved | `retrieved: true`, `complete: false`, exit 11, `REPORT_COVERAGE_MISMATCH` |
| Pending, unknown, unavailable, evaluator, transport, or auth failure | existing incomplete or error exit, with no coercion to pass |

Advisory failures stay advisory. A missing or non-numeric aggregate is not itself a contradiction. A coherent `outcome: failed` report remains useful evidence at exit 10. Pagination that already disagrees with `totalAttempts` still uses `REPORT_TOTAL_BOUNDS`. Diagnostics carry the code and a same-read recovery line only: no answers, prompts, credentials, or customer URLs. Stderr says the evidence is inconsistent and cannot be used as a passing release check.

## Verification

Commands below were run in this checkout against implementation `4012f69f903fa63f4ce39a77d34c3b7b9a5a4072`. This documentation commit does not change runtime behavior. The agent environment injects `AUGMENTWORKS_API_KEY`; the full suite and pack commands were run with that variable, `AUGMENTWORKS_API_URL`, and `AUGMENTWORKS_TOKEN` unset so fixture bearer tokens were not treated as an auth-env conflict. No hosted quote, admission, or billable run was issued.

| Command | Result |
| --- | --- |
| `npm run check:run-report-contract` | Pass. `aw-run-report/1` schema `7726ec277d33e435d2832e8be0898baf9337631d779f073a10c7795fc7de38ff`, fixtures `febd2626c96672d0e79afc4706b3a5136598b61bbebbdeb0f8ec1bdbc44cd806`, source `AW-QA-1` |
| `npm test -- test/report/export.test.ts test/report/cli-report.test.ts test/outcome/classify.test.ts` | Pass. 3 files, 54 tests |
| `npm run check` | Pass. typecheck, vitest 107 files / 1063 passed / 1 skipped, tsup, discovery `@augmentworks/cli@0.3.7` (development), billing contract, run-report contract, real-data contract |
| `npm run smoke:pack` | Pass. Packed tarball 74 files, 595455 compressed bytes. Installed-binary report fixture: `requests=34`, GET-only. Local core release acceptance `releaseReady=false` because `registry-identity` was not run; that is not a registry publish |
| `AUGMENTWORKS_PACKED_BIN=$PWD/dist/index.js npm run test:packed-report-fixture` | Pass. `requests=34`, producer `aw-criterion-detail-read/1` @ `8068a90` plus AW-QA-1 report |

Packed matrix on the built CLI: coherent pass exit 0, coherent required failure exit 10, claimed pass plus required fail exit 11 `REPORT_EVIDENCE_CONTRADICTION`, empty attempts hidden by `totalAttempts: 0` exit 11 `REPORT_COVERAGE_MISMATCH`, required-count mismatch exit 11, contradictory aggregate `failed` exit 11, advisory fail with a required pass exit 0, attempt execution `fail` with a required pass exit 0, omitted attempt `REPORT_TOTAL_BOUNDS` exit 11, mixed workspace exit 4. No POST, quote, or retry-evaluation.

Not done here: merge, npm publish, replacement of the 0.3.7 tarball, and deployed acceptance for [AUG-268](https://linear.app/augmentworks/issue/AUG-268/qaux-second-pass-verify-the-integrated-deployed-first-result-and-rerun).
