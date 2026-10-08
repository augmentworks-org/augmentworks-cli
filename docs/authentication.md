# Authentication

Authentication authorizes a local CLI to call AugmentWorks on behalf of one
workspace. That connector credential is used only for CLI-to-AugmentWorks API
requests. It does not authenticate requests to the customer application or
grant the hosted relay access to the local filesystem, shell, environment, or
network.

Authentication is not used by `test --local`. Local mode does not read an
AugmentWorks connector credential or contact the AugmentWorks control plane; it
resolves only the target credentials named by the selected configuration.

## Interactive login

```bash
npx --yes @augmentworks/cli@0.3.8 login
```

The default flow uses browser Authorization Code with PKCE and a temporary
loopback callback. The browser shows the connector authorization and selected
workspace; the human signs in and approves it. Browser approval authorizes this
terminal; it does not start an assessment. The verifier remains local, the code is
single-use and short-lived, and the callback listener closes after completion.

For SSH and other headless environments:

```bash
npx --yes @augmentworks/cli@0.3.8 login --device
```

The CLI displays a short user code and verification URL. Entering the code in a
separately authenticated browser authorizes the waiting CLI. The CLI does not
ask for a password.

## Explicit workspace selection

`--workspace <UUID>` and optional `AUGMENTWORKS_WORKSPACE_ID` name the company
workspace a hosted command is allowed to use. They do not mint credits, start
a run, or widen a credential. `--profile` remains the assessment/selection
profile and is not a tenant selector.

If both the flag and the environment variable are supplied and differ, the CLI
exits `2` with `WORKSPACE_CONFIG_CONFLICT` before any network call. An invalid
value is `INVALID_WORKSPACE_ID` (exit `2`) and is never ignored. After
interactive login, the CLI calls `/auth/me` and stores the credential only when
the actual workspace matches. A mismatch is `WORKSPACE_MISMATCH` (exit `3`);
the previous stored origin slot is left untouched.

Every hosted command (`login`, `whoami`, `usage`, `billing`, `selection compile`,
`test`, `run status`/`wait`/`retry-evaluation`/`report`, `compare`, `gate`,
`baseline status`/`promote`, `investigation fetch`, `recover`, and unregistered
`connect`) resolves its credential, calls `/auth/me`, and compares the expected
workspace before the first tenant request. A machine key issued for company B
with expected workspace A fails closed. The CLI does not retarget the key,
retry as a different credential, or fall back to a stored login.

When no workspace expectation is configured, existing single-workspace scripts
keep working. Human login, `whoami`, and spending context print the
authenticated name and UUID. Headless automation should always set an expected
workspace UUID.

`--workspace` on a local-only operation is rejected (`LOCAL_WORKSPACE_UNSUPPORTED`
on `test --local`; unknown-option on `demo`, `doctor`, `suite validate`, and
other offline commands). `AUGMENTWORKS_WORKSPACE_ID` is ignored in local mode
and does not turn local execution into a cloud call.

Independently inspected `@augmentworks/cli@0.3.7` examples (do not pin
immutable npm `0.3.6`):

```bash
# Developer invited to company B
node dist/index.js login --workspace "$AUGMENTWORKS_WORKSPACE_ID"

# Switching between company A and company B (one stored origin slot)
node dist/index.js logout
node dist/index.js login --workspace "$AUGMENTWORKS_WORKSPACE_ID"
node dist/index.js whoami --workspace "$AUGMENTWORKS_WORKSPACE_ID"

# CI machine key pinned to one workspace
export AUGMENTWORKS_API_KEY=aw_api_...
export AUGMENTWORKS_WORKSPACE_ID=<workspace-uuid>
node dist/index.js whoami --json
node dist/index.js test --assessment ./augmentworks.assessment.yaml --estimate --json --headless
```

Do not paste real workspace IDs, API keys, or invitation tokens into examples
or tickets.

## v0.1 endpoint contract

The CLI permits the production `https://augmentworks.ai` origin or an explicit
loopback development origin through `AUGMENTWORKS_API_URL`. Other origins and
origins containing credentials, paths, queries, or fragments are refused.

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/cli/auth/authorize` | Begin browser authorization with PKCE |
| `POST /api/v1/cli/auth/device` | Create a device/user code pair |
| `POST /api/v1/cli/auth/token` | Exchange authorization-code, device-code, or refresh-token grants |
| `POST /api/v1/cli/auth/revoke` | Revoke the active connector credential |
| `GET /api/v1/cli/auth/me` | Resolve workspace and connector identity. Optional machine fields: `principal_kind`, `credential_id`, `actions`, `expires_at` |
| `GET /v1/billing/capabilities` | Discover implemented billing capabilities (`usage_v1`, `quote_v1`, `status_v1`, `billing_portal_link_v1` when the server advertises them) |
| `GET /v1/billing/usage` | Read the workspace billing snapshot |
| `POST /v1/billing/quote` | Compile a hosted estimate; does not reserve credits or start a run (`connector:run`) |
| `GET /v1/billing/status?runId=` | Read original-run execution/grading status (`connector:run`) |
| `GET /v1/relay/runs/{runId}/report` | Read the pinned hosted report (`aw-run-report/1`). Read-only; never creates or regrades |
| `GET /v1/runs/{runId}/evaluations/{evaluationId}/attempts/{attemptId}/criteria` | Existing criterion index/detail pages (`aw-criterion-detail-read/1`), followed only when same-origin |

Aliases `GET /api/v1/billing/*` exist on the server. The CLI uses the primary
`/v1/billing/*` paths. Quote and status require `connector:run`. Usage and
capabilities discovery use `connector:identity`.

Browser authorization uses `client_id=augmentworks-cli`,
`response_type=code`, exact loopback `redirect_uri`, `state`, `scope`,
`code_challenge`, and `code_challenge_method=S256`. The CLI verifies state and
never sends the PKCE verifier to the authorization endpoint.

## Credential storage

Interactive credentials are revocable connector credentials, not workspace
owner tokens. Native storage is selected by platform:

- macOS stores one API-origin-scoped generic password in the login Keychain via
  the fixed `/usr/bin/security` helper. Save data is hex-encoded for the
  helper's interactive parser and delivered over its private stdin pipe, not a
  command-line argument; the CLI reads the item back before reporting success.
- Windows encrypts an API-origin-scoped file with CurrentUser DPAPI through the
  fixed built-in Windows PowerShell path. The helper protects the directory and
  file ACL for the current SID and Local System, refuses reparse points,
  inherited/broad ACLs, foreign ownership, and invalid ciphertext, and binds
  DPAPI entropy to the API origin.
- Linux uses the Secret Service through `secret-tool` when a session bus and
  helper are available.

If no supported store is available, first-time login fails safely by default.
On POSIX systems the user may explicitly opt into the local fallback with
`--allow-file-credentials`; the CLI emits a warning, refuses symlinks, and
enforces mode `0600`. Plaintext fallback is disabled on Windows because a POSIX
mode cannot prove a safe Windows ACL. No native Node add-on is required.

A long-running hosted `test` process resolves a current access token
before every cloud request. Interactive credentials refresh shortly before
expiry and once after an HTTP 401. Refresh-token rotation is serialized with a
secure, API-origin-scoped process lock; a waiting command re-loads and reuses
the credential written by the process that won the refresh. A same-host stale
lock is reclaimed when its process is positively known dead, including on
systems without Linux boot metadata. A verifiable previous boot or mismatched
process-start identity also proves that a live reused PID is not the recorded
owner. The CLI rechecks the unchanged directory, owner-file identity, and nonce
before removal; unknown identity remains fail-closed.

Use:

```bash
npx --yes @augmentworks/cli@0.3.8 whoami
npx --yes @augmentworks/cli@0.3.8 logout
```

This package also provides `usage` and `billing`, which use the same connector
credential and `connector:identity` scope. They do not need target YAML. They
are read-only: they do not grant credits, reserve units, create Checkout
Sessions, or manage payment methods.

```bash
node dist/index.js usage
node dist/index.js usage --json
node dist/index.js billing --print
node dist/index.js billing --json
```

`billing` opens or prints the first-party `/portal/billing?workspace=` page
from `billingPageUrl`. It does not create Checkout Sessions or Stripe
customers. A connector token is not billing-management permission.

`logout` requests server-side revocation and removes local credential material.
A workspace owner can also revoke a lost machine or connector from the
AugmentWorks portal. Routine automation cleanup must not run `logout`: it
revokes reusable workspace API keys and connector credentials.

## Workspace API keys

Issue a workspace API key at
[https://augmentworks.ai/portal/settings/api-keys](https://augmentworks.ai/portal/settings/api-keys).
Keys use prefix `aw_api_`, are shown once, expire (default 30 days, maximum 90),
and can be revoked or rotated in that settings page. Transport is
`Authorization: Bearer` to the production origin `https://augmentworks.ai` (or
an explicit loopback `AUGMENTWORKS_API_URL` in development). This is not a
Supabase anon/service key and not a chatbot target key.

```bash
export AUGMENTWORKS_API_KEY=aw_api_...
node dist/index.js whoami --json
node dist/index.js run report <run-id> --json
```

`AUGMENTWORKS_API_KEY` is an explicit noninteractive mode. Before any network
or credential-store access, the CLI rejects differing nonempty
`AUGMENTWORKS_API_KEY` and `AUGMENTWORKS_TOKEN` values (`AUTH_ENV_CONFLICT`,
exit `3`). Equal nonempty values are the same explicit key. In this mode the
CLI never loads a keychain or credential file, never launches browser or
device login, never refreshes, never persists credentials, and never falls
back to another identity. A stale `AUGMENTWORKS_REFRESH_TOKEN` is ignored.
When `AUGMENTWORKS_API_KEY` is absent, paired `AUGMENTWORKS_TOKEN` +
`AUGMENTWORKS_REFRESH_TOKEN` behavior is unchanged.

`whoami` prints safe credential metadata (principal kind, credential id,
actions, expiry, workspace name and UUID, connector) and never prints the bearer. Machine
principals do not require an email. Invalid, expired, or revoked keys exit `3`
with `API_KEY_REVOKED` and point at the API-keys settings page.

Report reads need `run:read`, `evaluation:read`, and `criterion_detail:read`.
A report-only key with zero spendable credits can still export a retained
report. `run report` does not quote, create, purchase, or regrade.

## Target authentication is separate

The connector credential above authenticates the CLI to AugmentWorks. Target
authentication is configured independently in `augmentworks.yaml`, for example
with `bearer_env` or `headers_env`, and resolved from the local process
environment or the `.env` file beside the selected configuration. Target
credential values are not put in YAML, sent during login, or uploaded during
run creation. `CHATBOT_API_KEY` (or whatever name `bearer_env` selects) is the
synthetic chatbot target secret. It is never an AugmentWorks workspace API key.

## Environment tokens and API keys

`AUGMENTWORKS_TOKEN` is a static injection point for connector tokens and
integration harnesses. When `AUGMENTWORKS_API_KEY` is unset, `login`, `whoami`,
`usage`, `billing`, and hosted `test` give `AUGMENTWORKS_TOKEN` precedence and
do not load or write the interactive credential store. Pair it with
`AUGMENTWORKS_REFRESH_TOKEN` when the token can rotate. `logout` still attempts
to revoke the environment token and any stored connector credential, removes
local stored credential material when accessible, and warns that the
environment variable remains set. Do not use the one-hour interactive access
token as an unattended CI credential. Prefer a workspace API key for
noninteractive report export.

Never pass a token as a command-line argument, commit it to YAML, print it in a
build log, or paste it into an AI assistant. Rotate CI credentials on exposure
and scope them to one workspace and the minimum required actions.

## GitHub Actions machine credentials

Issue a workspace API key at
[[REDACTED]/portal/settings/api-keys]([REDACTED]/portal/settings/api-keys)
with the CI preset. Store only `AUGMENTWORKS_API_KEY`, an explicit `AUGMENTWORKS_BASELINE_ID`, and
`AUGMENTWORKS_WORKSPACE_ID` as repository secrets. Optional
`AUGMENTWORKS_API_URL` selects the production origin or a loopback development
origin. Generate the synthetic target `CHATBOT_API_KEY` on the runner; do not
put target secrets in GitHub.

Minimum machine actions for hosted CI: `suite:read`, `run:execute`,
`run:cancel`, `run:read`, `evaluation:read`, `criterion_detail:read`, and
`billing:read`. `connector:identity` and `connector:run` are transport scopes
and are not sufficient. Do not grant purchase, subscription administration,
membership, publication, credential issuance, or `baseline:promote`. Revoking
the key blocks the next admission. The workflow cannot buy credits or
administer the workspace.

`test --headless` (or `CI=true` / `AUGMENTWORKS_HEADLESS=1`) requires the
environment key and never loads a keychain or launches a browser. Missing
credentials exit `3` with `AUTH_REQUIRED` without inventing a workspace.
Revoked keys exit `3` with `API_KEY_REVOKED`. A report-only key missing
`run:execute` exits `3` with `MACHINE_ACTION_DENIED` before quote or create.

Copy-pastable recipe: `docs/examples/github-actions-hosted.yml`. It starts an
isolated synthetic target, runs offline doctor and mapping validation,
estimates, admits with `--max-credits N --yes`, waits on that original run,
applies `gate`, writes a credential-free step summary, uploads
`.augmentworks/ci` for 7 days, and always stops the target. Bounded runtime is
20 minutes; concurrency is one hosted job per ref and does not cancel
in-progress billed work. Untrusted fork `pull_request` jobs are skipped.
Do not use `pull_request_target` to execute untrusted code with credentials.

`gate` after a finalized wait is the CI provenance call
(`POST /v1/release-gates/evaluate`). The server emits
`own_target.ci_result_recorded` once for that `aw-release-policy/1` decision
when the principal is a machine. Unfinished evaluation never reaches `gate`
and cannot be a green release. Status, wait, recover, and report do not start
a reservation. Do not call `logout` from CI cleanup.

