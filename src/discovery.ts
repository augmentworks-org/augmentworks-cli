import { z } from "zod";

import {
  LAST_VERIFIED_PUBLISHED_AT,
  LAST_VERIFIED_PUBLISHED_GIT_HEAD,
  LAST_VERIFIED_PUBLISHED_NODE_RANGE,
  LAST_VERIFIED_PUBLISHED_PACKAGE_VERSION,
  LOCAL_PACKET_REFERENCE,
  NPM_PACKAGE,
  SOURCE_PACKAGE_VERSION
} from "./release.js";

export const DISCOVERY_SCHEMA_VERSION = 1 as const;
export const DISCOVERY_SITE = "https://augmentworks.ai";
export const DISCOVERY_DOCS = {
  quickstart: "https://augmentworks.ai/docs/quickstart",
  localQuickstart: "https://augmentworks.ai/docs/local-quickstart",
  agentSetup: "https://augmentworks.ai/docs/agent-setup"
} as const;

export type DiscoveryReleaseStatus = "development" | "published";
export type DiscoveryCommandVector = readonly string[] | null;

export interface DiscoveryManifestV1 {
  readonly schemaVersion: 1;
  readonly package: {
    readonly name: typeof NPM_PACKAGE;
    readonly version: string;
    readonly releaseStatus: DiscoveryReleaseStatus;
  };
  readonly runtime: { readonly node: string };
  readonly capabilities: {
    readonly localDemo: boolean;
    readonly localTest: boolean;
    readonly hostedAssessment: boolean;
    readonly agentGuide: boolean;
  };
  readonly commands: {
    readonly localDemo: string[] | null;
    readonly localTest: string[] | null;
    readonly doctor: string[] | null;
    readonly hostedAssessment: string[] | null;
  };
  readonly site: typeof DISCOVERY_SITE;
  readonly docs: {
    readonly quickstart: string;
    readonly localQuickstart: string;
    readonly agentSetup: string;
  };
  readonly reportFormats: readonly string[];
  readonly provenance: {
    readonly sourceCommit: string | null;
    readonly verifiedAt: string | null;
  };
}

const SHELL_OPERATOR = /[|&;<>`$()]/u;
const CREDENTIAL_LIKE = /(token|secret|password|api[_-]?key)/iu;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

const commandToken = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("\n"), "command tokens cannot contain newlines")
  .refine((value) => !SHELL_OPERATOR.test(value), "command tokens cannot contain shell operators")
  .refine((value) => !CREDENTIAL_LIKE.test(value), "command tokens cannot include credential-like names");

const commandVector = z.array(commandToken).min(1).max(24).nullable();

const discoveryManifestSchema = z
  .object({
    schemaVersion: z.literal(DISCOVERY_SCHEMA_VERSION),
    package: z
      .object({
        name: z.literal(NPM_PACKAGE),
        version: z.string().regex(SEMVER),
        releaseStatus: z.enum(["development", "published"])
      })
      .strict(),
    runtime: z.object({ node: z.string().min(1).max(40) }).strict(),
    capabilities: z
      .object({
        localDemo: z.boolean(),
        localTest: z.boolean(),
        hostedAssessment: z.boolean(),
        agentGuide: z.boolean()
      })
      .strict(),
    commands: z
      .object({
        localDemo: commandVector,
        localTest: commandVector,
        doctor: commandVector,
        hostedAssessment: commandVector
      })
      .strict(),
    site: z.literal(DISCOVERY_SITE),
    docs: z
      .object({
        quickstart: z.string().url(),
        localQuickstart: z.string().url(),
        agentSetup: z.string().url()
      })
      .strict(),
    reportFormats: z.array(z.string().min(1).max(32)).min(1).max(8),
    provenance: z
      .object({
        sourceCommit: z.string().regex(COMMIT).nullable(),
        verifiedAt: z.string().datetime({ offset: true }).nullable()
      })
      .strict()
  })
  .strict()
  .superRefine((value, ctx) => {
    const pairs = [
      ["localDemo", "localDemo"],
      ["localTest", "localTest"],
      ["hostedAssessment", "hostedAssessment"]
    ] as const;
    for (const [capability, command] of pairs) {
      const enabled = value.capabilities[capability];
      const vector = value.commands[command];
      if (enabled && vector == null) {
        ctx.addIssue({
          code: "custom",
          message: `${capability} requires a command vector`,
          path: ["commands", command]
        });
      }
      if (!enabled && vector != null) {
        ctx.addIssue({
          code: "custom",
          message: `${capability} is false so ${command} must be null`,
          path: ["commands", command]
        });
      }
    }
    if (value.capabilities.localTest && value.commands.doctor == null) {
      ctx.addIssue({
        code: "custom",
        message: "localTest requires a doctor command",
        path: ["commands", "doctor"]
      });
    }
    for (const [key, url] of Object.entries(value.docs)) {
      if (!url.startsWith(`${DISCOVERY_SITE}/`)) {
        ctx.addIssue({
          code: "custom",
          message: `${key} must be a production docs URL`,
          path: ["docs", key]
        });
      }
    }
    if (value.package.releaseStatus === "published") {
      if (value.provenance.verifiedAt == null) {
        ctx.addIssue({
          code: "custom",
          message: "published manifests require provenance.verifiedAt",
          path: ["provenance", "verifiedAt"]
        });
      }
      const pin = `${value.package.name}@${value.package.version}`;
      for (const [name, vector] of Object.entries(value.commands)) {
        if (vector == null) continue;
        if (vector[0] !== "npx" || vector[1] !== "--yes" || vector[2] !== pin) {
          ctx.addIssue({
            code: "custom",
            message: `${name} must start with npx --yes ${pin}`,
            path: ["commands", name]
          });
        }
      }
    } else if (value.provenance.verifiedAt != null) {
      ctx.addIssue({
        code: "custom",
        message: "development manifests cannot claim a publication verification timestamp",
        path: ["provenance", "verifiedAt"]
      });
    }
    const nodeFloor = /^>=\s*(\d+)(?:\.\d+){0,2}$/.exec(value.runtime.node.trim());
    if (nodeFloor == null || Number(nodeFloor[1]) < 20) {
      ctx.addIssue({
        code: "custom",
        message: "runtime.node must be a >= range starting at Node 20 or later",
        path: ["runtime", "node"]
      });
    }
  });

export type DiscoveryManifestParseResult =
  | { ok: true; manifest: DiscoveryManifestV1 }
  | { ok: false; errors: string[] };

export function parseDiscoveryManifest(value: unknown): DiscoveryManifestParseResult {
  const parsed = discoveryManifestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`
      )
    };
  }
  return { ok: true, manifest: parsed.data as DiscoveryManifestV1 };
}

/** Must match `engines.node` in package.json. */
const SOURCE_NODE_RANGE = ">=22.17";

export interface BuildDiscoveryManifestOptions {
  readonly releaseStatus?: DiscoveryReleaseStatus;
  readonly version?: string;
  readonly localDemo?: boolean;
  readonly sourceCommit?: string | null;
  readonly verifiedAt?: string | null;
  readonly nodeRange?: string;
}

export function buildDiscoveryManifest(
  options: BuildDiscoveryManifestOptions = {}
): DiscoveryManifestV1 {
  const releaseStatus = options.releaseStatus ?? "development";
  const version = options.version ?? SOURCE_PACKAGE_VERSION;
  const localDemo = options.localDemo ?? releaseStatus === "development";
  const commands = discoveryCommands({
    releaseStatus,
    version,
    localDemo
  });
  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    package: {
      name: NPM_PACKAGE,
      version,
      releaseStatus
    },
    runtime: { node: options.nodeRange ?? SOURCE_NODE_RANGE },
    capabilities: {
      localDemo,
      localTest: true,
      hostedAssessment: true,
      agentGuide: true
    },
    commands,
    site: DISCOVERY_SITE,
    docs: { ...DISCOVERY_DOCS },
    reportFormats: ["json", "junit", "html"],
    provenance: {
      sourceCommit: options.sourceCommit ?? null,
      verifiedAt: releaseStatus === "published" ? (options.verifiedAt ?? null) : null
    }
  };
}

export function sourceDiscoveryManifest(): DiscoveryManifestV1 {
  return buildDiscoveryManifest({
    releaseStatus: "development",
    version: SOURCE_PACKAGE_VERSION,
    localDemo: true,
    sourceCommit: null,
    verifiedAt: null
  });
}

export function publishedDiscoveryManifest(options: {
  readonly version: string;
  readonly localDemo: boolean;
  readonly sourceCommit: string | null;
  readonly verifiedAt: string;
  readonly nodeRange?: string;
}): DiscoveryManifestV1 {
  return buildDiscoveryManifest({
    releaseStatus: "published",
    version: options.version,
    localDemo: options.localDemo,
    sourceCommit: options.sourceCommit,
    verifiedAt: options.verifiedAt,
    ...(options.nodeRange === undefined ? {} : { nodeRange: options.nodeRange })
  });
}

function discoveryCommands(options: {
  readonly releaseStatus: DiscoveryReleaseStatus;
  readonly version: string;
  readonly localDemo: boolean;
}): DiscoveryManifestV1["commands"] {
  const prefix =
    options.releaseStatus === "published"
      ? (["npx", "--yes", `${NPM_PACKAGE}@${options.version}`] as const)
      : (["node", "dist/index.js"] as const);
  return {
    localDemo: options.localDemo ? [...prefix, "demo"] : null,
    localTest: [
      ...prefix,
      "test",
      "--local",
      "-c",
      "augmentworks.yaml",
      "--packet",
      LOCAL_PACKET_REFERENCE
    ],
    doctor: [...prefix, "doctor", "-c", "augmentworks.yaml"],
    hostedAssessment: [
      ...prefix,
      "test",
      "-c",
      "augmentworks.yaml",
      "--assessment",
      "./augmentworks.assessment.yaml",
      "--profile",
      "quick"
    ]
  };
}

export const LAST_VERIFIED_PUBLISHED_DISCOVERY = publishedDiscoveryManifest({
  version: LAST_VERIFIED_PUBLISHED_PACKAGE_VERSION,
  localDemo: true,
  sourceCommit: LAST_VERIFIED_PUBLISHED_GIT_HEAD,
  verifiedAt: LAST_VERIFIED_PUBLISHED_AT,
  nodeRange: LAST_VERIFIED_PUBLISHED_NODE_RANGE
});
