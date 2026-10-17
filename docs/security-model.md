# Security model

This document defines the v0.2 security boundary. Hosted and local execution
share the same deterministic connector but have different trust claims. In
hosted mode the cloud selects a bounded semantic operation and the user's
configuration alone selects how it reaches the application. In local mode a
strict customer-supplied JSON packet selects the bounded operation sequence and
no AugmentWorks service is contacted.

## Assets

- Revocable AugmentWorks connector credentials
- Customer application credentials in the local environment
- Synthetic fixture identifiers and state
- Scenario messages, tool events, observations, and scored evidence
- Hosted private packet branches, assertions, and scorer implementation
- Customer-visible local packets and unsigned local reports
- Hosted active-run intent, command journal, and local configuration

## Trust boundaries

| Component | Trust assumption | May control |
| --- | --- | --- |
| Hosted control plane and relay | Delivers authenticated, versioned operation envelopes | Packet selection, typed input, order, deadline, cancellation |
| Local CLI | Customer-operated trusted computing boundary | Config resolution, credentials, URLs, mappings, target calls, allowlisting |
| Customer target | Potentially buggy or adversarial | Its responses and observed state |
| Hosted scorer | Trusted for packet logic and scoring | Assertions, findings, dashboard result |
| Local packet and scorer | Customer-controlled execution boundary | Visible scenarios, deterministic assertions, unsigned reports |

The hosted relay must never choose a URL, HTTP method, header, environment
variable, file, module, or shell command. Unknown fields and operation kinds are
refused.

## Hosted transport and command safety

- During assessment execution, the CLI initiates all cloud communication over
  outbound HTTPS. No inbound access to the target, public target URL, or tunnel
  is required. The default browser login separately uses a temporary
  `127.0.0.1` callback listener; `login --device` avoids that callback.
- The only runtime capabilities are `prepare`, `send`, `observe`, and `cleanup`.
- Envelopes are authenticated and include protocol version, command ID,
  sequence, lease/fencing epoch, issue/expiry time, and idempotency key.
- At-least-once delivery is handled by an owner-only local journal. A duplicate
  command with a durable terminal result returns that result; a conflicting
  replay fails. An unfinished operation executes again only when explicitly
  declared idempotent.
- Run creation has a durable idempotency key. Before the create POST, the CLI
  resolves `/api/v1/cli/auth/me` and writes one active intent per API origin,
  bound to that workspace and connector. It replays the exact request after a
  restart and refuses a different tenant or active request before create. There
  is no force-new bypass.
- Commands received after their expiry or under an old fencing epoch are not
  executed.
- Cancellation fences new work but permits cleanup for a fixture that may have
  been created.
- An ambiguous outcome for any operation that is not explicitly idempotent is
  marked indeterminate rather than blindly retried. Observation or cleanup runs
  only if the relay dispatches those typed follow-ups.
- Whole-suite `gate --manifest-file` sends identity-only v2 fields and does
  not follow redirects with the bearer. Local preflight is network-free and
  does not load API credentials. Diagnostics omit Authorization, cookies,
  target URLs, manifest bodies, and raw server payloads.

## Customer-executed local mode

`test --local` branches before AugmentWorks API-origin resolution,
authentication, cloud client creation, active-run intent state, relay polling,
command journals, and dashboard handling. It requires no AugmentWorks account
and contacts no AugmentWorks control-plane endpoint. The configured target may
still be remote and may itself call models or other network dependencies, so
“local” is not a promise of an air-gapped assessment.

Local packets are strict bounded JSON with `schema_version: "aw-packet/0.1"`.
The CLI accepts the bundled `support-refunds-starter@0.1.0`, a local JSON file,
or a local directory containing `packet.json`. It refuses packet URLs,
downloads, symbolic-link traversal, executable code, modules, shell
instructions, unknown fields, excessive nesting, and packets whose attempt or
operation counts exceed fixed limits.

Attempts execute serially. Cleanup runs in a `finally` path whenever a fixture
may exist, and a cleanup failure stops subsequent attempts. The first Ctrl+C
requests cancellation, aborts non-cleanup work, and drains cleanup; a second
interrupt exits immediately. A process crash, machine failure, `SIGKILL`, or
second interrupt can prevent cleanup. Lifecycle hooks that create or mutate fixtures must therefore be scoped to
data the customer is authorized to change, cleanup must be idempotent, and
fixtures need a server-side TTL independent of the CLI. The packaged starter
uses isolated synthetic data. The CLI stops new target work at a
30-minute local run deadline while still allowing bounded cleanup to drain.

Local mode writes `report.json`, `junit.xml`, and a script-free static
`report.html` to a fresh exact output directory. It refuses to merge into or
overwrite an existing leaf. POSIX output directories use mode `0700` and files
use mode `0600`. Artifact generation re-applies secret redaction and strips
target-boundary fields, but reports still contain prompts, mapped evidence, and
observations and must be treated as sensitive.

Every local artifact carries this trust label:

> Local, customer-executed result. AugmentWorks did not receive or independently verify this run. This artifact is unsigned and is not a certification, audit, or hosted evidence record.

The `AW-LOCAL-RESULT-1` JSON checksum detects a changed result when compared
with the original; it is unkeyed, is not a signature, and does not establish
provenance. Importing the JUnit file into another system cannot upgrade that
trust claim.

## Target request controls

- `base_url`, fixed operation paths, methods, and credential sources come only
  from the local YAML.
- Hosted run creation sends an unkeyed checksum of the resolved connector/base-URL and
  operation method/path boundary. The raw URL and paths remain local, and
  credentials, environment-variable names, selectors, bodies, limits,
  telemetry, and target state are excluded. The checksum binds restart drift;
  it is not target identity, ownership, code, state, or execution proof.
- The v1 connector uses a data-only mapping language. There is no JavaScript,
  eval, shell, plugin/module loading, or full JSONPath engine.
- All target redirects are refused. Response size, request size, nesting, event
  count, and operation duration are bounded.
- Plain HTTP is accepted automatically only for loopback and literal private IP
  targets. A public plain-HTTP target requires explicit `allow_insecure_http`
  and emits a warning; HTTPS remains strongly recommended.
- Target errors are converted to stable safe codes. Response bodies and headers
  are not copied into diagnostics without redaction and bounds.

The connector deliberately permits localhost and private addresses because
that is the product capability. This means the configuration author is a
trusted local principal. Neither a cloud command nor a local packet can alter
the configured endpoint.

## Credentials

- AugmentWorks interactive credentials use the macOS login Keychain, Windows
  CurrentUser DPAPI, or Linux Secret Service when supported. macOS and Windows
  save secrets to native helpers through stdin rather than command-line
  arguments. The
  Windows DPAPI file has an origin-bound entropy value and a protected
  current-user/Local-System ACL; foreign ownership, reparse points, inherited
  or broad ACLs, and invalid ciphertext fail closed.
- A POSIX file fallback requires explicit `--allow-file-credentials`, emits a
  warning, refuses symlinks, and enforces mode `0600`. Plaintext fallback is
  disabled on Windows because POSIX modes do not establish Windows ACL safety.
- `AUGMENTWORKS_API_KEY` is explicit noninteractive workspace-key mode.
  It never loads a native keychain, file store, browser/device login,
  or refresh token, and it does not persist credentials. Differing nonempty
  `AUGMENTWORKS_API_KEY` and `AUGMENTWORKS_TOKEN` values fail before network
  access.
- Hosted commands accept `--workspace` / `AUGMENTWORKS_WORKSPACE_ID`. A
  credential that resolves to a different workspace fails `WORKSPACE_MISMATCH`
  before the first tenant request. The CLI does not retarget machine keys or
  fall back to another stored login. Local commands ignore the environment
  variable and reject `--workspace`.
- `AUGMENTWORKS_TOKEN` is reserved for connector tokens and development
  integration harnesses when API-key mode is absent; the v0.1 interactive auth
  service does not issue a long-lived CI credential. Prefer a workspace API
  key for unattended hosted CI and report export. Do not run `logout` as routine automation
  cleanup; it revokes reusable credentials.
- GitHub Actions hosted CI uses `docs/examples/github-actions-hosted.yml`:
  one scoped `AUGMENTWORKS_API_KEY`, expected `AUGMENTWORKS_WORKSPACE_ID`,
  `--headless`, a finite `--max-credits`
  ceiling, and `gate` on the original run. Fork pull requests skip
  secret-bearing jobs. Do not use `pull_request_target`. Machine keys must not
  purchase credits or administer the workspace. Summaries and uploaded
  artifacts omit credentials, private target URLs, and excluded evidence.
- Customer target credentials are named, not embedded, in YAML and are resolved
  from the local environment.
- Tokens are never accepted as command-line flags, included in config digests,
  written to the command journal, or intentionally returned as evidence.
- Redaction covers exact configured secret values and common credential header
  names. It is defense in depth, not permission to send arbitrary logs.

## Data minimization

In hosted mode, only mapped content, allowed structured tool events, and
explicitly allowlisted observation fields can leave the local connector. Run
preflight also sends the
target display name, secret-free configuration and boundary checksums, declared
capabilities, and sorted public observation-key aliases. It does not send raw
target URLs or paths, local selectors, environment-variable names or values,
complete HTTP headers, arbitrary target responses, filesystem contents, or
application logs.

In local mode no evidence leaves for AugmentWorks. The same mappings and
allowlists bound what the deterministic scorer can consume and what local
reports can contain. The configured target remains a separate network boundary.

The following table describes hosted mode:

| Stays in the customer environment | Exchanged with AugmentWorks |
| --- | --- |
| Raw target URL and operation paths, mapping selectors, environment-variable names and values, target credentials, application code and logs, full fixture state, and unmapped responses | Packet inputs, target display name, secret-free checksums, declared capabilities, observation-key aliases, mapped assistant content, opted-in tool events, allowlisted observations, safe errors, and lifecycle status/timing |

A checksum can detect configuration drift or a conflicting replay. It does not
identify the target, reveal its raw boundary, or establish that returned
evidence is true.

Executed scenario prompts and fixture inputs necessarily reach the local CLI
and target. Therefore the complete assessment packet cannot be considered
secret from a connector that executes it. The hosted service can retain
undispatched branches, assertions, scorer logic, and comparative data; a local
packet and all of its assertions are necessarily visible to the customer.

Test your chatbot with your questions and business rules. Hosted real-data
tests run only against a target your workspace registered and verified, under
a test scope: a workspace owner runs `augmentworks target add` and
`augmentworks target verify <name>`, then `augmentworks scope create` writes
the scope into an `aw-suite/3` suite that `augmentworks test --suite` runs.
Register only agents your workspace owns or operates, or has written
permission to test. If the server isn't accepting real-data tests, the run
stops with `EXECUTION_RELEASE_UNAVAILABLE` before anything is sent to your
agent. Hosted runs without a scope use an authorized, isolated synthetic or
staging target and constructed test data. Do not point a
hosted run without a scope at a production system. Secrets, PHI, payment-card
credentials, and other separately restricted data stay out of evaluation
content. This text is not legal approval and does not claim SOC 2, HIPAA, or
Zero Data Retention. Logs and evidence should be treated as sensitive even
after allowlisting.

### Outbound data policy

When a frozen `aw-data-policy/1` document and bound `aw-redaction-profile/1`
are supplied, the CLI projects content through
`inspectOutbound(document, policy, profile, localSecrets)` before a mapping
preview hashes evidence, before a journal append, and before local report
files are written. For a hosted real-data run, the policy and profile come from
the server-created test scope, never from local YAML.

Credentials are excluded in both `minimized` and `verbatim` content handling.
Verbatim may retain expressly permitted personal fields; it is not a license
to export secrets. Typed placeholders (`[REDACTED:credential]` and related
forms) are not universal anonymization. Structural identifiers, protocol
enums, and hashes are not rewritten just because a local secret string equals
a status such as `passed`.

Receipts record policy/profile hashes, the hash of the **retained**
representation, counts, and outcome. They never include raw detected values,
pseudonym reversal maps, or raw-content fingerprints. Evidence offsets use
Unicode code points of that retained representation. If masking removes a
decisive expected fact, the criterion is insufficient evidence rather than a
placeholder pass.

Local `report.json` / `junit.xml` / `report.html` files and relay journals are
customer-controlled. A hosted purge cannot delete them. A safe local content
cleanup hook, when the executor exposes it, deletes only owned content files
under the state directory. It does not delete arbitrary working directories,
run-intent recovery state, or journal locks. Use `recover` for execution
recovery.

## Evidence integrity and truth

The CLI uses unkeyed SHA-256 digests as replay checksums. Comparing them with an
already-durable local or relay record detects a conflicting command or result;
it does not prove evidence provenance or make the evidence independently
tamper-evident. HTTPS authenticates the transport endpoint, not a later evidence
artifact. The hosted relay associates accepted results with the authenticated connector,
session, run, packet, configuration boundary, and command order. That
server-side association records what the connector reported; it is not a target
signature and does not independently verify the underlying observation.

Even a separately authenticated evidence record would **not** turn
customer-operated code into an independent observer. A target or observation
hook can be buggy or dishonest. Such a record could bind what that connector
reported, but could not prove that it matches production or an external system
of record. Missing or failed configured state observation produces `unknown`, never an
inferred success from chatbot text.

A local result has a separate `AW-LOCAL-RESULT-1` schema and explicit
customer-executed provenance fields. It is never a hosted evidence record and
must not be relabeled as one. Local scoring can be reproducible without being
independent: the customer controls the packet, target, observer, process, and
result files.

## Operational safeguards

- Hosted real-data runs need a registered, verified target and a test scope
  created by a workspace owner. Hosted runs without a scope use an
  authorized, isolated synthetic or staging target and constructed test
  data. Offline `aw-packet/0.1` stays synthetic-only and
  account-free. `aw-packet/local-authorized-1` never contacts AugmentWorks and
  is not hosted authority.
- `doctor` performs no lifecycle operation and consumes no assessment credit.
- `preview-mapping` applies the same production mapping and redaction pipeline
  to a caller-supplied synthetic JSON fixture. It reads only that fixture and
  the selected config, makes no network call, and consumes no credit. It is
  not a secret-detection guarantee. When a data policy is supplied to the
  preview service, the report can include effective policy, retained-field
  counts, and a data-handling receipt without printing original matches.
- Hosted `test` is the explicit action that starts a hosted assessment and
  keeps the connector online for that run. The dashboard can observe or request
  cancellation, but cannot start an assessment. There is no v0.2 `connect`
  command, and the dashboard cannot send arbitrary work, URLs, or shell
  instructions.
- `test --local` is a separate explicit action. It creates no cloud run, uses no
  interactive connector credential or credit, and produces only customer-held
  artifacts.
- Cleanup should be idempotent, and target fixtures should have a server-side
  TTL as a final orphan safeguard.
- Hosted active intents and command journals are bounded regular files with mode
  `0600` where POSIX permissions apply. They contain secret-free run bindings
  and normalized, redacted operation evidence rather than connector
  credentials.
- After an authoritative terminal **target execution** status, the CLI removes the active intent and
  purges the journal only when every command is acknowledged and no prepared
  fixture remains. Pending grading is not an active target slot. Interruption, an unavailable terminal status, unacknowledged
  evidence, or incomplete cleanup intentionally retains recovery state. There
  is no time-based retention job; protect these files and do not remove them
  until the run and any synthetic fixture are resolved. Use `recover` rather
  than deleting the journal.
- Recovery is same-machine and state-directory scoped. Losing that state can
  make a prior create or target side effect impossible to distinguish safely;
  the hosted runner will not invent a new run to bypass the ambiguity.
- The controlled-action intent ledger is a current-user directory (POSIX mode `0700`)
  of regular intent files (POSIX mode `0600`). It stores resource bindings, permits,
  and exact receipt bytes. Symlinks, non-regular paths, and other users' paths are
  refused without reading them. Its lock uses the same positive-ownership rule as
  run recovery; a dead owner's lock can be reclaimed, and a live or unreadable
  owner cannot.
- Recovery also requires positive lock ownership. On the same host, the CLI
  reclaims a lock after its recorded process is positively dead even when Linux
  boot/process metadata is unavailable. A verifiable prior boot or different
  process-start identity also proves that a reused live PID is not the owner.
  The current process's own live PID remains a verified owner when the platform
  cannot provide process-start metadata; it is never guessed stale or treated
  as ambiguous merely because `/proc` is unavailable.
  The CLI then rechecks the unchanged directory, owner-file identity, and nonce.
  A verified live owner, unknown liveness/identity, foreign host, symlink,
  permission-unsafe path, or changed lock is refused rather than guessed stale.

## Known limitations

- A compromised local machine can read local configuration, credentials, and
  test inputs.
- A malicious configuration author can intentionally target an internal
  service available to that machine.
- Telemetry mapping cannot make an untrustworthy target truthful.
- Redaction cannot reliably sanitize an arbitrary unbounded log stream, which
  is why arbitrary logs are not accepted.
- Credential and field masking is defense in depth, not a claim that a
  retained representation is anonymous.
- Availability of a private target depends on the customer network and process.

Report vulnerabilities using [SECURITY.md](../SECURITY.md).
