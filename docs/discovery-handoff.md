# CLI discovery handoff

This repository owns `contracts/discovery-manifest.json` and
`contracts/discovery-manifest.schema.json` (`schemaVersion: 1`).
`src/discovery.ts` is the generator. Do not maintain a second set of release
constants. Packaged identity versus post-publication inspection is defined in
`docs/feature-readiness/release-state.md`.

## Current source artifact

| Field | Value |
| --- | --- |
| Package | `@augmentworks/cli@0.3.8` |
| `releaseStatus` | `development` (this git checkout; not a live registry probe) |
| `capabilities.localDemo` | `true` |
| Demo invocation | `node dist/index.js demo` |
| Provenance | `sourceCommit: null`, `verifiedAt: null` |
| Last independently inspected npm | `@augmentworks/cli@0.3.8` (tag `v0.3.8` commit `f36d9086bad1ac109a7670e8acc9bf14a5d15047`, published 2026-10-08T01:42:45.969Z, integrity `sha512-T+e1VWQ8plx0jJMdkOHxocpH8SjCr9BSeRLMsCnCHAO0Z3z9bhgIf0um9x6eyWJfwPz01YOL7CZvM6sLTiSLIA==`, tarball SHA-256 `2849ceb6c3c9b18d02a4cb2aa7f0ad470ec74cb7846a8eadf91d83147965f36e`, 74 files). The registry document omitted `gitHead`. `thisPackageIdentity` is `independently-inspected`. The published 0.3.8 tarball still embeds the prior `LAST_VERIFIED` 0.3.7 snapshot; this inspection commit is not inside that artifact. |
| Immutable prior npm | `@augmentworks/cli@0.3.7`, `@augmentworks/cli@0.3.6`, `@augmentworks/cli@0.3.5`, `@augmentworks/cli@0.3.4`, and `@augmentworks/cli@0.3.3` (gitHead `4a08ea0d352f2515e725cb9ca946807112422436`). Do not overwrite or relabel. |

The committed discovery manifest stays `development` for a source checkout. A
locally packed tarball may carry this development-status manifest. That is QA,
not a rewrite of published npm 0.3.7. `scripts/verify-published-discovery.mjs --version 0.3.7`
emits metadata for the downloaded registry tarball and must not rewrite that
tarball or relabel 0.3.6 or 0.3.5:

```bash
npm run generate:discovery
npm run check:discovery
node scripts/verify-published-discovery.mjs --version 0.3.7
```

`verify-published-discovery` emits metadata and does not replace executable
inspection. Independently inspected 0.3.8 registry evidence is
`lastIndependentlyInspected` and `thisPackageIdentity`
(`independently-inspected`) in
`docs/feature-readiness/published-registry-evidence.json`. Independently
inspected 0.3.6 remains historical (capabilities, no saved-suite `/2`).
Independently inspected 0.3.5 remains historical (it omits suite-selection
`capabilities`). Independently inspected 0.3.4 evidence remains in that file
and in `docs/feature-readiness/first-dollar-registry-acceptance.json`.

Published status requires registry metadata plus unpacked inventory and an
executable smoke of that exact tarball, including `demo` if advertised and
the AUG-82 capability-bearing compile request.

## Implemented demo

```bash
npm ci
npm run build
node dist/index.js demo
node dist/index.js demo --json
```

`--mode faulty` preserves underlying assertion exit `10`. `--mode full` exits
`0` only when the faulty run fails as expected, the corrected run passes, and
cleanup succeeds.

This package's executable npx pin is `0.3.8`:

```bash
npx --yes @augmentworks/cli@0.3.8 demo
```

## Website adoption

Website maintainers must independently review and adopt a **pinned** published
manifest. Never fetch `latest` into the live website at runtime.

Independently inspected `@augmentworks/cli@0.3.7` is the pin for website
adoption (`gitHead` `876454878a31a897aec1d722fa838c9c0ecea2aa`, `verifiedAt`
`2026-09-27T21:06:12.276Z`, tarball SHA-256
`37b448b4db2c195b5c361daab10604d57476fa4d9e441916f7bfe2054f81b313`).
AUG-250 owns that website pin. Independently inspected `@augmentworks/cli@0.3.6`
includes suite-selection `capabilities` and does not include saved-suite `/2`.
Independently inspected `@augmentworks/cli@0.3.5` omits `capabilities` on
`selection compile` (AUG-82). Do not pin immutable npm `0.3.6`, `0.3.5`,
`0.3.4`, or `0.3.3` for the saved-suite customer path. Do not fetch `latest`.

Command arrays are data for reviewed rendering and tests. The website must not
execute imported command arrays.

Regenerate and validate this contract without hosted accounts:

```bash
npm run generate:discovery
npm run check:discovery
npm test
```

## Changed resources in this source revision

- `lastIndependentlyInspected` and `thisPackageIdentity` record independently inspected `@augmentworks/cli@0.3.8`
- Immutable 0.3.7, 0.3.6, 0.3.5, 0.3.4, and 0.3.3 records stay unchanged
- Source discovery stays `development`

## Published 0.3.7 receipt

The protected release already ran. Do not create another `v0.3.7` tag or
republish the version.

- Registry `gitHead` `876454878a31a897aec1d722fa838c9c0ecea2aa`
- integrity `sha512-O9IRRBgpCwRwQzUtIOgpa0nxRQ5UU6x28S7+G6e+egwmRP8QwvHTJgJUzmmFhyq+MhtzW8CPRHnAXhxRHNBIBA==`
- shasum `4b53d91272e51d9b27af3a00f407e3943ae1fa6e`
- published `2026-09-27T21:06:12.276Z`
- tarball SHA-256 `37b448b4db2c195b5c361daab10604d57476fa4d9e441916f7bfe2054f81b313`
- file count 74
- GitHub release `v0.3.7` published `2026-09-27T20:58:35Z`
- workflow `https://github.com/jeffskafi/augmentworks-cli/actions/runs/36349981048`
- provenance log index `2979747594`

Website maintainers (AUG-250) adopt this exact pin. Do not fetch `latest`.
Keep 0.3.6 and 0.3.5 as immutable historical evidence.
