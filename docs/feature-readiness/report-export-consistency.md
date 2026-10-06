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

Commands were run in this checkout after implementation. Results are recorded in the pull request once this file's verification table is updated from the actual command output.
