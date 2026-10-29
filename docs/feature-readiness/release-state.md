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
| Website pin | Main repository discovery snapshot | Adopted only after independent review of **this** patch. This CLI does not self-adopt. Independently inspected 0.4.0 remains the website pin until 0.4.1 is inspected. Website adoption of that pin is separate. Independently inspected 0.3.9 remains historical and is the last version for Node.js 20. Independently inspected 0.3.8 remains historical and includes the AUG-272 consistency check. Independently inspected 0.3.7 remains historical and omits the AUG-272 consistency check. Independently inspected 0.3.6 remains historical (capabilities, no saved-suite `/2`). Independently inspected 0.3.5 remains historical and omits suite-selection `capabilities`. Source 0.4.1 is not a registry probe until the protected `v0.4.1` release. Do not fetch `latest`. |

## `published_package_verified` (`aw-cli-release/0.1`)

`true` means this packaged identity is a published release line, not a
candidate. It is **not** proof that this exact tarball was downloaded from npm
and inspected.

Independent inspection of `@augmentworks/cli@0.4.0` remains
`lastIndependentlyInspected`. Packaged `LAST_VERIFIED_*` in this checkout names
that artifact (tag `v0.4.0` commit `afb23c37ffe99289c75b3769b50447c3e403c50f`,
published `2026-10-18T17:41:10.515Z`). The registry version document omitted
`gitHead`; its SLSA provenance names that commit. `thisPackageIdentity` for
0.4.1 stays `pending-protected-publish` until the trusted npm workflow runs and
a later commit records the downloaded tarball. The immutable 0.4.0 tarball
still embeds the prior 0.3.9 `LAST_VERIFIED_*` snapshot. Do not republish 0.4.0
to bake a newer receipt in.

Do not overwrite or relabel existing npm versions, including 0.4.0, 0.3.9, and
0.3.8.

## Help and documented pins

`test --help` `--assessment` copy is `HOSTED_ASSESSMENT_OPTION_HELP` from
`src/version.ts`. Documented `npx` pins must equal `CLI_VERSION`.
