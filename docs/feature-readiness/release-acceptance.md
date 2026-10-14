# Core published CLI release acceptance (AUG-48)

Issue: [AUG-48](https://linear.app/augmentworks/issue/AUG-48/cli-verify-the-published-cli-core-customer-workflow)
Schema: `aw-core-release-acceptance/1`
Machine record: `docs/feature-readiness/release-acceptance.json`

This is the CLI (`augmentworks-org/augmentworks-cli`) core customer-loop publication
gate. It installs the **exact npm registry tarball** and exercises own-target
starters, owned suites, session files, mapping preview/probe, quoted spend,
wait/running states, and release-policy CI decisions.

It reuses [AUG-73](https://linear.app/augmentworks/issue/AUG-73/cli-publish-a-verified-customer-owned-assessment-release) npm
identity. It does **not** complete [AUG-50](https://linear.app/augmentworks/issue/AUG-50/main-verify-deployed-core-repeat-use-and-team-features-for-first)
later features or [AUG-46](https://linear.app/augmentworks/issue/AUG-46/cli-consume-catalog-metadata-and-deterministic-suite-selections-with)
catalog/shard CLI.

`releaseReady` stays **false** until investigation/repro, machine `--headless`
CI, and a compatible authorized environment are verified on a real registry
install. Local pack success is recorded separately and is not a passed release.

## Recheck (2026-09-09)

| Item | Observed value |
| --- | --- |
| Default branch | `main` |
| `origin/main` | `5ecae185e34f09574c878f8b0e149710444a0625` (merge of CLI PR #40 / AUG-46) |
| Open PRs at start | Draft [PR #39](https://github.com/augmentworks-org/augmentworks-cli/pull/39) (AUG-79) owns the 0.3.5 candidate-metadata correction. This ticket does not change package versions or publish. |
| AUG-47 | Done. Main [PR #106](https://github.com/augmentworks-org/augmentworks/pull/106) head `d9f3a7fafca3ff2bb5d517bcea031dd2b9aa8ad9`. Handoff `docs/feature-readiness/core-acceptance.md`. CLI pin `@augmentworks/cli@0.3.4` `gitHead` `c3da8d9`. Packed tarball SHA-256 `a97b1ff77823933defcecac8181c0dc5c925cfe356dfe2d6bad2f39e271d4021` matches this registry download. Deployed web SHA remains unverified on that ticket. |
| AUG-73 | Done. Candidate 0.3.4 later published. |
| npm `latest` | `@augmentworks/cli@0.3.4` published 2026-09-08T06:38:24.847Z via GitHub Actions trusted publishing |
| GitHub release | `v0.3.4` tag `c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f` |
| Last independently verified GitHub release before 0.3.4 | `v0.3.2` |
| Immutable npm 0.3.3 | `gitHead` `4a08ea0d352f2515e725cb9ca946807112422436` — not overwritten |

## Published artifact versus current main

Published `0.3.4` (`gitHead` `c3da8d9`) includes AUG-32 suites, AUG-35
starters/probe, AUG-24 session, AUG-54 API-key/report, and AUG-40
compare/gate/baseline.

It does **not** include:

| Command | Landed on main | Published in 0.3.4 |
| --- | --- | --- |
| `investigation inspect` / `test --investigation` | CLI PR #37 / AUG-44 | No |
| `test --headless` / machine CI recipe | CLI PR #38 / AUG-45 | No |
| `catalog` / `selection` / `test --manifest` | CLI PR #40 / AUG-46 | Out of scope (later) |

Current source remains labeled `0.3.4`. Changing that version is AUG-79 /
protected `release.yml` ownership. This ticket does not publish `0.3.5`.

## Registry identity (downloaded)

| Item | Value |
| --- | --- |
| Package | `@augmentworks/cli@0.3.4` |
| `gitHead` | `c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f` |
| integrity | `sha512-TLeAzDglZoGL6fWLxA9rIUwJd69NFqgmlONzU4uRmhDz4S31+dfSZpaj44ahb6lUjnmuoY6sDmfPStxFzInpVQ==` |
| shasum | `c0c2443cac952c1cb100178e483e22ee222f12b1` |
| tarball SHA-256 | `a97b1ff77823933defcecac8181c0dc5c925cfe356dfe2d6bad2f39e271d4021` |
| file count | 55 |
| published | 2026-09-08T06:38:24.847Z |
| provenance | npm trusted publisher `github` |

Install used `npm pack @augmentworks/cli@0.3.4` then
`npm install --ignore-scripts` of that tarball. Tests spawn
`node node_modules/@augmentworks/cli/dist/index.js`. They do not import
`src/`.

## Main contract pair (from the installed tarball)

| Contract | Identity |
| --- | --- |
| `aw-billing/1` | main `650472d91442a6866a7b6ef18e6dacc23a2a9260`; schema `3097c7aa…b645`; fixtures `a4b9234b…cb84` |
| `aw-release-policy/1` | consumed commit cited `235d39074cab1c57ada2cc015192dc129697683c`; consumer fixtures SHA-256 `dcc76898c8e89bf4e2e18c68f6882e7c9643f0fe2a612a88eae1167d5224c65f` |
| `aw-investigation-export/1` | **absent** from this tarball |

No SQL migrations in this repository.

## Harness

```bash
env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN npm run test:packed-core-release
# node scripts/packed-core-release-acceptance.mjs --source registry --version 0.3.4

env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN AUGMENTWORKS_PACKED_BIN=$PWD/dist/index.js \
  npm run test:packed-core-release:local
```

`--write-evidence` is refused for `--source local`. Smoke-pack invokes local
mode after the existing billing/report fixtures so a source tarball still
exercises the new cases without claiming npm publication.

## Registry results (this run)

| Check | Status |
| --- | --- |
| registry-identity | pass |
| inventory-schemas-fixtures | pass |
| version-and-help | pass |
| documentation-pins (`init --agent` → `@augmentworks/cli@0.3.4`) | pass |
| offline-suite-session-mapping-probe | pass |
| invalid-mapping (`RESPONSE_MAPPING_INVALID`, exit 2) | pass |
| unsupported-capability (`SUITE_UNSUPPORTED_FEATURE`, exit 2) | pass |
| wait-timeout-running (`run wait` exit 11, original run id) | pass |
| revoked-credential (`test --estimate` 401 → exit 3, `GET /api/v1/cli/auth/me` only) | pass |
| credit-ceiling (`--max-credits 0 --yes` exit 13, no create) | pass |
| incompatible-baseline (`gate` exit 2) | pass |
| failing-required-criterion (`blocked_equal_pass_rate` exit 10) | pass |
| passing-ci-decision (`pass_compatible` exit 0) | pass |
| investigation-repro-export | **not_run** (command not in 0.3.4) |
| machine-ci-headless | **not_run** (no `--headless`) |
| live-authorized-environment | **not_run** (no disposable API token; `packed-billing-live` not run) |

Local current `dist/index.js` additionally passed investigation inspect and
`--headless` `MACHINE_ACTION_DENIED`. That is source QA, not registry.

## Publication path (maintainer)

Inspected `.github/workflows/release.yml`: `on.release.types: [published]`,
non-draft/non-prerelease, `environment: npm`, tag must equal `v` +
`package.json` version, `npm publish` with provenance, no `NODE_AUTH_TOKEN`.

A later immutable version that includes AUG-44 and AUG-45 must use that
workflow. Do not overwrite `0.3.4`. Do not bypass a held release. AUG-79
owns the 0.3.5 metadata correction; check that PR before changing versions.

## Recovery

- `run wait` / `run status` / `gate` / `compare` / `recover` reuse the original
  run id. They must not start a new billed assessment.
- Exit 10 is a blocked release. Do not admit another hosted test from the same
  job to flip it.
- Exit 11 (timeout / pending grading) is not a green gate. Re-query the same
  run id.
- A revoked API key cannot continue. Do not call `logout` from automation
  cleanup.
- Install a later registry version for investigation / `--headless`. Do not
  relabel this 0.3.4 tarball.

## External lanes not run

- Protected GitHub release of a post-0.3.4 version that contains AUG-44/45
- Disposable migrated main API / `scripts/packed-billing-live.mjs`
- GitHub-hosted ephemeral runner with a real workspace machine key
- Live purchases, production provider calls, customer-target contact
- AUG-46 catalog/shard published CLI (AUG-50)
- AUG-79 0.3.5 metadata publish
