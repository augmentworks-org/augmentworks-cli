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

`aw-suite/3` / `aw-customer-suite/3` run hosted tests with real data. Instead
of `synthetic_only` / `live_target`, the file names an `execution_scope` that
the server created for a registered, verified target. Offline validate,
preview, and preflight accept the format. Hosted quote and create need that
scope; see [Real-data suites](#real-data-suites-aw-suite3) below. If the
server isn't accepting real-data tests, the run stops with
`EXECUTION_RELEASE_UNAVAILABLE` before anything is sent to your agent. Unknown
schema versions fail closed and are never downgraded to synthetic. Local
authorized packets use `aw-packet/local-authorized-1`, stay account-free, and
cannot be presented as hosted authority.

Older `aw-suite/1` / `aw-packet/0.1` files still work and remain synthetic.
`aw-suite/2` live-informational files still require `synthetic_only: false`.
Real-data suites need CLI 0.4.0 or newer. Packaged examples in this document
are fictional. This text is not legal approval. Do not set
`synthetic_only: true` on a live or authorized document, grant `suite:write`
to a machine key, or test a third party without authority.

The command exists in this `0.4.0` package. Native hosted
`aw-customer-suite/1` upload translation shipped in immutable npm `0.3.7`
and is not in immutable registry `0.3.6`. From this clone after `npm ci` and
`npm run build`, use `node dist/index.js`. Pin `@augmentworks/cli@0.4.0`
after the protected `v0.4.0` publish. Do not assume registry `0.3.6`
contains the upload translation, and do not overwrite `0.3.9`, `0.3.8` or `0.3.7`.

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

## Real-data suites (`aw-suite/3`)

A real-data suite runs against your own agent, with the data your test cases
contain. Register only agents your workspace owns or operates, or has
written permission to test. Setup is four commands, run once by a workspace
owner from the directory that holds `augmentworks.yaml`. Machine keys
(`AUGMENTWORKS_API_KEY`) can't do setup; unset the key and run
`augmentworks login` first. Each step can also be done in the portal under
Settings → Targets.

```bash
augmentworks target add --env production
augmentworks target verify <name>
augmentworks scope create --target <name> --suite refunds.suite.yaml --data-origin customer_records
augmentworks test --suite refunds.suite.yaml --max-credits 30 --yes
```

1. **`target add`** registers the agent in `augmentworks.yaml`: its name
   (`target.name`), its address (`target.base_url`), and the endpoints its
   operations call. It asks whose agent it is (`--attest owned`, or
   `--attest written --permission-ref <ref>` for written permission). The
   first time, it shows the workspace's real-data statement and needs a typed
   `yes` from an owner; in CI it stops and points to Settings → Targets
   instead. `--method https|dns` picks how the address is verified. The
   method can't be changed after registration.
2. **`target verify <name>`** prints a code to publish, either as a file at
   `/.well-known/augmentworks-target` on the agent's address or as a DNS TXT
   record at `_augmentworks-target.<host>`. It checks every 15 seconds and
   finishes once the server confirms the code. Run it again to resume with
   the same code. A private or loopback address is confirmed from your
   machine with one connection check instead, recorded as your statement.
   Verification lasts 90 days from registration. Renewal opens 14 days
   before it ends: start it in Settings → Targets, then finish with the same
   command.
3. **`scope create`** creates a test scope for the verified target and writes
   its id and revision into the suite file's `execution_scope` block. It
   shows the data policy, data origin (`--data-origin
   constructed|customer_records|mixed`), expiry (30 days by default, never
   past the target's verification) and per-run budget first, and asks before
   creating it. The budget is sized to one run of the suite: one message per
   turn of each repetition, one credit per attempt. Only the scope id and
   revision in the file change. Use `--data-origin customer_records` (or
   `mixed`) when the cases hold real records.
4. **`test --suite`** runs the suite under that scope with the usual quote
   and `--max-credits` consent.

`target list` shows each target's status, verification expiry and scopes,
and warns when a scope expires within 7 days (`--suite <file>` checks the
scope that file uses). `target pull <name>` brings a target someone added in
the portal into `augmentworks.yaml`. It changes only the name, `base_url` and
a missing `send` operation. A new file gets `FILL_IN` placeholders that
`doctor` reports until you replace them.

The scope block in the suite file looks like this:

```yaml
schema_version: aw-suite/3
execution_scope:
  schema_version: aw-execution-scope/1
  scope_id: 77777777-7777-4777-8777-777777777777
  revision: 1
```

### Rules the CLI enforces

- `aw-suite/3` requires `execution_scope` and rejects `synthetic_only` and
  `live_target`.
- The scope is fetched from the server for every run. The CLI never builds
  authority from the YAML, and a scope that is expired, revoked, or for a
  different workspace stops the run before anything is sent.
- `target.base_url` must point at the address the target was registered with.
  A loopback address is transport only and can't stand in for a registered
  public address. A target registered at a private or loopback address runs
  real-data tests once `target verify` confirmed it from your machine
  (connector challenge).
- Every configured operation must call a registered endpoint (same method
  and path). Real-data runs check replies only: `scope create` refuses a
  suite whose cases declare `observations`, and a configured `prepare` or
  `cleanup` stops the run with `ACTION_NOT_ALLOWED`.
- Each run gets the scope's budget of messages, commands and time. A run
  whose plan needs more is refused before anything is sent. Spending is set
  per run by the quote and `--max-credits`, as for any hosted test. A run that
  stops partway isn't retried, because a retry could message your agent
  again.
- **Local scopes** (`aw-packet/local-authorized-1`) carry only a target
  boundary hash. The CLI rebuilds the boundary from `augmentworks.yaml` (the
  `base_url` origin and each operation's method and path) and the result must
  hash to exactly that value. Change the address or an operation, and the
  packet stops with `TARGET_SCOPE_MISMATCH` until you restore them or get a
  new packet.

Every error in this flow says what happened, then what to do, with the code
last: `Error: <message> (<CODE>)`.

Controlled actions, runs started from the dashboard, and a standing
`augmentworks connect` session are not available. Hosted `test` keeps the
connector online only for the run it starts.

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
