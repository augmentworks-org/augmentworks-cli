# C01 completion record — unfinished run observation

Issue: [AUG-11](https://linear.app/augmentworks/issue/AUG-11/cli-prevent-unfinished-run-observation-from-returning-success)

Owned repository: `augmentworks-org/augmentworks-cli`. Main remains read-only.

## Identity

| Item | Value |
| --- | --- |
| Audit baseline / default main | `8a9f31a9fa6d99b2f0ea7e1530a4b73741592027` |
| Working branch | `cursor/prevent-unfinished-run-observation-5ddb` |
| Implementation HEAD | recorded after verification commit on this branch |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/18 |
| Consumed billing 2B | already merged on main (`dc35d9e` / PR #15), vendored main `67749b22f04bbb8d94c0309acd36be3cb3144400` |
| Schema version | `aw-billing/1` |
| Schema SHA-256 | `4816444925c39629d41fc6993b0206fa5db25641ce40aafc13af6fe1a89ef901` |
| Fixtures SHA-256 | `cb26b6d36bf01d7c1957354f8982f20a6cfd8c8c47859f46e37d5270b75dd4a1` |
| Migrations | none (CLI does not own SQL) |
| Competing PRs on write paths | none open at start |

## Problem

`isWaitTerminal` treated `evaluationStatus === "absent"` as terminal regardless of execution. `billingStatusExitCode` fell through to exit `0`. A constructed `running` + `absent` + `0/10` attempts + `null` outcome therefore ended wait as success even though only the HTTP query succeeded. Production emission of that combination is unverified; the helper behavior made unattended release gates unsafe.

## Interfaces

Classifier: `classifyBillingRunStatus` in `src/billing/classify.ts`.

A successfully parsed status is **observation success**. That is not a passing assessment.

| Field | Meaning |
| --- | --- |
| `observation: "succeeded"` | GET `/v1/billing/status` parsed. JSON `ok: true`. |
| `work: "in_progress" \| "terminal"` | Relay execution still active vs finished/unknown. |
| `waitTerminal` | Wait may return. False while execution is nonterminal or grading is `pending`/`partial`. |
| `assessment` | Release-gate class: `passed`, `failed`, `incomplete`, `evaluator_error`, `interrupted`, `unsupported`, `unknown`. |
| `exit_code` | Documented CLI exit. `0` only for an explicit resolved `passed` outcome. |

`run status` / `run wait --json` now include `observation`, `work`, `assessment`, and `exit_code`. Process exit follows `assessment`, so a release gate cannot treat query success as a pass.

Wait timeout and poll exhaustion throw `EVALUATION_INCOMPLETE` (exit `11`) naming the original run: `augmentworks run wait <run-id>`. They only GET capabilities + status. No quote, reservation, create, target call, or evaluation retry.

### Execution × evaluation combinations

Known execution values are the relay statuses: `queued`, `connected`, `running`, `cancel_requested`, `cancelled`, `completed`, `failed`. The main billing schema leaves `executionStatus` unconstrained; unknown strings still parse.

| execution | evaluation | outcome | wait | assessment | exit |
| --- | --- | --- | --- | --- | --- |
| queued / connected / running / cancel_requested | absent | null | continue | incomplete | 11 |
| **running** | **absent** | **0/10, null** | **continue** | **incomplete** | **11** |
| completed | absent | passed | terminal | passed (deterministic-only) | 0 |
| completed | absent | failed / inconclusive / error | terminal | failed | 10 |
| completed | absent | null | terminal | incomplete | 11 |
| completed | pending / partial | any | continue | incomplete | 11 |
| completed | complete | passed | terminal | passed | 0 |
| completed | complete | failed / inconclusive / error | terminal | failed | 10 |
| completed | complete | null | terminal | incomplete | 11 |
| completed | error | any | terminal | evaluator_error | 12 |
| completed | unsupported | any | terminal | unsupported | 11 |
| failed | not pending/partial | any | terminal | failed | 10 |
| cancelled | not pending/partial | any | terminal | interrupted | 130 |
| failed / cancelled | error | any | terminal | evaluator_error | 12 |
| unknown | not pending/partial | any | terminal | unknown | 11 |

Ambiguous combinations (running + complete + passed, complete + null outcome, unknown execution, unknown outcome, unsupported even with `passed`) never silently pass. Evaluator `error` keeps exit `12` over execution failure.

## Proposed main fixture additions

Do **not** hand-edit vendored contract checksums in this CLI. Ask the contract owner (`augmentworks-org/augmentworks`) to add additive fixtures, then re-import:

- `status_running_absent_zero_attempts` — the reproduction (`running`, `absent`, `0/10`, `outcome: null`)
- `status_completed_deterministic_passed` — terminal deterministic-only success (`completed`, `absent`, `outcome: "passed"`)
- `status_completed_evaluation_unsupported`
- `status_execution_cancelled_absent`
- `status_execution_failed_absent`

Until those exist, CLI tests compose overlays on vendored `status_pending_grading` (`cb26b6d36bf01d7c1957354f8982f20a6cfd8c8c47859f46e37d5270b75dd4a1`).

## Examples

```bash
node dist/index.js run status <run-id> --json
# unfinished: ok=true, assessment=incomplete, process exit 11

node dist/index.js run wait <run-id>
# continues while execution is nonterminal; timeout remains read-only
```

## Verification

Working directory: this checkout. Commands and real outcomes:

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | Pass (`tsc --noEmit`) |
| `npx vitest run test/billing/run-status-classification.test.ts test/billing/cli-quote.test.ts test/billing/contract.test.ts test/billing/cli-run-wait.test.ts` | Pass. **4 files, 55 tests** including packed `dist/index.js run wait` / `run status` process exits |
| `npm test` | Pass. Vitest 4.1.11: **49 files, 407 tests** |
| `npm run build` | Pass. tsup ESM `dist/index.js` 1.63 MB |
| `npm run check:discovery` | Pass. `@augmentworks/cli@0.3.2` (development) |
| `npm run check:billing-contract` | Pass. `aw-billing/1` from `67749b22f04bbb8d94c0309acd36be3cb3144400`; schema `4816444925c39629d41fc6993b0206fa5db25641ce40aafc13af6fe1a89ef901`; fixtures `cb26b6d36bf01d7c1957354f8982f20a6cfd8c8c47859f46e37d5270b75dd4a1` |
| `npm run check` | Pass (typecheck + test + build + discovery + billing contract) |
| `npm run smoke:pack` | Pass. Packed tarball **20 files, 356000 compressed bytes** |
| Live paid target / Stage 2A host | **Not run.** Scope exclusion; missing live credentials are blockers, not passes |

Packed wait tests assert process exit `11` for the running/absent/0-of-10/null reproduction, exit `0` after the fixture API becomes deterministic `completed`/`absent`/`passed`, timeout output containing `augmentworks run wait <original-run-id>`, and zero `POST /v1/billing/quote` / `POST /v1/relay/runs` / retry-evaluation calls.

## Compatibility

- Numeric exits `10`, `11`, `12`, `13`, `130` unchanged in meaning.
- JSON `ok: true` remains query success; additive `assessment` / `exit_code` expose the gate.
- Vendored `aw-billing/1` hashes unchanged.
- Observation never creates a billable run.

## Remaining release requirements

- Source integration of this PR is not npm publication. AUG-7 / release-acceptance tickets verify published artifacts.
- Do not activate live billing.
- Re-import main fixtures if the contract owner adds the proposed status cases.
