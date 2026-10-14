# C06 completion record

Work package C06 / Linear [AUG-12](https://linear.app/augmentworks/issue/AUG-12/cli-preview-response-mappings-and-the-exact-sanitized-evidence-payload): preview response mappings and the exact sanitized evidence payload locally.

This is the CLI (`augmentworks-org/augmentworks-cli`) record for F05/F13 mapping preview. It is **code complete** in this repository.

It is **not** npm-published. Source integration is distinct from release acceptance under AUG-7.

## Source and implementation identity

| Item | Value |
| --- | --- |
| Audit / default-main baseline | `8a9f31a9fa6d99b2f0ea7e1530a4b73741592027` |
| Working branch | `cursor/preview-mapping-e212` |
| Feature commit | `fa6b664f2af5aab610d55f3ba6246f034a0bbc9e` |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/20 |
| Consumed dependency commits | None. C06 has no blocking implementation PRs. Open CLI PRs at start: none. |
| Schema versions | Unchanged. Config remains v1 (`CONFIG_VERSION = 1`). Relay evidence remains `aw-target/0.1`. Preview JSON is `AW-MAPPING-PREVIEW-1`. |
| Billing contract (untouched) | `aw-billing/1` from `67749b22f04bbb8d94c0309acd36be3cb3144400`; schema `4816444925c39629d41fc6993b0206fa5db25641ce40aafc13af6fe1a89ef901`; fixtures `cb26b6d36bf01d7c1957354f8982f20a6cfd8c8c47859f46e37d5270b75dd4a1` |
| Migrations | None. This repository does not own SQL. |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified |

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| Code completion (this repository) | **Complete.** Pure `previewMapping` plus offline `preview-mapping` command registered additively on the existing Commander program |
| Deterministic verification | **Passed** in this checkout. Commands and real outcomes below |
| Live target / hosted run / npm publish | **Not run / not done.** Preview is fixture-only by design |
| Release readiness | **Not ready.** No npm publish. Published `@augmentworks/cli@0.3.1` does not include this command |

## Interfaces

Pure module `src/connector/mapping-preview.ts` (also exported from `src/connector/index.ts` for C07):

- `previewMapping({ config, operation, response?, secrets?, probeKeys? })`
- Reuses `selectResponse`, `redactSecrets`, `shouldOmitMappedResponseField`, and `normalizeConnectorResult`
- Evidence bytes are `canonicalize(result)` from that production normalizer, then SHA-256 of those bytes — the same digest `CloudClient.completeOperation` hashes
- CLI command does **not** load `.env` or `ResolvedConfig.secrets`; C07 may pass `secrets` later without a second sanitizer

CLI:

```text
augmentworks preview-mapping [-c path] [--operation send|observe|cleanup|prepare] [--fixture path] [--probe-keys keys] [--json]
```

Default operation is `send`. `send` and `observe` require `--fixture`. `cleanup` (and empty `prepare`) do not. Chat-only YAML can preview `send` without stateful hooks.

## Examples

Source 0.3.2 (no unpublished npx pin):

```bash
node dist/index.js preview-mapping -c augmentworks.yaml --operation send --fixture ./fixtures/send-response.json
node dist/index.js preview-mapping -c augmentworks.yaml --operation send --fixture ./fixtures/send-response.json --json
```

Synthetic fixtures:

- `examples/response-agent/fixtures/send-response.json`
- `examples/refund-agent/fixtures/send-response.json`
- `examples/refund-agent/fixtures/observe-response.json`
- `test/fixtures/mapping-preview/` (valid, nested synthetic secrets, missing fields, malformed JSON, observe)

Doctor remains offline validation and now emits `MAPPING_PREVIEW_AVAILABLE`.

## Test evidence

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | Pass. 49 files, 399 tests |
| `npm run check:discovery` | Pass. `@augmentworks/cli@0.3.2 (development)` |
| `npm run check:billing-contract` | Pass. Untouched `aw-billing/1` hashes above |
| `npm run smoke:pack` | Pass. Packed tarball **20 files, 362798 compressed bytes**; packed `preview-mapping --help` and `--json` from a clean install with poisoned `AUGMENTWORKS_TOKEN` / `CHATBOT_API_KEY` (neither leaked); existing doctor / local packet / demo still ran |
| Live hosted assessment / npm publish | **Not run** |

Behavior covered:

- Malformed selector (`$.answer[`, `$.__proto__.polluted`) reported with YAML path / offset; no hosted run
- Absent required mapped field reported as `MAPPING_VALUE_MISSING` at `target.operations.send.response.content`
- Same fixture/configuration: preview `evidence.canonical` equals `canonicalize(normalizeConnectorResult(...))` and `canonicalize(HttpConnector.execute(...))`
- Seeded excluded nested secrets never appear in human output, JSON, or error text
- Oversized assistant content shows `TARGET_MESSAGE_TOO_LARGE` truncation and omits the body
- Observe/cleanup preview without invoking send; send-only configs do not require observe/cleanup
- Command does not read `.env`, unrelated files, process env secrets, or `fetch`

## Compatibility

- Additive Commander registration only (`src/cli.ts`). No `test.ts` / `run.ts` rewrite, no parallel registry
- Init templates and generated starter YAML were not edited (C07 owns billing starter integration)
- Session fields were not added (C05)
- Billing initializer, contracts, and live billing were not touched
- Existing commands remain dispatched from the same `createCli` program

## Remaining release requirements

- npm publication of a version that contains `preview-mapping` (not 0.3.1)
- AUG-7 release-acceptance against the published tarball
- C07 should call `previewMapping` rather than duplicating sanitization when it wires starter recipes / connection probe
- Keep AUG-12 In Review until source review; do not mark Done from this record

## Follow-up after #20 (this PR)

[PR #20](https://github.com/augmentworks-org/augmentworks-cli/pull/20) landed the
shipped `previewMapping` implementation on `main`. This branch was the parallel
C06 agent (`cursor/aug-12-end-to-end-ticket-c610`). After rebase it keeps that
implementation and adds:

- JSON parse errors report a numeric position only
- Extra fixtures: unsafe/malformed selectors, send-only, stateful, prepare,
  cleanup, and `examples/basic-chat/fixtures/send-preview.json`
- Command tests for those fixtures and the chat example path
