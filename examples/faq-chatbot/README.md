# Synthetic FAQ chatbot example

This directory is a fictional single-turn JSON HTTP support chatbot and one
local regression check. It is a demo, not a customer test, and it does not
prove that an arbitrary chatbot is supported.

The server file is the packaged response-quality fixture
(`assets/starters/response-quality/server.mjs` in this repository). License:
Apache-2.0 (`LICENSE` at the repository root). `examples/` is not in the npm
tarball. Download it by cloning
[https://github.com/augmentworks-org/augmentworks-cli](https://github.com/augmentworks-org/augmentworks-cli)
and pinning the commit in
`docs/feature-readiness/aug-282-faq-example.md`. Do not use `@latest` and do
not create another public repository for these files.

Published `@augmentworks/cli@0.3.8` and `@augmentworks/cli@0.3.7` do not
contain this directory or the `AW_FAQ_POLICY` switch. `init` from those
registry tarballs writes an older server that always returns the 30-day
sentence. A later npm release is required before a guide claims the published
package includes the stale-answer control. The commands below run the
published `@augmentworks/cli@0.3.8` binary against these git files.

Hosted real-data quote and admission stay release-disabled. Do not point a
hosted run at production records. This text is not legal approval.

## What the two runtimes do

| Check | Runtime | What a pass means |
| --- | --- | --- |
| `packet.json` | Local `test --local` | The mapped `answer` contains `within 30 days` and does not contain `within 14 days`. No LLM judge. No AugmentWorks account. No observation of customer application state. |
| `AW_FAQ_POLICY=stale` | Same local packet | The fixture answers with the 14-day sentence on purpose. Exit `10` means the check failed. It does not mean the CLI crashed. |
| `own-chatbot.suite.yaml` from `init` | Hosted `test --suite` | Optional paid grading, including LLM rubrics, after a human login and `--max-credits`. Not this example. |

Chat-only evidence is the assistant sentence. There is no `observe` hook, so
a passing answer is not proof that an order, refund, or other customer record
changed.

## Fixed question and answers

Question sent by `packet.json`:

```text
How long is the unused-item return window?
```

| `AW_FAQ_POLICY` | Answer | Local exit |
| --- | --- | --- |
| `current` (default) | `Orders placed in the synthetic catalog may be returned within 30 days when the item is unused.` | `0` |
| `stale` | `Orders placed in the synthetic catalog may be returned within 14 days when the item is unused.` | `10` |
| any other value | Server prints `AW_FAQ_POLICY must be current or stale.` and exits `2` before listening | CLI is not started |

Any other value of `AW_FAQ_POLICY` is rejected by the server. Do not invent a
third mode.

## Prerequisites

- Node.js 20 or newer (`package.json` `engines.node` is `>=20` on
  `@augmentworks/cli@0.3.8`).
- A shell whose current directory is **not** a checkout of this CLI
  repository. Inside the checkout, `npx` can bind the local package and exit
  `127` with `augmentworks: not found`.
- No AugmentWorks account, API key, or hosted credit.

Tested platform for the clean-room run recorded in
`docs/feature-readiness/aug-282-faq-example.md`: bash on Linux. Command
Prompt lines below are the same file operations and were not executed in that
run.

## Setup

```bash
git clone https://github.com/augmentworks-org/augmentworks-cli.git
cd augmentworks-cli
git checkout COMMIT
cd ..
rm -rf faq-clean
mkdir faq-clean
cp -a augmentworks-cli/examples/faq-chatbot/. faq-clean/
cd faq-clean
[ -f .env ] || cp .env.example .env
chmod 600 .env
```

`COMMIT` is `example_commit` in
`docs/feature-readiness/aug-282-faq-example.md`. `chmod 600` is POSIX. It was used on the Linux clean-room run. Windows
Command Prompt was not executed in that run:

```cmd
if not exist .env copy .env.example .env
```

Edit `.env` locally if you replace `CHATBOT_API_KEY`. YAML stores the name
`CHATBOT_API_KEY`, never the value. Do not paste `.env` into a chat, issue,
or model conversation. Do not run `cp .env.example .env` again after `.env`
exists: that shell copy overwrites the file. `init --force` also never
replaces an existing `.env`.

## Pass

Terminal A, from `faq-clean`:

```bash
AW_FAQ_POLICY=current node --env-file=.env server.mjs
```

Expected server log:

```text
Response-only mock listening on http://127.0.0.1:8765
```

Terminal B, from the same `faq-clean` directory (still outside the CLI
checkout):

```bash
npx --yes @augmentworks/cli@0.3.8 doctor -c augmentworks.yaml
npx --yes @augmentworks/cli@0.3.8 preview-mapping -c augmentworks.yaml --operation send --fixture ./fixtures/send-response.json
npx --yes @augmentworks/cli@0.3.8 test --local -c augmentworks.yaml --packet ./packet.json
echo "local-exit:$?"
```

`doctor` stays offline. It can still print
`WARN ASSESSMENT_FILE_ABSENT` because this directory has no hosted assessment
file. That warning is not a failure. A passing doctor ends with
`Doctor passed.` and exit `0`.

`preview-mapping` does not call the server. `Missing required fields` is
`(none)`.

`test --local` calls only `http://127.0.0.1:8765`. Progress is on stderr:

```text
LOCAL MODE — only the configured target will be contacted.
Starting 1 local attempt(s).
Running faq-chatbot-return-window.direct repetition 1.
Attempt passed.
```

The summary is on stdout:

```text
Local assessment passed.
```

The report paths follow that summary and change every run. Stdout also repeats the trust line:

```text
Local, customer-executed result. AugmentWorks did not receive or independently verify this run. This artifact is unsigned and is not a certification, audit, or hosted evidence record.
```

Exit `0`. `--json` prints `AW-LOCAL-RESULT-1` with `"outcome": "passed"`.
Do not add `--open` in a headless shell; `--open` only opens the local HTML
file.

## Forced failure

Stop is not required if you restart the server. In terminal A, stop the
process with Ctrl+C, then:

```bash
AW_FAQ_POLICY=stale node --env-file=.env server.mjs
```

Same packet, same published CLI:

```bash
npx --yes @augmentworks/cli@0.3.8 test --local -c augmentworks.yaml --packet ./packet.json
echo "local-exit:$?"
```

Expected stderr includes `Attempt failed.` Expected stdout:

```text
Local assessment failed.
```

Exit `10`. `"outcome": "failed"` in `--json`. Both
`states-30-day-window` and `omits-stale-14-day-window` are false because the
answer says `within 14 days`.
Exit `10` is a failed check. Exit `0` would mean the stale answer was treated
as a pass, which is wrong.

## Cleanup

In terminal A, press Ctrl+C once and wait until the process exits. Then, from
the parent of `faq-clean`:

```bash
rm -rf faq-clean
```

That removes `.env` and `.augmentworks/runs/`. Do not run `logout`. This
example never logged in. A hard kill can skip the server's `close` handler;
the loopback process still ends when the process ends. Nothing is created in
an AugmentWorks workspace.

## Common errors

| Situation | What you should see | Exit |
| --- | --- | --- |
| `node` is not on `PATH` | The shell reports that `node` or `npx` was not found. The CLI does not start. | Shell status, often `127` |
| Node.js older than 20 | Outside this package's `engines.node` range. The clean-room run used Node.js 20 or newer. | Not a tested CLI exit |
| No `.env` and neither variable is set | `ERROR ENV_REQUIRED` for `CHATBOT_BASE_URL` (`target.base_url`) and `CHATBOT_API_KEY` (`target.auth.bearer_env`). `Doctor found configuration errors.` | `2` |
| `.env` created with `cp` and left world-readable | `WARN ENV_FILE_PERMISSIONS` and doctor can still exit `0`. `chmod 600 .env` removes that warning. | `0` |
| `augmentworks.malformed.yaml` | `ERROR YAML_PARSE_ERROR` and the parser message. For this file: `Flow sequence in block collection must be sufficiently indented and end with a ]`, then the config path. `Doctor found configuration errors.` | `2` |
| `augmentworks.incompatible.yaml` | `doctor` can still pass. `preview-mapping` lists `content` / `$.reply` under `Missing required fields`, prints `ERROR MAPPING_VALUE_MISSING: No value exists at $.reply.`, and exits `2`. `probe --yes` exits `5` and prints `ERROR PROBE_RESPONSE_SELECTOR` plus `Mapped field content was missing at $.reply.` It also says this is not a chatbot semantic failure. Neither exit is `10`. | preview `2`, probe `5` |
| `AW_FAQ_POLICY=wrong` | `AW_FAQ_POLICY must be current or stale.` | Server `2` |
| Stale answer with the pass packet | `Local assessment failed.` | `10` |
| `npx` run inside this CLI checkout | `augmentworks: not found` | `127` |
| Existing `.env` | Leave it. `cp .env.example .env` overwrites it. `init --force` prints `preserved` for that `.env` and does not replace it. | |

`doctor` does not call the chatbot. A green doctor with a wrong `$.reply`
mapping is an offline config check, not a content pass. `.env` is loaded from
the directory that contains the selected `-c` file, not from the shell's
current directory when those differ.

```bash
npx --yes @augmentworks/cli@0.3.8 doctor -c augmentworks.malformed.yaml
npx --yes @augmentworks/cli@0.3.8 preview-mapping -c augmentworks.incompatible.yaml --operation send --fixture ./fixtures/send-response.json
npx --yes @augmentworks/cli@0.3.8 probe -c augmentworks.incompatible.yaml --yes
```

## Next step

Local validation is the pass command and the stale-policy command above.
Hosted authorization is a separate human action. Open
`/docs/agent-setup` on the product site, then run
`npx --yes @augmentworks/cli@0.3.8 login` only after a person approves it.
Pricing is `/pricing` on the product site.
The website's adopted production-compatible pin is still
`@augmentworks/cli@0.3.7`, recorded at
`/llms.txt` on the product site.
Supported HTTP limits for that pin are the
`/docs/quickstart` on the product site and the
`/docs/connectors/http` on the product site.
There is no separate compatibility URL.

Do not start hosted `test`, `test --suite`, or `test --assessment` from this
directory as part of the demo. Those commands can quote or spend credits.
`npx --yes` only skips the npm prompt.
