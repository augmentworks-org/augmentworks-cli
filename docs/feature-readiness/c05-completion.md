# C05 completion record

Work package C05 / Linear [AUG-24](https://linear.app/augmentworks/issue/AUG-24/cli-implement-one-explicit-session-mode-and-truthful-multi-turn): one explicit session mode and truthful multi-turn advertisement.

This is the CLI (`augmentworks-org/augmentworks-cli`) record for F06 session capability. It is **code complete** in this repository.

It is **not** npm-published. Source integration is distinct from release acceptance under AUG-7.

## Source and implementation identity

| Item | Value |
| --- | --- |
| Audit / default-main baseline | `8a9f31a9fa6d99b2f0ea7e1530a4b73741592027` |
| Working base (`origin/main`) | `eb6632a4501dbd8083563c92c3975c241082f5a0` (PR #27) |
| Working branch | `cursor/explicit-session-mode-2de5` |
| Implementation commit | `569434545eb54958beb60a3f8c6d4c1418e2a562` |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/30 |
| Consumed C04 / AUG-20 | Linear-published contract only. Package `aw-conversation-enforcement/1`. Strategy `explicit_session_v1` with `conversationId === attemptId`. Main PR https://github.com/augmentworks-org/augmentworks/pull/59. Implementation `a39edbf4324438c495b763f93167bb12b48fb8f1`. Head `649486ed2acdfdd3e5ce58f13ef70a59b49f3900`. Schema checksum prefix `7b6be959…`, fixtures `98f68b82…`. This environment cannot read `augmentworks-org/augmentworks` (GitHub 404); full checksums are **not** invented here. |
| Consumed CLI predecessors | AUG-12 C06 is on default main (`preview-mapping`). AUG-18 billing starter identity remains the vendored `aw-billing/1` lock below. |
| Config schema | v1 (`target.conversation` additive, optional) |
| Conversation package | `aw-conversation-enforcement/1` |
| Billing contract (untouched) | `aw-billing/1` from `650472d91442a6866a7b6ef18e6dacc23a2a9260`; schema `3097c7aa74233e97233dcc488ba7eaacb1be5c6af0554bc308ca1569d155b645`; fixtures `a4b9234b426f98132ddbd8e82755caa0aa718c4ec1e3bf17064d1bf364a6cb84` |
| Run-report contract (untouched) | `aw-run-report/1`; schema `7726ec277d33e435d2832e8be0898baf9337631d779f073a10c7795fc7de38ff`; fixtures `febd2626c96672d0e79afc4706b3a5136598b61bbebbdeb0f8ec1bdbc44cd806` (AW-QA-1) |
| Migrations | None. This repository does not own SQL. |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified |
| Competing open PRs | #28 (report completeness) and #29 (criterion wire) do not own C05 write paths. CHANGELOG is additive. |

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| Code completion (this repository) | **Complete.** One advertised multi-turn mode: `explicit_session_v1`. Single-turn remains the default. |
| Deterministic verification | **Passed** in this checkout. Commands and real outcomes below. |
| Live hosted assessment / npm publish | **Not run / not done.** |
| Release readiness | **Not ready.** Published npm remains `@augmentworks/cli@0.3.2`. |

## Interfaces

`src/config/conversation.ts` (re-exported from `src/config/index.ts`):

- `resolveConversation(config)` → `ResolvedConversation`
- `advertisedTargetCapabilities(resolved)` — estimate, execute, and `connect` share this object
- `assertConversationSupportsPacket({ resolved, packetRequiresMultiTurn, packetLabel? })` — fail-closed before authenticate/quote/reservation
- Validation diagnostics: `CONVERSATION_SINGLE_TURN`, `CONVERSATION_EXPLICIT_SESSION`, `SESSION_CONVERSATION_ID_UNMAPPED`, `SESSION_CONVERSATION_ID_UNEXPECTED`, `SESSION_STRATEGY_UNSUPPORTED`, `SESSION_IDEMPOTENCY_UNDECLARED`

Hosted advertisement:

- Single-turn **omits** `multi_turn` and `conversation` so older servers keep accepting genuinely single-turn plans.
- Session mode sends `multi_turn: true` and `conversation: { version: "aw-conversation-enforcement/1", strategy: "explicit_session_v1" }`.
- A boolean `multi_turn: true` flag without that strategy is rejected by `TargetCapabilitiesSchema`.

Attempt identity:

- At the send boundary the CLI sets `conversation_id` equal to `attempt_id`.
- The HTTP connector injects that field **only** when `strategy === explicit_session_v1`.
- Whole-body `$input` passthrough is accepted as a session mapping when session mode is declared. It is **not** treated as an unexpected session field on single-turn configs (refund-agent / resume compatibility).
- Mapping `$input.attempt_id`, `$input.run_id`, or `$input.turn_id` is correlation only.

YAML:

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

`send.idempotent: true` is a target-contract declaration: repeating the same `AW-Idempotency-Key`, conversation identifier, and `turn_id` must not append a second accepted user message. The CLI does not claim arbitrary endpoints are idempotent. Journal replay of a completed command still skips re-execution regardless.

Admission:

- Hosted packets whose required capabilities include `multi_turn` fail with `CONVERSATION_CAPABILITY_INCOMPATIBLE` (config, exit 2) **before** authenticate, quote, or create.
- Local packets fail with `MULTI_TURN_REQUIRED` / `LOCAL_PACKET_INCOMPATIBLE`.
- Current product packets keep `multi_turn: false`; existing single-turn assessments are unchanged.
- Custom-profile exclusion of incompatible cases remains main-owned (C04). The CLI does not silently shrink coverage.

## Examples

Default `examples/response-agent/augmentworks.yaml` stays **single-turn**.

Intentional migration (not a starter rewrite; C07 owns `assets/starters/`):

```bash
cp .env.example .env
node --env-file=.env session-server.mjs
node dist/index.js doctor -c augmentworks.session.yaml --offline
```

Files:

- `examples/response-agent/augmentworks.session.yaml`
- `examples/response-agent/session-server.mjs`

The fixture target isolates sessions by `conversation_id`, recalls a prior color, applies a corrected return-window fact, and suppresses duplicate accepted turns using `AW-Idempotency-Key` + conversation id + `turn_id`. A chatbot that does not recall context returns a miss string; a missing session identifier is `SESSION_CONVERSATION_ID_MISSING` or HTTP `session_required`.

Do not document `npx @augmentworks/cli@0.3.3`.

## Test evidence

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | Pass (`tsc --noEmit`) |
| `npm test` | Pass. **62 files, 583 tests** (vitest 4.1.11) |
| `npm run build` | Pass. `dist/index.js` 1.75 MB |
| `npm run check:discovery` | Pass. `@augmentworks/cli@0.3.3 (development)` |
| `npm run check:billing-contract` | Pass. Untouched `aw-billing/1` hashes above |
| `npm run check:run-report-contract` | Pass. Untouched `aw-run-report/1` hashes above |
| `npm run check` | Pass (typecheck + test + build + the three contract checks) |
| `npm run smoke:pack` | Pass. Packed tarball **34 files, 396572 compressed bytes**. Packed billing fixture: `creates=1 quotes=4 targets=1 polls=3 refreshes=1`. Packed report fixture: `requests=3`. Includes PR #27 `init --config` smoke. |
| Live hosted assessment / npm publish | **Not run** |

Behavior covered (synthetic fixtures only):

- Follow-up requiring previous context succeeds in one attempt; a second attempt cannot read that history (`test/integration/session-mode.test.ts`).
- Two simultaneous attempts stay isolated; a repetition uses a fresh identifier.
- Corrected fact in the same attempt is the last written return window.
- Replaying an accepted turn with the same idempotency key does not append a second user message.
- Missing `attempt_id` is a connector/session failure (`SESSION_CONVERSATION_ID_MISSING`), distinct from a chatbot miss string.
- Estimate and execute send identical capability objects; assessment files no longer imply `multi_turn` (`test/commands/conversation-admission.test.ts`, `test/cloud/create-run.test.ts`).
- Unsupported multi-turn plans throw `CONVERSATION_CAPABILITY_INCOMPATIBLE` with zero capabilities/quote/create HTTP calls.
- Relay resume of a completed send skips re-execution and keeps `conversation_id === attempt_id` (`test/relay/runner.test.ts`).
- `history_array_v1` and unknown strategies are rejected. Mapping `conversation_id` without declaring session mode is rejected. Mapping `attempt_id` is not a session.

## Compatibility

- Existing custom single-turn mappings are unchanged. `conversation_id` is not injected unless `explicit_session_v1` is configured.
- `$input` whole-body passthrough remains valid single-turn (refund-agent, create-resume).
- Local deterministic packets with `required_capabilities.multi_turn: false` are unchanged.
- Billing quote, reservation, recovery, and finite `--max-credits` consent are unchanged. Observation/recovery does not create a new billable run.
- `assets/starters/` was not edited (C07). E06 suite-authoring commands were not added.
- Published `@augmentworks/cli@0.3.2` does not include this mode.

## Remaining release requirements

- Review/merge of https://github.com/augmentworks-org/augmentworks-cli/pull/30
- npm publication of a version that contains `explicit_session_v1` (not 0.3.2)
- AUG-7 release-acceptance against the published tarball
- C07 starter/probe recipes should document the session mapping rather than duplicating it
- E06 suite authoring consumes this completed session capability
- Keep AUG-24 **In Review** until source review; do not mark Done from this record
- Do not weaken merge/deployment permissions or activate live billing
