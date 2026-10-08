# CLI QA instructions

This file is the generic QA guide for `jeffskafi/augmentworks-cli`. It is
documentation, not a product API and not a substitute for executing the
commands it lists.

Do **not** put campaign receipts, Linear identifiers, customer data, tokens,
mailbox contents, run IDs, or API keys in this public repository. Record
private evidence on the private tracker issue that owns the audit.

The main application's coverage map (owned by that repository's campaign
coordinator) should link here. This file does not replace
[hosted QA docs in the main repository](https://github.com/jeffskafi/augmentworks/blob/main/docs/qa/hosted-qa.md).

## Source build is not published; local is not hosted

| Lane | What it proves | What it does not prove |
| --- | --- | --- |
| **Source tree** | Behavior of *this checkout* after `npm ci && npm run build`, invoked as `node dist/index.js` | That npm has that version, that `npx` works, or that a customer install matches |
| **Packed / published** | The tarball `npx` would execute (packed smoke or an independently inspected registry version) | Source-tree green tests, or hosted grading |
| **Local** (`demo`, `test --local`, offline `doctor` / `schema` / `preview-mapping` / `probe`) | Customer-executed scoring or connector checks against *your* configured target. No AugmentWorks account required | Hosted dashboard evidence, LLM judging, or a certification |
| **Hosted** (`login`, `test` without `--local`, `run report`, billing) | Relayed assessment against the live control plane | Local packet oracle or an unpublished source SHA |
| **Browser** | Portal / session-door / consent UI owned by the main application | CLI stdout. This repo has no first-party web UI |

Package identity of a checkout is `package.json` (currently `0.3.8`). That
version string alone is not registry proof. The last independently inspected
npm tarball recorded in-tree is `@augmentworks/cli@0.3.7` in
`docs/feature-readiness/published-registry-evidence.json` (`gitHead`
`876454878a31a897aec1d722fa838c9c0ecea2aa`). Confirm with `npm view` before
treating a pin as installed. Never run `npx @augmentworks/cli@latest`.
`npx --yes` only skips the npm prompt; it is not a spending ceiling.

Local reports use schema `AW-LOCAL-RESULT-1`. They are unsigned,
customer-executed evidence. AugmentWorks did not receive or independently
verify them. They are not a certification, audit, or hosted evidence record.

Hosted reports use the vendored `aw-run-report` contracts. A hosted `exit 0`
is not a local packet pass, and a local `exit 0` is not a hosted grade.

## Secret segregation

Keep platform and target credentials in separate stores. Never paste real
values into YAML, command lines, tickets, or this file.

| Secret | Used by | Not used by |
| --- | --- | --- |
| `CHATBOT_BASE_URL`, `CHATBOT_API_KEY` (and other names referenced by `_env` fields) | Connector calls to the *target* | AugmentWorks login, billing, or hosted `test` |
| `AUGMENTWORKS_API_KEY` or the OS credential store from `login` | Hosted CLI → AugmentWorks API | `test --local`, `demo`, `doctor --offline` |
| Browser / session-door secrets | Main-repo hosted QA browser helper only | The CLI process |

Rules:

- YAML must reference **environment variable names**, not secret values.
  Literal secret-shaped fields are rejected (`LITERAL_SECRET_FORBIDDEN` or a
  schema error, exit `2`).
- Copy `.env.example` to a **task-local** `.env` beside the config. Do not
  commit `.env`.
- Fail closed on `AUGMENTWORKS_API_KEY` + `AUGMENTWORKS_TOKEN` conflict
  (`AUTH_ENV_CONFLICT`, exit `3`) before any network. Isolate those variables
  out of child processes when running local fixture tests.
- Do not log out or revoke a reusable daily/machine key as a test.
- Target placeholders such as `ci-synthetic-placeholder` are fine in fixtures;
  production or customer keys are not.

## Isolation and egress

1. **Install first.** Run `npm ci` (and any registry `npm view` you need)
   *before* denying egress. A blocked-network install is not a product defect.
2. Use an isolated checkout, `HOME`, task directory, output leaf, and
   loopback fixture. Do not reuse another worker's journals, keys, or
   `--output-dir`.
3. Point `CHATBOT_BASE_URL` at a **task-owned** loopback or fictional fixture.
   CI examples stay fabricated. A real assessment of customer records requires
   target-owner authority and a compatible published release; hosted real-data
   quote and admission stay release-disabled here. Do not copy third-party
   website selectors or commit customer production data.
4. Observe outbound calls (process wrapper, HTTP log, or `unshare --net` when
   the kernel allows it). If namespace isolation is denied, record
   **blocked** with the kernel error; do not treat that as a silent pass.
5. Offline commands (`schema`, `doctor --offline`, `preview-mapping`,
   `suite validate` / `preview` / `preflight`) must not call the target,
   hosted auth, billing, or a model. `probe` without `--yes` must not execute.
   `probe --yes` and `test --local` may call **only** the configured target.
6. Poisoned `AUGMENTWORKS_*` values and an unreachable cloud origin must not
   prevent a legitimate local run. `--workspace` is rejected in local mode
   (`LOCAL_WORKSPACE_UNSUPPORTED`, exit `2`). `AUGMENTWORKS_WORKSPACE_ID` is
   ignored for local execution.

## Expected CLI exits (record actuals)

Preserve these product codes separately from any harness taxonomy
(`PASS` / `PRODUCT_REGRESSION` / `BLOCKED_*`).

| Code | Typical local / offline meaning | Hosted-only (should not appear on a pure offline path) |
| --- | --- | --- |
| `0` | Local packet passed, or offline command succeeded | Hosted completed pass (`reportReady`) |
| `2` | Config / schema / output-path / local packet / `--workspace` on local | Invalid hosted selection before quote |
| `3` | — | Auth (`AUTH_REQUIRED`, `API_KEY_REVOKED`, `AUTH_ENV_CONFLICT`, …) |
| `4` | — | Relay / protocol |
| `5` | Target integration (`probe` failure, observation transport) | Target during hosted run |
| `6` | Cleanup failure; **no new attempts** after this | Cleanup during hosted run |
| `10` | Assessed local failure (packet oracle miss) | Assessed hosted failure |
| `11` | — | Incomplete / pending hosted evidence |
| `12` | — | Evaluator error |
| `13` | — | Billing |
| `130` | First interrupt (cancellation / drain). A second interrupt or `SIGKILL` may skip cleanup | Hosted interrupt |

A script that exits `0` with `releaseReady: false` / `launchReady: false` is
**not** launch success. Missing, skipped, or blocked evidence is never `pass`.

## Independent local lane (source tree)

Replace `<fresh-private-leaf>` with a directory that does not yet exist.
Do not reuse an output path.

```bash
npm ci
npm run build
npm test -- test/config test/connector test/commands test/local test/demo test/system

node dist/index.js --version
node dist/index.js schema --kind config
node dist/index.js schema --kind local-packet
node dist/index.js schema --kind local-result
node dist/index.js schema --kind customer-suite

node dist/index.js doctor --offline -c examples/basic-chat/augmentworks.yaml
node dist/index.js doctor --offline -c examples/refund-agent/augmentworks.yaml

# Suite files must be invoked from a tree that contains their references/.
node dist/index.js suite validate examples/customer-suites/faq-non-commerce.yaml
node dist/index.js suite preview examples/customer-suites/faq-non-commerce.yaml
node dist/index.js suite preflight examples/customer-suites/faq-non-commerce.yaml

node dist/index.js preview-mapping \
  -c examples/basic-chat/augmentworks.yaml \
  --operation send \
  --fixture <synthetic-fixture.json> \
  --json

node dist/index.js probe -c <owned-config>
node dist/index.js probe -c <owned-config> --yes --json   # owned loopback only

node dist/index.js demo --json --output-dir <fresh-private-leaf>

node dist/index.js test --local \
  -c <owned-config> \
  --packet support-refunds-starter@0.1.0 \
  --json \
  --output-dir <fresh-private-leaf>
```

Expect:

- `doctor --offline`: exit `0`, `OFFLINE_CHECK_COMPLETE`, no target/cloud calls.
- Missing env names: exit `2`, `ENV_REQUIRED`.
- Invalid YAML / unknown fields / oversize fixture: exit `2`.
- `preview-mapping`: fixture-only, `offline: true`, `credits_consumed: 0`.
  Hostile JSON is displayed as **data**; it is never executed as a command.
- `probe` without `--yes`: plan only (`executed: false`).
- `probe --yes`: bounded calls against the owned fixture;
  `hosted_contacted: false`; `credits_consumed: 0`. Access failure must be
  `failure_class=connection_refusal` (or equivalent), not a quality miss.
  A send that exceeds `operation_timeout_ms` must be classified as
  `failure_class=timeout` (`PROBE_TIMEOUT`), not a generic `target` class.
- `demo`: faulty underlying run exit `10`, corrected `0`, demo summary `0`.
- `test --local` on a correct fixture: exit `0`, `AW-LOCAL-RESULT-1`,
  `signed: false`, `cloud_contacted: false`.
- Faulty oracle: exit `10`. Cleanup failure: exit `6` and remaining attempts
  `not_run_after_cleanup_failure`. Interrupt: `130`. Hard kill: do not claim
  cleanup completed; remaining fixtures need a server-side TTL.
- Existing `--output-dir`: `LOCAL_OUTPUT_EXISTS` exit `2`. Symlink leaf:
  `LOCAL_OUTPUT_UNSAFE` exit `2`. POSIX modes: directory `0700`, files `0600`
  when the filesystem supports them. HTML must be script-free, with no
  external assets, and must escape untrusted text. JSON / HTML / JUnit must
  correspond (`result_sha256`).
- Packets: only strict `aw-packet/0.1`. Reject hybrid/LLM local grading,
  remote packet URLs, modules, and shell fields **before** target contact.

Cross-platform (macOS Keychain, Windows DPAPI, live Windows shells) is owned
by the CLI distribution/auth audit, not by repeating Linux local runs.

## Packed / published lane

From this repository, after a clean install:

```bash
npm run smoke:pack
```

Point nested packed fixtures at the **documented** packed binary
(`AUGMENTWORKS_PACKED_BIN` from `smoke:pack` / `AUGMENTWORKS_KEEP_SMOKE_TMP`),
not at `node dist/index.js` and not at `test:packed-billing-live` (that script
is not a normal offline check).

Independently inspect registry identity with `npm view` and compare
`gitHead` / `dist.integrity` / tarball SHA-256 to
`docs/feature-readiness/published-registry-evidence.json`. Source `0.3.8`
stays `pending-protected-publish` until the `v0.3.8` tarball is inspected.
That gap is not a local-runner pass.
Customer-facing `init` next steps on an npm install must not tell the user to
run `node dist/index.js` from an empty project.

## Hosted lane

Do not start a billed production assessment from this local guide. Exclusive
live admission, credit caps, and report completeness belong to the main
repository's hosted QA harness:

- [docs/qa/hosted-qa.md](https://github.com/jeffskafi/augmentworks/blob/main/docs/qa/hosted-qa.md)
  in `jeffskafi/augmentworks`

A missing hosted receipt is **blocked**, never a hidden pass. Read-only
`whoami` / usage and registry downloads are not a new assessment. Conflicting
API-key env vars must fail before network. `--estimate` must not reserve or
create a run.

## Browser lane

This CLI has no portal. Browser, 390px, session-door, and consent coverage
live in the main application. CLI `login` may bind a temporary `127.0.0.1`
callback; `login --device` avoids it. Do not treat Playwright `/dev` fixtures
as deployed, mobile, Safari, or real-auth coverage.

## Field-safe receipt template

Use contract name `aw-one-time-qa/1` on the **private** tracker issue (not in
git). Sanitize before posting.

```text
campaign_id:
scope_id:
issue_url:                # private tracker only
started_at / finished_at: # UTC
main_sha:
cli_sha:
deployment.origin / sha:  # or null
artifact.source / version / integrity
cases[]:
  id, requirement, environment (local_fixture|local_real_db|preview|production),
  status (pass|fail|blocked|not_run|not_applicable),
  expected, observed, evidence_refs, bug_issue|null
counts: required = passed + failed + blocked + not_run
        (not_applicable listed separately)
overall: PASS | PRODUCT_REGRESSION | FIXTURE_OR_PROVIDER_FAILURE |
         BLOCKED_SETUP | BLOCKED_COMPATIBILITY | BLOCKED_BUDGET |
         BLOCKED_AUTH_CHALLENGE | INCOMPLETE
cleanup:
limitations:
```

Omit credentials, auth URLs, cookies, mailbox text, raw transcripts, and
unredacted target bodies. Keep CLI exit codes distinct from overall.

## Filing product bugs

For each demonstrated product defect, file during the audit (do not only
recommend a ticket):

1. Search existing issues by repository + component + violated invariant
   (exclude timestamps and run IDs). Reuse when the fingerprint matches.
2. New tickets stay **Backlog**, unassigned, with no Cursor delegate and no
   `agent-ready` label. QA may file; it must not auto-dispatch a fix.
   Creation plus `Todo` plus `agent-ready` is what launches implementation —
   do not apply that combination to a bug you are only recording.
3. Title shape: `[QA bug][CLI] <specific observed failure>`. Labels: Bug and
   the CLI repo label. Include fingerprint, source SHA, expected vs actual,
   owned loopback steps, severity rationale, and retest acceptance.
4. Setup/provider/budget misses get an exact missing prerequisite, not a
   fake product bug.

Do not change product code, tests, or CI to make a QA row pass. Do not add
tests whose only purpose is to mirror this Markdown.
