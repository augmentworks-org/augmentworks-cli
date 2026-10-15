import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

import { parseDocument } from "yaml";
import { z } from "zod";

import starterPacketJson from "../../packets/support-refunds-starter/0.1.0/packet.json" with {
  type: "json"
};
import { AwError } from "../errors.js";
import { sameFileIdentity } from "../system/file-identity.js";
import { findUnsafeSymbolicLinkComponent } from "../system/path-safety.js";
import { LIMITS } from "../util/limits.js";
import { hostedSuiteUnsupportedLocalError, livePacketUnsupportedLocalError, authorizedPacketUnsupportedLocalError } from "../suite/errors.js";
import { looksLikeCustomerSuiteDocument, sourceLooksLikeCustomerSuite } from "../suite/schema.js";
import { looksLikeLivePacketDocument } from "../suite/live-target.js";
import {
  looksLikeHostedAuthorizedPacket,
  looksLikeLocalAuthorizedPacket,
  parseDataPolicy,
  parseLocalExecutionScope,
  parseRedactionProfile
} from "../real-data/documents.js";
import { LOCAL_AUTHORIZED_PACKET_SCHEMA_VERSION } from "../real-data/constants.js";
import { sha256Json } from "./canonical.js";
import type {
  AnyLocalPacketManifest,
  LocalAuthorizedPacketManifest,
  LocalJson,
  LocalJsonObject,
  LocalPacketBinding,
  PacketAssertion,
  PacketManifest,
  PacketScenario
} from "./types.js";

export const MAX_LOCAL_PACKET_BYTES = 1024 * 1024;
export const MAX_LOCAL_PACKET_ATTEMPTS = 100;
export const MAX_LOCAL_PACKET_COMMANDS = 100;
export const SUPPORT_REFUNDS_STARTER_REFERENCE = "support-refunds-starter@0.1.0";
export const SUPPORT_REFUNDS_STARTER_SHA256 =
  "6f9c1654eb6a40564939c7f4f762a8eae7f441dc27bff242846b3d3d5307caa4";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const PACKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const OBSERVATION_KEY =
  /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/u;
const BUNDLED_REFERENCE =
  /^([A-Za-z0-9][A-Za-z0-9._:/-]{0,159})@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u;

const boundedIdentifier = (maximum = 300) =>
  z.string().min(1).max(maximum).regex(IDENTIFIER, "must be a bounded protocol identifier");
const boundedText = (maximum: number, minimum = 1) => z.string().min(minimum).max(maximum);

function isLocalJson(
  value: unknown,
  seen = new Set<object>(),
  depth = 0
): value is LocalJson {
  if (depth > LIMITS.maxDepth) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (value.length > LIMITS.maxArrayItems || seen.has(value)) return false;
    seen.add(value);
    const valid = value.every((child) => isLocalJson(child, seen, depth + 1));
    seen.delete(value);
    return valid;
  }
  if (typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const entries = Object.entries(value as Record<string, unknown>);
  const valid =
    entries.length <= LIMITS.maxObjectKeys &&
    entries.every(
      ([key, child]) =>
        key !== "__proto__" &&
        key !== "prototype" &&
        key !== "constructor" &&
        isLocalJson(child, seen, depth + 1)
    );
  seen.delete(value);
  return valid;
}

function isLocalJsonObject(value: unknown): value is LocalJsonObject {
  return isLocalJson(value) && value !== null && typeof value === "object" && !Array.isArray(value);
}

const localJsonSchema = z.custom<LocalJson>(isLocalJson, "must be a bounded finite JSON value");
const localJsonObjectSchema = z.custom<LocalJsonObject>(
  isLocalJsonObject,
  "must be a bounded JSON object"
);

const assertionBase = {
  key: boundedIdentifier(160),
  description: boundedText(2_000)
} as const;

const assistantContainsSchema = (kind: "assistant_contains" | "assistant_not_contains") =>
  z
    .object({
      ...assertionBase,
      kind: z.literal(kind),
      value: boundedText(8_000),
      turn_index: z.number().int().min(0).max(19).optional(),
      case_sensitive: z.boolean().optional()
    })
    .strict();

const toolCalledSchema = z
  .object({
    ...assertionBase,
    kind: z.literal("tool_called"),
    tool_name: boundedIdentifier(),
    min_calls: z.number().int().min(1).max(100).optional(),
    max_calls: z.number().int().min(1).max(100).optional(),
    arguments_contain: localJsonObjectSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.min_calls !== undefined &&
      value.max_calls !== undefined &&
      value.min_calls > value.max_calls
    ) {
      context.addIssue({
        code: "custom",
        message: "min_calls cannot exceed max_calls",
        path: ["min_calls"]
      });
    }
  });

const packetAssertionSchema = z.discriminatedUnion("kind", [
  assistantContainsSchema("assistant_contains"),
  assistantContainsSchema("assistant_not_contains"),
  toolCalledSchema,
  z
    .object({
      ...assertionBase,
      kind: z.literal("tool_not_called"),
      tool_name: boundedIdentifier()
    })
    .strict(),
  z
    .object({
      ...assertionBase,
      kind: z.literal("tool_result"),
      tool_name: boundedIdentifier(),
      success: z.boolean(),
      output_contains: localJsonSchema.optional()
    })
    .strict(),
  z
    .object({
      ...assertionBase,
      kind: z.literal("observation_equals"),
      observation_key: z.string().min(1).max(300).regex(OBSERVATION_KEY),
      expected: localJsonSchema.optional(),
      authoritative_only: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      ...assertionBase,
      kind: z.literal("observation_absent"),
      observation_key: z.string().min(1).max(300).regex(OBSERVATION_KEY)
    })
    .strict(),
  z
    .object({
      ...assertionBase,
      kind: z.literal("handoff_occurred"),
      destination: boundedIdentifier().optional()
    })
    .strict(),
  z.object({ ...assertionBase, kind: z.literal("no_error_events") }).strict()
]);

const packetScenarioSchema = z
  .object({
    key: boundedIdentifier(160),
    name: boundedText(200),
    category: boundedIdentifier(160),
    severity: z.enum(["critical", "high", "medium", "low"]),
    description: boundedText(4_000),
    expected_behavior: boundedText(4_000),
    fixture: localJsonObjectSchema,
    turns: z
      .array(
        z
          .object({
            content: z
              .string()
              .min(1)
              .refine(
                (value) => Buffer.byteLength(value, "utf8") <= LIMITS.maxMessageBytes,
                "message content exceeds the UTF-8 byte limit"
              )
          })
          .strict()
      )
      .min(1)
      .max(20),
    observation_keys: z
      .array(z.string().min(1).max(300).regex(OBSERVATION_KEY))
      .max(LIMITS.maxObservations),
    assertions: z.array(packetAssertionSchema).min(1).max(100),
    repetitions: z.number().int().min(1).max(20),
    pass_threshold: z.number().finite().gt(0).max(1)
  })
  .strict()
  .superRefine((scenario, context) =>
    validateScenario(scenario as unknown as PacketScenario, context)
  );

export const PacketManifestSchema = z
  .object({
    schema_version: z.literal("aw-packet/0.1"),
    packet_id: z.string().min(1).max(80).regex(PACKET_ID),
    version: z.string().min(1).max(80).regex(VERSION),
    name: boundedText(200),
    description: boundedText(4_000),
    domain: boundedIdentifier(160),
    synthetic_only: z.literal(true),
    required_capabilities: z
      .object({
        multi_turn: z.boolean(),
        observation: z.boolean(),
        tool_events: z.boolean(),
        cleanup: z.boolean()
      })
      .strict(),
    scenarios: z.array(packetScenarioSchema).min(1).max(100)
  })
  .strict()
  .superRefine((manifest, context) =>
    validateManifest(manifest as unknown as PacketManifest, context)
  );

export const LocalAuthorizedPacketManifestSchema = z
  .object({
    schema_version: z.literal(LOCAL_AUTHORIZED_PACKET_SCHEMA_VERSION),
    packet_id: z.string().min(1).max(80).regex(PACKET_ID),
    version: z.string().min(1).max(80).regex(VERSION),
    name: boundedText(200),
    description: boundedText(4_000),
    domain: boundedIdentifier(160),
    synthetic_only: z.literal(false),
    execution_scope: z.unknown(),
    data_policy: z.unknown(),
    redaction_profile: z.unknown(),
    required_capabilities: z
      .object({
        multi_turn: z.boolean(),
        observation: z.boolean(),
        tool_events: z.boolean(),
        cleanup: z.boolean()
      })
      .strict(),
    scenarios: z.array(packetScenarioSchema).min(1).max(100)
  })
  .strict()
  .superRefine((manifest, context) =>
    validateManifest(manifest as unknown as PacketManifest, context)
  );

export interface LoadedLocalPacket {
  readonly manifest: AnyLocalPacketManifest;
  readonly binding: LocalPacketBinding;
  readonly source:
    | { readonly kind: "bundled"; readonly reference: string }
    | { readonly kind: "file"; readonly path: string };
  readonly derivedCommandCount: number;
}

export interface LoadLocalPacketOptions {
  readonly reference: string;
  readonly cwd?: string;
}

export function parseLocalPacket(value: unknown): AnyLocalPacketManifest {
  if (looksLikeCustomerSuiteDocument(value)) {
    throw hostedSuiteUnsupportedLocalError("this file");
  }
  if (looksLikeHostedAuthorizedPacket(value)) {
    throw authorizedPacketUnsupportedLocalError("this file");
  }
  if (looksLikeLocalAuthorizedPacket(value) || isSnakeLocalAuthorized(value)) {
    return parseLocalAuthorizedPacket(value);
  }
  if (looksLikeLivePacketDocument(value)) {
    throw livePacketUnsupportedLocalError("this file");
  }
  if (!isLocalJson(value)) {
    throw packetError(
      "LOCAL_PACKET_INVALID",
      "The local packet must contain only bounded, finite JSON values."
    );
  }
  rejectUnsupportedLocalGrader(value);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_LOCAL_PACKET_BYTES) {
    throw packetError(
      "LOCAL_PACKET_TOO_LARGE",
      `Local packets cannot exceed ${MAX_LOCAL_PACKET_BYTES} bytes.`
    );
  }
  const parsed = PacketManifestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "root";
    throw packetError(
      "LOCAL_PACKET_INVALID",
      `The local packet is invalid at ${path}: ${issue?.message ?? "schema validation failed"}.`
    );
  }
  return parsed.data as PacketManifest;
}

function isSnakeLocalAuthorized(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record["schema_version"] === LOCAL_AUTHORIZED_PACKET_SCHEMA_VERSION;
}

function parseLocalAuthorizedPacket(value: unknown): LocalAuthorizedPacketManifest {
  if (!isLocalJson(value)) {
    throw packetError(
      "LOCAL_PACKET_INVALID",
      "The local authorized packet must contain only bounded, finite JSON values."
    );
  }
  rejectUnsupportedLocalGrader(value);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_LOCAL_PACKET_BYTES) {
    throw packetError(
      "LOCAL_PACKET_TOO_LARGE",
      `Local packets cannot exceed ${MAX_LOCAL_PACKET_BYTES} bytes.`
    );
  }
  const parsed = LocalAuthorizedPacketManifestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "root";
    throw packetError(
      "LOCAL_PACKET_INVALID",
      `The local authorized packet is invalid at ${path}: ${issue?.message ?? "schema validation failed"}.`
    );
  }
  const executionScope = parseLocalExecutionScope(parsed.data.execution_scope);
  const dataPolicy = parseDataPolicy(parsed.data.data_policy);
  const redactionProfile = parseRedactionProfile(parsed.data.redaction_profile);
  if (dataPolicy.policyId !== executionScope.dataPolicy.id || dataPolicy.policyHash !== executionScope.dataPolicy.hash) {
    throw packetError(
      "LOCAL_PACKET_INVALID",
      "Local packet data_policy identity does not match execution_scope.dataPolicy."
    );
  }
  if (redactionProfile.profileHash !== dataPolicy.redactionProfileHash) {
    throw packetError(
      "LOCAL_PACKET_INVALID",
      "Local packet redaction_profile hash does not match the data policy."
    );
  }
  return {
    ...(parsed.data as Omit<
      LocalAuthorizedPacketManifest,
      "execution_scope" | "data_policy" | "redaction_profile"
    >),
    execution_scope: executionScope,
    data_policy: dataPolicy,
    redaction_profile: redactionProfile
  };
}

export function derivedPacketCommandCount(packet: AnyLocalPacketManifest): number {
  return packet.scenarios.reduce((total, scenario) => {
    const prepare = Object.keys(scenario.fixture).length > 0 ? 1 : 0;
    const observe = scenario.observation_keys.length > 0 ? 1 : 0;
    const cleanup = packet.required_capabilities.cleanup || prepare > 0 ? 1 : 0;
    return total + scenario.repetitions * (prepare + scenario.turns.length + observe + cleanup);
  }, 0);
}

export async function loadLocalPacket(
  options: LoadLocalPacketOptions
): Promise<LoadedLocalPacket> {
  const reference = options.reference.trim();
  if (reference === "") {
    throw packetError("LOCAL_PACKET_REFERENCE_INVALID", "A local packet reference is required.");
  }

  if (reference === SUPPORT_REFUNDS_STARTER_REFERENCE) {
    const manifest = parseLocalPacket(starterPacketJson);
    const digest = sha256Json(manifest as unknown as LocalJson);
    if (digest !== SUPPORT_REFUNDS_STARTER_SHA256) {
      throw packetError(
        "BUNDLED_PACKET_INTEGRITY_FAILED",
        "The bundled community packet failed its immutable integrity check."
      );
    }
    return loadedPacket(manifest, {
      kind: "bundled",
      reference: SUPPORT_REFUNDS_STARTER_REFERENCE
    });
  }

  if (BUNDLED_REFERENCE.test(reference)) {
    throw packetError(
      "LOCAL_PACKET_NOT_BUNDLED",
      `Local mode does not bundle ${reference} and does not download packets. Use a local packet.json path.`
    );
  }
  if (looksLikeNonFileReference(reference)) {
    throw packetError(
      "LOCAL_PACKET_REFERENCE_UNSUPPORTED",
      "Local mode accepts only a bundled packet reference or a local JSON file path."
    );
  }

  const packetPath = await resolvePacketPath(reference, resolve(options.cwd ?? process.cwd()));
  const value = await readPacketJson(packetPath);
  return loadedPacket(parseLocalPacket(value), { kind: "file", path: packetPath });
}

function loadedPacket(
  manifest: AnyLocalPacketManifest,
  source: LoadedLocalPacket["source"]
): LoadedLocalPacket {
  const derivedCommandCount = derivedPacketCommandCount(manifest);
  if (derivedCommandCount > MAX_LOCAL_PACKET_COMMANDS) {
    throw packetError(
      "LOCAL_PACKET_COMMAND_LIMIT",
      `The local packet derives ${derivedCommandCount} operations; the limit is ${MAX_LOCAL_PACKET_COMMANDS}.`
    );
  }
  const cloned = structuredClone(manifest);
  return {
    manifest: cloned,
    binding: {
      id: cloned.packet_id,
      version: cloned.version,
      sha256: sha256Json(cloned as unknown as LocalJson),
      name: cloned.name
    },
    source,
    derivedCommandCount
  };
}

function validateScenario(
  scenario: PacketScenario,
  context: z.RefinementCtx
): void {
  if (new Set(scenario.observation_keys).size !== scenario.observation_keys.length) {
    context.addIssue({
      code: "custom",
      message: "observation_keys must be unique",
      path: ["observation_keys"]
    });
  }
  const assertionKeys = new Set<string>();
  const observed = new Set(scenario.observation_keys);
  scenario.assertions.forEach((assertion, index) => {
    if (assertionKeys.has(assertion.key)) {
      context.addIssue({
        code: "custom",
        message: "assertion keys must be unique within a scenario",
        path: ["assertions", index, "key"]
      });
    }
    assertionKeys.add(assertion.key);
    if (
      (assertion.kind === "assistant_contains" ||
        assertion.kind === "assistant_not_contains") &&
      assertion.turn_index !== undefined &&
      assertion.turn_index >= scenario.turns.length
    ) {
      context.addIssue({
        code: "custom",
        message: "turn_index must reference a declared scenario turn",
        path: ["assertions", index, "turn_index"]
      });
    }
    if (
      (assertion.kind === "observation_equals" || assertion.kind === "observation_absent") &&
      !observed.has(assertion.observation_key)
    ) {
      context.addIssue({
        code: "custom",
        message: "observation assertions must reference a declared observation_key",
        path: ["assertions", index, "observation_key"]
      });
    }
  });
}

function validateManifest(manifest: PacketManifest, context: z.RefinementCtx): void {
  const scenarioKeys = new Set<string>();
  let totalAttempts = 0;
  for (const [index, scenario] of manifest.scenarios.entries()) {
    const namespace = `${manifest.packet_id}.`;
    if (!scenario.key.startsWith(namespace) || scenario.key.length === namespace.length) {
      context.addIssue({
        code: "custom",
        message: `scenario keys must be namespaced under ${manifest.packet_id}.`,
        path: ["scenarios", index, "key"]
      });
    }
    if (scenarioKeys.has(scenario.key)) {
      context.addIssue({
        code: "custom",
        message: "scenario keys must be unique",
        path: ["scenarios", index, "key"]
      });
    }
    scenarioKeys.add(scenario.key);
    totalAttempts += scenario.repetitions;

    if (scenario.turns.length > 1 && !manifest.required_capabilities.multi_turn) {
      context.addIssue({
        code: "custom",
        message: "multi-turn scenarios require required_capabilities.multi_turn",
        path: ["required_capabilities", "multi_turn"]
      });
    }
    if (scenario.observation_keys.length > 0 && !manifest.required_capabilities.observation) {
      context.addIssue({
        code: "custom",
        message: "scenario observations require required_capabilities.observation",
        path: ["required_capabilities", "observation"]
      });
    }
    if (Object.keys(scenario.fixture).length > 0 && !manifest.required_capabilities.cleanup) {
      context.addIssue({
        code: "custom",
        message: "non-empty synthetic fixtures require required_capabilities.cleanup",
        path: ["required_capabilities", "cleanup"]
      });
    }
    if (
      scenario.assertions.some((assertion) => assertionUsesEvents(assertion)) &&
      !manifest.required_capabilities.tool_events
    ) {
      context.addIssue({
        code: "custom",
        message: "structured event assertions require required_capabilities.tool_events",
        path: ["required_capabilities", "tool_events"]
      });
    }
  }
  if (totalAttempts > MAX_LOCAL_PACKET_ATTEMPTS) {
    context.addIssue({
      code: "custom",
      message: `packet repetitions derive ${totalAttempts} attempts; the limit is ${MAX_LOCAL_PACKET_ATTEMPTS}`,
      path: ["scenarios"]
    });
  }
  const commandCount = derivedPacketCommandCount(manifest);
  if (commandCount > MAX_LOCAL_PACKET_COMMANDS) {
    context.addIssue({
      code: "custom",
      message: `packet derives ${commandCount} operations; the limit is ${MAX_LOCAL_PACKET_COMMANDS}`,
      path: ["scenarios"]
    });
  }
}

function assertionUsesEvents(assertion: PacketAssertion): boolean {
  return (
    assertion.kind === "tool_called" ||
    assertion.kind === "tool_not_called" ||
    assertion.kind === "tool_result" ||
    assertion.kind === "handoff_occurred" ||
    assertion.kind === "no_error_events"
  );
}

async function resolvePacketPath(reference: string, cwd: string): Promise<string> {
  const requested = resolve(cwd, reference);
  let candidate = requested;
  try {
    await assertNoSymbolicLinkComponents(requested);
    const requestedStat = await lstat(requested);
    if (requestedStat.isDirectory()) candidate = resolve(requested, "packet.json");
    else if (!requestedStat.isFile()) {
      throw packetError(
        "LOCAL_PACKET_FILE_INVALID",
        "The local packet path must be a regular file or a directory containing packet.json."
      );
    }
    await assertNoSymbolicLinkComponents(candidate);
    const candidateStat = candidate === requested ? requestedStat : await lstat(candidate);
    if (!candidateStat.isFile()) {
      throw packetError(
        "LOCAL_PACKET_FILE_INVALID",
        "The resolved local packet is not a regular file."
      );
    }
    // Keep the lexical path. Resolving it here would introduce a lstat -> realpath
    // race in which a swapped leaf symlink could redirect the later open.
    return candidate;
  } catch (error) {
    if (error instanceof AwError) throw error;
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw packetError(
      missing ? "LOCAL_PACKET_NOT_FOUND" : "LOCAL_PACKET_UNREADABLE",
      missing ? `Local packet not found: ${candidate}` : `Could not read local packet: ${candidate}`,
      error
    );
  }
}

async function readPacketJson(path: string): Promise<unknown> {
  let handle;
  try {
    await assertNoSymbolicLinkComponents(path);
    const beforeOpen = await lstat(path);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
      throw packetError(
        "LOCAL_PACKET_FILE_INVALID",
        "The local packet path must be a regular file and cannot be a symbolic link."
      );
    }
    const noFollow =
      process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number"
        ? constants.O_NOFOLLOW
        : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw packetError("LOCAL_PACKET_FILE_INVALID", "The local packet path is not a regular file.");
    }
    if (!sameFileIdentity(metadata, beforeOpen)) {
      throw packetError(
        "LOCAL_PACKET_FILE_INVALID",
        "The local packet changed while it was being opened."
      );
    }
    await assertNoSymbolicLinkComponents(path);
    const afterOpen = await lstat(path);
    if (!sameFileIdentity(afterOpen, metadata)) {
      throw packetError(
        "LOCAL_PACKET_FILE_INVALID",
        "The local packet path changed after it was opened."
      );
    }
    if (metadata.size > MAX_LOCAL_PACKET_BYTES) {
      throw packetError(
        "LOCAL_PACKET_TOO_LARGE",
        `Local packet files cannot exceed ${MAX_LOCAL_PACKET_BYTES} bytes.`
      );
    }
    const bytes = Buffer.alloc(MAX_LOCAL_PACKET_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_LOCAL_PACKET_BYTES) {
      throw packetError(
        "LOCAL_PACKET_TOO_LARGE",
        `Local packet files cannot exceed ${MAX_LOCAL_PACKET_BYTES} bytes.`
      );
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    } catch (cause) {
      throw packetError("LOCAL_PACKET_JSON_INVALID", "The local packet is not valid UTF-8 JSON.", cause);
    }
    if (sourceLooksLikeCustomerSuite(source)) {
      throw hostedSuiteUnsupportedLocalError(path);
    }
    try {
      assertNoDuplicateJsonKeys(source);
      return JSON.parse(source) as unknown;
    } catch (cause) {
      if (cause instanceof AwError) throw cause;
      throw packetError("LOCAL_PACKET_JSON_INVALID", "The local packet is not valid JSON.", cause);
    }
  } catch (error) {
    if (error instanceof AwError) throw error;
    throw packetError("LOCAL_PACKET_UNREADABLE", `Could not read local packet: ${path}`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertNoSymbolicLinkComponents(path: string): Promise<void> {
  if ((await findUnsafeSymbolicLinkComponent(path)) === undefined) return;
  throw packetError(
    "LOCAL_PACKET_FILE_INVALID",
    "The local packet path cannot contain symbolic links."
  );
}

function assertNoDuplicateJsonKeys(source: string): void {
  const document = parseDocument(source, {
    schema: "json",
    strict: true,
    uniqueKeys: true
  });
  const duplicate = document.errors.find((error) => error.code === "DUPLICATE_KEY");
  if (duplicate !== undefined) {
    throw packetError(
      "LOCAL_PACKET_JSON_INVALID",
      "The local packet contains a duplicate JSON object key."
    );
  }
}

function rejectUnsupportedLocalGrader(value: LocalJson): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as LocalJsonObject;
  if (record["schema_version"] === "aw-packet/0.2" || record["evaluation_mode"] === "hybrid") {
    throw unsupportedLocalGrader();
  }
  const scenarios = record["scenarios"];
  if (!Array.isArray(scenarios)) return;
  for (const scenario of scenarios) {
    if (scenario === null || typeof scenario !== "object" || Array.isArray(scenario)) continue;
    for (const field of ["criteria", "assertions"] as const) {
      const items = scenario[field];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (
          item !== null &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          item["kind"] === "llm_rubric"
        ) {
          throw unsupportedLocalGrader();
        }
      }
    }
  }
}

function unsupportedLocalGrader(): AwError {
  return packetError(
    "UNSUPPORTED_LOCAL_GRADER",
    "This packet requires hosted LLM judging and cannot run in local mode."
  );
}

function looksLikeNonFileReference(reference: string): boolean {
  if (/^[A-Za-z]:[\\/]/u.test(reference)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference) || reference.startsWith("@") || reference.includes("\0");
}

function packetError(code: string, message: string, cause?: unknown): AwError {
  return new AwError({ code, category: "config", message, cause });
}
