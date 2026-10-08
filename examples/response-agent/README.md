# Synthetic response-agent example

This directory is a **synthetic** FAQ assessment fixture for this 0.3.8 package.
It is not a production knowledge base, not a real customer policy, and not
included in the npm tarball. Clone this repository for the example server.

This `@augmentworks/cli@0.3.8` package includes `--assessment`. `init --starter
response-only` writes a packaged copy of this fixture (including `server.mjs`)
instead of copying this git-only example directory.

From a clone after `npm ci && npm run build`, preview the chat-only send mapping before an
assessment. This does not call the target or consume credits:

```bash
node dist/index.js preview-mapping \
  -c augmentworks.yaml \
  --operation send \
  --fixture ./fixtures/send-response.json

node dist/index.js probe -c augmentworks.yaml
node dist/index.js probe -c augmentworks.yaml --yes
```
```yaml
# augmentworks.assessment.yaml is synthetic test data only.
```

Default `augmentworks.yaml` is **single-turn**. Hosted `multi_turn` is not
advertised from the presence of an assessment file. Correlation IDs
(`attempt_id`, `run_id`, `turn_id`) are not conversation memory.

To opt into the one supported session mode, copy the mapping in
`augmentworks.session.yaml` and run the stateful fixture:

```bash
[ -f .env ] || cp .env.example .env
# Windows: if not exist .env copy .env.example .env
node --env-file=.env session-server.mjs
```

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
        turn_id: $input.turn_id
```

`explicit_session_v1` maps the attempt-scoped conversation identifier
(`conversation_id === attempt_id`) into a target field. The target owns and
isolates that server-side context. Mapping is not a claim that a chatbot
remembered prior turns.

Set `idempotent: true` only when repeating the same `AW-Idempotency-Key`,
conversation identifier, and `turn_id` cannot append a second accepted user
message. This fixture does that; arbitrary endpoints are not assumed
idempotent.

From a clone after `npm ci && npm run build`, validate the session mapping offline, then probe
the session fixture. Doctor and init never probe:

```bash
node dist/index.js doctor -c augmentworks.session.yaml --offline
node dist/index.js probe -c augmentworks.session.yaml
node dist/index.js probe -c augmentworks.session.yaml --yes
```