# Troubleshooting

Start with:

```bash
npx --yes @augmentworks/cli@0.3.8 doctor \
  -c augmentworks.yaml
```

`doctor` makes no target or cloud request and does
not check AugmentWorks authentication. `doctor --json` prints the same
diagnostics as a JSON object on stdout and does not log in or contact a
target. It is offline validation only. `run status` is not a full hosted
report; use `node dist/index.js run report <run-id> --json` for criterion
evidence. Example successful doctor output (illustrative):

```text
OK OFFLINE_CHECK_COMPLETE: No target hooks or cloud operations were invoked.
Doctor passed.
```

## Data scope and release gate

Hosted real-data quote and admission stay release-disabled
(`EXECUTION_RELEASE_UNAVAILABLE`) until a compatible published release is
enabled and an operator verifies it. While that gate is closed, use an
authorized, isolated synthetic or staging target and constructed test data. Do
not point a hosted run at a production system, and do not upload production,
customer, or regulated records.

`aw-packet/0.1` and `aw-suite/1` files still work. `aw-suite/2` still requires
`synthetic_only: false` and is not relabeled as synthetic. `aw-suite/3` and
`aw-packet/local-authorized-1` are explicit. Offline local execution stays
account-free and never contacts AugmentWorks. This package does not guess the
minimum published npm version for a later real-data release, and this text is
not legal approval. Packaged starters remain fictional.

## Common failures

### Config or `.env` is not found

Pass the config path explicitly. `.env` must be beside that file, not
necessarily in the current directory.

```bash
npx --yes @augmentworks/cli@0.3.8 doctor \
  -c ./config/augmentworks.yaml
```

### An environment variable is missing

Copy `.env.example` to `.env`, insert the value locally, and keep `.env` out of
source control. Do not replace an `_env` field in YAML with the secret itself.

### Plain HTTP is refused

Use HTTPS whenever possible. Loopback hosts and literal private IP targets may
use HTTP without an extra setting. A public HTTP target is refused unless the
configuration explicitly accepts the risk:

```yaml
allow_insecure_http: true
```

The CLI emits a warning even with this setting. Do not use it to normalize
sending credentials over an untrusted network.

### A response mapping is missing

Confirm that the target returns JSON and that selectors use the supported
`$.field.nested` subset. `doctor` does not execute lifecycle hooks. Preview
the production mapping against a synthetic fixture without starting a run:

```bash
node dist/index.js preview-mapping \
  -c augmentworks.yaml \
  --operation send \
  --fixture ./fixtures/send-response.json
```

The command reports missing selectors with their YAML path, omitted
allowlisted fields, redactions, and truncation. It does not print unselected
source objects. The preview is fixture-only and does not guarantee that future
responses are secret-free.

### The target is reachable in doctor but assessments fail

`doctor` does not call the target. `probe` prints a bounded plan;
`probe --yes` then checks authentication, selectors, optional session
identifiers, and cleanup against a synthetic payload. Doctor and init never
start a probe. A probe failure is an integration diagnostic, not a claim that
the chatbot missed a fact.

```bash
node dist/index.js probe -c augmentworks.yaml
node dist/index.js probe -c augmentworks.yaml --yes
```

### A local packet is not found or is refused

`test --local` accepts exactly one of:

- the bundled `support-refunds-starter@0.1.0` reference
- a local JSON file
- a local directory containing `packet.json`

It does not download packet references or accept URLs, YAML, JavaScript,
modules, symlinks, or executable instructions. Validate the expected data shape
with:

```bash
npx --yes @augmentworks/cli@0.3.8 schema --kind local-packet
```

An `aw-packet/0.1` packet must declare `synthetic_only: true`, remain within the
fixed attempt and operation limits, and use only capabilities and observation
keys available in `augmentworks.yaml`. Hybrid `aw-packet/0.2` packets and any
packet with `evaluation_mode: hybrid` or `llm_rubric` criteria fail with
`UNSUPPORTED_LOCAL_GRADER` before the target is contacted.

### `--assessment` requires an assessment file

This `@augmentworks/cli@0.3.8` package includes `--assessment`. `init` writes
`augmentworks.assessment.yaml` and starter references.
See `examples/response-agent/`. `--assessment` cannot be combined with `--local`.
If hosted grading is pending after target work, the exit code is `11`, not `0`.

### `LOCAL_PACKET_INCOMPATIBLE`

The packet requires a lifecycle capability that the target configuration does
not provide. Add only the required synthetic `prepare`, `observe`, or `cleanup`
mapping, enable structured tool events if required, and add every requested
observation alias to `telemetry.allow_observations`. A packet with
`required_capabilities.multi_turn` also needs
`target.conversation.strategy: explicit_session_v1` and
`$input.conversation_id` mapped on send. Run `doctor` again before starting the
assessment.

### `CONVERSATION_CAPABILITY_INCOMPATIBLE`

The selected packet requires multi-turn conversation, but this connector
advertises single-turn. Configure:

```yaml
target:
  conversation:
    strategy: explicit_session_v1
  operations:
    send:
      request:
        conversation_id: $input.conversation_id
```

No quote, reservation, or run is created. Correlation IDs are not a session.
`history_array_v1` is not implemented.

### `SESSION_CONVERSATION_ID_UNMAPPED` / `SESSION_STRATEGY_UNSUPPORTED`

`explicit_session_v1` requires an exact `$input.conversation_id` send mapping.
Do not map `attempt_id` as a substitute. Unknown or reserved strategies
(`history_array_v1`) are rejected. Mapping `conversation_id` without declaring
the session strategy is also rejected so the CLI cannot silently invent a
session field on an old target.

### `LOCAL_OUTPUT_EXISTS`

Local artifacts are never merged into or written over an existing directory.
Omit `--output-dir` to use a new `.augmentworks/runs/<run_id>` leaf, or select a
different path. `--output-dir` identifies the exact fresh leaf, not a parent in
which the CLI chooses another subdirectory.

### Does local mode require login or internet access?

No AugmentWorks login or control-plane access is used by `test --local`. The
configured target may still be an HTTP network service and may call a model or
other dependency. Local mode is independent of the AugmentWorks website; it is
not necessarily air-gapped.

### `login` cannot connect

Confirm outbound HTTPS access to `https://augmentworks.ai`, verify the system
clock, and retry browser authorization. Use `login --device` for an SSH or
headless machine, or `--no-open` to print the browser URL. Do not set
`AUGMENTWORKS_API_URL` to another hosted origin; hosted authentication accepts the production
origin or an explicit loopback development origin only.

### `AUTH_ENV_CONFLICT` or unexpected API-key identity

If `AUGMENTWORKS_API_KEY` and `AUGMENTWORKS_TOKEN` are both nonempty and differ,
the CLI exits `3` before contacting the network or opening a keychain. Unset
one of them. Equal values are treated as the same explicit API key.

Expired, revoked, or invalid workspace keys exit `3` with `API_KEY_REVOKED`.
Issue a new key at https://augmentworks.ai/portal/settings/api-keys. Do not
call `logout` from automation cleanup; logout revokes reusable workspace keys.
Headless CI without `AUGMENTWORKS_API_KEY` or `AUGMENTWORKS_TOKEN` exits `3`
with `AUTH_REQUIRED` and does not load a keychain. A machine key missing
`run:execute` exits `3` with `MACHINE_ACTION_DENIED` and does not quote.

`CHATBOT_API_KEY` authenticates only the synthetic target. Putting an
AugmentWorks API key in `bearer_env` will not authorize hosted report reads.

### `WORKSPACE_MISMATCH` or `WORKSPACE_CONFIG_CONFLICT`

`--workspace` and `AUGMENTWORKS_WORKSPACE_ID` select the company workspace a
hosted command may use. If both are set and differ, the CLI exits `2` with
`WORKSPACE_CONFIG_CONFLICT` before contacting the network. An invalid UUID is
`INVALID_WORKSPACE_ID` (exit `2`) and is never ignored.

If the resolved credential's `/auth/me` workspace does not match, the CLI exits
`3` with `WORKSPACE_MISMATCH` and prints safe expected/actual IDs. It does not
quote, upload, retarget a machine key, or fall back to another stored login.
Failed selected `login` leaves the previous origin slot unchanged. `test --local
--workspace` is `LOCAL_WORKSPACE_UNSUPPORTED` (exit `2`); the environment
variable is ignored in local mode.

### `CREDENTIAL_STORE_UNAVAILABLE`

On macOS, confirm that `/usr/bin/security` is present and the login Keychain is
available. On Windows, confirm that the built-in
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` is present and
that the current user owns the AugmentWorks directory under `%LOCALAPPDATA%`.
The Windows store refuses reparse points, foreign ownership, and broad or
inherited credential-file ACLs; move an old untrusted path aside and retry only
after investigating it. The CLI will not downgrade Windows credentials to a
plaintext file. On Linux or macOS without native storage, an explicit
`--allow-file-credentials` enables the warned mode-`0600` POSIX fallback.

### Login works, but the target returns 401 or 403

The AugmentWorks connector credential authenticates CLI-to-cloud requests only.
Check the target credential named by `bearer_env` or `headers_env` in the local
process environment or the `.env` file beside the selected YAML. Do not copy an
AugmentWorks access token into a target credential field.

### A target operation timed out

If the request may have reached the target and the operation is not declared
idempotent, the CLI records an indeterminate outcome rather than retrying. It
does not blindly repeat it. In hosted mode the relay may dispatch an appropriate
typed follow-up. In local mode the fixed lifecycle attempts observation after an
ambiguous send and cleanup whenever a fixture may exist. Check the target using
its synthetic attempt or fixture identifier.

### Cleanup failed

The assessment reports cleanup separately from requirement scoring. There is no
standalone hosted cleanup-recovery command; confirm whether the relay dispatched
cleanup, preserve the synthetic identifier for investigation, and rely on a
target-side fixture TTL as the final safeguard. Never silently treat a cleanup
failure as success.

In local mode cleanup failure has exit code `6`, takes precedence over assertion
status, and stops new attempts. A hard process or machine failure can prevent
the `finally` path from running, so a server-side fixture TTL is required even
when cleanup is idempotent.

### Local `test --local` was interrupted

The first Ctrl+C aborts the active non-cleanup operation, stops new attempts,
and drains cleanup before exiting with `130`. A second Ctrl+C exits immediately
and can leave a fixture behind. Local mode has no cloud run or restart journal;
inspect the target using the synthetic identifier and rely on its fixture TTL
if cleanup was not confirmed.

### Hosted `test` was interrupted

Re-run the exact same `test` command as the same OS user, authenticated connector,
and workspace on the same machine. The CLI retains one tenant-bound active intent
per AugmentWorks API origin, replays the same create ID and request, and resumes
the same run and command journal. A different connector or workspace is refused
with `ACTIVE_RUN_TENANT_MISMATCH` before create. A different packet or
configuration is refused with `ACTIVE_RUN_EXISTS` until the existing assessment
is recovered. Changing the resolved target base URL or an operation
method/path also changes the boundary checksum and is refused for that active run.
There is no `--rerun` flag and no force-new option.

Inspect the existing assessment without creating another run:

```bash
npx --yes @augmentworks/cli@0.3.8 recover
npx --yes @augmentworks/cli@0.3.8 recover --json
```

`--retire` retires a create only after the server proves it never became a run,
or retires local execution state after target execution is terminal and cleanup
is reconciled. It never cancels an active run. `--resume` continues the recorded
assessment after verifying the original configuration. `--cancel` requests
cancellation and drains cleanup. Those three flags are mutually exclusive. Do
not delete journal files, and there is no `--force-delete`.

### Multi-shard selection used another workspace or an old progress file

`test --all-shards` binds the local execution to one API origin, workspace, and
connector (`aw-selection-execution/3`). Resume the same `--execution-id` with
that original workspace. A later login, API-key, or connector switch is
`SELECTION_TENANT_MISMATCH` (JSON `code`, exit `3`) and does not quote, admit,
or call the target for another tenant. `--json` does not invent a verdict.

Spent `aw-selection-progress/1` files and unbound `aw-selection-execution/2`
documents are not rewritten with whichever user is logged in now. The CLI
returns `SELECTION_LEGACY_UNBOUND` (exit `2`), leaves the file unchanged, and
lists recorded original run IDs for authorized observation only. Start a new
execution only after you have reconciled those runs. Unused all-pending v1
progress may be marked migrated without charging.

This pinning ships in this `0.3.8` package. Independently inspected npm
`@augmentworks/cli@0.3.6` still persists unbound `/2` documents. Immutable
`0.3.7` is not overwritten by this patch.

If the hosted service does not yet support reconciliation, `recover` keeps local
state and reports that limitation. Re-running the same `test` command remains
the resume path while the create-replay window is open.

Recovery proceeds only if secure lock ownership can be positively established.
A same-host lock is reclaimable when its process is positively dead, including
on macOS or Windows where Linux boot/process metadata is unavailable. A
verifiable earlier boot or different process-start identity can also prove PID
reuse. The CLI refuses a verified live or foreign-host owner, unknown process
liveness/identity, unsafe permissions or symlinks, or a lock that changes during
inspection. Do not delete such a lock to force a run; investigate the owning
process and preserve recovery state.

Do not delete the active intent or journal to work around an ambiguous target
operation or incomplete cleanup. If local recovery state was lost or corrupted,
stop and reconcile the run and synthetic fixture through the dashboard or
support before attempting another assessment.

### `usage` cannot read billing

`usage` is in this 0.3.8 package. Run `node dist/index.js usage` from a clone
or `npx --yes @augmentworks/cli@0.3.8 usage` after install. The command uses the existing connector
credential (`connector:identity`) and does not need target YAML.

A server without `usage_v1` exits `13` with `USAGE_UNSUPPORTED`. That is not a
zero balance and does not grant or reserve credits. Revoked membership or a
missing `connector:identity` scope exit `3`. A missing application or billing
profile points at the first-party `/portal` recovery page; the CLI does not
create a replacement account. `--json` writes one structured error object on
stdout; human hints stay on stderr.

Hosted assessment quotes and admission use typed billing
codes rather than HTTP status guessing. `INSUFFICIENT_CREDITS`,
`QUOTE_EXPIRED`, `QUOTE_MISMATCH`, `BUDGET_EXCEEDED`, `UPDATE_REQUIRED`,
`WORKSPACE_CLOSING`, and `BILLING_UNAVAILABLE` exit `13`.
`MEMBERSHIP_REVOKED` exits `3`. `--estimate` never reserves credits.
Noninteractive hosted `--assessment` requires `--max-credits N`; `--yes` is
not an unlimited budget. After target work finishes, pending grading is
observed with `run wait <run-id>` / `run status <run-id>` on the original
run. Do not re-run the test command to resume grading. `run wait` keeps
polling while target execution is nonterminal even when evaluation is
`absent`. A successful HTTP status query is not a passing assessment: wait
and release gates must use process exit `0` only after an explicit resolved
`passed` outcome with complete required grading and known coverage. A
completed run with a null outcome exits `11`, never `0`. Timed-out waits stay
read-only and never create another quote, reservation, or run. Retry guidance
names the original run ID.

`compare` / `gate --run` POST `/v1/comparisons/evaluate` or
`/v1/release-gates/evaluate` for an explicit `--run` and `--baseline`.
They never quote, create, or retry a run. HTTP 200 with `decision: block`
exits `10` even when aggregate pass rates match. Pending judging, missing
coverage, and unknown server decisions exit `11`. Evaluator error exits
`12`. A missing pin exits `2`. Auth failures exit `3`. `--json` keeps
diagnostics on stderr. After an interrupt, re-query the original run ID;
do not substitute a newer run or auto-promote. `baseline promote` requires
`--expected-revision` and `baseline:promote`; a stale pin exits `4`.

`gate --manifest-file` POSTs identity-only
`aw-manifest-release-gate-request/2` to `/v1/release-gates/evaluate-manifest`.
Exit `0` requires an `aw-manifest-release-policy/2` receipt with
`evidenceSource: server`, `decision: pass`, complete coverage, and every
resolved shard terminal/completed/pass. Empty, non-executable, tampered, or
incomplete declarations fail locally (`MANIFEST_EMPTY`,
`MANIFEST_NOT_EXECUTABLE`, `MANIFEST_INTEGRITY_MISMATCH`,
`MANIFEST_DECLARATION_INCOMPLETE` / `DUPLICATE`) with no network. Legacy v1,
malformed, or mismatched receipts exit nonzero with
`MANIFEST_GATE_CONTRACT_UNSUPPORTED` or `MANIFEST_GATE_RESPONSE_MISMATCH`.
Do not fall back to a caller-authoritative v1 pass.

`run report <run-id> --json` exports one
`aw-run-report-export/1` document: `retrieved`, `complete`, `report`,
`criteria`, and `diagnostics`. Retrieval success is not grading success. An
expected failing assessment still exports mapped responses and criterion
details and exits `10`. Incomplete or truncated required evidence exits `11`.
A claimed pass whose completed required judgment is `fail`, a known aggregate
`failed` count above zero on that pass (`REPORT_EVIDENCE_CONTRADICTION`), or
coverage that claims completed attempts or finished required judgments the
export did not retrieve (`REPORT_COVERAGE_MISMATCH`) is also exit `11` and
cannot be used as a passing release check. Retry that same report read or
contact support. Do not start another billed assessment. The command never
quotes, creates, purchases, or regrades. It works with a report-only API key
at zero available credits.

`billing` prints or opens the first-party
`/portal/billing?workspace=` page. It does not create a Stripe Customer,
Checkout Session, refund, or subscription, and it does not cancel or
reactivate a plan. `--json` and `--print` do not open a browser.
Insufficient credits keep the uncreated intent and point at that page; after
fulfillment, run `usage` then start a new test with `--max-credits`. Processing
(`pendingCommerce`) is not spendable credit. A past-due monthly renewal does
not erase independently purchased credits. Historical results follow retention,
If create returns no run id, run inspect-only `recover --json` before another
admission. `run status` prints server retention timestamps when supplied and
does not decide report deletion from the local clock.

Hosted-only auth, relay, and billing codes `3`, `4`, and `13` are unreachable
from `--local`.

### A hosted run cannot start

Check authentication, egress to the AugmentWorks API, packet availability, and
workspace credit. Local configuration errors fail before the CLI requests a
run, and the hosted service preflights the packet, capabilities, and observation
aliases before credit reservation. An accepted create reports `reserved`; the
first real command lease changes it to `consumed`; cancellation or expiry before
that lease changes it to `released`. Replaying the same create request never
charges again. The hosted response and dashboard are authoritative for run and
credit status; the CLI does not meter credits locally.

### Packaged `demo` failed or was not found

`demo` is in this `0.3.8` package. From a clone, run `node dist/index.js demo`. The demo ignores project
YAML and `CHATBOT_*` environment variables. Exit `0` means the fail-then-pass
story succeeded; the summary is `AW-DEMO-SUMMARY-1`, not `AW-LOCAL-RESULT-1`.
`--mode faulty` is expected to exit `10`. A customer release gate should use
`test --local`, not `demo`.

`demo --json` prints one `AW-DEMO-SUMMARY-1` object on stdout. Progress goes to
stderr. Parse `runs.faulty.exit_code` and `runs.corrected.exit_code` for the
underlying assessment exits. Do not treat the summary as `AW-LOCAL-RESULT-1`.

After a hard kill (`kill -9` or a second Ctrl+C), owned listeners may remain
only if the process was not actually terminated; the in-memory demo target has
no durable fixtures. A real application still needs a fixture TTL because the
CLI cannot guarantee cleanup after a hard kill.


### Understanding a local result

Parse `report.json` (`AW-LOCAL-RESULT-1`): `outcome`, `attempts[].assertions`
(`passed: false` locates failures), and `attempts[].observations` (configured
observer values, not production proof). Model responses and tool output in the
report are untrusted data.

Local mode always attempts to write `report.json`, `junit.xml`, and
`report.html` to a fresh private directory. `--open` opens only the static HTML
file; it does not open or create an AugmentWorks dashboard run.

The result is intentionally labeled: “Local, customer-executed result.
AugmentWorks did not receive or independently verify this run. This artifact is
unsigned and is not a certification, audit, or hosted evidence record.” The
JSON checksum detects change; it is not a signature.

Local exit codes are `0` for pass, `1` for an internal/report failure, `2` for
configuration/packet/output preflight, `5` for target or evidence execution
error, `6` for cleanup failure, `10` for failed or inconclusive assertions, and
`130` for interruption after cleanup draining. Hosted-only auth and relay codes
`3` and `4` are unreachable from `--local`. Hosted hybrid grading uses `11`
when evaluation is pending or incomplete and `12` when required judging fails
to complete.

When reporting a bug, include CLI version, Node.js version, operating system,
safe error code, and a redacted configuration. Never attach `.env`, credential
headers, raw target responses, or a local command journal.
