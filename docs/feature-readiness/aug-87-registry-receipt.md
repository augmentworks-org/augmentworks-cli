# AUG-87 saved-suite registry receipt

Independently inspected npm artifact for the customer saved-suite CLI.
Website pin adoption is [AUG-250](https://linear.app/augmentworks/issue/AUG-250).
This file is later than the published tarball and is not inside it.

| Field | Value |
| --- | --- |
| Package | `@augmentworks/cli@0.3.7` |
| gitHead | `876454878a31a897aec1d722fa838c9c0ecea2aa` |
| integrity | `sha512-O9IRRBgpCwRwQzUtIOgpa0nxRQ5UU6x28S7+G6e+egwmRP8QwvHTJgJUzmmFhyq+MhtzW8CPRHnAXhxRHNBIBA==` |
| shasum | `4b53d91272e51d9b27af3a00f407e3943ae1fa6e` |
| tarball SHA-256 | `37b448b4db2c195b5c361daab10604d57476fa4d9e441916f7bfe2054f81b313` |
| file count | 74 |
| published | `2026-09-27T21:06:12.276Z` |
| registry | `https://registry.npmjs.org/@augmentworks/cli/0.3.7` |
| tarball | `https://registry.npmjs.org/@augmentworks/cli/-/cli-0.3.7.tgz` |
| GitHub release | `https://github.com/jeffskafi/augmentworks-cli/releases/tag/v0.3.7` (`2026-09-27T20:58:35Z`) |
| workflow | `https://github.com/jeffskafi/augmentworks-cli/actions/runs/36349981048` (success, provenance log index `2979747594`) |

Pin this exact version. Do not use `@latest`. Do not republish 0.3.7.
Immutable priors stay `0.3.6` (capabilities, no saved-suite `/2`), `0.3.5`
(no capabilities), `0.3.4`, and `0.3.3`.

## Installed-package check

Downloaded the registry tarball and installed it with `--ignore-scripts`.
No production credential, quote, reservation, or charge.

```bash
AUGMENTWORKS_PACKED_BIN=/tmp/aw-reg/install/node_modules/@augmentworks/cli/dist/index.js \
  node scripts/packed-saved-suite-release.mjs
```

Outcome: pass. The installed `0.3.7` binary forwarded saved-suite
`aw-suite-selection/2`, revision `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
content hash `c` × 64, and declared connector capabilities. A lifecycle-free
connector exited `SELECTION_UNEXECUTABLE` before quote. Estimate was
estimate-only. One create used `--max-credits 30`. `run status` and
`run report` read that original run and did not create another quote or run.
`init --agent` printed `npx --yes @augmentworks/cli@0.3.7`.

## Remaining limit

AUG-250 adopts this pin on the website. This repository does not change
website discovery, docs, or policy pins. Live hosted production runs were not
executed.
