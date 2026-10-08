# Contributing

Thanks for improving the AugmentWorks CLI. This package sits on a consequential
security boundary, so deterministic behavior, bounded data, and explicit trust
claims matter more than connector cleverness.

## Development setup

Use Node.js 20 or 22 and npm:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:pack
```

Do not commit `.env`, credentials, real customer inputs, production data, local
command journals, or generated credential-store files.

## Practical contribution routes

- **New synthetic fixture / local packet:** add data-only `aw-packet/0.1` JSON
  under `packets/` or a test fixture. No JavaScript, URLs, or secrets. Update
  integrity hashes and `schema --kind local-packet` checks.
- **Connector example:** extend `examples/` (not shipped in npm) or the packaged
  `assets/demo/` tree if the runtime demo needs a minimal asset. Prefer the
  generic HTTP YAML connector; do not add framework adapters the CLI does not
  provide.
- **Documentation correction:** keep version pins accurate. Distinguish this
  package `0.3.8` from immutable prior npm artifacts `0.3.7`, `0.3.6`, `0.3.5`, `0.3.4`, and `0.3.3`.
  Historical changelog entries are not current executable quickstarts.
- **Reported setup failure:** file an issue with CLI version, Node.js version,
  OS, redacted config, and the safe error code. Never attach `.env`,
  credentials, or customer reports.

## Pull requests

- Keep behavior deterministic; do not add an LLM to config validation or test
  execution.
- Treat YAML and relay messages as untrusted input.
- Reject unknown protocol/config fields and preserve stable safe error codes.
- Do not allow the relay to provide target URLs, methods, headers, environment
  names, file paths, modules, or commands.
- Add tests for success, validation failure, redaction, limits, replay,
  cancellation, and ambiguous non-idempotent delivery where relevant.
- Update the JSON Schema, examples, protocol/security docs, and changelog when a
  public contract changes.
- Preserve the `aw-relay/0.1` and `aw-target/0.1` compatibility promise within a
  release line.
- Keep user-facing errors safe and actionable; never echo raw response bodies or
  authorization headers.
- If you change discovery copy, run `npm run generate:discovery` and
  `npm run generate:agent-resources` so wrappers cannot drift.
- If you change the vendored billing contract, import it from main with
  `node scripts/import-aw-billing-contract.mjs --from <augmentworks>` and keep
  `npm run check:billing-contract` green. Do not edit the schema by hand.
  Contract JSON and generated bindings are LF-locked (`.gitattributes`); hashes
  are computed from canonical LF bytes so Windows CRLF checkouts still match.

A pull request should explain its user-visible outcome, security implications,
test evidence, and any deployment dependency. Mark cloud functionality as
unavailable until the matching production service has actually shipped.

## Testing

Unit tests should use bounded synthetic fixtures. Integration tests must run
against loopback mock servers and cannot depend on production AugmentWorks,
third-party model providers, or customer services.

The packed-tarball smoke test is required because source-level success does not
prove that `npx` receives the executable, schema, notices, documentation, and
demo assets.

Independent local, packed/published, hosted, and browser QA instructions
(including expected exits, isolation/egress checks, secret segregation, and a
field-safe receipt template) are in [docs/qa/README.md](docs/qa/README.md).
`node dist/index.js` after a source build is not a registry-installed pin.
Local packet scoring is not hosted grading.

## Releases

Maintainers create a protected `vX.Y.Z` GitHub release after CI passes. The
release workflow verifies the tag/package version and publishes with npm trusted
publishing and provenance. Do not add a long-lived npm token to repository
secrets.

Trusted publishing requires the npm package to exist first. Bootstrap only the
initial package with a short-lived, narrowly scoped credential, then immediately
configure npm's trusted publisher to the exact GitHub owner, repository,
`.github/workflows/release.yml` filename, and `npm` environment. Revoke the
bootstrap credential. The regular release workflow uses Node.js 24/npm 11+ and
OIDC; it deliberately has no `NODE_AUTH_TOKEN`.

## Vulnerabilities

Use the private process in [SECURITY.md](SECURITY.md), not a public issue.
