# CLI release-state contract

This document defines the non-circular contract for packaged CLI identity
versus post-publication registry inspection. It exists because npm tarballs
are immutable: a field that can only become true after `npm publish` cannot
honestly live inside that same tarball.

## Layers

| Layer | Where | What it may claim |
| --- | --- | --- |
| Package identity | `package.json`, `src/version.ts`, `CLI_RELEASE` / `schemas/v1/cli-release.json` | This artifact's version, protocol, and whether it is a **published-line release** versus a candidate snapshot. |
| Source discovery | `contracts/discovery-manifest.json` | This git checkout. Stays `releaseStatus: development` with `node dist/index.js` commands. Not a live registry status. |
| Independently inspected tarball | `LAST_VERIFIED_*` and `docs/feature-readiness/published-registry-evidence.json` | A **prior** (or separately inspected) registry version, keyed by version, gitHead, integrity, and `verifiedAt`. |
| Website pin | Main repository discovery snapshot | Adopted only after independent review of **this** patch. This CLI does not self-adopt. Independently inspected 0.3.8 is the current registry pin. Website adoption of that pin is separate. Independently inspected 0.3.7 remains historical and omits the AUG-272 consistency check. Independently inspected 0.3.6 remains historical (capabilities, no saved-suite `/2`). Independently inspected 0.3.5 remains historical and omits suite-selection `capabilities`. Do not fetch `latest`. |

## `published_package_verified` (`aw-cli-release/0.1`)

`true` means this packaged identity is a published release line, not a
candidate. It is **not** proof that this exact tarball was downloaded from npm
and inspected.

Independent inspection of `@augmentworks/cli@0.3.8` is
`lastIndependentlyInspected` and `thisPackageIdentity`
(`independently-inspected`). Packaged `LAST_VERIFIED_*` in this checkout names
that artifact (tag `v0.3.8` commit `f36d9086bad1ac109a7670e8acc9bf14a5d15047`,
published `2026-10-08T01:42:45.969Z`). The registry version document omitted
`gitHead`. The immutable 0.3.8 tarball still embeds the prior 0.3.7
`LAST_VERIFIED_*` snapshot; this inspection commit is not inside that tarball.
Do not republish 0.3.8 to bake the receipt in.

Do not overwrite or relabel existing npm versions, including 0.3.8, 0.3.7, and
0.3.6.

## Help and documented pins

`test --help` `--assessment` copy is `HOSTED_ASSESSMENT_OPTION_HELP` from
`src/version.ts`. Documented `npx` pins must equal `CLI_VERSION`.
