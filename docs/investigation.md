# Inspect and reproduce a saved failure

`aw-investigation-export/1` artifacts pin the exact suite revision and case
that failed. Inspecting a file is observation-only: the CLI does not execute
the target, spawn copied shell fragments, call an evaluator, or create a
run. Reproducing the case is a **new** quoted hosted run. The original run
and credits stay unchanged.

This command is in the `0.3.8` package. From a clone after `npm ci` and
`npm run build`, use `node dist/index.js`. Installed npx pins match this
package version. Do not pin immutable npm `0.3.6`. Packed installs include
the same samples under `assets/investigations/`.

## Commands

```bash
node dist/index.js investigation inspect examples/investigations/response-only.json
node dist/index.js investigation inspect examples/investigations/stateful.json --json
node dist/index.js investigation fetch --run <run-id> --evaluation <evaluation-id> --attempt <attempt-id> --criterion <criterion-id> --json
node dist/index.js investigation export-regression examples/investigations/response-only.json --out regression.yaml
node dist/index.js schema --kind investigation-export
```

`--json` writes one object on stdout. Diagnostics go to stderr.
`ok: true` on inspect means the artifact parsed; it is not a paid pass.

Fetch is also observation-only. It POSTs the investigation export path and
never calls `POST /v1/relay/runs` or quote. Copied `commandFragment` values
are data. This CLI will not execute them.

## Reproduce the pinned case

```bash
node dist/index.js test \
  --investigation examples/investigations/response-only.json \
  --max-credits 30 \
  --yes
```

`--investigation` resolves `GET /v1/suites/{suiteId}/revisions/{revisionId}`
for the **saved** revision. It does not call `/revisions/latest` or
`POST /v1/suites`. Admission sends `selected_scenario_ids` with that one
case. A new quote is required; a consumed quote is not reused. A changed
local file cannot replace the pin. An unavailable revision, hash mismatch,
or missing case fails closed.

`--investigation` cannot be combined with `--local`, `--suite`,
`--assessment`, or `--packet`. Local deterministic packets cannot admit this
artifact (`HOSTED_INVESTIGATION_UNSUPPORTED_LOCAL`).

Noninteractive admission still requires a finite `--max-credits` ceiling.
`--yes` is not an unlimited budget.

## Prerequisites

| Kind | Inspect | Reproduce |
| --- | --- | --- |
| Response-only | Displays send mapping status | Send mapping is enough |
| Stateful | Labels prepare / observe / cleanup / session | Missing required mappings block **before** quote |
| `fullyReproducible: false` | Qualifies the artifact | Does not invent completeness |
| Copied shell fragment | Printed as data | Never executed |

A response transcript is not a complete stateful reproduction.

## Regression draft

`investigation export-regression` writes `aw-suite/1` YAML from the **original
expected condition**. Failing chatbot output is not saved as the expected
answer. Hosted semantic judging uses `test --suite` or `test --investigation`.
`test --local` cannot admit the draft.

## Samples

| File | What it covers |
| --- | --- |
| `examples/investigations/response-only.json` | Semantic FAQ failure. Inspect with a poisoned token does not admit. Reproduction pins `faq.status-page`. |
| `examples/investigations/stateful.json` | Stateful refund-limit failure. Missing prepare/observe/cleanup block paid reproduction. |

## Schema

The consumed main-owned identity is `aw-investigation-export/1` from AUG-33
(PR https://github.com/jeffskafi/augmentworks/pull/73, cited head
`a8e5ad17ce60f9b199d6a45f34188546d075e4bf`). Feature package `aw-feature/1`
schema SHA-256
`4f026740a349c736e98af95599736a92cb81246bea3a1673b26e7fa94cadc870`.
`jeffskafi/augmentworks` is not readable from this environment (GitHub 404);
checksums are Linear-published identities, not invented hashes. Lock file:
`contracts/aw-investigation-export-v1.lock.json`.
