# AUG-124 completion — live-informational CLI handoff

Issue: [AUG-124](https://linear.app/augmentworks/issue/AUG-124/cli-land-the-missing-aug-112-live-informational-client-handoff)
Provenance: [AUG-112](https://linear.app/augmentworks/issue/AUG-112/maincli-add-authorized-live-informational-assessments-with-truthful)
Repository: `augmentworks-org/augmentworks-cli`
Write boundary: CLI source only. No server, database, allowlist, npm publish, website pin, or live-target execution.

This is the missing client half of AUG-112. Website/server `main`
`8dc4763ffbf475b472b1899de7f76515aab00d70` already admits `aw-suite/2`,
`aw-customer-suite/2`, the live packet overlay, and
`?scope=live-informational`. CLI `main` `f6131d3c78944ba25a25ff0a912cee3f5e597158`
still admitted only synthetic `aw-suite/1`. The matching local CLI commit from
PR [augmentworks-org/augmentworks#141](https://github.com/augmentworks-org/augmentworks/pull/141)
was never pushed (GitHub App 403). This change ports that contract onto current
CLI `main` after PRs #52 and #53.

## Code completion vs verification vs release

| Gate | Status |
| --- | --- |
| CLI source implementation | Complete on this branch. |
| Offline fixture verification | Targeted live-contract tests plus `npm test`, `npm run typecheck`, `npm run build`, contract checks, and `node scripts/smoke-pack.mjs`. |
| npm publish / production allowlist / owned-target receipt | **Not claimed.** Source merge is not enablement. |

## Contract

- Authoring: `aw-suite/2` with `syntheticOnly: false` and `aw-live-target/1`.
- Native upload: `aw-customer-suite/2` plus `aw-packet/live-informational-1`.
- Catalog stub `aw-customer-suite@2.0.0` remains a packet binding only; clients cannot authorize an origin.
- Frozen errors: `LIVE_TARGET_NOT_ENABLED`, `LIVE_TARGET_AUTHORIZATION_EXPIRED`, `LIVE_TARGET_SCOPE_MISMATCH`, `LIVE_TARGET_MESSAGE_LIMIT`. Recovery copy never tells an operator to relabel a live target as synthetic.
- Synthetic `aw-suite/1` / `aw-customer-suite/1` producer hash `bc5a3edd…` is unchanged.
- Investigation pin still parses `CustomerSuiteV1Schema` only.
- `run report` without `--scope` still requests and parses `aw-run-report/1`. `--scope live-informational` is an explicit overlay.

## Commands

```bash
node dist/index.js suite validate test/fixtures/customer-suites/live-informational.yaml
node dist/index.js suite preview test/fixtures/customer-suites/live-informational.yaml
node dist/index.js suite preflight test/fixtures/customer-suites/live-informational.yaml
node dist/index.js run report <run-id> --scope live-informational --json
```

`--local` rejects live packets with `LIVE_PACKET_UNSUPPORTED_LOCAL`. `--suite --local` remains `HOSTED_SUITE_UNSUPPORTED_LOCAL`.
