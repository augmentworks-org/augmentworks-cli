# Customer-owned hosted suites

Git-friendly `aw-suite/1` files let you define hosted semantic cases without
editing AugmentWorks source. Local `suite validate` / `suite preview` never
quote, never execute a target, and never call an LLM. A hosted
`test --suite` pins an immutable server revision, then uses the existing
quote / `--max-credits` / `--yes` consent path.

This package also admits versioned `aw-suite/2` live-informational files for
offline validate/preview/preflight and hosted quote checks. Submitting an
`aw-suite/2` file does **not** authorize a live origin. Server admission stays
fail-closed behind `AUGMENTWORKS_LIVE_TARGET_PILOT_ALLOWLIST`. Do not relabel a
live target as synthetic.

`aw-suite/3` / `aw-customer-suite/3` bind a server-admitted
`execution_scope` instead of `synthetic_only` / `live_target`. Offline
validate, preview, and preflight accept that format. Hosted quote and create
stay fail-closed with `EXECUTION_RELEASE_UNAVAILABLE` until the advertised
server capability and release gate are verified. Hosted real-data quote and
admission stay release-disabled; this document does not claim that release is
enabled. Unknown schema versions fail closed and are never downgraded to
synthetic. Local authorized packets use `aw-packet/local-authorized-1`, stay
account-free, and cannot be presented as hosted authority.

Older `aw-suite/1` / `aw-packet/0.1` files still work and remain synthetic.
`aw-suite/2` live-informational files still require `synthetic_only: false`.
The minimum published npm artifact for a later real-data release is decided by
the publication gate; do not guess a version. Packaged examples in this
document are fictional. This text is not legal approval. Do not set
`synthetic_only: true` on a live or authorized document, grant `suite:write`
to a machine key, or test a third party without authority.

The command exists in this `0.3.8` package. Native hosted
`aw-customer-suite/1` upload translation shipped in immutable npm `0.3.7`
and is not in immutable registry `0.3.6`. From this clone after `npm ci` and
`npm run build`, use `node dist/index.js`. Pin `@augmentworks/cli@0.3.8`
after the protected `v0.3.8` publish. Do not assume registry `0.3.6`
contains the upload translation, and do not overwrite `0.3.7`.

## Commands

```bash
node dist/index.js suite validate examples/customer-suites/faq-non-commerce.yaml
node dist/index.js suite preview examples/customer-suites/returns-14-day.yaml
node dist/index.js suite preview examples/customer-suites/faq-non-commerce.yaml --json
node dist/index.js suite preflight test/fixtures/customer-suites/live-informational.yaml
node dist/index.js schema --kind customer-suite
node dist/index.js test --suite examples/customer-suites/faq-non-commerce.yaml --estimate
node dist/index.js test --suite examples/customer-suites/faq-non-commerce.yaml --max-credits 30 --yes
```

`--estimate` creates a suite revision and requests a quote. It does not
create a run, reserve credits, or execute a target. Local preview counts are
not an authoritative price.

Both `--estimate --suite` and `test --suite` require an authorized **user
connector grant** (`AUGMENTWORKS_TOKEN`; optional
`AUGMENTWORKS_REFRESH_TOKEN`). Unset `AUGMENTWORKS_API_KEY` when choosing that
credential. Machine API keys deliberately cannot create suites: they fail
before upload with `SUITE_WRITE_REQUIRES_USER`. Use an already saved immutable
revision through an assessment's `selection.suite_revision_id` or an exact
compiled manifest for machine execution. Do not grant `suite:write` to a
machine key as a workaround. Saved-suite v2 is also unreleased source until
its publication gate is completed.

The CLI translates authoring data into the server's native
`aw-customer-suite/1` source document. Local preview `content_hash` remains
the authoring identity used to detect changed files. Hosted
`suite_content_hash` is the separate native canonical hash verified against
the server response. Scenario IDs become
`aw-customer-suite/1.0.0/<case_id>`; criterion IDs are unchanged. No source
file is relabeled and no live-target permission is implied by this adapter.

Noninteractive admission still requires a finite `--max-credits` ceiling.
`--yes` is not an unlimited budget. The CLI does not prompt, open a browser,
or raise limits silently.

## Authoring format

YAML or JSON. Snake_case keys (`schema_version`, `suite_id`, `case_id`) are
rewritten to the camelCase canonical document (`schemaVersion: aw-suite/1`).
`aw-suite/2` additionally requires `synthetic_only: false` and a complete
`aw-live-target/1` contract (exact canonical HTTPS origin, authorization
reference, expiry, and `max_messages` 1–3). Live cases are single-turn only.
`aw-suite/3` requires `execution_scope` (`aw-execution-scope/1`) and rejects
`synthetic_only` / `live_target`. Unsupported schema versions, duplicate case
IDs, missing references, credential-like keys, executable scripts, and
`history_array_v1` fail **before** any network call.

Local authoring limits: 64 KiB suite file, 64 KiB / 16 references,
20 cases, 20 turns, 3 repetitions, 16 criteria/tags/facts/observations.

Hosted source is additionally validated against the pinned producer schema
before upload: at most 3 turns per case, 12 facts/conditions, 2,000-character
descriptions/statements, 1,000-character facts/conditions, and 160-character
case IDs. Values are rejected, never silently truncated.

Offline authoring preview recognizes `policy.window_days` and
`policy.permitted_refusal`, but the current hosted data-only customer-suite
producer does **not** execute deterministic observations. Such suites fail
with `SUITE_HOSTED_OBSERVATION_UNSUPPORTED` before upload. Keep deterministic
checks in the existing local packet path; author supported response-only
semantic criteria for this hosted path.

Conversation capability is **not** inferred from a multi-turn case. Hosted
`multi_turn` is advertised only when `augmentworks.yaml` declares
`target.conversation.strategy: explicit_session_v1` (see the C05 session
mode). A multi-turn suite against a single-turn connector fails with
`CONVERSATION_CAPABILITY_INCOMPATIBLE` before authenticate or quote.

## Samples

| File | What it covers |
| --- | --- |
| `examples/customer-suites/faq-non-commerce.yaml` | Five synthetic FAQ cases (status page, hours, password reset, data export, accessibility). No commerce or return-window facts. |
| `examples/customer-suites/returns-14-day.yaml` | Offline authoring/preview example including multi-turn and deterministic observations. The current hosted producer rejects its observations; it is not a hosted acceptance fixture. |

Packed installs include the same files under `assets/customer-suites/`.

## Local versus hosted

| Capability | Local `test --local --packet` | Hosted `test --suite` |
| --- | --- | --- |
| Format | `aw-packet/0.1` JSON | `aw-suite/1` YAML/JSON |
| Offline validate/preview/preflight | Packet parse only | `suite validate` / `suite preview` / `suite preflight` |
| LLM rubric / hybrid | Rejected (`UNSUPPORTED_LOCAL_GRADER`) | Quoted hosted judging |
| Customer-owned cases | Private deterministic packet | Immutable suite revision |
| Quote / `--max-credits` | Not used | Required for admission |
| File change after quote | N/A | `SUITE_CHANGED_AFTER_QUOTE`; the CLI will not re-pin mutable content |
| Multi-turn | Packet `required_capabilities.multi_turn` | Config `explicit_session_v1`, not the suite file |

`--suite` cannot be combined with `--local`, `--assessment`, or `--packet`.

## Migrating from a private local packet

1. Keep the existing packet for account-free `test --local`.
2. Author an `aw-suite/1` file for hosted semantic cases (inputs, expected
   facts, references, required/advisory criteria).
3. Validate and preview offline.
4. Run hosted `test --suite` against the same connector YAML, with a finite
   `--max-credits` ceiling.
5. Do not paste judging credentials into the suite file. Do not expand to a
   hundred default scenarios. Do not import production transcripts.

Case order is file order for `test --suite`. Larger owned suites use the
server compiler:

```bash
node dist/index.js catalog list --json
node dist/index.js selection compile \
  -c augmentworks.yaml \
  --assessment ./augmentworks.assessment.yaml \
  --out ./suite-selection.manifest.json
node dist/index.js test \
  --manifest ./suite-selection.manifest.json \
  --shard shard-000 \
  --max-credits 30 \
  --yes
node dist/index.js gate --manifest-file ./suite-selection.manifest.json --declared-shards ./suite-selection.declared-shards.json --json
```

Optional assessment YAML `selection` fields (`profile: smoke|release`,
`suite_version`, tags, `include_catalog`, requested/excluded case ids) are
compiled by the server. Local `test --local` still uses deterministic packets
only. Catalog counts are not a quote. `--all-shards` requires a finite
aggregate `--max-credits` and stops before exceeding consent. Resume an
unfinished multi-shard attempt with `--execution-id` using the original
workspace and connector; omit it after the attempt is terminal to start a new
rerun. A login switch between shards is `SELECTION_TENANT_MISMATCH` and does
not quote the next shard. Unbound `aw-selection-execution/2` and spent
`aw-selection-progress/1` files fail closed as `SELECTION_LEGACY_UNBOUND`
instead of inheriting the current login. An incomplete declared shard set
cannot make a whole-suite gate green. `gate --manifest-file`
requires `--declared-shards` covering every expected shard, POSTs identity
only, and exits 0 only for `aw-manifest-release-policy/2` with
`evidenceSource: server` and exact coverage.
