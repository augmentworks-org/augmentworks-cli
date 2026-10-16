# AugmentWorks CLI

[![CI](https://github.com/augmentworks-org/augmentworks-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/augmentworks-org/augmentworks-cli/actions/workflows/ci.yml)

AugmentWorks is regression testing for support and FAQ chatbots and the agents
behind them. You write the questions and the business rules; the CLI sends
them to your chatbot, checks the answers, and can also check the tool calls it
reports and the application state it changes. A chatbot saying “done” is not
treated as proof that anything happened.

The CLI runs in two ways:

| Mode | What it does | Needs |
| --- | --- | --- |
| Local `test --local` | Runs and scores a data-only packet against your chatbot on your machine. Requires no AugmentWorks account and contacts no AugmentWorks service. | Node.js 22.12 or newer and a chatbot you are authorized to call |
| Hosted `test` | Runs an assessment through AugmentWorks over outbound HTTPS, with hosted judging and a live dashboard. Paid in credits, with a ceiling you set. | An invited AugmentWorks workspace and `login`. For real data, a registered, verified target with a test scope |

Product site: [augmentworks.ai](https://augmentworks.ai). Docs:
[quickstart](https://augmentworks.ai/docs/quickstart),
[local quickstart](https://augmentworks.ai/docs/local-quickstart),
[real-data tests](https://augmentworks.ai/docs/real-data),
[agent setup](https://augmentworks.ai/docs/agent-setup). Pricing is the
[pricing page](https://augmentworks.ai/pricing).

## Install

The CLI needs **Node.js 22.12 or newer**. Run it with `npx`, pinned to this
release:

```bash
npx --yes @augmentworks/cli@0.3.9 --version
```

or install it once and use the `augmentworks` command:

```bash
npm install -g @augmentworks/cli@0.3.9
augmentworks --version
```

Older versions aren't supported. Upgrade with
`npm install -g @augmentworks/cli@0.3.9`, or change the version in your `npx`
commands. On Node.js 20, upgrade Node.js to 22.12 or newer first: Node.js 20
reached end of life in April 2026.

The examples below use `npx --yes @augmentworks/cli@0.3.9`. `--yes` only skips
npm's install prompt; it never approves spending. Run the published CLI from a
directory that isn't a clone of this repository; inside a clone, `npx` can exit
`127` with `augmentworks: not found`.

## First local test

### The packaged demo

No account, login, Docker, database, or model:

```bash
npx --yes @augmentworks/cli@0.3.9 demo
```

The demo starts a fictional refund agent on `127.0.0.1` and runs the real local
runner and scorer against it twice with the same packet:

1. **Faulty implementation.** It refunds $80 even though the policy maximum is
   $50. The order becomes `refunded`, the check
   `policy-limit-order-remains-paid` fails, and that run exits `10`.
2. **Corrected implementation.** It enforces the maximum. The order stays
   `paid`, and that run exits `0`.

The conversational reply “The synthetic order refund completed.” is not
proof; the observed order state is. The demo exits `0` when that fail-then-pass
story and cleanup both succeed, and writes reports under
`.augmentworks/demo/<id>/`. Add `--json` for a machine-readable summary or
`--open` to open the HTML report. The demo ignores your `.env`, YAML and
`CHATBOT_*` / `AUGMENTWORKS_*` variables.

### Your own chatbot

`init` writes a starter `augmentworks.yaml`, `.env.example`, a local `.env`,
fixtures, and an assessment file. Pick the response-only chat pattern (the
default) or `--starter workflow` for an agent with state:

```bash
npx --yes @augmentworks/cli@0.3.9 init --agent
```

Edit `.env` and `augmentworks.yaml` for your chatbot (see
[Configuration](#configuration)), then check the setup and run the bundled
starter packet:

```bash
npx --yes @augmentworks/cli@0.3.9 doctor \
  -c augmentworks.yaml

npx --yes @augmentworks/cli@0.3.9 test \
  --local \
  -c augmentworks.yaml \
  --packet support-refunds-starter@0.1.0 \
  --open
```

`doctor` never contacts your chatbot or AugmentWorks. `test --local` requires
no AugmentWorks account and contacts no AugmentWorks service. It calls only the
chatbot your configuration names, and writes private JSON, JUnit and static
HTML reports under `.augmentworks/runs/<run_id>/`. `--open` opens the HTML.

To try it against a fictional server first, clone this repository and use the
refund-agent example:

```bash
git clone https://github.com/augmentworks-org/augmentworks-cli.git
cd augmentworks-cli
npm ci
npm run build
cd examples/refund-agent
[ -f .env ] || cp .env.example .env
node --env-file=.env server.mjs
```

Then run the `doctor` and `test --local` commands above from
`examples/refund-agent` in a second terminal. On Windows, create `.env` with
`if not exist .env copy .env.example .env`. The FAQ example in
[examples/faq-chatbot/README.md](examples/faq-chatbot/README.md) shows a
passing and a failing single-turn chatbot.

Before calling your chatbot, two optional checks help:

- `preview-mapping -c augmentworks.yaml --operation send --fixture ./fixtures/send-response.json`
  shows what your response mapping extracts from a saved JSON response, and the
  exact evidence that would leave the machine. It makes no network call.
- `probe -c augmentworks.yaml` prints a bounded connection check; add `--yes`
  to run it against your chatbot. It doesn't contact AugmentWorks or use
  credits.

### How local tests work

“Local” describes the AugmentWorks boundary, not an air gap. The CLI makes no
AugmentWorks control-plane request, but the configured target may itself be a
network service and may call models or other dependencies.

1. The CLI validates the YAML, resolves target credentials locally, and loads
   the bundled `support-refunds-starter@0.1.0` packet or a local `packet.json`.
2. It checks that your configured operations and telemetry allowlist cover
   what the packet needs.
3. It runs attempts one at a time: `prepare`, one or more `send` operations,
   `observe`, and `cleanup` in a `finally` path.
4. It scores the packet's checks and writes `report.json`, `junit.xml` and
   `report.html` to a fresh private directory.

The CLI never blindly retries an ambiguous operation that isn't declared
idempotent. It still observes when a send's outcome is unclear, and cleans up
when a fixture may exist. A cleanup failure stops new attempts. The first
Ctrl+C drains cleanup; a second exits immediately. A hard process or machine
failure cannot guarantee cleanup, so fixtures need a server-side expiry. New
target work stops after 30 minutes; cleanup can still finish after that.

**Packets.** Local packets use the strict `aw-packet/0.1` JSON format. They are
data, not plugins: no JavaScript, modules, shell commands, remote URLs, or
downloads. `--packet` takes the bundled `support-refunds-starter@0.1.0`, a
local JSON file, or a directory containing `packet.json`. Packets with
`aw-packet/0.2`, hybrid evaluation, or `llm_rubric` criteria are refused before
any call. `aw-packet/local-authorized-1` is a customer-declared local scope; it
never contacts AugmentWorks and is not hosted authority. Print the schemas:

```bash
npx --yes @augmentworks/cli@0.3.9 schema --kind local-packet
npx --yes @augmentworks/cli@0.3.9 schema --kind local-result
```

**Reports.** The default output directory is `.augmentworks/runs/<run_id>`.
Change it with `--output-dir <path>`; the selected leaf must not already exist,
and the CLI never merges into or overwrites a directory. On POSIX systems the
directory is mode `0700` and the files `0600`. Every local report says:

> Local, customer-executed result. AugmentWorks did not receive or independently verify this run. This artifact is unsigned and is not a certification, audit, or hosted evidence record.

The JSON report uses `AW-LOCAL-RESULT-1` and includes a SHA-256 checksum for
change detection; it is not a signature. The HTML is a self-contained static
file with no scripts or external assets. Treat all three files as sensitive.
`--json` prints the same result on stdout.

## First hosted test

Hosted tests need an invited AugmentWorks workspace; there is no self-serve
signup. A person logs in once per machine:

```bash
npx --yes @augmentworks/cli@0.3.9 login
```

Use `login --device` over SSH or on a headless machine, and
`login --workspace <uuid>` to pin a company workspace. Approving in the browser
only authorizes this terminal; it never starts a run.

Then generate the starter files, check them, and run a quick assessment:

```bash
npx --yes @augmentworks/cli@0.3.9 init --agent

npx --yes @augmentworks/cli@0.3.9 doctor \
  -c augmentworks.yaml

npx --yes @augmentworks/cli@0.3.9 test \
  -c augmentworks.yaml \
  --assessment ./augmentworks.assessment.yaml \
  --profile quick \
  --open
```

`test` shows the quoted credit cost and asks before starting. In CI or any
non-interactive shell, pass a ceiling with `--max-credits N` and `--yes`; the
run never spends more than that. `--estimate` prints the quote without
creating a run or reserving credits. `--open` opens the run's live dashboard.
Keep the terminal open until the run finishes. The CLI connects outbound over
HTTPS, so there is no inbound port, tunnel, or separate `connect` command.

If grading is still pending when your chatbot's part is done, the CLI exits
`11` and the evidence is saved. Wait on the same run instead of starting
another:

```bash
npx --yes @augmentworks/cli@0.3.9 run wait <run-id>
npx --yes @augmentworks/cli@0.3.9 run report <run-id> --json
```

Re-running the exact same `test` command on the same machine resumes the run
it started; there is no `--rerun` flag. If a run's state is unclear, inspect it
with `recover` before starting another.

Other hosted commands:

- `test --suite <file>` runs your own `aw-suite` file of cases. See
  [docs/customer-suites.md](docs/customer-suites.md).
- `compare --run <run-id> --baseline <baseline-id>` shows regressions and fixes
  against a pinned baseline; `gate` decides pass or block for a release.
  `baseline create --run <run-id>` pins the first baseline, and
  `baseline promote` moves it explicitly.
- `usage` shows the workspace's credits, and `billing` opens the billing page.
- `catalog list` and `selection compile` split large suites into shards that
  `test --shard` runs one at a time.
- `investigation inspect` / `fetch` / `export-regression` turn a failure into
  a regression case. See [docs/investigation.md](docs/investigation.md).

For CI, create a workspace API key at
https://augmentworks.ai/portal/settings/api-keys and set it as
`AUGMENTWORKS_API_KEY`. The complete GitHub Actions recipe is
[docs/examples/github-actions-hosted.yml](docs/examples/github-actions-hosted.yml).
Don't run `logout` as CI cleanup; it revokes reusable keys.

Interactive credentials are stored in the macOS Keychain, Windows DPAPI, or
the Linux Secret Service. On POSIX systems without one,
`login --allow-file-credentials` stores a warned mode-`0600` file. Never put an
AugmentWorks token on the command line.

## Real-data test

Test your chatbot with your questions and business rules. Hosted real-data
tests run only against a target your workspace registered and verified, under
a test scope: a workspace owner runs `augmentworks target add` and
`augmentworks target verify <name>`, then `augmentworks scope create` writes
the scope into an `aw-suite/3` suite that `augmentworks test --suite` runs.
Register only agents your workspace owns or operates, or has written
permission to test. If the server isn't accepting real-data tests, the run
stops with `EXECUTION_RELEASE_UNAVAILABLE` before anything is sent to your
agent. Hosted runs without a scope use an authorized, isolated synthetic or
staging target and constructed test data.

The full guide is at
[augmentworks.ai/docs/real-data](https://augmentworks.ai/docs/real-data).
Setup takes four commands, run by a workspace owner from the directory that
holds `augmentworks.yaml`. Each step can also be done in the portal under
Settings → Targets.

```bash
npx --yes @augmentworks/cli@0.3.9 target add --env production
npx --yes @augmentworks/cli@0.3.9 target verify <name>
npx --yes @augmentworks/cli@0.3.9 scope create --target <name> --suite refunds.suite.yaml
npx --yes @augmentworks/cli@0.3.9 test --suite refunds.suite.yaml --max-credits 30 --yes
```

1. `target add` registers the agent's name, address and endpoints from
   `augmentworks.yaml`. It asks whose agent it is, and the first time shows
   the workspace's real-data statement for an owner to accept.
2. `target verify <name>` prints a code to publish as a file on the agent's
   address or as a DNS TXT record, and finishes once the server sees it. A
   private address is confirmed from your machine instead. Verification
   lasts 90 days.
3. `scope create` shows the data policy, expiry and per-run budget, asks, and
   writes the scope id into the suite file.
4. `test --suite` runs the suite under that scope.

`target list` shows each target's status and scopes, and `target pull <name>`
brings a target added in the portal into `augmentworks.yaml`. Machine keys
can't do setup: unset `AUGMENTWORKS_API_KEY` and `login` as an owner first.

A workspace owner authorizes an exact target (`owned_target` or
`written_permission`) and a data policy for public, business, or ordinary
personal content. Hostname control is not ownership. Secrets, PHI,
payment-card credentials, and other separately restricted data stay out of
evaluation content. This text is not legal approval and does not claim SOC 2,
HIPAA, Zero Data Retention, or guaranteed reversal of actions. Controlled
actions and runs started from the dashboard are not available.

Offline `aw-packet/0.1` stays synthetic-only and account-free. Older synthetic
and live-informational suite files still load. Packaged examples and starters
are fictional.

## Configuration

The CLI loads `.env` from the directory of the selected config. YAML holds
environment-variable **names**, never secret values.
Target authentication is separate from your AugmentWorks login: `bearer_env`
names a local variable used only for CLI-to-chatbot requests.

```yaml
version: 1

target:
  name: refunds-staging
  connector: http
  base_url: ${CHATBOT_BASE_URL}

  auth:
    bearer_env: CHATBOT_API_KEY

  operations:
    send:
      method: POST
      path: /chat
      idempotent: false
      request:
        message: $input.message.content
        turn_id: $input.turn_id
        attempt_id: $input.attempt_id
      response:
        content: $.answer
        tool_events: $.events
```

```dotenv
# .env
CHATBOT_BASE_URL=http://127.0.0.1:8000
CHATBOT_API_KEY=replace-locally
```

Add `prepare`, `observe` and `cleanup` operations, and a `telemetry` allowlist,
when your tests check application state. The generic HTTP connector needs no
adapter or SDK. See the
[configuration reference](docs/configuration.md), the
[`augmentworks.yaml` schema](schemas/v1/augmentworks.schema.json), and the
[refund-agent example](examples/refund-agent/README.md).

| Evidence level | Operations | What it shows |
| --- | --- | --- |
| Chat-only | `send` | Conversational behavior |
| Tool-aware | `send` with tool events | What the chatbot tried to call |
| Stateful | `prepare`, `send`, `observe`, `cleanup` | The state your observer reports |

A customer-run observer can be wrong, and a staging result doesn't prove
production behaves the same.

## Commands

| Command | Purpose | Side effects |
| --- | --- | --- |
| `login [--device] [--workspace uuid] [--allow-file-credentials]` | Authorize this machine | Opens a browser by default and stores a revocable credential |
| `logout` | Revoke and remove the connector credential | Revokes server-side. Don't use as routine CI cleanup when `AUGMENTWORKS_API_KEY` is set |
| `whoami [--workspace uuid]` | Show the current workspace identity | Reads identity; may refresh interactive credentials |
| `usage [--workspace uuid] [--json]` | Show workspace credit usage | Read-only |
| `billing [--json] [--print] [--open]` | Open or print the billing page | Read-only navigation |
| `init [-c path] [--starter name] [--agent] [--force]` | Generate config, assessment, starter files, and setup guidance | Never replaces `.env`; overwrites edited files only with `--force` |
| `doctor [-c path] [--offline] [--json] [--assessment path] [--profile profile]` | Validate config, mappings, secrets, and assessment files | No network calls, no target operations, no credits |
| `preview-mapping [-c path] [--operation kind] [--fixture path] [--json]` | Preview what a response mapping extracts from a JSON fixture | No network calls |
| `probe [-c path] [--yes] [--json]` | Bounded connection check | Prints the plan; `--yes` calls your chatbot. No AugmentWorks call, no credits |
| `catalog list [--json]` / `catalog show <id> [--json]` | List or show the public coverage catalog | Unauthenticated; counts are not a quote |
| `selection compile [--assessment path] [--profile smoke\|release] [--json] [--out path]` | Compile included cases into bounded shards | Not a quote or a run |
| `suite validate <file>` / `suite preview <file>` / `suite preflight <file> [-c path]` | Check an `aw-suite/1`, `/2` or `/3` file | Offline |
| `test [-c path] --assessment path [--profile profile] [--estimate] [--max-credits n] [--yes] [--open]` | Quote or run a hosted assessment | `--estimate` never reserves credits |
| `test [-c path] --suite path [--estimate] [--max-credits n] [--yes] [--headless] [--open]` | Quote or run a hosted suite, including real-data `aw-suite/3` suites | Pins the server-accepted revision. `--headless` never opens a browser |
| `test [-c path] --manifest path [--shard id \| --all-shards] [--execution-id uuid] [--max-credits n] [--yes]` | Run compiled shards | `--all-shards` requires `--max-credits` |
| `test [-c path] --investigation path [--estimate] [--max-credits n] [--yes]` | Reproduce a pinned case from an investigation | New quote every time |
| `test [-c path] --packet name@version [--open]` | Run a hosted packet assessment, such as `support-refunds@0.1.0` | Calls your configured operations |
| `test --local [-c path] --packet reference [--output-dir path] [--open] [--json]` | Run and score a local assessment | Contacts only your chatbot; no AugmentWorks account or service |
| `investigation inspect <file>` / `investigation fetch --run id --evaluation id --attempt id --criterion id` / `investigation export-regression <file> --out path` | Inspect a failure, or export it as a regression draft | Observation only |
| `run status <run-id>` / `run wait <run-id>` / `run retry-evaluation <run-id>` / `run report <run-id>` | Inspect, wait on, re-grade, or export a hosted run | Read-only, except re-grading, which costs no credits and doesn't call your chatbot |
| `compare --run <run-id> --baseline <baseline-id> [--json]` | Compare a run against a pinned baseline | Read-only |
| `gate --run <run-id> --baseline <baseline-id> [--wait] [--json]` | Decide pass or block for a release | Read-only |
| `gate --manifest-file path --declared-shards path [--wait] [--json]` | Decide a whole sharded suite | Read-only; exits `0` only for exact coverage |
| `baseline status` / `baseline create --run <run-id> --name <name> --application <name> --environment <name>` / `baseline promote --run <run-id> --baseline <id> --expected-revision <n>` | List, create, or promote baseline pins | Promotion is never automatic |
| `target add [-c path] --env <environment> [--attest owned \| --attest written --permission-ref <ref>] [--method https\|dns] [--json]` | Register your agent as a workspace target for real-data tests | Workspace owner only; shows the real-data statement the first time |
| `target verify <name> [--env <environment>] [--client-ref <ref>] [-c path] [--timeout-ms n] [--json]` | Verify a target you added | Prints the code to publish and waits for it. Workspace owner only |
| `target list [--suite <file>] [--json]` / `target pull <name> [--env <environment>] [-c path] [--json]` | See targets and scopes; bring a portal-added target into `augmentworks.yaml` | Pull changes only the name, `base_url` and a missing `send` |
| `scope create --target <name> --suite <file> [--env <environment>] [--policy <id>] [--data-origin constructed\|customer_records\|mixed] [--expires YYYY-MM-DD] [--yes] [--json]` | Create a test scope and write it into the suite file | Workspace owner only; asks first. No credits |
| `recover [-c path] [--retire \| --resume \| --cancel] [--json]` | Inspect or recover an interrupted hosted run | Never creates a new run |
| `action recover --state-dir path [--json]` | Retry a saved controlled-action receipt | Controlled actions are not available yet |
| `demo [--json] [--open] [--output-dir path] [--mode full\|faulty\|corrected]` | Packaged loopback refund demo | Contacts only its own 127.0.0.1 server |
| `schema [--kind config\|local-packet\|local-result\|customer-suite\|investigation-export]` | Print a bundled JSON Schema | None |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The assessment passed, or the release gate passed. For `demo`, the fail-then-pass story and cleanup succeeded |
| `1` | Internal or report-generation failure |
| `2` | Configuration, packet, capability, or comparison-scope problem |
| `3` | Hosted authentication failure |
| `4` | Hosted relay or protocol failure |
| `5` | Target, evidence, or indeterminate execution error |
| `6` | Cleanup failure; takes precedence over the assessment result |
| `10` | Checks failed, the assessment was inconclusive, or the release gate blocked |
| `11` | Hosted grading is pending or incomplete; wait on the same run |
| `12` | Hosted judging failed operationally |
| `13` | Hosted billing rejection, such as too few credits |
| `130` | Interrupted after cleanup finished |

## Troubleshooting

Start with `doctor`; it checks the configuration without calling anything.

- **Real-data errors** print what happened, what to do, and the code last:
  `Error: <message> (<CODE>)`. The table in
  [docs/troubleshooting.md](docs/troubleshooting.md#data-scope-and-real-data-errors)
  lists each one.
- **`augmentworks: not found` (exit 127)**: you ran `npx` inside a clone of
  this repository. Run it from another directory.
- **Engine or syntax errors on install**: upgrade Node.js to 22.12 or newer.
- **Exit `11`**: grading is still running. Run `run wait <run-id>` on the same
  run; don't start another.
- **Exit `13`**: the workspace needs credits. Run `usage`, then `billing`.
- **Login works but your chatbot returns 401 or 403**: check the variable that
  `bearer_env` names in `.env`. Your AugmentWorks login is separate.

The full guide is [docs/troubleshooting.md](docs/troubleshooting.md). Security
details are in [docs/security-model.md](docs/security-model.md),
[docs/protocol.md](docs/protocol.md) and [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:pack
```

Commands from a clone run as `node dist/index.js <command>`; see
[docs/command-examples.md](docs/command-examples.md). Repository conventions
are in [CONTRIBUTING.md](CONTRIBUTING.md), the coding-assistant workflow in
[docs/agent-setup.md](docs/agent-setup.md), release notes in
[CHANGELOG.md](CHANGELOG.md), and release history and publishing in
[docs/distribution-runbook.md](docs/distribution-runbook.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
