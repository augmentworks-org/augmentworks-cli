# Distribution runbook (do not execute in this task)

These commands mutate GitHub/npm metadata. They are prepared for Jeff to run
after review. This task must not publish npm, create tags, or edit the
repository About page.

## GitHub repository About

Current `gh repo view` at implementation time: empty description, empty
homepage, no topics.

Proposed:

```bash
gh repo edit jeffskafi/augmentworks-cli \
  --description "Deterministic hosted and customer-executed local testing for AI agents" \
  --homepage "https://augmentworks.ai" \
  --add-topic agent-testing \
  --add-topic ai-evaluation \
  --add-topic chatbot-testing \
  --add-topic cli \
  --add-topic regression-testing
```

No topics exist today, so there are no proposed removals. Keep useful npm
keywords already in `package.json`; `regression-testing` was added as an
accurate extra term.

## npm

Do not run `npm publish` ad hoc. `@augmentworks/cli@0.4.0` is published from
GitHub release `v0.4.0` (`afb23c37ffe99289c75b3769b50447c3e403c50f`) by
`.github/workflows/release.yml` through npm trusted publishing, with SLSA
provenance from `augmentworks-org/augmentworks-cli`, and independently
inspected. Do not republish 0.4.0. `@augmentworks/cli@0.3.9` stays the last
version for Node.js 20; its tag bytes were published by the package owner
after the trusted workflow's OIDC publish returned 404, and it has no SLSA
provenance attestation. Do not overwrite or relabel `@augmentworks/cli@0.4.0`,
`0.3.9`, `0.3.8`, `0.3.7`, `0.3.6`, `0.3.5`, `0.3.4`, or `0.3.3`. The next
release still needs a new tag and `.github/workflows/release.yml`.

## Release history

The README pins only the current package. The identities and rules below
moved here from the README so maintainers have them in one place.

| Identity | Current value |
| --- | --- |
| This package (`package.json`) | `0.4.0` |
| Executable `npx` pin (matches this tarball) | `@augmentworks/cli@0.4.0` |
| Hosted assessment protocol | `aw-relay/0.3` |
| Immutable prior npm artifacts | `@augmentworks/cli@0.3.9` (`gitHead` `9e7919cbfe583cc15701904580be9d36da3bcaf4`, integrity `sha512-ZDXMg5etb3UNGGrakJ5Iz+oYAkAOHqOt2DIVn41MvFnLjmlz/AIUL05pYGJHnDISo1At5Cik6Kjkses4hB4CYA==`, published 2026-10-13T20:31:53.099Z; AUG-335 run-scope lookup hardening, last version for Node.js 20, registry document omitted `gitHead`), `@augmentworks/cli@0.3.8` (`gitHead` `f36d9086bad1ac109a7670e8acc9bf14a5d15047`, integrity `sha512-T+e1VWQ8plx0jJMdkOHxocpH8SjCr9BSeRLMsCnCHAO0Z3z9bhgIf0um9x6eyWJfwPz01YOL7CZvM6sLTiSLIA==`, published 2026-10-08T01:42:45.969Z; AUG-272 report consistency check, registry document omitted `gitHead`), `@augmentworks/cli@0.3.7` (`gitHead` `876454878a31a897aec1d722fa838c9c0ecea2aa`, integrity `sha512-O9IRRBgpCwRwQzUtIOgpa0nxRQ5UU6x28S7+G6e+egwmRP8QwvHTJgJUzmmFhyq+MhtzW8CPRHnAXhxRHNBIBA==`, published 2026-09-27T21:06:12.276Z; saved-suite customer path, no AUG-272 consistency check), `@augmentworks/cli@0.3.6` (`gitHead` `a9b927a2413305003f817c20e9c5df277512f83e`, integrity `sha512-idDM/kYfDCzDu+iaSqzZjEchyui9I8r1krUFdZ8BmVtZIye2D5WbHFpbYaNzuwjPvV7gCk1XixLwu1kuROXfwA==`, published 2026-09-10T16:26:29.450Z; includes suite-selection `capabilities`), `@augmentworks/cli@0.3.5` (`gitHead` `11570f6cf883ec6e6743e010c35134bb485234dd`, integrity `sha512-WyS9d2lSPhX26ONyxISbN9ncsDoR3JBQjkr6DLaJPl6IrksBg8zxpxawABb4iLZ4ugqlu7TA9J623nqua9dlwQ==`, published 2026-09-09T02:56:49.964Z; omits suite-selection `capabilities`), `@augmentworks/cli@0.3.4` (`gitHead` `c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f`, integrity `sha512-TLeAzDglZoGL6fWLxA9rIUwJd69NFqgmlONzU4uRmhDz4S31+dfSZpaj44ahb6lUjnmuoY6sDmfPStxFzInpVQ==`, published 2026-09-08T06:38:24.847Z), and `@augmentworks/cli@0.3.3` (`gitHead` `4a08ea0d352f2515e725cb9ca946807112422436`). Do not overwrite or relabel any of them. |
| Hosted packet | `support-refunds@0.1.0` |
| Local starter packet | `support-refunds-starter@0.1.0` |

Executable `npx` examples pin **0.4.0**, the identity of this package. It requires Node.js 22.12 or newer. This published-line package includes hosted authorized real-data testing (`target add` / `verify` / `list` / `pull`, `scope create`, `test --suite` with an `aw-suite/3` execution scope), `baseline create`, packaged `demo`, hosted `--assessment` / `--profile`, `usage`, `billing`, `preview-mapping`, `probe`, `catalog list` / `show`, `selection compile` with connector capabilities, `suite validate` / `preview`, `test --suite`, `investigation inspect` / `fetch` / `export-regression`, `test --investigation`, `--estimate` / `--max-credits`, `run status` / `run wait` / `run report`, `compare` / `gate` / `baseline`, `AUGMENTWORKS_API_KEY` mode, empty-directory own-target starters, native customer-suite upload translation, saved-suite v2, v2 gate receipts, durable execution IDs, cross-shard quote uniqueness, and non-destructive generated `.env` guidance. `examples/` is still omitted from the npm tarball; starters ship under `assets/`. `published_package_verified` is published-line identity, not a live registry probe of this exact tarball. Independent inspection of `@augmentworks/cli@0.3.7` (`gitHead` `876454878a31a897aec1d722fa838c9c0ecea2aa`, published 2026-09-27T21:06:12.276Z, tarball SHA-256 `37b448b4db2c195b5c361daab10604d57476fa4d9e441916f7bfe2054f81b313`) is recorded in `docs/feature-readiness/published-registry-evidence.json`. The immutable 0.3.5 tarball omits suite-selection `capabilities` (AUG-82); independently inspected 0.3.6 includes that fix and does not include saved-suite `/2`. Website adoption of this exact 0.3.7 artifact is AUG-250. Do not overwrite or relabel npm 0.3.9, 0.3.8, 0.3.7, 0.3.6, 0.3.5, 0.3.4, or 0.3.3. `npx --yes` only skips the npm prompt; it is not a hosted spending ceiling. Do not run `npx @augmentworks/cli@latest`.

Website adoption: the public website's adopted production-compatible pin was
`@augmentworks/cli@0.3.7` (stated in `/llms.txt`; AUG-250). Supported limits
for that pin are the quickstart and `/docs/connectors/http`. The published
0.3.7 tarball's embedded `LAST_VERIFIED_*` still names 0.3.6; the inspection
receipt in `docs/feature-readiness/published-registry-evidence.json` is the
later evidence. The FAQ example under `examples/faq-chatbot/` is not in the
published 0.3.8 or 0.3.7 tarballs; pin the commit in
`docs/feature-readiness/aug-282-faq-example.md`.

## Website

Adopt a pinned discovery manifest only after tarball inspection. Never `latest`.
