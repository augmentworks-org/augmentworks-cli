# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.8] - 2026-10-08

Immutable patch. Customers can install the AUG-272 report consistency check
without replacing npm `0.3.7`. The dev-only `source-map-js` lock is `1.2.2`,
so `npm audit --audit-level=high` can pass `prepublishOnly`.

### Fixed

- `run report` no longer exits 0 for an internally contradictory hosted export
  ([AUG-272](https://linear.app/augmentworks/issue/AUG-272/cli-reject-internally-contradictory-hosted-report-exports-before)).
  A claimed pass with a completed required verdict of `fail`, or a known aggregate
  `failed` count above zero, is `REPORT_EVIDENCE_CONTRADICTION`. Coverage that
  claims more completed attempts or finished required judgments than the export
  retrieved is `REPORT_COVERAGE_MISMATCH`. Both stay retrieved with
  `complete: false` and exit 11. Original evidence is not rewritten. Coherent
  passes stay exit 0 and coherent assessed failures stay exit 10. Advisory
  failures and attempt execution outcomes are not required semantic failures.
  This ships in `@augmentworks/cli@0.3.8` and does not overwrite npm `0.3.7`.

- The release audit resolves `tsup -> postcss -> source-map-js@1.2.2`, outside
  [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)
  ([AUG-273](https://linear.app/augmentworks/issue/AUG-273/qa-bugcli-update-source-map-js-so-the-release-audit-passes)).
  The package stays a dev dependency and is not added to the packed CLI.

### Changed

- Customer-facing CLI copy no longer states a blanket synthetic-only product
  ban ([AUG-196](https://linear.app/augmentworks/issue/AUG-196/main-cli-replace-blanket-synthetic-only-copy-contracts-and-setup)).
  Hosted real-data quote and admission stay release-disabled until a compatible
  published release is enabled. `aw-packet/0.1` and fictional starters stay
  synthetic. `aw-packet/local-authorized-1` remains local and account-free and
  is not hosted authority. This text is not legal approval and does not publish
  a new npm pin.

- `init --agent` and `test --local` progress copy now match that gated claim
  ([AUG-188](https://linear.app/augmentworks/issue/AUG-188/cli-support-real-data-execution-in-hosted-and-fully-offline-workflows)
  handoff from AUG-196). Generated agent setup no longer tells operators to add
  only synthetic hooks. Local cancellation/progress lines no longer label
  `aw-packet/local-authorized-1` runs synthetic. Hosted quote and admission
  stay release-disabled.

### Added

- Customer controlled-action wrapper (`runCustomerBoundary`) persists the
  signed receipt before delivery. A rejected or unacknowledged receipt stays
  evidence-pending and is retried byte-for-byte without rerunning the tool.
  Public controlled actions remain unavailable
  ([AUG-210](https://linear.app/augmentworks/issue/AUG-210/qa-bugmain-cli-land-the-controlled-action-client-and-preserve-failed)).

- Frozen AW-REAL-DATA-1 revision 1 schema, fixtures, and checksums are vendored
  from the verified Linear attachment on
  [AUG-188](https://linear.app/augmentworks/issue/AUG-188/cli-support-real-data-execution-in-hosted-and-fully-offline-workflows)
  (`jeffskafi/augmentworks@b198906188bab2dac9ae2a1ad539405807e46e1e`).
  `contracts/aw-real-data-1.lock.json` records `imported: true` with
  `releaseEnabled` and `runtimeEnforced` still false. Generic fabricated
  contract bytes only; no customer records.

- CLI privacy transforms for [AUG-189](https://linear.app/augmentworks/issue/AUG-189/cli-minimize-real-customer-content-before-upload-journals-and-exports)
  (`AW-REAL-DATA-1` R06). Frozen `aw-data-policy/1` /
  `aw-redaction-profile/1` documents drive `inspectOutbound`,
  `applyRedactionProfile`, and `sealDataHandlingReceipt`. Mapping preview,
  relay journals, local HTML/JSON/JUnit artifacts, and assessment reference
  bundles can project a retained representation before hashing. Credentials
  stay excluded in both minimized and verbatim modes; receipts never echo raw
  matches. Hosted real-data remains unavailable; AUG-188 owns contract vending
  and command/executor wiring. Local artifacts are customer-controlled and are
  not deleted by a hosted purge.

### Fixed

- The controlled-action intent ledger now keeps its directory and intent files
  private to the current user and reclaims a lock left by a positively dead
  owner, or an empty ownerless lock left by a crash. Live and unreadable owners
  stay fail-closed, and `action recover` still does not rerun the customer tool
  ([AUG-212](https://linear.app/augmentworks/issue/AUG-212/qa-bugcli-harden-the-action-intent-ledger-for-private-crash-safe)).
  Public controlled actions remain unavailable. Source `0.3.7` work; this does
  not publish the package.

- A hosted permit request that throws, times out, or returns no permit document
  leaves the action intent `prepared` so the same idempotency key can be
  retried. Dispatch is claimed only after a validated permit, and only that
  claim runs the customer tool once. A crash after the claim stays
  indeterminate. Invalid permits stay denied. Public controlled actions remain
  unavailable
  ([AUG-211](https://linear.app/augmentworks/issue/AUG-211/qa-bugcli-retry-permit-issuance-before-committing-action-dispatch)).

- The hosted GitHub Actions recipes continue to `gate` when `run wait` exits 11
  because billing status is `completed` / `complete` / `outcome` null
  ([AUG-201](https://linear.app/augmentworks/issue/AUG-201/qa-bugcli-hosted-github-actions-recipe-treats-wait-exit-11-as)).
  That document is a terminal status query, not unfinished grading. Pending and
  partial evaluation still skip the gate. `run wait` and `run status` still
  exit 11 when billing `outcome` is null. Source `0.3.7` recipe; this does not
  publish the package.

- `probe --yes` now classifies a non-idempotent send that exceeds
  `operation_timeout_ms` as `failure_class=timeout` (`PROBE_TIMEOUT`) instead of
  generic `target` (`PROBE_TARGET`)
  ([AUG-168](https://linear.app/augmentworks/issue/AUG-168/qa-bugcli-probe-yes-classifies-a-send-operation-timeout-as-generic)).
  HTTP still reports `TARGET_OUTCOME_INDETERMINATE` so local runners do not
  blindly retry an ambiguous delivery. Connection refusal, hosted isolation, and
  credit accounting are unchanged. Source `0.3.7` work; npm latest remains an
  independently inspected published pin until the protected publish.

- npm/npx `init` next steps and generated `OWN-TARGET.md` now invoke the
  published pin (`npx --yes @augmentworks/cli@0.3.7 …`) instead of
  `node dist/index.js` from the customer project directory
  ([AUG-160](https://linear.app/augmentworks/issue/AUG-160/qa-bugcli-init-next-steps-tell-npm-installed-customers-to-run-node)).
  Source checkouts (`LOCAL_DISTRIBUTION === "git"`) may still document
  `node dist/index.js` after an explicit build. Independently inspected npm
  `0.3.6` remains an immutable historical tarball until the protected
  `v0.3.7` publish.

### Added

- Coordinated live-informational CLI contract for [AUG-112](https://linear.app/augmentworks/issue/AUG-112/maincli-add-authorized-live-informational-assessments-with-truthful)
  / [AUG-124](https://linear.app/augmentworks/issue/AUG-124/cli-land-the-missing-aug-112-live-informational-client-handoff).
  `suite validate` / `preview` / `preflight` admit `aw-suite/2` and
  `aw-customer-suite/2` offline. Exact approved HTTPS origin, expiry,
  send-only operations, and the dispatched-message cap are enforced before
  quote and send. Live packets are rejected in `--local`. `run report --scope
  live-informational` requests `aw-run-report-live-scope/1` without mutating
  synthetic `aw-run-report/1`. Source merge does not enable a production
  allowlist, publish the CLI, or authorize any third-party origin.
  Synthetic `aw-suite/1` hashes and packets stay frozen.

- Multi-shard `test --all-shards` pins one authenticated API origin, workspace,
  and connector for the whole execution, including resume and later shards
  ([AUG-137](https://linear.app/augmentworks/issue/AUG-137/cli-mt11-pin-every-shard-and-resumed-selection-to-one-workspace-and)
  / MT11). Local documents are `aw-selection-execution/3` with opaque
  `RunIntentTenantBinding` identity only (never access or refresh tokens).
  A login switch or foreign-workspace manifest fails with
  `SELECTION_TENANT_MISMATCH` before another quote, create, or target call.
  Unbound `aw-selection-execution/2` and spent `aw-selection-progress/1` files
  fail closed as `SELECTION_LEGACY_UNBOUND` and are not relabeled with the
  current login. This is source `0.3.7` work; npm latest remains independently
  inspected `0.3.6` until the protected publish.

- `--workspace <UUID>` and optional `AUGMENTWORKS_WORKSPACE_ID` on `login` and
  every hosted command
  ([AUG-138](https://linear.app/augmentworks/issue/AUG-138/cli-mt12-add-explicit-workspace-login-and-preflight-guards-to-every)
  / MT12). Flag/env conflicts are `WORKSPACE_CONFIG_CONFLICT` before network.
  Selected login sends `expected_workspace_id` and verifies `/auth/me` before
  storing. Hosted commands compare the expected workspace after `/auth/me` and
  fail `WORKSPACE_MISMATCH` before quote, upload, or target work. Machine keys
  are not retargeted or replaced by a stored login. Local `--workspace` is
  rejected; `AUGMENTWORKS_WORKSPACE_ID` is ignored in local mode. This is
  source `0.3.7` work; do not treat independently inspected npm `0.3.6` as
  having the new flags.

## [0.3.7] - 2026-09-17

Published-line package for native customer-suite upload translation, saved-suite
v2 binding, authoritative v2 whole-suite gate receipts, durable execution IDs,
cross-shard quote uniqueness, and non-destructive generated `.env` guidance.
Protected publish completed 2026-09-27. Independently inspected npm
`@augmentworks/cli@0.3.7` `gitHead`
`876454878a31a897aec1d722fa838c9c0ecea2aa` is recorded in
`docs/feature-readiness/published-registry-evidence.json`. The published
tarball predates that inspection commit, so its embedded `LAST_VERIFIED_*`
still names 0.3.6. Do not republish 0.3.7 or relabel `@augmentworks/cli@0.3.6`.
`published_package_verified` is published-line identity, not a live registry
probe of this exact tarball.

### Fixed

- Customer-suite uploads now translate local `aw-suite/1` authoring into the
  actual hosted `aw-customer-suite/1` source document. Admission pins the
  native canonical hash, `suiteRevisionId`, `aw-customer-suite` packet, and
  fully qualified scenario IDs. The authoring hash still detects local edits.
  Machine credentials stop before the forbidden suite write, and unsupported
  deterministic observations fail before upload rather than being omitted.
  Producer schema and fixture bytes are pinned to main `7ee82d2f`.

- Multi-shard `aw-selection-execution/2` now rejects a non-null `quoteId` or
  `runId` already bound to a different shard before another quote, admission, or
  ledger reconcile. Same-shard poll/retry completions stay idempotent and count
  once. Charged and reserved totals are the sum of validated per-shard bindings,
  so a replayed hosted identifier cannot undercount `--max-credits`. Persisted
  documents with cross-shard duplicates fail closed as
  `SELECTION_EXECUTION_CORRUPT`.

- Generated `OWN-TARGET.md` and clone-example setup no longer unconditionally
  copy `.env.example` over an existing `.env`. Init still creates a mode-0600
  `.env` when missing and never replaces an existing file. Missing-file
  recovery is copy-if-absent.

### Added

- `test --all-shards` persists `aw-selection-execution/2` documents with a
  cryptographically random `executionId` distinct from the immutable manifest
  hash. An unfinished attempt refuses a second invocation with
  `SELECTION_RESUME_REQUIRED` until `--execution-id` is supplied. A terminal
  attempt plus a later invocation without that flag starts a new empty
  execution. Local remaining credits are reconciled from unique quoted and
  charged units; incomplete coverage, including aggregate budget exhaustion,
  cannot return success.

- Saved-suite assessments negotiate `aw-suite-selection/2`, validate
  `aw-saved-suite-binding/1`, and carry `suite_id` / `suite_revision_id` /
  `suite_content_hash` through estimate, quote, and create. Catalog compiles
  still omit `acceptedManifestVersions` and keep `aw-suite-selection/1`.
  A v1 or HTTP 400 response to a requested saved-suite compile fails with
  `SAVED_SUITE_BINDING_UNSUPPORTED` before quote.

- Whole-suite `gate --manifest-file` sends identity-only
  `aw-manifest-release-gate-request/2` and consumes only
  `aw-manifest-release-policy/2` receipts. Local preflight refuses
  empty, non-executable, tampered, or incomplete declarations before
  authentication. Exit 0 requires `evidenceSource: server`, exact coverage,
  and every resolved shard terminal/completed/pass. Legacy v1 and
  malformed bodies fail closed with `MANIFEST_GATE_CONTRACT_UNSUPPORTED`.
  Existing `--run`/`--baseline` gate behavior is unchanged.

## [0.3.6] - 2026-09-10

Published-line patch for the AUG-82 suite-selection capability fix. Executable
npx pins match this tarball. Do not overwrite or relabel
`@augmentworks/cli@0.3.5`. Independent inspection of 0.3.5 is recorded in
`docs/feature-readiness/published-registry-evidence.json`.
`published_package_verified` is published-line identity, not a live registry
probe of this exact tarball.

### Fixed

- `selection compile` and assessment-driven hosted selection now forward the
  connector's prepare/observation/tool-event/cleanup snapshot (including sorted
  observation keys and truthful multi-turn) on `POST /v1/suite-selections/compile`.
  A missing default `augmentworks.yaml` stays an explicit capability-free
  single-turn mode. Malformed or unresolved `--config` paths fail with the
  existing config diagnostic before authentication or quoting.

## [0.3.5] - 2026-09-08

Corrective published-line package for 0.3.4's stale candidate/unverified
packaged metadata. Executable npx pins match this tarball. Do not overwrite
or relabel `@augmentworks/cli@0.3.4`. Independent inspection of 0.3.4 is
recorded in `docs/feature-readiness/published-registry-evidence.json`.
`published_package_verified` is published-line identity, not a live registry
probe of this exact tarball.

### Fixed

- Packaged `cli-release.json`, README, `test --help`, agent resources, and
  discovery last-inspected snapshot no longer describe this line as a
  candidate or claim last verified npm is 0.3.2. Help advertises quoted
  `aw-relay/0.3` from `HOSTED_ASSESSMENT_OPTION_HELP` instead of hard-coded
  source-0.3.3 / published-0.3.2 protocol wording.

### Added

- Catalog listing (`catalog list` / `catalog show`) consumes public
  `aw-coverage-catalog/1` metadata with bounded cache, ETag revalidation, and
  fail-closed stale `catalogVersion`. Static counts are informative, not a
  quote. `selection compile` and `test --manifest` / `--shard` / `--all-shards`
  consume server-produced `aw-suite-selection/1` shard manifests under the
  existing finite `--max-credits` ceiling. Whole-suite `gate --manifest-file`
  maps the server `aw-manifest-release-policy/1` verdict. Incomplete shard sets
  cannot pass. The CLI does not compile, price, or batch-run locally.

- Hosted GitHub Actions own-target recipe
  (`docs/examples/github-actions-hosted.yml`) with scoped
  `AUGMENTWORKS_API_KEY`, explicit `test --headless`, isolated synthetic
  target startup, offline doctor/mapping/suite validation, quoted
  `--max-credits`, original-run wait, `gate` CI provenance, credential-free
  summaries/artifacts, and fork-PR secret skipping. Machine principals missing
  `run:execute` fail closed with `MACHINE_ACTION_DENIED` before quote.

- Investigation inspect/fetch/export-regression and `test --investigation`
  consume `aw-investigation-export/1`. Inspect is observation-only (no target,
  shell fragment, evaluator, or admission). Reproduction GETs the exact pinned
  suite revision and uses a new quote / `--max-credits` / `--yes` path. Missing
  prepare/session/cleanup prerequisites block before paid execution. Regression
  drafts keep the original expected condition; failing chatbot output is not
  ground truth.

## [0.3.4] - 2026-09-08

Published 2026-09-08 (`gitHead` `c3da8d92bdd3daa21e9e230ffc5d110b43adaa5f`,
integrity `sha512-TLeAzDglZoGL6fWLxA9rIUwJd69NFqgmlONzU4uRmhDz4S31+dfSZpaj44ahb6lUjnmuoY6sDmfPStxFzInpVQ==`).
The immutable tarball still contains candidate/unverified packaged metadata;
0.3.5 corrects that copy without overwriting 0.3.4.

Candidate first-dollar customer-owned assessment package. Executable npx pins
match this tarball. Registry verification is recorded in
`docs/feature-readiness/first-dollar-registry-acceptance.json` and is not
implied by this changelog entry.

### Added

- Explicit `AUGMENTWORKS_API_KEY` mode, `run report <run-id> --json`
  complete hosted export (`aw-run-report-export/1`), and conservative hosted
  result exits shared by `test`, `run wait`/`status`, and `run report`. Exit `0`
  requires a fully passed, graded, known-coverage result. A completed run with
  a null outcome never passes. Vendors AW-QA-1 compatibility fixtures until
  AUG-55 publishes canonical copies.
- Stage 5B subscription usage display: recurring vs
  purchased vs trial lots, cancel-at-period-end, processing and failed
  renewal, expired monthly grants, and pack-only servers without
  `subscriptions_v1`. Vendors `aw-billing/1` from main
  `650472d91442a6866a7b6ef18e6dacc23a2a9260`. The CLI remains a read-only
  billing client. Live $149 sales stay gated.
- Stage 4B packaged empty-directory starters
  (`response-quality` default and `workflow`), offline doctor wire-bound
  checks, packed-tarball billing HTTP fixture (target execution, token
  refresh, dropped-create replay, pending grading wait), and prepaid-journey
  recovery docs. Initially vendored 4A `49806f0`; Stage 5B re-imported 5A
  `650472d`. Live sales remain disabled.
- CI/environment token refresh via `AUGMENTWORKS_REFRESH_TOKEN` without
  writing the OS credential store. Token-only `AUGMENTWORKS_TOKEN` remains
  static.
- Packaged `augmentworks demo` command: isolated loopback refund target, real
  local runner/scorer, fail-then-pass policy story, `AW-DEMO-SUMMARY-1` JSON.
- `contracts/discovery-manifest.json` generated from the existing release
  machinery (`schemaVersion: 1`, source `development` until npm verification).
- Opt-in `agent-resources/` wrappers generated from one canonical guidance
  file. `init --agent` pins this package version rather than 0.3.2.
- Copyable GitHub Actions example and synthetic sample reports under
  `docs/examples/`.
- Authenticated `augmentworks usage` / `usage --json` for Stage 1B billing
  snapshots. Exit `13` is the billing category. Does not enable live sales.
- Hosted `test --estimate`, `--max-credits`, quoted
  `aw-relay/0.3` create, and `run status` / `run wait` /
  `run retry-evaluation`. Quotes do not reserve credits.
- `augmentworks billing` / `billing --json` /
  `billing --print` for first-party billing-page navigation. The CLI does not
  create Checkout Sessions or Stripe customers.
- Offline `preview-mapping` inspects response mappings and the exact
  canonical sanitized evidence payload from a local synthetic JSON fixture.
  It uses the production extraction, allowlist, redaction, and
  `canonicalize` pipeline. No target, cloud, or model call.
- Customer-owned hosted suites: `suite validate` /
  `suite preview` parse `aw-suite/1` files offline (not a price, no target,
  no LLM). `test --suite` pins an immutable server revision through the
  existing quote / `--max-credits` / `--yes` path. Changing the file after
  quote cannot silently alter admitted work. Samples live in
  `examples/customer-suites/` and packed `assets/customer-suites/`.
- Explicit session mode (`target.conversation.strategy:
  explicit_session_v1`). Hosted `multi_turn` is advertised only from that
  validated configuration, together with `aw-conversation-enforcement/1`.
  Single-turn omits `multi_turn`. Estimate and execute send the same
  declaration. Unsupported multi-turn plans fail before quote.
- Own-target starter recipes and an explicit bounded
  `probe` command. One initializer still writes `response-quality`
  (response-only JSON chat, including a five-question synthetic suite) or
  `workflow` (stateful prepare/send/observe/cleanup). `probe` prints a
  call plan; `--yes` executes it against the configured target only.
  Doctor and init never probe.
- Hosted release gate: `compare`, `gate`, and
  `baseline status` / `baseline promote` consume `aw-release-policy/1`.
  A new required semantic regression exits `10` even when aggregate pass
  rates match and the HTTP request succeeded. Pending judging, evaluator
  error, incompatible scope, and missing coverage cannot exit `0`.
  Observation commands do not start, reserve, or charge a run. Promotion
  is explicit and never automatic.

### Fixed

- Hosted `run report --json` keeps the producer `aw-criterion-detail/1`
  `document` on converted export details so occurrence, criterion kind, and
  stored rationale survive the published CLI pin.
- Hosted `run report` no longer treats a terminal `hasMore: false` page as
  complete when `totalAttempts` / `totalCriteria` disagree with retrieved
  unique IDs, when pages contradict those totals, or when a page, criterion
  index, or detail `workspaceId` does not match the authenticated session.
  Null totals stay unknown (never zero). Missing or mixed evidence stays
  `complete: false` with a bounded retry-the-original-run warning; the CLI
  never starts another billed assessment.
- Hosted `run report` parses the main producer's `aw-criterion-detail-read/1`
  index (`items`, `nextCursor`, `totalInAttempt`) and nested
  `document`/`inspection` details instead of rejecting them as
  `CRITERION_SCHEMA_INVALID`. Producer-shaped fixtures are vendored separately
  from the locked AW-QA-1 invented `criteria`/`page` documents.
- `init -c custom.yaml` writes the requested connector filename instead of
  always emitting `augmentworks.yaml`. Companion assessment, reference, and
  environment files stay in the selected config directory. `--force` replaces
  only the selected generated files.
- Packed-tarball smoke invokes npm/npx as `node *-cli.js` so Windows Node 22
  does not fail with `spawnSync npm.cmd EINVAL`.
- Packed billing HTTP fixture uses async `spawn` so the in-process loopback
  server can accept CLI requests (`spawnSync` deadlocked the event loop).
- Packed CLI tests rebuild `dist/index.js` when TypeScript sources are newer,
  so `npm test` before `npm run build` still exercises current `run wait`
  classification.
- Hosted `test --json` writes one structured error object on stdout for
  billing/admission rejection, matching estimate/usage/billing.
- `run wait` / `run status` no longer treat a successful status query of
  unfinished work as a passing assessment. Wait continues while target
  execution is nonterminal even when evaluation is `absent`. Exit `0` requires
  an explicit resolved `passed` outcome. JSON `ok: true` remains observation
  success; `assessment` and `exit_code` are the release gate.
- `preview-mapping` JSON parse failures report a numeric position only and
  never echo fixture text.

### Changed

- Package version is `0.3.4`. Generated and documented npx commands pin
  `@augmentworks/cli@0.3.4`. Last independently verified npm remains `0.3.2`
  (`gitHead` `d36ec8590b005445dba940d2df3abcb53971cea5`). Immutable npm `0.3.3`
  (`gitHead` `4a08ea0d352f2515e725cb9ca946807112422436`) is not overwritten or
  relabeled. `published_package_verified` stays false until registry evidence
  is recorded. `npm --yes` is not a spending ceiling; hosted consent is
  `--max-credits N`.

## [0.3.3] - 2026-09-07

npm registry contains `@augmentworks/cli@0.3.3` (published 2026-09-07T16:21:14Z,
`gitHead` `4a08ea0d352f2515e725cb9ca946807112422436`). That tarball is
immutable and is **not** this customer-owned assessment release. It lacks
`suite validate`/`preview`, `test --suite`, and own-target starter/`probe`.
This repository does not overwrite or relabel 0.3.3.

## [0.3.1] - 2026-09-05

### Fixed

- Hosted hybrid `--assessment` now sends `aw-judge-disclosure/2`, matching the
  OpenAI judging disclosure recorded in the portal.
- `test --help` describes `--assessment` as published in this package.

### Changed

- Source and published package version is `0.3.1`. Hosted and local npx
  examples pin `@augmentworks/cli@0.3.1`.

## [0.3.0] - 2026-09-05

### Added

- Source-only hosted `--assessment` / `--profile` compiler for
  `augmentworks.assessment.yaml` (`aw-assessment-file/1`), including local
  reference file freeze hashes and `doctor --assessment` validation without
  target or credit use.
- Relay protocol `aw-relay/0.2` create-run assessment metadata, optional
  `multi_turn` capability, command sequences up to 512, and optional hosted
  `evaluation_status` (`pending` / `complete` / `partial` / `error`).
- Distinguishable hosted grading exit codes `11` (incomplete) and `12`
  (evaluation error). Behavioral failures remain `10`.
- Local-mode rejection of `aw-packet/0.2`, `evaluation_mode: hybrid`, and
  `llm_rubric` packets before any target call.
- Hosted `test` uses the 0.2.1 recover/reconcile path, so interrupted creates
  can be rebound or retired instead of treating a corrected command as a
  second active run.

### Changed

- Source and published package version is `0.3.0`. Hosted and local npx
  examples pin `@augmentworks/cli@0.3.0`, including `--assessment`.

## [0.2.1] - 2026-09-05

### Added

- `recover` inspects a hosted assessment without creating a new run. `--retire`,
  `--resume`, and `--cancel` are mutually exclusive; default recovery is
  inspection only.
- Client support for `POST /v1/relay/run-intents:reconcile`
  (`aw-run-intent-reconcile/0.1`) so a definitive rejected create can be
  retired and an interrupted run can be rebound after the create-replay window.

### Changed

- Hosted `test` reconciles an existing intent before treating a corrected
  command as `ACTIVE_RUN_EXISTS`. Generic create HTTP errors no longer clear
  pending state.
- Terminal local execution retirement now checks the relay journal for
  outstanding cleanup, and pending grading no longer keeps the local execution
  intent active.
- Browser login callback responses send `cache-control: no-store` and
  `referrer-policy: no-referrer`.
- Hosted and local `npx` examples pin `@augmentworks/cli@0.2.1`.

### Fixed

- Credential refresh no longer fails with `CREDENTIAL_REFRESH_LOCK_CHANGED` when
  the lock directory disappears during reclaim (Windows waiter `EEXIST` then
  holder `release()` race). Acquire retries `mkdir` instead of treating
  disappearance as a fatal identity change.

## [0.2.0] - 2026-09-04

### Added

- Customer-executed `test --local` mode that branches before authentication and
  cloud setup, loads strict data-only JSON packets, executes the synthetic
  lifecycle directly, and scores results without contacting AugmentWorks.
- Bundled Apache-2.0 `support-refunds-starter@0.1.0` packet plus local packet and
  local result JSON Schemas.
- Private JSON, JUnit, and static HTML local reports with explicit unsigned,
  unverified provenance; fresh-output enforcement; change-detection checksum;
  redaction; and cleanup-aware exit codes.
- `schema --kind config|local-packet|local-result` and local report
  `--output-dir`/`--open` support.

### Changed

- Pinned v0.2 setup examples and documented the separate hosted and local
  security, evidence, authentication, packet, cleanup, and networking
  boundaries.
- Hosted and local `npx` examples pin `@augmentworks/cli@0.2.0`. The refund-agent
  example remains git-checkout-only because the npm tarball omits `examples/`.
- Login, init, and hosted `test` print the next first-user action without a
  `connect` or `--rerun` command.

## [0.1.0] - 2026-08-31

### Added

- Initial deterministic HTTP connector and v1 YAML configuration.
- Browser PKCE and headless device authorization client contracts.
- `init`, `doctor`, `test`, `login`, `logout`, `whoami`, and `schema` command
  surface.
- Outbound `aw-relay/0.1` long-poll client with typed lifecycle operations,
  fencing, expiry, deduplication, bounded evidence, and cleanup semantics.
- Durable idempotent run creation, same-machine restart recovery, target-boundary
  drift binding, explicit credit states, and sorted observation-alias preflight.
- Refund-agent mock target, public documentation, schema, tests, packed-package
  smoke test, CI, and npm trusted-publishing workflow.

[0.3.8]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.3.8
[0.3.7]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.3.7
[0.3.6]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.3.6
[0.3.5]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.3.5
[0.3.4]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.3.4
[0.3.3]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.3.3
[0.3.1]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.3.1
[0.3.0]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.3.0
[0.2.1]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.2.0
[0.1.0]: https://www.npmjs.com/package/%40augmentworks%2Fcli/v/0.1.0
