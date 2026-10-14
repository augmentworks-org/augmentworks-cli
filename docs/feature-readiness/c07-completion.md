# C07 completion record

Work package C07 / Linear [AUG-35](https://linear.app/augmentworks/issue/AUG-35/cli-complete-own-target-starter-recipes-and-an-explicit-bounded): complete own-target starter recipes and an explicit bounded connection probe.

This is the CLI (`augmentworks-org/augmentworks-cli`) record for F05/F06 own-target starters and probe. It is **code complete** in this repository.

It is **not** npm-published. Source integration is distinct from release acceptance under AUG-7.

## Source and implementation identity

| Item | Value |
| --- | --- |
| Audit / default-main baseline | `8a9f31a9fa6d99b2f0ea7e1530a4b73741592027` |
| Working base (`origin/main`) | `d9c0fb8e5c4a9c235cca9085b2d3870825e36cfd` (merge of CLI PR #31 / AUG-32) |
| Working branch | `cursor/own-target-starter-probe-b534` |
| Implementation commit | `d18c01ae7db19858b558e1cfac71cf1bec530ede` |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/32 |
| AUG-24 (C05) | Merged CLI#30 `29aa07e`. Handoff `docs/feature-readiness/c05-completion.md`. Probe session turns use `explicit_session_v1`; success is not a chatbot-memory claim. |
| AUG-12 (C06) | Merged CLI#20 `e767e75` / CLI#21 `fa24dae`. Handoff `docs/feature-readiness/c06-completion.md`. Probe reuses `previewMapping` on captured JSON. |
| AUG-32 (E06) | Merged CLI#31 `d9c0fb8`. Handoff `docs/feature-readiness/e06-completion.md`. Packaged `own-chatbot.suite.yaml` is `aw-suite/1` with five FAQ cases. |
| AUG-18 / AUG-25 | Linear-recorded Done at dispatch (main#53 `e925bd0`, main#74 `71fc0d4`). This environment cannot read `augmentworks-org/augmentworks` (GitHub 404); those SHAs are not re-fetched here. |
| Competing open PRs at start | None. Rechecked before edit. `src/commands/test.ts` was not modified (C12 / AUG-46). |
| Config schema | v1 unchanged (`CONFIG_VERSION = 1`). Probe JSON is `AW-CONNECTION-PROBE-1`. |
| Billing contract (untouched) | `aw-billing/1` from `650472d91442a6866a7b6ef18e6dacc23a2a9260`; schema `3097c7aa74233e97233dcc488ba7eaacb1be5c6af0554bc308ca1569d155b645`; fixtures `a4b9234b426f98132ddbd8e82755caa0aa718c4ec1e3bf17064d1bf364a6cb84` |
| Run-report contract (untouched) | `aw-run-report/1`; schema `7726ec277d33e435d2832e8be0898baf9337631d779f073a10c7795fc7de38ff`; fixtures `febd2626c96672d0e79afc4706b3a5136598b61bbebbdeb0f8ec1bdbc44cd806` (AW-QA-1) |
| Suite lock (untouched) | `contracts/aw-suite-v1.lock.json`; `aw-feature/1` schema `4f026740a349c736e98af95599736a92cb81246bea3a1673b26e7fa94cadc870` |
| Migrations | None. This repository does not own SQL. |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified |

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| Code completion (this repository) | **Complete.** One initializer, two own-target patterns, packaged fixture servers, explicit `probe`. |
| Deterministic verification | **Passed** in this checkout. Commands and real outcomes below. |
| Live hosted assessment / npm publish | **Not run / not done.** |
| Release readiness | **Not ready.** Published npm remains `@augmentworks/cli@0.3.2`. |

## Interfaces

Pure module `src/connector/connection-probe.ts` (exported from `src/connector/index.ts`):

- `planConnectionProbe(resolved)` / `runConnectionProbe({ resolved, execute })`
- Response-only: 1 send. `explicit_session_v1`: send + follow-up. Stateful: prepare → send → observe → cleanup (cleanup always after prepare). Bound: 5 calls, 45s overall.
- Diagnostics: `connection_refusal`, `timeout`, `authentication`, `response_selector`, `conversation_session`, `cleanup`, `target`. Exit 0 / 5 / 6. Never exit 10 (not a semantic assessment).
- `credits_consumed: 0`, `hosted_contacted: false`. Correlation ids `probe_<hex>`; session `conversation_id === attempt_id`.

CLI (additive Commander registration after `preview-mapping` in `src/cli.ts`):

```text
augmentworks probe [-c path] [--yes] [--json]
```

Without `--yes`: preflight only, no HTTP. `--yes` executes the printed plan against the configured target only. Doctor and init never probe. Hosted billable work still uses `test --estimate` / `--max-credits N --yes`.

One initializer (`src/commands/init.ts` + `src/onboarding/starters.ts`):

| `--starter` | Pattern | Generated hooks |
| --- | --- | --- |
| `response-quality` (`response-only`, `chat`) | Response-only JSON chat | `send` only, five-question suite, dual-mode + session fixture servers |
| `workflow` (`stateful`) | Stateful tool workflow | `prepare` / `send` / `observe` / `cleanup` |

Unknown names (including `streaming`, `websocket`, `history-array`, marketplace) return `INIT_STARTER_UNKNOWN` with an actionable boundary.

## Examples (packaged; `examples/` is git-only)

Copied by `init` from `assets/starters/` (these **are** in the npm tarball):

- `assets/starters/response-quality/` — YAML, session YAML, assessment, `own-chatbot.suite.yaml` (five FAQ cases), references, fixtures, `server.mjs`, `session-server.mjs`, `OWN-TARGET.md`
- `assets/starters/workflow/` — YAML, assessment, refund-policy reference, fixtures, `server.mjs` (probe-ack, `[aw-tool-failure]` without state change, cleanup), `OWN-TARGET.md`

Git-only copies remain byte-aligned for development:

- `examples/basic-chat/server.mjs`
- `examples/response-agent/server.mjs` + `session-server.mjs`
- `examples/refund-agent/server.mjs`

Do not document `npx @augmentworks/cli@0.3.3`. Source commands use `node dist/index.js`. Packed testers use the installed `augmentworks` binary.

## Test evidence

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | Pass (`tsc --noEmit`) |
| `npm test` | Pass. **70 files, 674 tests** (vitest 4.1.11, 22.26s). Hosted `AUGMENTWORKS_API_KEY` was unset for this run so test tokens did not trip `AUTH_ENV_CONFLICT`; that env var is an agent-workspace credential, not a product change. |
| `npm run build` | Pass. `dist/index.js` 1.85 MB |
| `npm run check:discovery` | Pass. `@augmentworks/cli@0.3.3 (development)` |
| `npm run check:billing-contract` | Pass. Untouched `aw-billing/1` hashes above |
| `npm run check:run-report-contract` | Pass. Untouched `aw-run-report/1` hashes above |
| `npm run check` | Pass when the same `AUGMENTWORKS_API_KEY` unset is applied before `npm test`. A first `npm test` with the agent API key still set failed 52 subprocess billing/relay tests with `AUTH_ENV_CONFLICT` (exit 3). Unrelated to probe. |
| `npm run smoke:pack` | Pass in **15s**. Packed tarball **53 files, 428969 compressed bytes**. Packed `--help` lists existing commands plus `probe`. Packed `probe --help` documents `--yes` and “Never runs during doctor or init”. Workflow `init` writes `server.mjs` / `OWN-TARGET.md`; doctor prints `CONNECTION_PROBE_AVAILABLE` without calling the target; `probe` without `--yes` against `127.0.0.1:1` does not execute; `probe --yes` against the **generated** workflow `server.mjs` made prepare/send/observe/cleanup (4 calls, 0 credits). Response-only `init --starter response-only` wrote send-only YAML, validated the five-case suite, previewed mappings, and probed one send against generated `server.mjs`. Local packet still passed on that generated workflow server (no `examples/` in the tarball). Packed billing fixture: `creates=1 quotes=4 targets=1 polls=3 refreshes=1`. Packed report fixture: `requests=8`. |
| Live hosted assessment / npm publish | **Not run** |

Focused slice before the full suite: `npx vitest run test/connector/connection-probe.test.ts test/commands/probe.test.ts test/integration/own-target-starters.test.ts test/integration/cli-entry.test.ts test/docs/copy-contract.test.ts test/docs/agent-resources.test.ts test/release.test.ts test/config/commands.test.ts` → **8 files, 108 passed**.

Behavior covered (synthetic fixtures only):

- Preflight does not call `fetch`. Doctor and init make zero target calls and emit `CONNECTION_PROBE_AVAILABLE`.
- Response-only probe: 1 send, secret redaction, 0 credits.
- Stateful probe: 4 phases; cleanup after send mapping failure; cleanup HTTP 500 → exit 6.
- Diagnostics: connection refusal (`ECONNREFUSED` on a valid unused port), 401, missing selector, `session_required`.
- Starter aliases `response-only` / `stateful`; unknown `streaming` names WebSocket / history-array / marketplace.
- Five FAQ cases load after authoring rewrite (`faq.returns-window` … `faq.warranty`). Mixed 14-day/30-day windows are refused by existing suite policy, so `old-returns.md` is packaged but **not** attached to the suite.
- Packed help/dispatch for login, logout, whoami, usage, billing, init, doctor, preview-mapping, probe, demo, test, suite, run, recover, schema. No replacement of the Commander registry.

## Observed time and undocumented assistance

These are measured wall times on this Cloud Agent checkout, not a newcomer tutorial claim:

- Focused C07 tests: **4.4s**
- Full `npm test` (674 tests): **22.3s**
- `npm run smoke:pack` (including tarball init of both patterns, probe, local packet, demo, billing/report fixtures): **15s**

No 15-minute “time to first own-target result” was measured with a newcomer, so none is advertised.

Undocumented assistance: the Cloud Agent workspace had `AUGMENTWORKS_API_KEY` set. Subprocess tests that inject `AUGMENTWORKS_TOKEN` fail with `AUTH_ENV_CONFLICT` unless that API key is unset. Validation used `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN`. No extra human walkthrough and no hidden chain of thought were used as evidence.

## Compatibility

- One initializer. No second `connect` command. No streaming/WebSocket/history-array adapter. No automatic production-target calls.
- Response-only YAML has no prepare/observe/cleanup.
- Probe does not quote, reserve, or create a hosted run. Finite spend consent remains `--max-credits N` on `test`.
- Billing identity, quotes, reservation/settlement, and original-run recovery are unchanged.
- Published `@augmentworks/cli@0.3.2` does not include `probe` or these starter files.

## Remaining release requirements

- [AUG-73](https://linear.app/augmentworks/issue/AUG-73/cli-publish-a-verified-customer-owned-assessment-release) publishes a verified npm package. Do not document `npx @augmentworks/cli@0.3.3` until that tarball is independently verified.
- [AUG-58](https://linear.app/augmentworks/issue/AUG-58/main-verify-deployed-api-key-password-and-published-cli-qa-integration) verifies deployed API-key / password QA against the published CLI.
- [AUG-7](https://linear.app/augmentworks/issue/AUG-7/gate-automated-merges-and-verify-releases-before-marking-tickets-done) remains the merge/release automation owner. This work does not weaken approval rules or activate live billing.
- [AUG-46](https://linear.app/augmentworks/issue/AUG-46/cli-consume-catalog-metadata-and-deterministic-suite-selections-with) (C12) still owns catalog-selection wiring in `test.ts`.
- [AUG-74](https://linear.app/augmentworks/issue/AUG-74) adopts public/portal instructions after publication.

Keep AUG-35 **In Review**. Source integration is not Done until reviewers accept this PR; npm publication is a later ticket.
