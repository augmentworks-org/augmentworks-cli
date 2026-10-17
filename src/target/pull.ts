import { isMap, isScalar, parseDocument, type Document, type YAMLMap } from "yaml";

import { exactEnvironmentName } from "../config/environment.js";
import { AwError, sanitizeTerminal } from "../errors.js";
import type { StoredTarget, TargetDetail } from "./protocol.js";

/** Every value `target pull` can't know carries this marker until someone fills it in; `doctor` refuses it. */
export const PLACEHOLDER_MARKER = "FILL_IN";

const OPERATION_KINDS = ["prepare", "send", "observe", "cleanup"] as const;
const CONNECTOR_METHODS = new Set(["GET", "POST", "DELETE"]);

export interface PullResult {
  readonly text: string;
  readonly created: boolean;
  readonly changes: readonly string[];
  readonly notes: readonly string[];
}

/** The address to put in base_url: the registered origin, or an env reference for a named local identity. */
export function baseUrlFor(target: Pick<StoredTarget, "assessedIdentity">): string {
  const identity = target.assessedIdentity.trim();
  if (identity.startsWith("local:")) return "${CHATBOT_BASE_URL}";
  return new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(identity) ? identity : `https://${identity}`).origin;
}

/** A new augmentworks.yaml for a target added in the portal, with placeholders where only the developer knows. */
export function newConfigFromTarget(detail: TargetDetail): PullResult {
  const target = detail.target;
  const usable = detail.endpoints.filter((endpoint) => CONNECTOR_METHODS.has(endpoint.method));
  const send = usable[0];
  if (send === undefined) {
    throw new AwError({
      code: "TARGET_PULL_UNSUPPORTED",
      category: "config",
      message: `${sanitizeTerminal(target.name)} has no GET, POST or DELETE endpoint, which is what the CLI's HTTP connector calls.`
    });
  }
  const lines = [
    `# Created by \`augmentworks target pull ${target.name}\`.`,
    `# Replace every ${PLACEHOLDER_MARKER} value with where your agent reads and writes, then run \`augmentworks doctor\`.`,
    "version: 1",
    "",
    "target:",
    `  name: ${JSON.stringify(target.name)}`,
    "  connector: http",
    `  base_url: ${baseUrlFor(target)}`,
    "  # If the agent needs a key: auth: { bearer_env: CHATBOT_API_KEY }",
    "",
    "  operations:",
    "    send:",
    `      method: ${send.method}`,
    `      path: ${send.path}`,
    "      request:",
    "        message: $input.message.content",
    "      response:",
    `        content: $.${PLACEHOLDER_MARKER}_reply_field`,
    ""
  ];
  return {
    text: lines.join("\n"),
    created: true,
    changes: [`created with send at ${send.method} ${send.path}`],
    notes: otherEndpointNotes(detail, [send])
  };
}

/**
 * Merges a target's address and endpoints into an existing augmentworks.yaml.
 * Mappings, auth and every other field are left alone. An operation that calls
 * an endpoint the target doesn't have is a conflict, and nothing is written.
 */
export function mergeTargetIntoConfig(source: string, detail: TargetDetail): PullResult {
  const document = parseDocument(source);
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw pullError("augmentworks.yaml isn't a YAML mapping the CLI can update.");
  }
  const targetNode = (document.contents as YAMLMap).get("target", true);
  if (!isMap(targetNode)) throw pullError("augmentworks.yaml has no target block to merge into.");
  const target = detail.target;
  const changes: string[] = [];
  const notes: string[] = [];

  if (scalarValue(targetNode, "name") !== target.name) {
    targetNode.set("name", target.name);
    changes.push(`name set to ${target.name}`);
  }
  const registeredBase = baseUrlFor(target);
  const currentBase = scalarValue(targetNode, "base_url");
  const envName = typeof currentBase === "string" ? exactEnvironmentName(currentBase) : undefined;
  let effectiveBase = registeredBase;
  if (envName !== undefined) {
    notes.push(`base_url reads \${${envName}}. Set ${envName} to ${registeredBase}.`);
  } else if (typeof currentBase !== "string" || originOf(currentBase) !== originOf(registeredBase)) {
    targetNode.set("base_url", registeredBase);
    changes.push(`base_url set to ${registeredBase}`);
  } else {
    effectiveBase = currentBase;
  }

  let operations = targetNode.get("operations", true);
  if (operations === undefined) {
    targetNode.set("operations", document.createNode({}));
    operations = targetNode.get("operations", true);
  }
  if (!isMap(operations)) throw pullError("target.operations in augmentworks.yaml must be a mapping.");
  const registered = detail.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).join(", ");
  const used: Array<{ method: string; path: string }> = [];
  for (const kind of OPERATION_KINDS) {
    const operation = operations.get(kind, true);
    if (!isMap(operation)) continue;
    const method = scalarValue(operation, "method");
    const path = scalarValue(operation, "path");
    if (typeof method !== "string" || typeof path !== "string") continue;
    const resolvedPath = resolvedPathOf(path, effectiveBase);
    const match = detail.endpoints.find(
      (endpoint) => endpoint.method === method && samePath(endpoint.path, resolvedPath)
    );
    if (match === undefined) {
      throw new AwError({
        code: "TARGET_PULL_CONFLICT",
        category: "config",
        message: `target.operations.${kind} calls ${method} ${resolvedPath}, which isn't an endpoint of ${sanitizeTerminal(target.name)} (${registered}). Change the operation to one of those, or add the endpoint to the target in Settings → Targets. augmentworks.yaml wasn't changed.`
      });
    }
    used.push(match);
  }
  if (!isMap(operations.get("send", true))) {
    const send = detail.endpoints.find(
      (endpoint) => CONNECTOR_METHODS.has(endpoint.method) && !used.includes(endpoint)
    );
    if (send === undefined) {
      throw pullError(`augmentworks.yaml has no send operation, and ${sanitizeTerminal(target.name)} has no free endpoint to use for one.`);
    }
    operations.set(
      "send",
      document.createNode({
        method: send.method,
        path: send.path,
        request: { message: "$input.message.content" },
        response: { content: `$.${PLACEHOLDER_MARKER}_reply_field` }
      })
    );
    used.push(send);
    changes.push(`send added at ${send.method} ${send.path}; fill in its response mapping`);
  }
  notes.push(...otherEndpointNotes(detail, used));
  return { text: changes.length === 0 ? source : stringify(document), created: false, changes, notes };
}

function otherEndpointNotes(detail: TargetDetail, used: ReadonlyArray<{ method: string; path: string }>): string[] {
  return detail.endpoints
    .filter((endpoint) => !used.some((item) => item.method === endpoint.method && item.path === endpoint.path))
    .map((endpoint) =>
      CONNECTOR_METHODS.has(endpoint.method)
        ? `Also registered: ${endpoint.method} ${endpoint.path}. Add it under operations as prepare, observe or cleanup if it is one.`
        : `Also registered: ${endpoint.method} ${endpoint.path}. The CLI's HTTP connector calls only GET, POST and DELETE.`
    );
}

/** Values in a parsed config that still hold the `target pull` placeholder, as dotted paths. */
export function placeholderPaths(value: unknown, path = ""): string[] {
  if (typeof value === "string") return value.includes(PLACEHOLDER_MARKER) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => placeholderPaths(item, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => placeholderPaths(item, path === "" ? key : `${path}.${key}`));
  }
  return [];
}

function scalarValue(map: YAMLMap, key: string): unknown {
  const node = map.get(key, true);
  return isScalar(node) ? node.value : undefined;
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function resolvedPathOf(path: string, base: string): string {
  try {
    return new URL(path, base.includes("${") ? "https://placeholder.invalid" : base).pathname;
  } catch {
    return path;
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => (value.startsWith("/") ? value : `/${value}`).replace(/\/+$/u, "") || "/";
  return normalize(left) === normalize(right);
}

function stringify(document: Document): string {
  return document.toString({ lineWidth: 0 });
}

function pullError(message: string): AwError {
  return new AwError({ code: "TARGET_PULL_FAILED", category: "config", message });
}
