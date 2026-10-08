# AUG-282 FAQ example handoff

Website guides can reuse this directory. It is a fictional single-turn JSON
HTTP chatbot, not a customer test and not proof that an arbitrary chatbot is
supported. Hosted real-data quote and admission stay release-disabled.

## Reusable paths

| Item | Path |
| --- | --- |
| Directory | `examples/faq-chatbot/` |
| Server | `examples/faq-chatbot/server.mjs` (same bytes as `assets/starters/response-quality/server.mjs` in the example commit) |
| Connector | `examples/faq-chatbot/augmentworks.yaml` |
| Packet | `examples/faq-chatbot/packet.json` |
| Pass fixture | `examples/faq-chatbot/fixtures/send-response.json` |
| Malformed config | `examples/faq-chatbot/augmentworks.malformed.yaml` |
| Wrong selector | `examples/faq-chatbot/augmentworks.incompatible.yaml` |
| Walkthrough | `examples/faq-chatbot/README.md` |

License: Apache-2.0, `LICENSE` at the repository root. Download path: clone
`https://github.com/augmentworks-org/augmentworks-cli` and check out
`example_commit` below. `examples/` is omitted from the npm tarball. Do not
create another public repository for these files.

`example_commit` is the commit that added these fixture bytes. The handoff
line below was recorded in the following commit, so that SHA is not inside
`example_commit` itself. Pin `example_commit` for the files. Do not use
`@latest`.

## Question, answers, exits

Question in `packet.json`: `How long is the unused-item return window?`

| Control | Answer | `test --local` exit |
| --- | --- | --- |
| `AW_FAQ_POLICY=current` (default) | `Orders placed in the synthetic catalog may be returned within 30 days when the item is unused.` | `0`, stdout `Local assessment passed.`, stderr `Attempt passed.` |
| `AW_FAQ_POLICY=stale` | `Orders placed in the synthetic catalog may be returned within 14 days when the item is unused.` | `10`, stdout `Local assessment failed.`, stderr `Attempt failed.` |

On the stale run, JSON `outcome` is `failed`. Assertions
`states-30-day-window` and `omits-stale-14-day-window` are both false.
Exit `10` is a failed check. Local scoring is substring checks in
`aw-packet/0.1`. It is not hosted LLM judging and it does not observe
customer application state. There is no `observe` hook.

## Clean-room evidence

| Field | Value |
| --- | --- |
| Evidence date | 2026-10-08 |
| Shell | bash on Linux. Windows Command Prompt lines in the example README were not executed. |
| Node.js | `v22.14.0` (`/exec-daemon/node` in the clean-room environment) |
| Missing `node` | `PATH=/bin:/usr/bin node --version` printed `node: command not found` and exited `127` |
| Published CLI exercised | `@augmentworks/cli@0.3.8` from the npm registry, current directory outside this checkout |
| Registry shasum | `009bc1739654c704b75967214ef9604374bd9a92` |
| Registry integrity | `sha512-T+e1VWQ8plx0jJMdkOHxocpH8SjCr9BSeRLMsCnCHAO0Z3z9bhgIf0um9x6eyWJfwPz01YOL7CZvM6sLTiSLIA==` |
| Registry `gitHead` | Omitted on the 0.3.8 version document. Tag `v0.3.8` remains `f36d9086bad1ac109a7670e8acc9bf14a5d15047`. |
| Tarball | 74 files. No `examples/` member. `package/assets/starters/response-quality/server.mjs` has no `AW_FAQ_POLICY`. |
| `init --force` from 0.3.8 | Printed `preserved` for an existing `.env` and left `CHATBOT_API_KEY=keep-this-marker` in place. The generated `server.mjs` has no `AW_FAQ_POLICY`. |
| Inside this checkout | `npx --yes @augmentworks/cli@0.3.8 doctor --help` exited `127` with `augmentworks: not found`. |
| Website-adopted pin | `@augmentworks/cli@0.3.7` (`gitHead` `876454878a31a897aec1d722fa838c9c0ecea2aa`) as stated by `/llms.txt` on the product site on this date. The same pass exit `0` and stale exit `10` were observed with that binary against these git files. Executable examples in this repository stay pinned to `@augmentworks/cli@0.3.8`. |
| Published npm description | Still `Deterministic hosted and customer-executed local testing for AI agents` on both 0.3.8 and 0.3.7. The source `package.json` description change is not in those tarballs. |
| Hosted `test` | Not run. No login, quote, credit reservation, or provider call. |

`example_commit: 66c23e9ed97e9d52bebd52abecb159528852efbe`

## Publication prerequisite

Source readiness is not npm publication. Do not tell a downstream guide that
`npx @augmentworks/cli@0.3.8` or `@0.3.7` `init` writes `examples/faq-chatbot/`
or the stale-policy switch. A later release is required before that claim.
This change adds no CLI command and does not publish a package.

## Operator checks still open

- `example_commit` is recorded above. Pin that SHA after this branch is on the default branch. Checking out only that SHA omits this later handoff sentence and still contains the fixture bytes.
- Website adoption of `@augmentworks/cli@0.3.8`, and of any later package that
  contains `AW_FAQ_POLICY`, is a website change. This repository does not
  update the product website.
- Windows Command Prompt was not executed.
- No hosted authorization, paid run, or customer-target evidence was collected.
