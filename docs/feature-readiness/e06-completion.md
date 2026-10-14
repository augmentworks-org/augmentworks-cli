# E06 completion — customer-owned suite files (AUG-32)

Issue: [AUG-32](https://linear.app/augmentworks/issue/AUG-32/cli-author-validate-preview-and-run-customer-owned-suite-files)
Repository: `augmentworks-org/augmentworks-cli`
Work package: E06 · Audit coverage: F02

This file is issue-specific. It does not replace C05 (`c05-completion.md`) or
C06 (`c06-completion.md`).

This is the CLI record for F02 customer-owned suite authoring. It is **code
complete** in this repository. It is **not** npm-published. Source integration
is distinct from release acceptance under AUG-7.

## Source and implementation identity

| Item | Value |
| --- | --- |
| Audit / default-main baseline | `8a9f31a9fa6d99b2f0ea7e1530a4b73741592027` |
| Working base (`origin/main`) | `4a08ea0d352f2515e725cb9ca946807112422436` (merge of PR #28; includes merged AUG-24 PR #30) |
| Working branch | `cursor/customer-owned-suites-70eb` |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/31 |
| AUG-24 (C05) | Merged PR #30. Handoff `docs/feature-readiness/c05-completion.md`. Hosted `multi_turn` comes from `target.conversation.strategy: explicit_session_v1`, not from a suite file. |
| AUG-14 (G01) | Done. Billing contract remains vendored `aw-billing/1`. |
| AUG-13 / AUG-14 feature package | `aw-feature/1` schema SHA-256 `4f026740a349c736e98af95599736a92cb81246bea3a1673b26e7fa94cadc870`; fixtures SHA-256 `8f481f4c30fd4db165c738c3333c529a72904c8cf8b00780b40b64e391495f23` |
| AUG-17 (main E05) | Linear Done. Cited by merged AUG-22 as `ad40b3549e882aad5a7f577aa93c289d2a8d2116`; head cited `620dd54`. Handoff `docs/feature-readiness/e05-completion.md` on main. Migration `20260907160001_customer_suite_revisions.sql`. Main PR https://github.com/augmentworks-org/augmentworks/pull/42 |
| Main repository fetch | **Blocked.** `GET https://api.github.com/repos/augmentworks-org/augmentworks` returns HTTP 404 for this agent. Source schema files were **not** byte-copied. Checksums above are Linear-published AUG-13/AUG-17 identities; they are not invented beyond those published values. |
| Live API probe (configured API origin, unauthenticated) | `POST /v1/suites` and `POST /v1/suites/validate` exist (401). `GET /v1/suites/{id}/revisions/{id}` and `/latest` exist (401). `POST /v1/suites/preview` is **404**. Local preview is therefore offline and not a server round-trip. |
| Billing contract (untouched) | `aw-billing/1` from `650472d91442a6866a7b6ef18e6dacc23a2a9260`; schema `3097c7aa74233e97233dcc488ba7eaacb1be5c6af0554bc308ca1569d155b645`; fixtures `a4b9234b426f98132ddbd8e82755caa0aa718c4ec1e3bf17064d1bf364a6cb84` |
| Migrations | None. This repository does not own SQL. |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified |

Lock file: `contracts/aw-suite-v1.lock.json`.

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| Code completion (this repository) | **Complete.** `aw-suite/1` validate/preview offline; hosted `test --suite` pins an immutable revision. |
| Deterministic verification | See Test evidence below. |
| Live hosted assessment / npm publish | **Not run / not done.** |
| Release readiness | **Not ready.** Published npm remains `@augmentworks/cli@0.3.2`. |

## Interfaces

- Schema: `src/suite/schema.ts` (`aw-suite/1`, camelCase canonical; snake_case authoring rewrite).
- Load / validate: `src/suite/load.ts` (path safety, `O_NOFOLLOW`, 64 KiB UTF-8, YAML line diagnostics).
- Preview: `src/suite/preview.ts`, `src/suite/format.ts`.
- Admission mapping: `src/suite/admit.ts` → `CreateRunAssessment` with sentinel packet `{ key: "customer-owned-suite", version: "1.0.0" }`, `profile: custom`, pin `suite_id` / `suite_revision_id` / `suite_content_hash`.
- Protocol: `src/suite/protocol.ts` (`SuiteCreateRequestSchema`). Feature errors parsed only when `schemaVersion` is `aw-feature-error/1`.
- CLI: additive `suite validate|preview` in `src/commands/suite.ts`; `src/cli.ts` registers the command without replacing Commander.
- Hosted run: `src/commands/test.ts` `--suite` (conflicts with `--assessment` / `--packet` / `--local`).
- Client: `CloudClient.createSuiteRevision` / `getSuiteRevision`; `parseFeaturePackageError` in `src/cloud/errors.ts` via `cloudHttpError`.
- JSON Schema dump: `src/commands/schema.ts --kind customer-suite`.

Conversation capability is derived from merged C05 (`explicit_session_v1`), not from the presence of a multi-turn case. `suiteRequiresMultiTurn` is computed from `turns.length > 1` and checked against config **before** authenticate.

## Commands

Source tree (after `npm ci` && `npm run build`):

```bash
node dist/index.js suite validate examples/customer-suites/faq-non-commerce.yaml
node dist/index.js suite preview examples/customer-suites/returns-14-day.yaml
node dist/index.js suite preview examples/customer-suites/faq-non-commerce.yaml --json
node dist/index.js schema --kind customer-suite
node dist/index.js test --suite examples/customer-suites/faq-non-commerce.yaml --estimate
node dist/index.js test --suite examples/customer-suites/faq-non-commerce.yaml --max-credits 30 --yes
```

Do not document `npx @augmentworks/cli@0.3.3`.

Packed binary: `node dist/index.js` from a clean `npm pack` extract (see `scripts/smoke-pack.mjs`). Packed samples live under `assets/customer-suites/` because `examples/` is forbidden in the tarball.

## Examples (this ticket owns these paths only)

- `docs/customer-suites.md`
- `examples/customer-suites/faq-non-commerce.yaml`
- `examples/customer-suites/returns-14-day.yaml`
- Packed copies: `assets/customer-suites/`
- Negative fixtures: `test/fixtures/customer-suites/`

C07-owned `examples/basic-chat/`, `examples/response-agent/`, `examples/refund-agent/`, `docs/configuration.md`, `docs/agent-setup.md`, and `init.ts` were not edited.

## Test evidence

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | Pass (`tsc --noEmit`) |
| `npm test` | Pass. **67 files, 647 tests** (vitest 4.1.11) |
| `npm run build` | Pass. `dist/index.js` 1.82 MB |
| `npm run check:discovery` | Pass. `@augmentworks/cli@0.3.3 (development)` |
| `npm run check:billing-contract` | Pass. Untouched `aw-billing/1` hashes above |
| `npm run check:run-report-contract` | Pass. Untouched `aw-run-report/1` hashes above |
| `npm run check` | Pass (typecheck + test + build + the three contract checks) |
| `npm run smoke:pack` | Pass. Packed tarball **41 files, 415927 compressed bytes**. Includes packed `suite --help`, `test --help --suite`, and offline validate/preview of both packed samples with a poisoned hosted token. Packed billing fixture: `creates=1 quotes=4 targets=1 polls=3 refreshes=1`. Packed report fixture: `requests=8`. |
| Live hosted assessment / npm publish | **Not run** |

Focused suite/regression slice before the full check: `npx vitest run test/suite test/local/packet.test.ts test/docs/copy-contract.test.ts test/config/commands.test.ts test/integration/cli-entry.test.ts test/assessment/cli-flags.test.ts test/billing/cli-quote.test.ts test/commands/conversation-admission.test.ts test/cloud/create-run.test.ts` → **11 files, 147 passed**.

Behavior covered (synthetic fixtures only):

- Offline validate/preview of both sample suites, with poisoned `AUGMENTWORKS_TOKEN` unused.
- Diagnostics: invalid field (`unexpected_widget`), duplicate case ID, missing reference, unsupported schema, unsupported feature (`history_array_v1`), 14-vs-30 contradiction.
- Mocked estimate/consent/admission pins `suite_id` / `suite_revision_id` / `suite_content_hash`. Changing the file after quote throws `SUITE_CHANGED_AFTER_QUOTE` and does not `POST /v1/relay/runs`.
- Server content hash mismatch throws `SUITE_REVISION_HASH_MISMATCH`.
- Noninteractive `--yes` without `--max-credits` throws `MAX_CREDITS_REQUIRED` before authenticate or suite HTTP. No browser open.
- Multi-turn suite vs single-turn connector throws `CONVERSATION_CAPABILITY_INCOMPATIBLE` before HTTP. FAQ sample does not advertise `multi_turn`.
- Local packet path rejects `aw-suite/1` with `HOSTED_SUITE_UNSUPPORTED_LOCAL`. Assessment load rejects suite files with `ASSESSMENT_SUITE_FILE`.
- Existing local packet tests and billing quote/consent tests continue to pass.

## Compatibility

- Existing local deterministic packets still parse.
- Creating a suite revision is not a billed run. Relay execution uses the server-accepted pin, not a re-read of the mutable file.
- Noninteractive admission still requires `--max-credits`; `--yes` is not an unlimited budget.
- Billing quote, reservation, recovery, and original-run identity are unchanged.
- Published `@augmentworks/cli@0.3.2` does not include these commands.

## Remaining release requirements

- Review/merge of https://github.com/augmentworks-org/augmentworks-cli/pull/31
- Byte-vendor of main schema files when a token with `augmentworks-org/augmentworks` access is available; until then lock checksums stay Linear-published identities only
- Live hosted admission against a workspace that accepts `POST /v1/suites` and the sentinel packet binding
- npm publication of a version that contains `suite` / `test --suite` (not 0.3.2)
- AUG-7 release-acceptance against the published tarball
- Keep AUG-32 **In Review** until source review; do not mark Done from this record
- Do not weaken merge/deployment permissions or activate live billing
