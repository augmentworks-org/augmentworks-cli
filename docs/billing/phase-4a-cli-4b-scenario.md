# Clean-directory scenario script imported from main Stage 4A

Copied from `augmentworks-org/augmentworks` `docs/billing/phase-4a-cli-4b-scenario.md`
at main commit `49806f0f52377bbca0fbe02f160668723c589fa7`. Main 4A fixture YAML
is **not** proof that `augmentworks init` generates those files. This CLI
phase owns packaged onboarding.

## Website install pin vs unpublished source

| Item | Value |
| --- | --- |
| Website / discovery pin | Published `@augmentworks/cli@0.3.2` |
| Source package for this branch | `0.3.3` (unpublished) |
| Commands not in 0.3.2 | `billing`, `usage`, `test --estimate`, `--max-credits`, `run status`/`wait`, init starter generation |
| Do not advertise | `npx @augmentworks/cli@0.3.3` |

## Expected balances (server ledger)

| Journey | Available | Reserved | Consumed | Notes |
| --- | --- | --- | --- | --- |
| Eligible new user after bootstrap | 200 | 0 | 0 | Trial once. `trial_200_v1` |
| Quote 10 then admit 10, terminalize | 190 | 0 | 10 | Same as Stage 1 invariant |
| Cancel after 3 consumed / 7 released | 197 | 0 | 3 | |
| Insufficient credits (0 available) | 0 | 0 | (prior) | Dashboard and prior results remain. Billing URL only. |
| Test-mode pack fulfilled | previous + 300 | 0 | unchanged | SKU `test_pack_300_v1`. Purchased lots do not expire. |
| Pending fulfillment | unchanged | unchanged | unchanged | `pendingCommerce` is not spendable |
| Returning former trial user | no second 200 | | | Can buy a pack without a new trial |
| Local/demo/offline | n/a | n/a | n/a | No billing calls |

One standard credit = one scenario attempt against one target, consumed at
the first durable target-command lease. A valid FAIL is billable. Grading
retries and status reads debit 0 customer units.

## Safe URLs

```text
https://augmentworks.ai/portal/billing?workspace=<workspace-uuid>
```

No CLI order-status API. Purchase history is browser-only.
