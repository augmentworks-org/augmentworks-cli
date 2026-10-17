import { isMap, isScalar, parseDocument, type Node, type Pair, type YAMLMap } from "yaml";

import { AwError } from "../errors.js";
import { EXECUTION_SCOPE_SCHEMA_VERSION, SUITE_SCHEMA_VERSION_V3 } from "../real-data/constants.js";

/**
 * Writes a scope id and revision into an `aw-suite/3` file by splicing only
 * those values into the original text, so comments, quoting, order and every
 * other field stay byte for byte as they were.
 */
export function writeSuiteScope(source: string, scope: { readonly scopeId: string; readonly revision: number }): string {
  const document = parseDocument(source, { keepSourceTokens: true });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw suiteError("The suite file isn't a YAML mapping the CLI can update.");
  }
  const root = document.contents as YAMLMap;
  const schemaVersion = root.get("schema_version");
  if (schemaVersion !== SUITE_SCHEMA_VERSION_V3) {
    throw suiteError(
      `Scopes go in aw-suite/3 files, and this one is ${typeof schemaVersion === "string" ? schemaVersion : "not versioned"}. A real-data suite starts with schema_version: aw-suite/3.`
    );
  }
  const block = pairOf(root, "execution_scope");
  if (block === undefined) return insertBlock(source, root, scope);
  if (!isMap(block.value)) throw suiteError("execution_scope in the suite file must be a mapping.");
  const map = block.value as YAMLMap;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const [key, text] of [
    ["scope_id", scope.scopeId],
    ["revision", String(scope.revision)]
  ] as const) {
    const pair = pairOf(map, key);
    if (pair !== undefined) {
      const range = scalarRange(pair.value);
      if (range === undefined) throw suiteError(`execution_scope.${key} in the suite file must be a single value.`);
      edits.push({ start: range[0], end: range[1], text });
      continue;
    }
    // Add a missing key on its own line, under the last key of the block.
    const lastPair = map.items[map.items.length - 1] as Pair<Node, Node> | undefined;
    const lastRange = lastPair === undefined ? undefined : scalarRange(lastPair.value);
    const keyRange = lastPair === undefined ? undefined : (lastPair.key as Node | null)?.range;
    if (lastRange === undefined || keyRange === undefined || keyRange === null) {
      throw suiteError("execution_scope in the suite file has no fields the CLI can add to.");
    }
    const indent = indentAt(source, keyRange[0]);
    const lineEnd = endOfLine(source, lastRange[1]);
    edits.push({ start: lineEnd, end: lineEnd, text: `\n${indent}${key}: ${text}` });
  }
  return applyEdits(source, edits);
}

function insertBlock(source: string, root: YAMLMap, scope: { readonly scopeId: string; readonly revision: number }): string {
  const versionPair = pairOf(root, "schema_version");
  const range = versionPair === undefined ? undefined : scalarRange(versionPair.value);
  if (range === undefined) throw suiteError("The suite file's schema_version must be a single value.");
  const lineEnd = endOfLine(source, range[1]);
  const block = [
    "execution_scope:",
    `  schema_version: ${EXECUTION_SCOPE_SCHEMA_VERSION}`,
    `  scope_id: ${scope.scopeId}`,
    `  revision: ${scope.revision}`
  ].join("\n");
  return applyEdits(source, [{ start: lineEnd, end: lineEnd, text: `\n${block}` }]);
}

function pairOf(map: YAMLMap, key: string): Pair<Node, Node> | undefined {
  return map.items.find((item) => isScalar(item.key) && item.key.value === key) as Pair<Node, Node> | undefined;
}

function scalarRange(node: unknown): [number, number] | undefined {
  if (!isScalar(node) || node.range === undefined || node.range === null) return undefined;
  return [node.range[0], node.range[1]];
}

function indentAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return source.slice(lineStart, offset).replace(/[^ \t]/gu, " ");
}

function endOfLine(source: string, offset: number): number {
  const newline = source.indexOf("\n", offset);
  const end = newline === -1 ? source.length : newline;
  // Keep a trailing comment on the same line with its value.
  return source[end - 1] === "\r" ? end - 1 : end;
}

function applyEdits(source: string, edits: ReadonlyArray<{ start: number; end: number; text: string }>): string {
  let result = source;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  }
  return result;
}

function suiteError(message: string): AwError {
  return new AwError({ code: "SUITE_SCOPE_WRITE_FAILED", category: "config", message });
}
