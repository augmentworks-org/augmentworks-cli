# Command examples from a clone

These are the CLI's commands as you run them from a clone of this repository
after `npm ci && npm run build`, using `node dist/index.js` in place of
`npx --yes @augmentworks/cli@<version>`. The [README](../README.md) explains
what each one does; this page collects the exact invocations that the doc
tests check.

## Demo and setup

```bash
node dist/index.js demo
node dist/index.js demo --json
node dist/index.js init
node dist/index.js init --starter workflow
node dist/index.js login --workspace "$AUGMENTWORKS_WORKSPACE_ID"
node dist/index.js whoami --workspace "$AUGMENTWORKS_WORKSPACE_ID"
```

`--workspace` and `AUGMENTWORKS_WORKSPACE_ID` must agree when both are set. A
machine key for another workspace fails `WORKSPACE_MISMATCH` before any quote,
upload, or target work. `test --local --workspace` is rejected.

## Usage and billing

```bash
node dist/index.js usage
node dist/index.js usage --json
node dist/index.js billing
node dist/index.js billing --json
node dist/index.js billing --print
```

`usage` reads the workspace's credit ledger as a server snapshot; it never
grants credits, reserves units, or opens checkout. `billing` prints or opens
the first-party billing page; `--json` and `--print` never open a browser.

## Mapping preview and connection probe

```bash
node dist/index.js preview-mapping -c augmentworks.yaml --operation send --fixture ./fixtures/send-response.json
node dist/index.js preview-mapping -c augmentworks.yaml --operation send --fixture ./fixtures/send-response.json --json
node dist/index.js probe -c augmentworks.yaml
node dist/index.js probe -c augmentworks.yaml --json
node dist/index.js probe -c augmentworks.yaml --yes
```

`preview-mapping` applies the real response extraction, allowlist, redaction,
and evidence serialization to a local JSON fixture, without any network call.
Don't pass production transcripts or live target output. `probe` prints its
bounded plan; `--yes` runs it against the configured target only.

## Real-data setup

```bash
node dist/index.js target add --env production
node dist/index.js target verify <name>
node dist/index.js target list --suite refunds.suite.yaml
node dist/index.js target pull <name>
node dist/index.js scope create --target <name> --suite refunds.suite.yaml
node dist/index.js test --suite refunds.suite.yaml --max-credits 30 --yes
```

See [customer-suites.md](customer-suites.md#real-data-suites-aw-suite3).

## Hosted assessments, reports and gates

```bash
node dist/index.js test --assessment ./augmentworks.assessment.yaml --estimate
node dist/index.js test --assessment ./augmentworks.assessment.yaml --estimate --json
node dist/index.js test --assessment ./augmentworks.assessment.yaml --profile quick --max-credits 30 --yes
node dist/index.js run status <run-id>
node dist/index.js run wait <run-id>
node dist/index.js run report <run-id> --json
node dist/index.js compare --run <run-id> --baseline <baseline-id> --json
node dist/index.js gate --run <run-id> --baseline <baseline-id> --json
node dist/index.js gate --run <run-id> --baseline <baseline-id> --wait --timeout-ms 60000 --json
node dist/index.js baseline status --json
node dist/index.js investigation inspect examples/investigations/response-only.json
node dist/index.js investigation inspect examples/investigations/stateful.json --json
node dist/index.js investigation fetch --run <run-id> --evaluation <evaluation-id> --attempt <attempt-id> --criterion <criterion-id> --json
node dist/index.js investigation export-regression examples/investigations/response-only.json --out regression.yaml
```

Reproducing an investigation's pinned case is a new quoted run:

```bash
node dist/index.js test \
  --investigation examples/investigations/response-only.json \
  --max-credits 30 \
  --yes
```

Catalog, selection and shards:

```bash
node dist/index.js catalog list --json
node dist/index.js catalog show response-quality/0.1.0/R01
node dist/index.js selection compile \
  -c augmentworks.yaml \
  --assessment ./augmentworks.assessment.yaml \
  --out ./suite-selection.manifest.json
node dist/index.js test \
  --manifest ./suite-selection.manifest.json \
  --shard shard-000 \
  --max-credits 30 \
  --yes
node dist/index.js test \
  --manifest ./suite-selection.manifest.json \
  --all-shards \
  --max-credits 30 \
  --yes
node dist/index.js test \
  --manifest ./suite-selection.manifest.json \
  --all-shards \
  --execution-id <uuid> \
  --max-credits 30 \
  --yes
node dist/index.js gate --manifest-file ./suite-selection.manifest.json --declared-shards ./suite-selection.declared-shards.json --json
```

Doctor and quoted hosted execution of an assessment file:

```bash
node dist/index.js doctor \
  --assessment ./augmentworks.assessment.yaml \
  --profile quick

node dist/index.js test \
  --assessment ./augmentworks.assessment.yaml \
  --profile quick \
  --max-credits 30 \
  --yes

node dist/index.js test \
  --assessment ./augmentworks.assessment.yaml \
  --profile full \
  --max-credits 30 \
  --yes
```

## Non-interactive CI

Capture the run id, wait on that exact run if grading is pending, and inspect
`recover` before considering another run. `npx --yes` is not a spending
ceiling; `--max-credits` is.

```bash
set +e
json=$(node dist/index.js test \
  --assessment ./augmentworks.assessment.yaml \
  --max-credits 30 \
  --yes \
  --json)
code=$?
set -e
run_id=$(printf '%s\n' "$json" | node -e "
  let s = '';
  process.stdin.on('data', (d) => { s += d; });
  process.stdin.on('end', () => {
    const parsed = JSON.parse(s);
    process.stdout.write(String(parsed.run_id ?? parsed.runId ?? ''));
  });
")
if [ -z "$run_id" ]; then
  echo "No run id. Inspect recover before starting another hosted test." >&2
  set +e
  node dist/index.js recover --json
  set -e
  exit "$code"
fi
if [ "$code" -eq 11 ]; then
  node dist/index.js run wait "$run_id" --json --timeout-ms 60000
  code=$?
fi
# Read-only complete export. Do not run logout in automation cleanup;
# logout revokes reusable workspace API keys.
node dist/index.js run report "$run_id" --json
# Read-only semantic gate. Does not start, reserve, or charge a run.
# Set AUGMENTWORKS_BASELINE_ID to an explicit pin; do not auto-promote.
if [ -n "${AUGMENTWORKS_BASELINE_ID:-}" ]; then
  node dist/index.js gate \
    --run "$run_id" \
    --baseline "$AUGMENTWORKS_BASELINE_ID" \
    --json
  code=$?
fi
exit "$code"
```

The complete GitHub Actions recipe is
[examples/github-actions-hosted.yml](examples/github-actions-hosted.yml).
