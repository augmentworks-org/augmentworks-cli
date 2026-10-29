# Relay protocol `aw-relay/0.1`

The relay protocol connects a hosted assessment to one explicitly started local
CLI process. Delivery is outbound HTTPS and at least once. Operation inputs are
typed; transport messages cannot contain target URLs, HTTP methods, headers,
environment-variable names, files, modules, or shell instructions.

This document is the v0.1 contract implemented by the CLI and relay service
code, plus the `aw-relay/0.2` create-run assessment extension and this
package's quoted `aw-relay/0.3` create.
Repository integration tests exercise the same envelope and binding rules
against local services.

This protocol applies only to hosted `test`. `test --local` branches before
authentication, run-intent state, cloud clients, relay polling, command
journals, and dashboard handling. It loads a strict local JSON packet and calls
only the target selected by `augmentworks.yaml`; no `aw-relay/0.1` or
`aw-relay/0.2` message or AugmentWorks control-plane request exists in that
mode. Hybrid local packets are refused before any target call.

## Versions

- Cloud envelopes use `protocol_version: "aw-relay/0.1"` for legacy `--packet`
  runs such as `support-refunds@0.1.0`.
- Hosted `--assessment` / hybrid / expanded plans on `aw-relay/0.2` accept
  command sequence 101–512 only on 0.2.
- This package's quoted hosted `--assessment` uses `aw-relay/0.3` create with
  `quote_id` and optional `max_credits`. Command polling stays on 0.1/0.2.
  Do not send those fields through an unchanged 0.1/0.2 object.
- Normalized target operation inputs and results use
  `protocol_version: "aw-target/0.1"`.
- Unknown versions, fields, and operation variants are rejected.
- Published `@augmentworks/cli@0.2.0` speaks `aw-relay/0.1` only.
- Published `@augmentworks/cli@0.3.2` speaks `aw-relay/0.1` and `0.2`.
  After server cutover, new billed work from that package receives
  `UPDATE_REQUIRED`.

## Run lifecycle

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> connected
    connected --> running
    running --> completed
    running --> failed
    running --> cancel_requested
    cancel_requested --> cancelled
    queued --> failed
```

Valid statuses are `queued`, `connected`, `running`, `cancel_requested`,
`cancelled`, `completed`, and `failed`. A terminal status cannot return to an
active state.

## HTTP surface

All endpoints require a connector bearer credential and bounded JSON. The
client sends its version in `X-AugmentWorks-CLI-Version` and refuses redirects.

| Method and path | Purpose |
| --- | --- |
| `POST /v1/relay/runs` | Create or replay one run for a packet/config binding |
| `POST /v1/relay/run-intents:reconcile` | Authoritative create-key lookup, binding past replay, and optional uncreated-key retirement (`aw-run-intent-reconcile/0.1`) |
| `POST /v1/relay/sessions/{session_id}/commands:poll` | Long-poll after the last accepted sequence |
| `POST /v1/relay/commands/{command_id}:complete` | Commit a normalized successful result |
| `POST /v1/relay/commands/{command_id}:fail` | Commit a safe failure or indeterminate outcome |
| `GET /v1/relay/runs/{run_id}` | Read terminal status/outcome |
| `GET /v1/relay/runs/{runId}/report` | Read the pinned hosted report (`aw-run-report/1`). GET only; refuses off-origin links and redirects with the bearer |
| `GET /v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria` | Criterion index/detail (`aw-criterion-detail-read/1`); `/api/v1` alias exists |
| `GET /v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria/{criterionId}/investigation` | Read a saved investigation (`aw-investigation-export/1`). Observation only; `createsBillableRun` must be false |
| `POST /v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria/{criterionId}/investigation` | Export the same investigation for the exact run/evaluation/attempt/criterion. Does not start a run |
| `POST /v1/relay/runs/{run_id}:cancel` | Request cancellation and fence new work |
| `GET /v1/billing/capabilities` | Discover implemented billing read capabilities |
| `GET /v1/billing/usage` | Read the workspace execution-credit snapshot |
| `GET /v1/applications` | List application/environment/baseline identities. Observation only; `createsBillableRun` must be false |
| `POST /v1/comparisons/evaluate` | Authoritative semantic comparison over an explicit candidate run and baseline pin (`aw-comparison/1` request) |
| `POST /v1/release-gates/evaluate` | Versioned release-policy decision (`aw-release-policy/1`). HTTP success is not a pass |
| `POST /v1/release-gates/evaluate-manifest` | Whole-suite identity-only gate (`aw-manifest-release-gate-request/2` → `aw-manifest-release-policy/2`). `/api/v1` alias exists; this CLI uses `/v1`. Exit 0 only for a server-authoritative exact-coverage pass. Legacy v1 never passes |
| `POST /v1/baselines/{baselineId}/promote` | Explicit authorized baseline promotion with `expectedPromotionRevision`. Never automatic |

`usage` and `billing` GET those billing paths only. They never call create,
reserve, grant, quote, Checkout, or the target. `billing` prints or opens the
server `billingPageUrl` after `billing_portal_link_v1` is advertised. Server
aliases under `/api/v1/billing/*` exist; this CLI uses the primary
`/v1/billing/*` paths.

`compare`, `gate`, and `baseline status` POST/GET the comparison and
application paths only. They never call `POST /v1/relay/runs`, quote,
reservation, or retry-evaluation. `--json` writes one object on stdout;
diagnostics stay on stderr. Process exit follows the server `decision`, not
transport success. Unknown or unsupported policy states exit `11`, never `0`.
Whole-suite `gate --manifest-file` additionally requires a v2 server
receipt; a generic pass or v1 policy document is `MANIFEST_GATE_CONTRACT_UNSUPPORTED`.

`investigation inspect` and `investigation fetch` validate
`aw-investigation-export/1` without quoting or executing a target. Copied
command fragments are data. `test --investigation` GETs the pinned suite
revision, then uses a new quote and `--max-credits` consent. It never selects
`/revisions/latest` or reuses a consumed quote.

The corresponding authentication endpoints are documented in
[authentication.md](authentication.md).

## Create a run

Request:

```json
{
  "protocol_version": "aw-relay/0.1",
  "create_request_id": "crq_0123456789abcdefghijklmnop",
  "packet": { "key": "support-refunds", "version": "0.1.0" },
  "config_sha256": "1111111111111111111111111111111111111111111111111111111111111111",
  "target": {
    "name": "refunds-staging",
    "boundary_sha256": "eaf7c8fed20952fe77634d9655282429de36a9b1735a12eda4e6edc3e96b1cdc",
    "capabilities": {
      "prepare": true,
      "observation": true,
      "cleanup": true,
      "tool_events": true,
      "observation_keys": ["order.refunded_amount", "order.status"]
    }
  }
}
```

Single-turn connectors omit `multi_turn` and `conversation`. A boolean
`multi_turn: true` flag is not a session. The only advertised multi-turn mode
is package `aw-conversation-enforcement/1` with
`conversation.strategy: explicit_session_v1`. Estimate and execute send that
same object. `conversation_id` on send input, when present, must equal
`attempt_id`.

The CLI persists `create_request_id` before sending this body and also sends it
as the `Idempotency-Key` header. The response is bound to the complete canonical
request:

```json
{
  "protocol_version": "aw-relay/0.1",
  "create_request_id": "crq_0123456789abcdefghijklmnop",
  "create_request_sha256": "5f89fddf13e9407eb69321511917d2c9229ecf628a2d8b2adb9dc591d8a49c53",
  "create_disposition": "created",
  "run_id": "run_01",
  "session_id": "session_01",
  "packet": {
    "key": "support-refunds",
    "version": "0.1.0",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "config_sha256": "1111111111111111111111111111111111111111111111111111111111111111",
  "fencing_epoch": 1,
  "status": "queued",
  "dashboard_url": "https://augmentworks.ai/runs/run_01",
  "run_expires_at": "2026-08-30T13:00:00Z",
  "credit_state": "reserved",
  "poll_after_ms": 1000
}
```

The configuration digest is over canonical secret-free configuration. Resolved
credential values are never part of the digest. `boundary_sha256` is the
lowercase SHA-256 of canonical `{connector, base_url, operations}` after local
environment resolution. The base URL is normalized by the WHATWG URL parser,
has search and fragment removed, and has trailing pathname slashes collapsed
except for `/`. Present operations are ordered `prepare`, `send`, `observe`,
`cleanup`, each as `{kind, method, path}`.

The boundary checksum excludes credentials and auth headers, environment
variable names, request/response mappings and selectors, bodies, limits,
telemetry, and target state. The raw URL and operation data stay local. Secret
rotation leaves the checksum stable; a resolved base URL or operation
method/path change does not. It is an unkeyed binding checksum, not proof of the
target's identity, ownership, code, or state.

`observation_keys` is the sorted, unique list of public aliases from
`telemetry.allow_observations`; it is empty when observation is unavailable.
Observation values, response selectors, environment-variable names, target
URLs, paths, and credentials are not part of the capability preflight.

The hosted service must validate packet availability, capabilities, and
observation aliases before reserving credit. An exact replay of the same ID and
canonical body returns the same run, session, fencing epoch, packet/config
binding, dashboard URL, and `run_expires_at`. `create_disposition` changes to
`replayed`; current `status` and `credit_state` may advance. The same ID with a
different body is a conflict, and a duplicate must never reserve or consume a
second credit.

The service must retain the create-ID binding for at least the supported local
resume window, including the run lifetime and recovery grace. After that
tombstone expires, a stale replay must fail rather than silently create a new
run.

## Credit lifecycle

`credit_state` is required on create and run-status responses and is independent
of the run status:

| Credit state | Meaning |
| --- | --- |
| `reserved` | Run creation succeeded, but no real packet command has been leased |
| `consumed` | The relay leased the first real packet command |
| `released` | The run was cancelled or expired before any real command lease |

The CLI does not meter credits locally. The hosted response and dashboard are
authoritative, and replaying a create request never charges again.

## Run creation and restart recovery

Before the create POST, `test` resolves the authenticated workspace and
connector through `/api/v1/cli/auth/me`, then atomically stores a secret-free
active intent in the local AugmentWorks state directory. There is one locked
intent per API origin, and its durable tenant binding must match before any
create request is sent. Re-running the exact same `test` request as the same OS
user on the same machine and connector reuses its create ID and byte-equivalent
canonical body, then resumes the same run and command journal. A different
tenant is refused with `ACTIVE_RUN_TENANT_MISMATCH`; a different packet,
configuration, target, or capability set is refused with `ACTIVE_RUN_EXISTS`.
v0.1 has no force-new bypass.

A legacy bound intent without a tenant field is migrated only after the current
credential can read its exact run. An unbound legacy intent cannot prove which
connector may already own its create ID and therefore fails closed without
sending a create request.

Multi-shard `test --all-shards` additionally persists
`aw-selection-execution/3` with the same opaque workspace/connector binding plus
normalized API origin. Every shard and resume must match that pin
(`SELECTION_TENANT_MISMATCH`). Unbound `/2` execution documents and spent
`aw-selection-progress/1` files fail closed (`SELECTION_LEGACY_UNBOUND`) and are
not charged or relabeled. Per-shard run-intent retirement does not clear the
selection pin. Tokens are never written to these documents.

The intent is removed only after the runner or a status GET returns an
authoritative `completed`, `failed`, or `cancelled` **target execution** status
and local cleanup or acknowledgements are complete. Pending background grading
does not keep the local execution intent active. A crash, network
failure, indeterminate operation, incomplete cleanup, or unavailable terminal
status keeps recovery state. Recovery is local to that state directory; copying
only the command line to another machine does not transfer ownership or safely
reconstruct a lost create ID.

`augmentworks recover` inspects that state without creating a run. A generic
HTTP 400/404/409/410 from create is not proof that no run exists. The CLI
retires a pending create only after an explicit typed `rejected_uncreated`
result or `aw-run-intent-reconcile/0.1` proof. Old servers that lack the
reconcile endpoint leave pending state in place and return
`RECOVERY_UNSUPPORTED` rather than clearing the journal.

Recovery proceeds only when the secure lock owner can be positively
established. On the same host, a positively dead recorded process is reclaimable
even when boot/process-start metadata is unavailable. A verifiable earlier boot
or mismatched process-start identity also establishes that a reused live PID is
not the recorded owner. The current process's own live PID remains locked when
the platform has no process-start identifier. Before removal, the CLI rechecks
the unchanged lock directory, owner-file identity, and nonce. A verified live owner, unknown
liveness/identity, different host, symlink, unsafe permissions, or changed lock
is refused; the CLI does not guess ownership.

## Polling

The client sends `run_id`, `after_sequence`, `fencing_epoch`, and a bounded
`wait_seconds`. The relay returns the current status and either one command or
`command: null`. An empty `204` poll is also treated as no command.

A poll response may also carry `skipped_sequences`: an ascending list of
sequences above `after_sequence` that the relay closed and will never deliver,
with or without a command. An absent field means none. The CLI journals a
`skipped` record only for listed sequences that are contiguous with what it
already holds, so its cursor moves past them; a gap the relay did not list still
fails with `COMMAND_SEQUENCE_GAP`.

A retryable poll or status failure (a network error, `408`, `429`, or `5xx`) is
retried until the run deadline. Each pause is at least the relay's
`Retry-After`, with capped exponential backoff. Runner errors in `--json` output
carry the `run_id`.

Every command has this binding:

```json
{
  "protocol_version": "aw-relay/0.1",
  "command_id": "cmd_01",
  "session_id": "session_01",
  "run_id": "run_01",
  "attempt_id": "attempt_01",
  "packet": {
    "key": "support-refunds",
    "version": "0.1.0",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "config_sha256": "1111111111111111111111111111111111111111111111111111111111111111",
  "sequence": 1,
  "fencing_epoch": 1,
  "idempotency_key": "idem_01",
  "issued_at": "2026-08-30T12:00:00Z",
  "expires_at": "2026-08-30T12:01:00Z",
  "kind": "prepare",
  "input": {
    "protocol_version": "aw-target/0.1",
    "run_id": "run_01",
    "attempt_id": "attempt_01",
    "scenario_key": "policy-override",
    "repetition_index": 0,
    "idempotency_key": "idem_01",
    "mode": "evaluation",
    "fixture": {},
    "metadata": {}
  }
}
```

Before execution, the CLI verifies every binding against its active session,
checks timestamps and sequence/fencing values, validates the variant-specific
input, and consults the local journal.

## Operation inputs

### `prepare`

Carries `run_id`, `attempt_id`, `scenario_key`, `repetition_index`,
`idempotency_key`, `mode` (`evaluation` or `conformance`), and bounded `fixture`
and `metadata` objects.

The normalized result is `status: "ready"`, the matching `attempt_id`, optional
`target_session_id`, and no unconfigured target fields.

### `send`

Carries `turn_id`, `idempotency_key`, one user `message` (`role` and `content`),
and bounded `metadata`. Optional `conversation_id` is the attempt-scoped session
key for `explicit_session_v1` and must equal `attempt_id`. The CLI injects it
into the target request only when that strategy is configured.

The normalized result contains the matching `turn_id`, one assistant `message`,
bounded typed `events`, and `finished`. Event variants are:

- `tool_call`: tool name, call ID, and bounded arguments
- `tool_result`: tool name, call ID, bounded output, and success
- `handoff`: destination and optional reason
- `error`: safe code, message, and retryability

### `observe`

Carries `request_id`, a unique bounded `probe_keys` array, and `metadata`.

The result contains the matching `request_id` and observations with `key`,
bounded JSON `value`, `source`, and `authoritative`. The `authoritative` field is
a declaration made by the customer-controlled observer; it is not independent
verification by AugmentWorks. Local telemetry configuration rejects a
cloud-requested probe that is not explicitly allowed before local dispatch and
filters any unallowed key returned by the target.

### `cleanup`

Carries the `attempt_id`. A successful result contains
`status: "cleaned"` and that same identifier.

## Completion and failure

A completion repeats the command/session/run/packet/config/sequence/fencing
binding and includes the normalized result plus `result_sha256`. The relay
acknowledges the command ID with `accepted: true`.

A failure repeats the same binding and contains:

```json
{
  "disposition": "failed",
  "error": {
    "code": "TARGET_UNREACHABLE",
    "safe_message": "The configured target could not be reached.",
    "retryable": true
  },
  "result_sha256": "<failure digest>"
}
```

`disposition` is `failed` or `outcome_indeterminate`. The latter is mandatory
when a non-idempotent request may have reached the target but no definitive
response was received. Safe failures do not include raw response bodies,
headers, stack traces, secrets, or arbitrary logs.

## Delivery, replay, and fencing

1. The relay may redeliver a command until it accepts a terminal result.
2. The CLI journals the command binding and terminal digest before acknowledging
   success locally.
3. An exact duplicate with a durable terminal result returns that journaled
   result without re-executing the target operation. If a previous process
   started but did not durably finish an operation, only an explicitly
   idempotent operation may execute again; otherwise the outcome is reported as
   indeterminate.
4. The same command ID with a different binding is a protocol conflict.
5. A lower fencing epoch, expired command, sequence conflict, packet mismatch,
   or config mismatch is refused.
6. A new epoch invalidates unfinished work from a previous connector lease.
7. If the process dies after uploading a result but before journaling its
   acknowledgement, the CLI re-sends the journaled result (same binding, result
   and digest) instead of running the operation again: when the relay delivers
   the next command, and before `recover` or a new `test` releases a terminal
   run. An identical-repeat accept, `RUN_TERMINAL`, or `RELAY_CONFLICT` (the
   relay already holds a result) closes it; on a terminal run so do
   `STALE_FENCE` and `RUN_BINDING_MISMATCH`. On a terminal run, a command that
   never completed and a prepared fixture still awaiting cleanup are journaled
   as abandoned, with a warning for the fixture, because the relay can no
   longer send that work.

No retry policy can infer that a timed-out, non-idempotent target operation was
not delivered. For `prepare`, `send`, `observe`, or `cleanup`, the CLI records
`outcome_indeterminate` when delivery is ambiguous unless that operation is
explicitly idempotent. The relay may then dispatch bounded typed follow-ups,
such as `observe` or `cleanup` when a fixture may exist. The CLI never
synthesizes those follow-ups itself.

## Cancellation and cleanup

Cancellation prevents the CLI from executing new `prepare`, `send`, or
`observe` work. If preparation may have created a fixture, a relay-dispatched
`cleanup` remains permitted under the active binding. Cleanup failure is
reported separately and must not be rewritten as assessment success. Synthetic
fixtures should also have a server-side TTL.

## Evidence binding

The CLI's unkeyed command/result digests are replay checksums: comparison with
an already-durable local or relay record detects a conflicting replay. They are
not signatures and do not by themselves provide evidence provenance or
tamper-evidence; HTTPS authenticates transport only. The hosted relay associates
accepted results with authenticated connector, session, run, packet,
configuration, sequence, and fencing bindings. That association records what
the connector reported. It does not prove target identity, make a
customer-operated observation truthful, or establish production equivalence;
see [security-model.md](security-model.md).
