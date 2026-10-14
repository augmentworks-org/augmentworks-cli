# First-dollar registry acceptance (AUG-73)

Issue: [AUG-73](https://linear.app/augmentworks/issue/AUG-73/cli-publish-a-verified-customer-owned-assessment-release)
Schema: `aw-first-dollar-release/1`
Machine record: `docs/feature-readiness/first-dollar-registry-acceptance.json`

This is the CLI (`augmentworks-org/augmentworks-cli`) first-dollar publication handoff
for **published** `@augmentworks/cli@0.3.4`. It does **not** claim live
purchases, full regression-CI completion, or hosted browser QA
([AUG-58](https://linear.app/augmentworks/issue/AUG-58/main-verify-deployed-api-key-password-and-published-cli-qa-integration)).
The immutable 0.3.4 tarball still contains stale candidate metadata; the 0.3.5
patch corrects packaged copy without overwriting 0.3.4. See
`published-registry-evidence.json` and `release-state.md`.

## Recheck (2026-09-07)

| Item | Observed value |
| --- | --- |
| Default branch | `main` |
| `origin/main` | `b8c3e7c3d71d9bef2cb07ddf3771c0822934208d` (merge of CLI PR #32 / AUG-35) |
| Open PRs at start | None |
| AUG-35 | Done. Handoff `docs/feature-readiness/c07-completion.md`. Consumed, not reimplemented. |
| npm `latest` / 0.3.3 | Published 2026-09-07T16:21:14Z, `gitHead` `4a08ea0d352f2515e725cb9ca946807112422436`. Lacks suite validate/preview and `test --suite`. No GitHub tag `v0.3.3`. |
| npm 0.3.4 (recheck 2026-09-08) | Published 2026-09-08T06:38:24.847Z, `gitHead` `c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f`, integrity `sha512-TLeAzDglZoGL6fWLxA9rIUwJd69NFqgmlONzU4uRmhDz4S31+dfSZpaj44ahb6lUjnmuoY6sDmfPStxFzInpVQ==` |
| Independently inspected GitHub release | `v0.3.4` (published 2026-09-08 06:33:39 UTC) |
| Independently inspected npm | `@augmentworks/cli@0.3.4` |

Selected candidate: current default main plus this 0.3.4 metadata PR. Compatible own suites, starter/probe, session, mapping preview, quoted billing, API-key auth, and complete report fixes are on that head.

## Registry evidence (2026-09-08)

| Layer | 0.3.4 state |
| --- | --- |
| GitHub release | `v0.3.4`, target `c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f` |
| npm | `@augmentworks/cli@0.3.4`, integrity `sha512-TLeAzDglZoGL6fWLxA9rIUwJd69NFqgmlONzU4uRmhDz4S31+dfSZpaj44ahb6lUjnmuoY6sDmfPStxFzInpVQ==` |
| This JSON `cli.gitHead` / `cli.integrity` / `verifiedAt` | Filled from `npm view` |
| Packaged `CLI_RELEASE` inside that tarball | Still candidate / `published_package_verified: false` (AUG-79 / 0.3.5) |

Do not overwrite npm 0.3.3 or relabel its provenance.

## Candidate verification (not registry)

Tested head: PR https://github.com/augmentworks-org/augmentworks-cli/pull/33 on branch `cursor/cli-verified-customer-release-f205`. Base `main` `b8c3e7c3d71d9bef2cb07ddf3771c0822934208d`.

| Command | Result |
| --- | --- |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN npm ci` | Pass |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN npm run check` | Pass. typecheck; **71 files / 677 tests**; discovery `@augmentworks/cli@0.3.4 (development)` |
| `npm run audit:ci` | Pass. 0 vulnerabilities |
| `npm run smoke:pack` | Pass. Local tarball **53 files, 429540 bytes**, SHA-256 `46a7f4d653cf1e29a38ac0b47adf0c4117bba2daefcc54c6fd1fc35cd910d5f4`. examples/ absent. Starters and customer suites present. |
| `AUGMENTWORKS_PACKED_BIN=<local installed dist> npm run test:packed-billing-fixture` | Pass. `creates=1 quotes=4 targets=1 polls=3 refreshes=1` |
| `AUGMENTWORKS_PACKED_BIN=<local installed dist> npm run test:packed-report-fixture` | Pass. `requests=8` |
| Packed `init --agent` | Writes `npx --yes @augmentworks/cli@0.3.4`, not 0.3.2/0.3.3 |
| `node scripts/verify-published-discovery.mjs --version 0.3.4` (pre-publish) | **404**. npm 0.3.4 was not on the registry at candidate QA time. |

A local pack is QA only. It is not npm publication.

## Publication completed (2026-09-08)

| Item | Observed value |
| --- | --- |
| GitHub release | `v0.3.4`, 2026-09-08 06:33:39 UTC, target `c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f` |
| npm | `@augmentworks/cli@0.3.4`, `gitHead` `c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f`, integrity `sha512-TLeAzDglZoGL6fWLxA9rIUwJd69NFqgmlONzU4uRmhDz4S31+dfSZpaj44ahb6lUjnmuoY6sDmfPStxFzInpVQ==`, `time` `2026-09-08T06:38:24.847Z` |

Do not overwrite 0.3.4. The immutable tarball still packages candidate/unverified `CLI_RELEASE` copy (AUG-79). 0.3.5 corrects packaged copy.

## External lanes still not claimed

- Hosted positive/fault/browser QA (AUG-58)
- Live purchases, production provider calls, customer-target contact
- AUG-47/48 baseline/regression/CI journey
