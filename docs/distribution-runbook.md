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

Do not run `npm publish` ad hoc. `@augmentworks/cli@0.3.8` is published from
GitHub tag `v0.3.8` (`f36d9086bad1ac109a7670e8acc9bf14a5d15047`) and
independently inspected. The trusted workflow's OIDC publish returned 404
after the repository moved to `augmentworks-org`; the same tag bytes were
published by the package owner and have no SLSA provenance attestation. Do not
republish 0.3.8. Do not overwrite or relabel `@augmentworks/cli@0.3.7`,
`0.3.6`, `0.3.5`, `0.3.4`, or `0.3.3`. The next release still needs a new tag
and `.github/workflows/release.yml`, after the npm trusted publisher allows
`augmentworks-org/augmentworks-cli`.

## Website

Adopt a pinned discovery manifest only after tarball inspection. Never `latest`.
