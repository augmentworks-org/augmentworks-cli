# Refund-agent example

This loopback server demonstrates the full synthetic lifecycle without a model,
database, production data, or production side effect. It creates an in-memory
order from the packet fixture, applies a deterministic refund policy, emits
structured tool events, exposes allowlisted state, and removes the fixture.

The example is designed to pass the bundled Apache-2.0
`support-refunds-starter@0.1.0` local packet. It is a connector and scorer
demonstration, not a realistic support agent or a substitute for AugmentWorks'
private hosted packet `support-refunds@0.1.0` and managed scoring.

This directory is **not included in the npm tarball**. Clone the CLI repository
for the example server. This `@augmentworks/cli@0.3.8` package supports `--local`,
hosted `--assessment`, packaged `demo`, `init --starter stateful`, `usage`,
`billing`, `preview-mapping`, `probe`, and `--estimate` via npx. The refund-agent
example directory is still not in the npm tarball.

## Obtain the example

```bash
git clone https://github.com/jeffskafi/augmentworks-cli.git
cd augmentworks-cli/examples/refund-agent
```

## Run locally without AugmentWorks

From this directory, start the target:

```bash
[ -f .env ] || cp .env.example .env
# Windows: if not exist .env copy .env.example .env
node --env-file=.env server.mjs
```

The target listens on `http://127.0.0.1:8000` by default and exposes a
side-effect-free `GET /health` endpoint. In another terminal, from this
directory, run the complete local assessment:

```bash
npx --yes @augmentworks/cli@0.3.8 doctor \
  -c augmentworks.yaml
```

From a clone after `npm ci && npm run build`, preview the production mapping against a synthetic
fixture before the assessment. This does not call the target or consume
credits:

```bash
node dist/index.js preview-mapping \
  -c augmentworks.yaml \
  --operation send \
  --fixture ./fixtures/send-response.json

node dist/index.js preview-mapping \
  -c augmentworks.yaml \
  --operation observe \
  --fixture ./fixtures/observe-response.json

node dist/index.js probe -c augmentworks.yaml
node dist/index.js probe -c augmentworks.yaml --yes
```

```bash
npx --yes @augmentworks/cli@0.3.8 test \
  --local \
  -c augmentworks.yaml \
  --packet support-refunds-starter@0.1.0 \
  --open
```

No AugmentWorks account, login, credit, relay, control-plane request, or
dashboard is involved. The CLI calls only the configured loopback target,
scores the bundled data-only JSON packet, and writes `report.json`, `junit.xml`,
and a static `report.html` under `.augmentworks/runs/<run_id>/`. `--open` opens
that HTML file. Local reports do not upload to AugmentWorks.

The reports are customer-executed, unsigned, not received or independently
verified by AugmentWorks, and are not a certification, audit, or hosted evidence
record.

## Run the same target with a hosted packet

After an invited workspace authorizes this connector, omit `--local` and select
the hosted pack. Browser approval does not start an assessment. Keep the
terminal open; there is no separate `connect` command. Re-running the same
hosted `test` command resumes an active bound intent or follows the remaining
baseline/remediation allowance. There is no `--rerun` flag.

```bash
npx --yes @augmentworks/cli@0.3.8 login

npx --yes @augmentworks/cli@0.3.8 test \
  -c augmentworks.yaml \
  --packet support-refunds@0.1.0 \
  --open
```

The hosted path creates an assessment, polls the relay over outbound HTTPS,
calls the same loopback target through the local mapping, sends only bounded
allowlisted evidence, and opens the live dashboard. Hosted packet availability
and requirements are controlled by the AugmentWorks service. The hosted pack is
not the same coverage as `support-refunds-starter@0.1.0`.

## API shape

| Endpoint | Synthetic behavior |
| --- | --- |
| `POST /__augmentworks/prepare` | Validates and stores one packet-provided in-memory fixture keyed by attempt ID |
| `POST /chat` | Refunds an eligible order exactly once, denies an ineligible refund, and leaves unrelated shipping questions unchanged |
| `POST /__augmentworks/observe` | Returns only status, refunded amount, and the refundable flag |
| `POST /__augmentworks/cleanup` | Deletes the in-memory fixture; safe to repeat |

The YAML normalizes the application response (`answer`, `events`, and `order`)
into the strict `aw-target/0.1` evidence contract. The target does not need to
know whether the caller is running a local or hosted assessment and does not
return `protocol_version`.

In a real integration, authenticate these lifecycle routes, restrict them to an
isolated synthetic test environment, make fixture operations idempotent, and
enforce a server-side fixture TTL. The CLI attempts cleanup in a `finally` path,
but a hard process or machine failure cannot guarantee that cleanup executes.
