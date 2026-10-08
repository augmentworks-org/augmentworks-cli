# Basic chat example

This is the minimum chat-only connector. It maps one user message to `/chat`
and extracts `answer` as assistant content. It can assess conversational
behavior, but it cannot establish whether a tool ran or state changed.

Copy `.env.example` to `.env`, set values locally, and run `doctor` against the
YAML before starting an assessment. This 0.3.8 package can preview the sanitized
evidence payload without calling the target, then explicitly probe a running
synthetic process. Doctor and init never probe.

```bash
node dist/index.js preview-mapping \
  -c augmentworks.yaml \
  --operation send \
  --fixture ./fixtures/send-preview.json

node dist/index.js probe -c augmentworks.yaml
node dist/index.js probe -c augmentworks.yaml --yes
```

This directory is a **source-only fixture**. It is **not** copied into the
published npm tarball. `npx @augmentworks/cli@0.3.8` cannot start this
server from a clean directory.

A packaged copy of `server.mjs` ships inside `@augmentworks/cli` under
`dist/assets/starters/response-quality/` and is written by
`node dist/index.js init --starter response-only` in this 0.3.8 package.
Immutable npm `0.3.3` does not include `probe` or these starter files.

