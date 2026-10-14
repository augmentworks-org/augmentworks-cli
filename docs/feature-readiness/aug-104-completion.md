# AUG-104 completion — authoritative v2 whole-suite release receipts

Issue: [AUG-104](https://linear.app/augmentworks/issue/AUG-104/cli-ar03-consume-only-authoritative-v2-whole-suite-release-receipts)

Owned repository: `augmentworks-org/augmentworks-cli`. Main (`augmentworks-org/augmentworks`) remains read-only.

This is **source integration** for the CLI identity-only aggregate gate client
(`aw-manifest-release-gate-request/2` → `aw-manifest-release-policy/2`).
It is **not** npm publication, server deployment, feature enablement, or
customer use. Those remain AR05 / [AUG-87](https://linear.app/augmentworks/issue/AUG-87/maincli-publish-and-adopt-the-aug-82-suite-selection-fix).

## Identity

| Item | Value |
| --- | --- |
| CLI default main at start | `b6cf0bc6613412fdb4cc8b2f3bd3b803f07a5e36` (AUG-104 reviewed head) |
| Working branch | `cursor/ar03-authoritative-gate-v2-5d39` |
| Source head after verification | recorded in git on this branch |
| Frozen contract | [AW-AUTHORITATIVE-RELEASE-1](https://linear.app/augmentworks/document/augmentworks-product-strategy-authoritative-release-evidence-2026-09-22e501c45d79) |
| Source package | `0.3.6` (unchanged; not a published npm version bump) |
| Golden fixtures | `contracts/aw-manifest-release-gate-v2.fixtures.json` |
| Fixture checksum | `0754c0983f3ee1db8d7d994fe426ddf94d2f0d3090957cab9fcda863a7f7ca3a` |
| Main repository | **Not modified.** AR01 owns the producer. |
| Billing / run-report contracts | Untouched |

## Owned implementation

- `src/selection/schema.ts` — strict v2 request/response types, reason-code set, 64 KiB bound, `/v1` and `/api/v1` path constants.
- `src/selection/gate-v2.ts` — local integrity/executable/declaration preflight, identity-only request builder, response identity proof, HTTP family mapping, secret redaction.
- `src/selection/load.ts` — `loadManifestForReleaseGate` (hash, empty, non-executable) before credentials.
- `src/selection/classify.ts` / `format.ts` / `gate-execute.ts` — exit 0 only for server-authoritative exact coverage; JSON stdout / stderr diagnostics.
- `src/cloud/client.ts` — POST identity-only body to `/v1/release-gates/evaluate-manifest`; retry 408/429/5xx; honor `Retry-After`; no v1 fallback.
- `src/commands/gate.ts` — help copy. Existing `--run`/`--baseline` gate is unchanged.

## Verification

No production credential, quote, reservation, run, or charge. Hosted secrets present in this agent environment were unset for the check/smoke processes so child CLI tests did not inherit `AUGMENTWORKS_API_KEY`.

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | Pass |
| Focused Vitest (`gate-v2`, `cli`, `admit`, `cli-release-gate`, `cli-entry`, `baseline/classify`) | 6 files / 60 tests passed |
| `npm run check` | Pass: typecheck, 88 files / 834 tests, `tsup` build, discovery/billing/run-report contracts |
| `npm run smoke:pack` | Pass (66 packed files; packed gate help includes `aw-manifest-release-policy/2`) |
| `npm audit --audit-level=high` | 0 vulnerabilities |

## Limitations

- Server v2 flag may still be off; the client fails closed with `MANIFEST_GATE_CONTRACT_UNSUPPORTED` rather than treating v1 as a pass.
- Compiler fixture hashes in `aw-suite-selection-v1.fixtures.json` are synthetic; gate tests recompute `computeManifestIntegrityHash` before evaluation.
- This merge is not an npm publish. Packaged 0.3.6 remains the published artifact until AR05.
- Runtime POST uses `/v1/release-gates/evaluate-manifest`. `/api/v1/release-gates/evaluate-manifest` is documented as an alias and is not a v1 fallback.
