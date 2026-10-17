import { z } from "zod";

import producerSchema from "../../contracts/aw-feature-v1.producer.schema.json" with { type: "json" };
import { canonicalize, sha256 } from "../util/canonical.js";
import type { LoadedCustomerSuite } from "./load.js";
import { suiteError } from "./errors.js";
import { canonicalLiveTarget, LIVE_PACKET_SCHEMA_VERSION, LIVE_TARGET_SCHEMA_VERSION } from "./live-target.js";
import {
  isAuthorizedCustomerSuite,
  isLiveCustomerSuite,
  type CustomerSuite,
  type SuiteCase
} from "./schema.js";
import { SUITE_SCHEMA_VERSION_V3 } from "../real-data/constants.js";
import { ExecutionScopeSchema, type ExecutionScope } from "../real-data/documents.js";

/** Exact producer schema from augmentworks@7ee82d2f; authoring aw-suite/1 stays separate. */
const { oneOf: _documentChoices, ...producerDefinitions } = producerSchema;
export const NativeSuiteSourceSchema = z.fromJSONSchema({
  ...producerDefinitions,
  $ref: "#/$defs/customerSuiteSource"
} as Parameters<typeof z.fromJSONSchema>[0]);

const identifier = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const LiveNativeSuiteSourceSchema = z
  .object({
    schemaVersion: z.literal("aw-customer-suite/2"),
    documentKind: z.literal("customer_suite_source"),
    suiteId: identifier,
    displayName: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    syntheticOnly: z.literal(false),
    conversationMode: z.literal("single_turn"),
    packetOverlay: z.literal(LIVE_PACKET_SCHEMA_VERSION),
    liveTarget: z
      .object({
        schemaVersion: z.literal(LIVE_TARGET_SCHEMA_VERSION),
        mode: z.literal("informational"),
        origin: z.string().min(8).max(2_048),
        authorizationKind: z.enum(["owned_target", "written_permission"]),
        authorizationRef: z.string().min(1).max(200),
        expiresAt: z.string().min(1).max(64),
        maxMessages: z.number().int().min(1).max(3)
      })
      .strict(),
    tags: z.array(z.string().min(1).max(80)).max(16),
    references: z.array(z.unknown()).max(16),
    cases: z.array(z.unknown()).min(1).max(3)
  })
  .strict();

export const AuthorizedNativeSuiteSourceSchema = z
  .object({
    schemaVersion: z.literal("aw-customer-suite/3"),
    documentKind: z.literal("customer_suite_source"),
    suiteId: identifier,
    displayName: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    conversationMode: z.enum(["single_turn", "explicit_session_v1"]),
    executionScope: ExecutionScopeSchema,
    tags: z.array(z.string().min(1).max(80)).max(16),
    references: z.array(z.unknown()).max(16),
    cases: z.array(z.unknown()).min(1).max(20)
  })
  .strict();

/**
 * The document `POST /v1/suites` stores. An aw-suite/3 file names its test
 * scope by ID; the upload carries the sealed scope the server returned for
 * that ID (aw-real-data/1 `customer_suite_v3`), so pass it as `sealedScope`.
 */
export function nativeSuiteSource(
  loaded: LoadedCustomerSuite,
  sealedScope?: ExecutionScope
): Record<string, unknown> {
  const suite = loaded.document;
  if (suite.suiteId.includes("/") || suite.cases.some((item) => item.caseId.length > 160)) {
    throw suiteError(
      "SUITE_HOSTED_INCOMPATIBLE",
      "Hosted suite IDs cannot contain '/' and case IDs must be at most 160 characters."
    );
  }
  if (
    suite.cases.some(
      (item) => (item.observations?.length ?? 0) > 0 || item.criteria.some((criterion) => criterion.kind === "deterministic")
    )
  ) {
    throw suiteError(
      "SUITE_HOSTED_OBSERVATION_UNSUPPORTED",
      "The hosted customer-suite producer does not execute deterministic observations. Use supported response-only criteria; no suite, quote, or run was created."
    );
  }
  if (isAuthorizedCustomerSuite(suite)) {
    return authorizedNativeSuiteSource(loaded, suite, sealedScope);
  }
  if (isLiveCustomerSuite(suite)) {
    return liveNativeSuiteSource(loaded, suite);
  }
  return syntheticNativeSuiteSource(loaded, suite);
}

function syntheticNativeSuiteSource(
  loaded: LoadedCustomerSuite,
  suite: CustomerSuite
): Record<string, unknown> {
  const document = {
    schemaVersion: "aw-customer-suite/1",
    documentKind: "customer_suite_source",
    suiteId: suite.suiteId,
    displayName: suite.title,
    description: suite.description?.trim() ? suite.description : suite.title.trim() || suite.suiteId,
    syntheticOnly: true,
    conversationMode: suite.cases.some((item) => item.turns.length > 1) ? "explicit_session_v1" : "single_turn",
    tags: suite.tags ?? [],
    references: nativeReferences(loaded),
    cases: nativeCases(loaded, suite.cases)
  };
  return parseNativeDocument(document, NativeSuiteSourceSchema);
}

function liveNativeSuiteSource(
  loaded: LoadedCustomerSuite,
  suite: Extract<CustomerSuite, { schemaVersion: "aw-suite/2" }>
): Record<string, unknown> {
  const document = {
    schemaVersion: "aw-customer-suite/2",
    documentKind: "customer_suite_source",
    suiteId: suite.suiteId,
    displayName: suite.title,
    description: suite.description?.trim() ? suite.description : suite.title.trim() || suite.suiteId,
    syntheticOnly: false,
    conversationMode: "single_turn" as const,
    packetOverlay: LIVE_PACKET_SCHEMA_VERSION,
    liveTarget: canonicalLiveTarget(suite.liveTarget),
    tags: suite.tags ?? [],
    references: nativeReferences(loaded),
    cases: nativeCases(loaded, suite.cases)
  };
  return parseNativeDocument(document, LiveNativeSuiteSourceSchema);
}

function authorizedNativeSuiteSource(
  loaded: LoadedCustomerSuite,
  suite: Extract<CustomerSuite, { schemaVersion: typeof SUITE_SCHEMA_VERSION_V3 }>,
  sealedScope: ExecutionScope | undefined
): Record<string, unknown> {
  const ref = suite.executionScope;
  if (
    sealedScope === undefined ||
    sealedScope.scopeId !== ref.scopeId ||
    (ref.revision !== undefined && sealedScope.revision !== ref.revision) ||
    (ref.scopeHash !== undefined && sealedScope.scopeHash !== ref.scopeHash)
  ) {
    throw suiteError(
      "SUITE_HOSTED_INCOMPATIBLE",
      "The suite's test scope wasn't fetched from AugmentWorks before upload. No suite, quote, or run was created."
    );
  }
  const document = {
    schemaVersion: "aw-customer-suite/3",
    documentKind: "customer_suite_source",
    suiteId: suite.suiteId,
    displayName: suite.title,
    description: suite.description?.trim() ? suite.description : suite.title.trim() || suite.suiteId,
    conversationMode: suite.cases.some((item) => item.turns.length > 1) ? "explicit_session_v1" : "single_turn",
    executionScope: sealedScope,
    tags: suite.tags ?? [],
    references: nativeReferences(loaded),
    cases: nativeCases(loaded, suite.cases)
  };
  return parseNativeDocument(document, AuthorizedNativeSuiteSourceSchema);
}

function nativeReferences(loaded: LoadedCustomerSuite): Array<Record<string, unknown>> {
  return loaded.references.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    sourceLabel: entry.path ?? `inline:${entry.id}`,
    content: entry.content
  }));
}

function nativeCases(
  loaded: LoadedCustomerSuite,
  cases: readonly SuiteCase[]
): Array<Record<string, unknown>> {
  return cases.map((item) => {
    const explicitReferences = [
      ...new Set([...(item.referenceIds ?? []), ...item.criteria.flatMap((criterion) => criterion.referenceIds ?? [])])
    ];
    const hasExplicitReferences =
      item.referenceIds !== undefined || item.criteria.some((criterion) => criterion.referenceIds !== undefined);
    const referenceIds = hasExplicitReferences ? explicitReferences : loaded.references.map((entry) => entry.id);
    return {
      caseId: item.caseId,
      displayName: item.name ?? item.caseId,
      description: item.name?.trim() ? item.name : item.caseId,
      tags: item.tags ?? [],
      repetitions: item.repetitions ?? 1,
      conversationMode: item.turns.length > 1 ? "explicit_session_v1" : "single_turn",
      lifecycle: { prepare: false, observe: false, cleanup: false },
      requiredCapabilities: {
        prepare: false,
        observation: false,
        toolEvents: false,
        cleanup: false,
        multiTurn: item.turns.length > 1
      },
      turns: item.turns,
      expected: {
        kind: item.expected.permittedRefusal === true ? "permitted_refusal" : "facts",
        facts: item.expected.facts,
        permittedRefusal:
          item.expected.permittedRefusal === true ? { mustRefuse: true, allowedAlternatives: [] } : null
      },
      criteria: item.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        version: "1.0.0",
        kind: criterion.kind,
        requirement: criterion.requirement,
        statement: criterion.statement,
        passConditions: criterion.passConditions ?? [],
        failConditions: criterion.failConditions ?? [],
        allowedAlternatives: [],
        requiredEvidenceKinds:
          (criterion.referenceIds ?? referenceIds).length > 0
            ? ["assistant_response", "reference_entry"]
            : ["assistant_response"],
        referenceIds: criterion.referenceIds ?? referenceIds
      })),
      supportedObservations: [],
      referenceIds
    };
  });
}

function parseNativeDocument(document: Record<string, unknown>, schema: z.ZodType): Record<string, unknown> {
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    throw suiteError(
      "SUITE_HOSTED_INCOMPATIBLE",
      "The authoring file exceeds the hosted customer-suite contract. No suite, quote, or run was created.",
      { field: parsed.error.issues[0]?.path.join(".") ?? "root" }
    );
  }
  if (Buffer.byteLength(JSON.stringify(document), "utf8") > 256_000) {
    throw suiteError("SUITE_TOO_LARGE", "Hosted customer-suite source exceeds 256000 bytes.");
  }
  return document;
}

export function nativeSuiteContentHash(document: Record<string, unknown>): string {
  return sha256(canonicalize(document));
}

export function parseNativeSuiteCreateDocument(document: unknown): Record<string, unknown> {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw suiteError(
      "INVALID_SUITE_REQUEST",
      "The customer suite create request does not match the hosted aw-customer-suite/1, aw-customer-suite/2, or aw-customer-suite/3 source contract."
    );
  }
  const authorized = AuthorizedNativeSuiteSourceSchema.safeParse(document);
  if (authorized.success) return document as Record<string, unknown>;
  const live = LiveNativeSuiteSourceSchema.safeParse(document);
  if (live.success) return document as Record<string, unknown>;
  const synthetic = NativeSuiteSourceSchema.safeParse(document);
  if (synthetic.success) return document as Record<string, unknown>;
  throw suiteError(
    "INVALID_SUITE_REQUEST",
    "The customer suite create request does not match the hosted aw-customer-suite/1, aw-customer-suite/2, or aw-customer-suite/3 source contract."
  );
}
