# Stabilization rollout (CLI)

This is the CLI half of the September 5, 2026 stabilization rollout. Database
migrations, publication RPCs, Turnstile, and dashboard grants belong to
`jeffskafi/augmentworks`.

This document does not authorize production publication, customer contact, or
running customer targets.

## Compatibility matrix

| Client / server | Behavior |
| --- | --- |
| Published `@augmentworks/cli@0.2.0` + stabilized server | Existing strict `aw-relay/0.1` create/poll/status/cancel contracts remain valid. `recover` is absent from that published tarball. |
| Published `@augmentworks/cli@0.3.1` + stabilized server | Full inspect/retire/resume/cancel once `POST /v1/relay/run-intents:reconcile` (`aw-run-intent-reconcile/0.1`) is deployed. |
| `@augmentworks/cli@0.3.1` + old server | Create/resume within the replay window still works. Reconcile 404/405/501 becomes `RECOVERY_UNSUPPORTED`. Pending journals are not cleared. |
| Packed CLI + `--local` | Unchanged; no AugmentWorks connection. |

Do not add unknown fields to existing strict create/status/poll success
schemas. Recovery uses a separate endpoint and protocol version.

## Release order

1. Deploy the website/server reconcile endpoint and typed `rejected_uncreated`
   create errors. Keep old create/status contracts.
2. Verify ordinary-role create, replay, and reconcile against a disposable
   environment (website repo).
3. Publish `@augmentworks/cli@0.3.1` through the existing trusted-publishing
   workflow. Do not republish `0.2.0`. `0.2.1` is already on npm
   ([v0.2.1](https://github.com/jeffskafi/augmentworks-cli/releases/tag/v0.2.1)).
4. Update the website CLI pin and recovery copy to `0.3.1` after npm lists it.
5. `npx --yes @augmentworks/cli@0.3.8 recover --help` must list
   `--retire`, `--resume`, and `--cancel`, and must not list `--force-delete`.
   **Done:** verified on the published tarball.

## Local verification

```sh
npm ci
npm run check
npm run test:integration:recovery
npm run test:e2e:cli-auth
npm run smoke:pack
```

Expected: typecheck, unit/integration tests, build, packed `recover --help`,
and local `--local` smoke.

Recorded on this branch after implementation:

- `npm run check`: typecheck, 291 tests, build passed
- `npm run test:integration:recovery`: 21 tests passed
- `npm run test:e2e:cli-auth`: 4 tests passed
- `npm run smoke:pack`: passed (packed `recover --help` present)


## Rollback

- Keep pending journals and retirement archives. Do not tell users to delete
  `.json` intent or journal files.
- Last compatible published CLI remains `@augmentworks/cli@0.2.0` for create
  replay inside the server window.
- If the new reconcile endpoint misbehaves, keep it returning `unknown` rather
  than a false `rejected_uncreated`. The CLI will preserve state.

## Operator notes

- New configuration variables: none in this repository.
- New protocol: `aw-run-intent-reconcile/0.1` on
  `POST /v1/relay/run-intents:reconcile`.
- Archives under the state `runs/archive/` directory store only request id,
  hash, tenant, phase, optional run id, and reason.
