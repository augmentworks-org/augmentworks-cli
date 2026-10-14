# R02 completion — published CLI core customer workflow (AUG-48)

Issue: [AUG-48](https://linear.app/augmentworks/issue/AUG-48/cli-verify-the-published-cli-core-customer-workflow)
Repository: `augmentworks-org/augmentworks-cli`
Work package: R02 · Audit coverage: release

This file is issue-specific. It does not replace AUG-73 first-dollar evidence,
C03, E10, E12, or C12 completion records.

This is the CLI record for verifying the **published** core own-target, suite,
session, mapping, quote, wait, and release-policy loop. Source integration of
later commands is distinct from this registry gate under AUG-7.

## Source and implementation identity

| Item | Value |
| --- | --- |
| Audit / default-main baseline | `8a9f31a9fa6d99b2f0ea7e1530a4b73741592027` |
| Working base (`origin/main`) | `5ecae185e34f09574c878f8b0e149710444a0625` (merge of CLI PR #40 / AUG-46) |
| Working branch | `cursor/cli-published-core-workflow-b20a` |
| Pull request | [CLI #42](https://github.com/augmentworks-org/augmentworks-cli/pull/42) |
| AUG-47 (R01) | Done. Main [PR #106](https://github.com/augmentworks-org/augmentworks/pull/106) head `d9f3a7fafca3ff2bb5d517bcea031dd2b9aa8ad9`. Handoff `docs/feature-readiness/core-acceptance.md`. CLI pin `@augmentworks/cli@0.3.4` `gitHead` `c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f`. Packed SHA-256 `a97b1ff77823933defcecac8181c0dc5c925cfe356dfe2d6bad2f39e271d4021` matches the registry tarball downloaded here. Deployed web SHA still unverified on that ticket. |
| AUG-73 | Done. CLI PR #33. npm `@augmentworks/cli@0.3.4` published 2026-09-08T06:38:24.847Z. Integrity reused, not relabeled. |
| AUG-40 (E10) | Merged CLI#34. Present in published 0.3.4. Handoff `docs/feature-readiness/e10-completion.md`. |
| AUG-44 (E12) | Merged CLI#37 **after** `v0.3.4`. Not in the registry tarball. |
| AUG-45 (C03) | Merged CLI#38 **after** `v0.3.4`. Not in the registry tarball. |
| AUG-46 (C12) | Merged CLI#40. Explicitly out of scope for this first core published CLI. |
| AUG-79 | Open draft CLI PR #39. Owns 0.3.5 candidate-metadata correction. This ticket does not change `package.json` version or publish. |
| Billing contract (from installed tarball) | `aw-billing/1` from `650472d91442a6866a7b6ef18e6dacc23a2a9260`; schema `3097c7aa74233e97233dcc488ba7eaacb1be5c6af0554bc308ca1569d155b645`; fixtures `a4b9234b426f98132ddbd8e82755caa0aa718c4ec1e3bf17064d1bf364a6cb84` |
| Release-policy consumer fixtures | SHA-256 `dcc76898c8e89bf4e2e18c68f6882e7c9643f0fe2a612a88eae1167d5224c65f`; consumed commit cited `235d39074cab1c57ada2cc015192dc129697683c` |
| Migrations | None. This repository does not own SQL. |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified |

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| Harness + evidence in this repository | **Complete.** Registry installer, synthetic journey, honesty tests. |
| Registry install of `@augmentworks/cli@0.3.4` | **Passed** for the commands that tarball actually contains. |
| Investigation / `--headless` on that tarball | **not_run** (unpublished in 0.3.4). |
| Compatible authorized live environment | **not_run** (no disposable API token). |
| `releaseReady` | **false**. Not a passed full core release. |

## Interfaces

New owned files:

- `docs/feature-readiness/release-acceptance.md`
- `docs/feature-readiness/release-acceptance.json` (`aw-core-release-acceptance/1`)
- `scripts/packed-core-release-acceptance.mjs`
- `test/release-acceptance.test.ts` (reads the JSON and the harness script; does not import `src/`)

Existing harness: `scripts/smoke-pack.mjs` now runs local `--source local` after the packed billing/report fixtures. Local success cannot write the registry JSON.

```text
node scripts/packed-core-release-acceptance.mjs --source registry --version 0.3.4
node scripts/packed-core-release-acceptance.mjs --source registry --version 0.3.4 --write-evidence
node scripts/packed-core-release-acceptance.mjs --source local
```

`--write-evidence` is refused unless `--source registry`.

Check statuses are `pass` | `fail` | `not_run`. Missing credentials, skipped tests, and unpublished tarballs cannot be `pass`.

## Examples

Registry (this gate):

```bash
npx --yes @augmentworks/cli@0.3.4 --version
npx --yes @augmentworks/cli@0.3.4 init --agent --no-env
npx --yes @augmentworks/cli@0.3.4 doctor --offline -c augmentworks.yaml
npx --yes @augmentworks/cli@0.3.4 preview-mapping -c augmentworks.yaml --operation send --fixture ./fixtures/send-response.json --json
npx --yes @augmentworks/cli@0.3.4 suite validate own-chatbot.suite.yaml --json
npx --yes @augmentworks/cli@0.3.4 probe -c augmentworks.yaml --json
npx --yes @augmentworks/cli@0.3.4 test --suite own-chatbot.suite.yaml --estimate --json
npx --yes @augmentworks/cli@0.3.4 test --suite own-chatbot.suite.yaml --max-credits 0 --yes --json
npx --yes @augmentworks/cli@0.3.4 run wait <run-id> --json --timeout-ms 1
npx --yes @augmentworks/cli@0.3.4 gate --run <run-id> --baseline <baseline-id> --json
```

Not in published 0.3.4 (do not document as installed from this tarball):

```text
npx --yes @augmentworks/cli@0.3.4 investigation inspect ...
npx --yes @augmentworks/cli@0.3.4 test --headless ...
```

Those exist on current main via `node dist/index.js` after `npm ci && npm run build`.

## Test evidence

Injected Cloud Agent `AUGMENTWORKS_API_KEY` is unset for these commands.

| Command | Outcome |
| --- | --- |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN -u AUGMENTWORKS_API_URL node scripts/packed-core-release-acceptance.mjs --source registry --version 0.3.4 --write-evidence` | Pass. `releaseReady=false`. 13 pass / 3 not_run. Registry identity matches AUG-73/AUG-47. |
| `AUGMENTWORKS_PACKED_BIN=$PWD/dist/index.js ... --source local` | Pass as **local QA**. Investigation inspect and `--headless` `MACHINE_ACTION_DENIED` pass on current dist. `registry-identity` is `not_run`. |
| `npx vitest run test/release-acceptance.test.ts` | Pass. **1 file / 3 tests** |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN npm run check` | Pass. typecheck; **83 files / 768 tests**; discovery `@augmentworks/cli@0.3.4 (development)`; billing/run-report contracts unchanged |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN npm run smoke:pack` | Pass. Packed tarball **64 files, 479713 compressed bytes**. Local core-release ran after packed billing (`creates=1 quotes=4 targets=1 polls=3 refreshes=1`) and report (`requests=8`). Local investigation/`--headless` pass; `registry-identity` remains `not_run`. |
| Live hosted assessment / `packed-billing-live` / GitHub-hosted runner | **Not run** |
| npm publish / version bump | **Not done.** AUG-79 owns 0.3.5 metadata. |

Behavior covered against the **registry** binary and loopback fixtures:

- Clean `npm pack` + `npm install --ignore-scripts` of `@augmentworks/cli@0.3.4`
- Inventory: billing + release-policy locks, own-target starter, session YAML, five-case suite
- `init --agent` pins `@augmentworks/cli@0.3.4`
- Offline doctor / preview-mapping / suite validate / probe preflight
- Invalid mapping exit 2 `RESPONSE_MAPPING_INVALID`
- Unsupported `history_array_v1` suite exit 2 `SUITE_UNSUPPORTED_FEATURE`
- Wait timeout + running status exit 11, original run id, no quote/create
- Revoked API key exit 3, `GET /api/v1/cli/auth/me` only
- `--max-credits 0 --yes` exit 13, no `POST /v1/relay/runs`
- `gate` incompatible scope exit 2; equal pass-rate regression exit 10; compatible pass exit 0
- Stdout JSON; stderr diagnostics; no fixture secrets

## Compatibility

- Billing prices, live activation, and release approval remain the existing billing/SDLC workflow.
- AUG-73 first-dollar JSON is not rewritten.
- `src/release.ts` / `package.json` version stay 0.3.4. Packaged `published_package_verified: false` is AUG-79's correction, not this ticket.
- Observation/recovery do not create a new billable run.
- Finite `--max-credits` consent is unchanged. `--yes` is not a ceiling.

## Remaining release requirements

- A later immutable registry version that contains AUG-44 investigation and AUG-45 `--headless` machine CI, published through protected `release.yml`.
- Re-run `npm run test:packed-core-release -- --version <that-version>` (or the equivalent argv) against that tarball; flip those `not_run` checks only from the downloaded artifact.
- Compatible authorized / disposable main API evidence (`packed-billing-live` or equivalent). Synthetic fixtures cannot substitute.
- AUG-47 deployed web SHA remains a main-repo release ticket.
- Keep Linear **In Review**. Source integration of this harness is not a passed core release.
- Do not mark skipped, missing, or unpublished evidence as a green release gate.
