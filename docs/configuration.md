# Configuration reference

The v1 configuration describes a local application boundary. It is input to a
deterministic HTTP connector, not an instruction language. No Python adapter or
AugmentWorks target SDK is required: expose the mapped endpoints in the
application's existing framework. In hosted mode the relay cannot change the
configured host, path, method, headers, environment-variable names, or mappings
during a run. In local mode no relay or AugmentWorks service is contacted.

## Data scope

Test your chatbot with your questions and business rules. That hosted scope
stays off until a compatible published release is enabled. Until then, hosted
runs use an authorized,
isolated synthetic or staging target and constructed test data. Hosted
real-data quote and admission stay release-disabled. The lifecycle table below
describes the fictional starter and that current hosted path. Offline
`aw-packet/0.1` stays synthetic-only and account-free.
`aw-packet/local-authorized-1` is a customer-declared local scope and is not
hosted authority. Packaged examples remain fictional. This text is not legal
approval. Do not commit customer or private fixtures, and do not pass
production transcripts to `preview-mapping`.

## File and environment resolution

The default filename is `augmentworks.yaml`. Select another file with `-c` or
`--config`. `init -c` writes the connector to that path; companion assessment,
reference, and environment files stay in the same directory.

The CLI loads `.env` from the selected configuration file's directory before it
resolves `${NAME}` references. Existing process environment values take
precedence. Keep `.env` out of source control; commit `.env.example` containing
names and placeholder values only.

`base_url` may use a whole-value environment reference:

```yaml
base_url: ${CHATBOT_BASE_URL}
```

Authentication values must always be indirect:

```yaml
auth:
  bearer_env: CHATBOT_API_KEY
  headers_env:
    X-Tenant-ID: CHATBOT_TENANT_ID
```

`bearer_env` and `headers_env` values name environment variables. They are not
secret values. `doctor` rejects credential-like literal values in these fields.
These credentials authenticate CLI-to-target calls and are separate from the
revocable connector credential created by `augmentworks login`.

## Top-level shape

```yaml
version: 1
target: {}
telemetry: {}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | Yes | Configuration schema version; CLI 0.2 accepts `1` |
| `target` | Yes | Local connector and operation mappings |
| `telemetry` | No | Explicit evidence allowlist |

Unknown fields are rejected so a typo cannot silently weaken a boundary.

## Target

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | Yes | Stable human-readable target name |
| `connector` | Yes | Must be `http` in v1 |
| `base_url` | Yes | Target origin; public targets should use HTTPS, while loopback/private IP targets may use HTTP |
| `allow_insecure_http` | For public plain HTTP | Explicit high-risk opt-in; loopback and private IP targets are allowed without it |
| `auth` | No | Bearer or additional header environment-variable names |
| `conversation` | No | Conversation mode. Omitted or `strategy: single_turn` is the default. The only supported multi-turn mode is `strategy: explicit_session_v1`. |
| `operations` | Yes | Lifecycle mappings |
| `limits` | No | Stricter per-target byte and timeout limits |

Example limits:

```yaml
limits:
  request_bytes: 65536
  response_bytes: 1048576
  operation_timeout_ms: 30000
```

Configured values can only tighten the CLI's hard safety ceilings. Operation
timeouts must be between 100 and 120,000 milliseconds.

### Target boundary checksum

For a hosted run, the CLI hashes a canonical boundary containing the connector,
the fully resolved and normalized base URL, and each configured operation's
kind, method, and fixed path. Only `boundary_sha256` leaves the machine; the raw
URL, paths, and any environment-variable names do not.

The checksum excludes credentials, auth headers, mappings/selectors, bodies,
limits, telemetry, and target state. Rotating a secret leaves it stable, while
changing the resolved base URL or an operation method/path changes it and
prevents an active run from resuming against that different boundary. This is
an unkeyed drift-binding checksum, not target identity or execution proof.

## Operations

`send` is always required. `prepare`, `observe`, and `cleanup` are required as a
set for a stateful assessment.

```yaml
operations:
  send:
    method: POST
    path: /chat
    request:
      message: $input.message.content
      attempt_id: $input.attempt_id
    response:
      content: $.answer
      tool_events: $.events
    timeout_ms: 30000
    idempotent: false
```

| Field | Required | Meaning |
| --- | --- | --- |
| `method` | Yes | `GET` or `POST`; `DELETE` is accepted only for `cleanup` |
| `path` | Yes | Fixed path joined to `base_url` |
| `request` | No | JSON-compatible request body template |
| `response` | No | Named output fields mapped from the JSON response |
| `timeout_ms` | No | Per-operation timeout |
| `idempotent` | No | Declares whether replay after a known non-delivery is safe; defaults to `false` for every operation |

Paths are configuration constants. They cannot contain `$input` templates, a
second origin, credentials, fragments, or cloud-provided URLs.

`GET` operations cannot define a request body. `DELETE` is restricted to
`cleanup` so a cloud-selected semantic operation cannot turn another lifecycle
step into a destructive request.

### Request templates

A request template is JSON-compatible YAML. Scalar strings beginning with
`$input.` copy a value from the typed operation input:

```yaml
request:
  message: $input.message.content
  attempt_id: $input.attempt_id
  metadata:
    turn_id: $input.turn_id
```

The supported accessor is a dotted object path. There are no expressions,
functions, conditionals, filters, JavaScript, shell commands, or dynamic keys.
Missing required input fails the operation before an HTTP request is made.

### Response mappings

Responses must be JSON when a `response` mapping is present. Each output field
uses the safe subset `$.field.nested` (with simple array indexes where
supported):

```yaml
response:
  content: $.answer
  tool_events: $.events
```

No recursive descent, predicates, script expressions, or arbitrary JSONPath
evaluation is supported. A missing required mapped value produces a bounded,
redacted target error.

### Lifecycle meaning

| Operation | Purpose | Retry rule |
| --- | --- | --- |
| `prepare` | Create a synthetic fixture and return its identifiers | An ambiguous outcome is indeterminate unless explicitly idempotent |
| `send` | Deliver a scenario message to the application | An ambiguous outcome is indeterminate unless explicitly idempotent |
| `observe` | Read allowlisted synthetic state through the configured observer | An ambiguous outcome is indeterminate unless explicitly idempotent |
| `cleanup` | Remove the synthetic fixture | An ambiguous outcome is indeterminate unless explicitly idempotent |

Target authors should make lifecycle operations idempotent by the attempt or
fixture identifier wherever the application contract permits it, and declare
that guarantee explicitly.

Set `idempotent: true` only when the target contract actually guarantees that
repeating the same idempotency/attempt key cannot duplicate a consequence. The
CLI treats every operation as non-idempotent when the field is absent.

## Conversation

Conversation defaults to **single-turn**. Hosted create/quote/estimate omit
`multi_turn` and `conversation` in that case so older servers keep accepting
genuinely single-turn plans. An assessment file does **not** advertise
multi-turn. `run_id`, `attempt_id`, and `turn_id` are correlation identifiers,
not proof that the target bound them to conversation memory.

The only implemented multi-turn mode is `explicit_session_v1`:

```yaml
target:
  conversation:
    strategy: explicit_session_v1
  operations:
    send:
      idempotent: true
      request:
        message: $input.message.content
        conversation_id: $input.conversation_id
```

Rules:

- The send request template must copy `$input.conversation_id` into a target
  field the server uses as its isolated conversation key. Mapping
  `$input.attempt_id` is correlation only.
- At the attempt boundary the CLI sets `conversation_id` equal to `attempt_id`.
  Ordered turns and resume keep that identifier. A new attempt or repetition
  gets a fresh identifier.
- The target owns and isolates server-side context for that identifier.
  Declaring the mapping is not a claim that the chatbot remembered prior turns.
- `history_array_v1` is reserved and rejected. The CLI does not infer memory.
- Duplicate suppression of an already accepted user turn depends on the
  target. Set `send.idempotent: true` only when repeating the same
  `AW-Idempotency-Key`, conversation identifier, and `turn_id` cannot append a
  second user message.
- Estimate and execute send the same capability object. A packet that requires
  multi-turn against a single-turn connector fails with
  `CONVERSATION_CAPABILITY_INCOMPATIBLE` before quote or reservation.

A migration example lives at `examples/response-agent/augmentworks.session.yaml`
with `session-server.mjs`. Default `examples/response-agent/augmentworks.yaml`
stays single-turn.

## Telemetry

Telemetry is denied unless enabled:

```yaml
telemetry:
  allow_tool_events: true
  allow_observations:
    - order.status
    - order.refunded_amount
```

`allow_tool_events` permits structured tool-event results from `send`.
`allow_observations` is a field-level allowlist applied to observation output.
It does not permit arbitrary database records or logs. At hosted run creation,
the CLI sends only these public key aliases, sorted and deduplicated, for packet
preflight. Observation values, local response selectors, environment-variable
names, and the target URL remain local. Returned values leave the connector
only for a typed relay request whose keys passed this allowlist. During
`test --local`, the same allowlist constrains which observations may be scored
and written to reports, but nothing is sent to AugmentWorks.

## Capability levels

| Level | Required config | What an assessment can claim |
| --- | --- | --- |
| Chat-only | `send` | Conversational behavior |
| Tool-aware | `send` and allowed structured events | Attempted tool invocation |
| Stateful | `prepare`, `send`, `observe`, `cleanup`, and allowed observation fields | Values reported by the configured state observer |

If state observation is absent or fails, state is `unknown`; the chatbot's
message is not substituted as proof. An observation is customer-reported
evidence, not independent verification that the observer is correct or that a
test environment matches production.

## Validation

Use offline validation while editing:

```bash
npx --yes @augmentworks/cli@0.3.8 doctor \
  -c augmentworks.yaml
```

`doctor` makes no target or cloud network request, never invokes `prepare`,
`send`, `observe`, or `cleanup`, and consumes no assessment credit. It does
not inspect a response shape. After `doctor` passes, preview the production
mapping against a synthetic JSON fixture:

```bash
node dist/index.js preview-mapping \
  -c augmentworks.yaml \
  --operation send \
  --fixture ./fixtures/send-response.json
```

`preview-mapping` reads only the selected configuration file and fixture. It
does not load `.env`, call the target, contact AugmentWorks, invoke a model,
or consume credits. Chat-only configs can preview `send` without configuring
`prepare` / `observe` / `cleanup`. Stateful configs can preview `observe` or
`cleanup` the same way.

The command prints extracted versus missing fields, omitted allowlisted paths,
redacted values, truncation decisions, and the exact canonical evidence
payload that `complete` would hash. Invalid selectors include the YAML path
and selector offset. `--json` emits stable `AW-MAPPING-PREVIEW-1` for
automated checks.

Safe representative send preview from
`examples/response-agent/` (synthetic fixture, no secrets):

```text
Mapping preview (offline, fixture-only)
Operation: send
Config: examples/response-agent/augmentworks.yaml
Fixture: examples/response-agent/fixtures/send-response.json

Extracted fields
  content  $.answer  string  84 bytes
    The synthetic order remains paid because the requested refund exceeds the maximum.
    (target.operations.send.response.content)
  finished  $.finished  boolean  4 bytes
    true
    (target.operations.send.response.finished)

Missing required fields
  (none)

Omitted paths
  (none)

Redacted values
  (none)

Truncation
  (none)

Diagnostics
OK CONFIG_VALID: Configuration schema and mappings are valid.
OK MAPPING_PREVIEW_OFFLINE: No target, cloud, or model call was made.

Canonical evidence payload
  229 bytes
  sha256 64348b36a1bb30e3f8b2d4e0e14b060f5cbf7cfe8398f37941233e8c7624e963
{"events":[],"finished":true,"message":{"content":"The synthetic order remains paid because the requested refund exceeds the maximum.","role":"assistant"},"metadata":{},"protocol_version":"aw-target/0.1","turn_id":"preview_turn"}

This preview applies the production mapping, allowlist, redaction, and evidence limits to the supplied fixture only. It does not call the target, AugmentWorks, or a model, consumes no credits, and does not guarantee that future responses are secret-free.
Mapping preview complete. No target, cloud, or model call was made.
```

The preview is for the supplied fixture only and is not a secret-detection
guarantee. Do not pass production transcripts. Include the `--json` output in
a support handoff when the mapping looks wrong; it already matches relay
evidence bytes after canonicalization.

## Own-target patterns

One initializer writes two supported JSON HTTP patterns:

| `--starter` | Pattern | Generated hooks |
| --- | --- | --- |
| `response-quality` (`response-only`, `chat`) | Response-only JSON chat | `send` only, plus a five-question synthetic suite |
| `workflow` (`stateful`) | Stateful tool workflow | `prepare`, `send`, `observe`, `cleanup` |

Response-only setup must not add unused state hooks. Streaming, WebSocket,
history-array multi-turn, and connector marketplaces are not supported. The
only multi-turn mode is `explicit_session_v1` (see Conversation). Packaged
fixture servers and `OWN-TARGET.md` are copied by `init`.

## Connection probe

`doctor` and `preview-mapping` stay offline. They do not prove network
authentication, selector behavior against a live response, session
continuity, or cleanup. This package adds an explicit command:

```bash
node dist/index.js probe -c augmentworks.yaml
node dist/index.js probe -c augmentworks.yaml --yes
```

Without `--yes` the command prints the planned operations, number of calls,
time and byte limits, and possible synthetic side effects. `--yes` executes
that plan against the configured target with synthetic correlation ids.
Doctor and init never start a probe. The probe does not quote, reserve, or
create a hosted run. If hosted work is required, use ordinary
`test --estimate` / `--max-credits N --yes`. Failures name the phase
(connection refusal, timeout, authentication, response selector,
conversation/session, cleanup) and a corrective action. They are not chatbot
quality verdicts and must not expose request secrets.

The canonical machine-readable definition is
[`schemas/v1/augmentworks.schema.json`](../schemas/v1/augmentworks.schema.json).

Print any bundled schema with:

```bash
npx --yes @augmentworks/cli@0.3.8 schema --kind config
npx --yes @augmentworks/cli@0.3.8 schema --kind local-packet
npx --yes @augmentworks/cli@0.3.8 schema --kind local-result
```

Local assessment packets are separate strict JSON documents with
`schema_version: "aw-packet/0.1"`; they do not add executable configuration to
the YAML boundary. A local path may identify a JSON file or a directory whose
`packet.json` is loaded. URLs, downloaded packets, JavaScript, and modules are
not accepted. `aw-packet/0.2` and hybrid/`llm_rubric` packets are refused in
`--local` before any target call.

This package can validate a hosted assessment file without running tests:

```bash
node dist/index.js doctor \
  --assessment ./augmentworks.assessment.yaml \
  --profile quick
```

Optional hosted compiler fields may be added to that same assessment file.
They are not a second generated format. `test --profile` remains
`quick|full|combined|custom`. Smoke/release lives under `selection.profile`:

```yaml
selection:
  profile: smoke
  include_catalog: true
  include_tags:
    - factuality
```

`selection compile` asks the server for included, excluded, and incompatible
cases plus bounded shards. Those counts are not a quote. `--local` cannot use
catalog metadata or compiled manifests. Compile forwards the connector's
prepare, observation, tool-event, cleanup, and conversation capabilities from
`--config`. A missing default `augmentworks.yaml` is an explicit
capability-free single-turn advertisement. An explicit `--config` path that
is missing, malformed, or unresolved fails with the existing config
diagnostic before authentication.

## Outbound data policy

Connector YAML does not yet author a data policy. Frozen `aw-data-policy/1`
and `aw-redaction-profile/1` documents are supplied by the hosted contract
(AUG-188) when real-data execution is wired. This CLI package implements the
pure transforms:

- `inspectOutbound(document, policy, profile, localSecrets)`
- `applyRedactionProfile(input, profile, policy, secrets)`
- `sealDataHandlingReceipt(...)`

`preview-mapping` remains fixture-only: no login, target call, suite upload,
or credit use. Passing a policy into the mapping-preview service shows
retained fields, counts, effective policy, and limits. Ordinary terminal
output must not print original secret or personal matches.

A stale policy or profile hash fails closed before egress. A blocked target
response is recorded as sanitized, non-retryable evidence-unavailable status.
Local reports stay on the customer machine; hosted purge does not remove them.
