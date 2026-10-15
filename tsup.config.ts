import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: false,
  minify: false,
  splitting: false,
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __awCreateRequire } from "node:module"; const require = __awCreateRequire(import.meta.url);'
  },
  noExternal: ["commander", "open", "yaml", "zod"]
});
