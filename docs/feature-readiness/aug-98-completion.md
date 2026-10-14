# AUG-98 completion — land the missing AUG-90 saved-suite v2 client handoff

Issue: [AUG-98](https://linear.app/augmentworks/issue/AUG-98/cli-land-the-missing-aug-90-saved-suite-v2-client-handoff)

Owned repository: `augmentworks-org/augmentworks-cli`. Main (`augmentworks-org/augmentworks`) remains read-only.

This is **source integration** for the saved-suite v2 compile → quote → execute
client contract. It is **not** npm publication, website pin adoption, billing
activation, or released policy-feature acceptance. Those remain
[AUG-87](https://linear.app/augmentworks/issue/AUG-87/maincli-publish-and-adopt-the-aug-82-suite-selection-fix) /
P09 / P10 / [AUG-7](https://linear.app/augmentworks/issue/AUG-7/gate-automated-merges-and-verify-releases-before-marking-tickets-done).

[AUG-90](https://linear.app/augmentworks/issue/AUG-90/maincli-p06-make-saved-policy-suites-executable-through-a-verified-cli)
is historical evidence that the server half merged and that a CLI mailbox
patch existed. This issue is not marked Done from that patch file.

## Identity

| Item | Value |
| --- | --- |
| CLI default main at start | `dcba2537c2a298af1dfaebbddac679b4c8145622` (AUG-98 reviewed head) |
| Working branch | `cursor/saved-suite-v2-handoff-80d9` |
| Pull request | https://github.com/augmentworks-org/augmentworks-cli/pull/47 |
| Source package | `0.3.6` (unchanged; not a published npm version bump) |
| Published artifact | still immutable `@augmentworks/cli@0.3.6` `gitHead` `a9b927a2413305003f817c20e9c5df277512f83e` |
| Server half | already merged in `augmentworks-org/augmentworks#117`; cited main `df4844bef8b9990b747e2c79c02c57ff55cdd43b` |
| Main repository fetch | **Blocked.** `GET https://api.github.com/repos/augmentworks-org/augmentworks` returns HTTP 404. `docs/policy-tests/P06-cli.patch` was **not** applied. Client reconstructed from the AUG-90/AUG-98 contract against current CLI `main`. |
| Billing contract (untouched) | `aw-billing/1` from `650472d91442a6866a7b6ef18e6dacc23a2a9260`; schema `3097c7aa74233e97233dcc488ba7eaacb1be5c6af0554bc308ca1569d155b645`; fixtures `a4b9234b426f98132ddbd8e82755caa0aa718c4ec1e3bf17064d1bf364a6cb84` |
| Run-report contract (untouched) | `aw-run-report/1` schema `7726ec277d33e435d2832e8be0898baf9337631d779f073a10c7795fc7de38ff`; fixtures `febd2626c96672d0e79afc4706b3a5136598b61bbebbdeb0f8ec1bdbc44cd806` |
| Migrations | none |
| Counterpart | `augmentworks-org/augmentworks` was **not** modified |

## Owned implementation

- `src/selection/schema.ts` — request `acceptedManifestVersions` (exactly `aw-suite-selection/2`, requires `suiteRevisionId`); manifest `schemaVersion` `/1`|`/2`; nullable `catalogChecksum`; strict `aw-saved-suite-binding/1`.
- `src/selection/request.ts` — saved-suite assessments send v2 negotiation and omit `includeCatalog`; catalog/flag compiles omit `acceptedManifestVersions`.
- `src/selection/parse.ts` — parse v2 bindings; map a v1 body or HTTP 400 on a requested saved-suite compile to `SAVED_SUITE_BINDING_UNSUPPORTED`.
- `src/selection/admit.ts` — binding/case/integrity admission; `savedSuitePinFromManifest` projects `suite_id` / `suite_revision_id` / `suite_content_hash` (`canonicalHash`); shard `plan_hash` stays the shard hash.
- `src/selection/errors.ts` — `SAVED_SUITE_BINDING_UNSUPPORTED` / `INVALID` / `STALE`.
- `src/commands/selection.ts` / `src/commands/test.ts` / `src/cloud/client.ts` / `src/selection/load.ts` / `src/selection/format.ts` — compile, `--manifest`, estimate, quote, and create carry the pin.
- `test/selection/saved-suite.test.ts` — schema, negotiation, pin, local HTTP compile → estimate → finite-ceiling create, and zero-quote negatives.

## Verification

Commands run in this checkout with injected `AUGMENTWORKS_API_KEY` /
`AUGMENTWORKS_TOKEN` / `AUGMENTWORKS_REFRESH_TOKEN` unset. No production
credential, quote, reservation, run, or charge.

| Command | Outcome |
| --- | --- |
| `npm run typecheck` | Pass |
| `npx vitest run test/selection/saved-suite.test.ts` | Pass. 1 file / 10 tests |
| `npm test` | Pass. 87 files / 820 tests (was 86 / 810 on `dcba2537`) |
| `npm run build` | Pass. `dist/index.js` 2.05 MB |
| `node --import tsx scripts/check-discovery-manifest.mjs` | Pass. `@augmentworks/cli@0.3.6 (development)`; last independently inspected published 0.3.5 |
| `npm run check:billing-contract` | Pass. hashes unchanged |
| `npm run check:run-report-contract` | Pass. hashes unchanged |
| `npm audit --audit-level=high` | found 0 vulnerabilities |
| `npm run smoke:pack` | Pass. 64 files, packed compile snapshot, billing fixture `creates=1 quotes=4`, report fixture, local 0.3.6 `releaseReady=false` (registry-identity and live-authorized not run) |
| Live hosted assessment / npm publish | **Not run.** Source integration is not publication. |

Targeted fixture coverage:

- `selection compile --assessment policy.assessment.yaml --json` sends `acceptedManifestVersions: ["aw-suite-selection/2"]` and does not quote.
- `test --assessment ... --estimate --json` quotes once with the complete suite triple and does not create.
- `test --assessment ... --max-credits 30 --yes --json` quotes once more, creates once with the same triple, `quote_id` `55555555-5555-4555-8555-555555555555`, `max_credits` 30.
- Legacy v1 compile body and HTTP 400 fail with `SAVED_SUITE_BINDING_UNSUPPORTED` and zero quote/create paths.
- Tampered, mixed-revision, and stale bindings fail with `SAVED_SUITE_BINDING_INVALID` / `STALE` and zero quotes.

## Out of scope

- Package version bump and npm publish
- Website / npx pin adoption (AUG-87)
- Main-repo compiler, HTTP negotiation, or mailbox patch edits
- Billing activation, policy-generation APIs/UI, env-copy fix
- P09/P10 released policy-to-report acceptance
