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

Do not run `npm publish` ad hoc. `@augmentworks/cli@0.3.7` is already published
from GitHub release `v0.3.7` (target
`876454878a31a897aec1d722fa838c9c0ecea2aa`) by the trusted-publishing workflow
and independently inspected. Do not republish 0.3.7. A later version needs a
new tag and the same workflow, then a fresh tarball inspection. Do not
overwrite or relabel `@augmentworks/cli@0.3.6`, `0.3.5`, `0.3.4`, or `0.3.3`.

## Website

Adopt a pinned discovery manifest only after tarball inspection. Never `latest`.
