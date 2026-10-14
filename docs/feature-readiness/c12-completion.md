# C12 completion — catalog metadata and bounded suite selections (AUG-46)

Issue: [AUG-46](https://linear.app/augmentworks/issue/AUG-46/cli-consume-catalog-metadata-and-deterministic-suite-selections-with)
Repository: `augmentworks-org/augmentworks-cli`
Work package: C12 · Audit coverage: F02, F12, SCENARIO_CAPACITY

This file is issue-specific. It does not replace C03, C05, C07, E06, E10, or
E12 completion records.

This is the CLI record for consuming the main-owned coverage catalog and
deterministic suite-selection / shard contracts. It is **code complete** in
this repository. It is **not** npm-published. Source integration is distinct
from release acceptance under AUG-7.

## Source and implementation identity

| Item | Value |
| --- | --- |
| Audit / default-main baseline | `8a9f31a9fa6d99b2f0ea7e1530a4b73741592027` |
| Working base (`origin/main`) | `303fc38d3168814ef6f698e75da0dcbcb4ec2a25` (merge of CLI PR #38 / AUG-45) |
| Working branch | `cursor/catalog-selection-shards-950b` |
| Implementation commits | `8869c5bdcf06a7a30f5e4ff0715bc159ce903ede` (feature), `d199d90b34423d99021d8680b0494283dff1916c` (schema/create-run/admit fixes), `4379a957355abcf1c18c64d66a3e730fb363aa62` (verification evidence) |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/40 |
| AUG-24 (C05) | Merged CLI#30. Explicit session mode remains config-advertised; compile sends `single_turn` or `explicit_session_v1`. |
| AUG-25 (C08) | Main#74 merge `71fc0d4`; head cited `0288c5ed12eeb5563d144ae61521cf686e9a2c2b`. Schema `aw-coverage-catalog/1`. Live catalog checksum `75fe8b5d745bed9da4459875b1b40a8c87f56f3e8740765df6de28653b40a566` (`catalogVersion` `1.0.0`). Consumer fixtures SHA-256 `d6b5803007218cfeb0a6c918122d2a32c42e4e9c29b603bf8284411f4d210ea9`. |
| AUG-31 (C11) | Main cited commit `2ac0e80b13277414c61d04f8899e0ba78a46325c`. Schema `aw-suite-selection/1` SHA-256 `73520f60369feaa74799aacd3da4473a2bf0006cac6d54bc69c3f019f26f83d0`; producer fixtures SHA-256 `45231e40cf88f040b49d4bb72ac1d3b3a3ed350c81b7bfa547962a81de71c26b`. Consumer fixtures SHA-256 `d7cb44cb8a776fcd60b816b391525c61721a95561be29ab70e1f37dd6fb481c5`. |
| AUG-32 (E06) | Merged CLI#31. Customer-owned `aw-suite/1` files remain; this ticket does not replace them with a local compiler. |
| AUG-14 (G01) | Billing handoff unchanged. Quotes, `--max-credits`, reservation/settlement, and original-run recovery are reused. |
| AUG-45 (C03) | Merged CLI#38 `303fc38`. Initial hosted GHA recipe stays the single-run gate; this ticket adds optional whole-suite `gate --manifest-file`. |
| AUG-40 (E10) | Merged CLI#34. Existing `--run`/`--baseline` gate is unchanged; whole-suite policy is a separate evaluate-manifest call. |
| AUG-35 (C07) | Merged CLI#32. One generated assessment format remains. Selection fields are optional additive YAML, not a second initializer. |
| Main repository fetch | **Blocked.** `GET https://api.github.com/repos/augmentworks-org/augmentworks` returns HTTP 404. Main schema files were not byte-copied. Identities are Linear-published plus live public/auth probes (`createsBillableRun: false`). |
| Billing contract (untouched) | `aw-billing/1` from `650472d91442a6866a7b6ef18e6dacc23a2a9260`; schema `3097c7aa74233e97233dcc488ba7eaacb1be5c6af0554bc308ca1569d155b645`; fixtures `a4b9234b426f98132ddbd8e82755caa0aa718c4ec1e3bf17064d1bf364a6cb84` |
| Run-report contract (untouched) | `aw-run-report/1`; schema `7726ec277d33e435d2832e8be0898baf9337631d779f073a10c7795fc7de38ff`; fixtures `febd2626c96672d0e79afc4706b3a5136598b61bbebbdeb0f8ec1bdbc44cd806` (AW-QA-1) |
| Migrations | None. This repository does not own SQL. |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified |
| Competing CLI PRs | Draft PR #39 (AUG-79) also edits `src/commands/test.ts` (help copy), `scripts/smoke-pack.mjs`, README/docs version strings, and copy-contract/release tests. It does not own catalog/selection. Merge after one lands will need a rebase of the other. No competing rewrite of the compiler/catalog path. |

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| Code completion (this repository) | **Complete.** Catalog listing, selection compile, bounded shard execution, and manifest gate mapping. |
| Deterministic verification | **Passed** in this checkout. Commands and real outcomes below. |
| Live hosted assessment / npm publish | **Not run / not done.** |
| Release readiness | **Not ready.** Published npm remains `@augmentworks/cli@0.3.4` candidate; this source change is not a registry publish. |

## Interfaces

Public catalog (no Bearer):

```text
GET /v1/catalog/coverage
GET /v1/catalog/coverage?catalogVersion=<semver>   # stale → 409 catalog_stale
If-None-Match → 304
```

CLI:

```text
augmentworks catalog list [--json] [--catalog-version <semver>]
augmentworks catalog show <case|profile|packet@version> [--json]
augmentworks selection compile [-c path] [--assessment path] [--profile smoke|release] [--include-catalog] [--include-tags tags] [--exclude-tags tags] [--out path] [--json]
augmentworks test --manifest <file> --shard <id> --max-credits N --yes
augmentworks test --manifest <file> --all-shards --max-credits N --yes [--artifact-out path]
augmentworks gate --manifest-file <file> [--declared-shards path] [--wait] [--json]
```

Server compiler (auth, `createsBillableRun: false`):

```text
POST /v1/suite-selections/compile          # aw-suite-selection/1
POST /v1/release-gates/evaluate-manifest   # aw-manifest-release-policy/1
```

Per-run caps stay 20 cases / 60 executions / 512 commands. Shard
`packetBindings` come from the server (`aw-customer-suite@1.0.0`); the CLI
does not substitute `customer-owned-suite@1.0.0`. Exit mapping: pass=0,
block=10, incomplete=11, evaluator error=12, incompatible=2,
`createsBillableRun`=4.

Cache: `{stateDir}/catalog/coverage-v1.json` honors `maxAgeSeconds` (300) and
`staleIfErrorSeconds` (86400). Observation/recovery reuse `RunIntentStore`;
status never duplicates admission.

## Examples

```bash
node dist/index.js catalog list --json
node dist/index.js catalog show response-quality/0.1.0/R01
node dist/index.js selection compile \
  -c augmentworks.yaml \
  --assessment ./augmentworks.assessment.yaml \
  --out ./suite-selection.manifest.json
node dist/index.js test \
  --manifest ./suite-selection.manifest.json \
  --shard shard-000 \
  --max-credits 30 \
  --yes
node dist/index.js gate --manifest-file ./suite-selection.manifest.json --declared-shards ./suite-selection.declared-shards.json --json
```

Optional assessment YAML (same `aw-assessment-file/1` format):

```yaml
selection:
  profile: smoke
  include_catalog: true
  include_tags:
    - factuality
```

`test --profile` remains `quick|full|combined|custom`. Smoke/release is
`selection.profile`. `--local` cannot use catalog, compile, or manifests.

## Test evidence

Injected Cloud Agent `AUGMENTWORKS_API_KEY` is `AUTH_ENV_CONFLICT` (exit 3) if
left in the environment. The suite was run with API key/token unset.

| Command | Outcome |
| --- | --- |
| `npx tsc --noEmit` | Pass |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN npx vitest run test/catalog/cli.test.ts test/selection/admit.test.ts test/selection/cli.test.ts test/assessment/load.test.ts test/assessment/cli-flags.test.ts test/integration/cli-entry.test.ts test/docs/copy-contract.test.ts test/release.test.ts` | Pass. **8 files, 104 tests** |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN npm test` | Pass. **82 files, 765 tests** (vitest 4.1.11) |
| `npm run build` | Pass. `dist/index.js` 2.03 MB / 2.1M on disk |
| `npm run check:discovery` | Pass. `@augmentworks/cli@0.3.4 (development)` |
| `npm run check:billing-contract` | Pass. Untouched `aw-billing/1` hashes above |
| `npm run check:run-report-contract` | Pass. Untouched `aw-run-report/1` hashes above |
| `env -u AUGMENTWORKS_API_KEY -u AUGMENTWORKS_TOKEN -u AUGMENTWORKS_API_URL npm run smoke:pack` | Pass. Packed tarball **64 files, 479660 compressed bytes**. Packed `--help` lists `catalog` and `selection`. Packed `catalog` help includes list/show; `selection` help includes compile; `test` help includes `--manifest` / `--all-shards`; `gate` help includes `--manifest-file`. Packed billing fixture: `creates=1 quotes=4 targets=1 polls=3 refreshes=1`. Packed report fixture: `requests=8`. |
| Live hosted assessment / npm publish | **Not run / not done** |
| GitHub Actions on this branch | Recorded on the PR after push; not claimed here |

Behavior covered (synthetic fixtures only; no quote/create on these paths unless a shard is explicitly consented):

- Stale catalog `?catalogVersion=0.0.1` → exit 2 `CATALOG_STALE`; catalog GET sends no `Authorization`. Fresh cache skips a second fetch; expired max-age revalidates with `If-None-Match` → 304.
- Empty compile (`compile_empty`) → prints `includedCaseCount: 0`, exit 2 `SELECTION_EMPTY`, no `POST /v1/billing/quote` or `POST /v1/relay/runs`.
- Incompatible session (`capability_multi_turn`) → exit 2 `SELECTION_UNEXECUTABLE`; incompatible rows remain visible; no quote.
- Per-run expanded limit → exit 2 `PER_RUN_EXPANDED_LIMIT`; caps stay 20/60/512; no quote.
- `--local` with catalog/compile/manifest → exit 2 `HOSTED_SELECTION_UNSUPPORTED_LOCAL`.
- Executable compile writes the immutable manifest (`createsBillableRun: false`, packet key `aw-customer-suite`) without quoting.
- `gate --manifest-file` with empty declared shards maps server `incomplete` / `missing_shard` to exit 11; JSON keeps `coverageComplete: false`. Complete declared set maps server `pass` to exit 0. Neither path creates a run.
- Interrupted shard progress resumes the same shard; starting a different shard is `SHARD_PROGRESS_BLOCKED`. Exhausted aggregate budget skips remaining pending shards; artifact `createsBillableRun` stays false.
- Additive Commander registry still lists login, whoami, catalog, selection, test, suite, investigation, run, compare, gate, baseline, recover.

## Compatibility

- No local compiler or pricing engine.
- No implicit unlimited batch; `--yes` is not a budget; `--all-shards` requires
  finite `--max-credits`.
- No second generated assessment format.
- Additive Commander registration of `catalog` and `selection` only.
- Initial GHA recipe remains `gate --run` / `--baseline`. Whole-suite gating is
  opt-in via `--manifest-file`.
- Synthetic fixtures only. Workspace IDs in consumer fixtures are
  `11111111-1111-4111-8111-111111111111`.

## Remaining release requirements

- Review/merge of PR https://github.com/augmentworks-org/augmentworks-cli/pull/40.
- Keep Linear **In Review**. Do not mark Done from source integration.
- Do not npm-publish or activate live billing.
- Dedicated AUG-7 / AUG-48 / release-acceptance tickets verify published artifacts.
- Website/CLI identical authoritative counts require the already merged
  main compiler; this CLI only renders server results.
