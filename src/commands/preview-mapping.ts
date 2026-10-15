import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

import { Command } from "commander";

import { validateConfigObject } from "../config/validate.js";
import { parseYamlStrict, StrictYamlError } from "../config/yaml.js";
import type { AugmentWorksConfig, Diagnostic, JsonValue } from "../config/types.js";
import {
  isMappingPreviewOperation,
  MAPPING_PREVIEW_DISCLAIMER,
  previewMapping,
  type MappingPreviewReport
} from "../connector/mapping-preview.js";
import { selectResponse } from "../connector/mapping.js";
import { EXIT, AwError, sanitizeTerminal } from "../errors.js";
import { sameFileIdentity } from "../system/file-identity.js";
import { findUnsafeSymbolicLinkComponent } from "../system/path-safety.js";
import { LIMITS } from "../util/limits.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export interface PreviewMappingOptions {
  readonly config?: string;
  readonly cwd?: string;
  readonly operation?: string;
  readonly fixture?: string;
  readonly probeKeys?: string;
  readonly json?: boolean;
}

export interface PreviewMappingCommandDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly cwd?: () => string;
  readonly setExitCode?: (code: number) => void;
}

class BoundedFileError extends AwError {
  constructor(code: string, message: string, path?: string) {
    super({
      code,
      category: "config",
      message,
      ...(path === undefined ? {} : { details: { path } })
    });
    this.name = "BoundedFileError";
  }
}

export async function runPreviewMapping(options: PreviewMappingOptions = {}): Promise<MappingPreviewReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.config ?? "augmentworks.yaml");
  const operationName = options.operation ?? "send";
  const diagnostics: Diagnostic[] = [];

  if (!isMappingPreviewOperation(operationName)) {
    throw new AwError({
      code: "PREVIEW_OPERATION_INVALID",
      category: "config",
      message: "Operation must be send, observe, cleanup, or prepare."
    });
  }

  const config = await loadPreviewConfig(configPath, diagnostics);
  const fixtureRequired = operationName === "send" || operationName === "observe";
  if (fixtureRequired && options.fixture === undefined) {
    diagnostics.push({
      level: "error",
      code: "FIXTURE_REQUIRED",
      message: `A synthetic JSON response fixture is required to preview the ${operationName} mapping.`,
      path: "--fixture"
    });
  }

  let response: JsonValue | undefined;
  let fixturePath: string | undefined;
  if (options.fixture !== undefined) {
    fixturePath = resolve(cwd, options.fixture);
    try {
      response = await loadPreviewFixture(fixturePath);
    } catch (error) {
      if (error instanceof AwError) {
        diagnostics.push({
          level: "error",
          code: error.code,
          message: error.message,
          path: fixturePath
        });
      } else {
        diagnostics.push({
          level: "error",
          code: "FIXTURE_UNREADABLE",
          message: "The response fixture could not be read.",
          path: fixturePath
        });
      }
    }
  }

  const probeKeys = parseProbeKeys(options.probeKeys, diagnostics);

  if (config === undefined || diagnostics.some((item) => item.level === "error")) {
    return {
      schema_version: "AW-MAPPING-PREVIEW-1",
      ok: false,
      offline: true,
      credits_consumed: 0,
      operation: operationName,
      config_path: configPath,
      fixture_path: fixturePath ?? null,
      extracted: [],
      missing: [],
      omitted: [],
      redacted: [],
      truncation: [],
      diagnostics: [
        ...diagnostics,
        {
          level: "ok",
          code: "MAPPING_PREVIEW_OFFLINE",
          message: "No target, cloud, or model call was made."
        }
      ],
      evidence: null,
      disclaimer: MAPPING_PREVIEW_DISCLAIMER
    };
  }

  const report = previewMapping({
    config,
    operation: operationName,
    ...(response === undefined ? {} : { response }),
    ...(probeKeys === undefined ? {} : { probeKeys }),
    configPath,
    ...(fixturePath === undefined ? {} : { fixturePath })
  });
  return {
    ...report,
    diagnostics: [
      ...diagnostics,
      ...report.diagnostics,
      {
        level: "ok",
        code: "MAPPING_PREVIEW_OFFLINE",
        message: "No target, cloud, or model call was made."
      }
    ]
  };
}

export function formatPreviewMappingHuman(report: MappingPreviewReport): string {
  const marker = { ok: "OK", warning: "WARN", error: "ERROR" } as const;
  const lines: string[] = [
    "Mapping preview (offline, fixture-only)",
    `Operation: ${report.operation}`,
    `Config: ${report.config_path ?? "(in-memory)"}`,
    `Fixture: ${report.fixture_path ?? "(none)"}`,
    ""
  ];

  lines.push("Extracted fields");
  if (report.extracted.length === 0) {
    lines.push("  (none)");
  } else {
    for (const field of report.extracted) {
      const flags = [
        field.redacted ? "redacted" : undefined,
        field.display_truncated ? "truncated" : undefined
      ].filter((value): value is string => value !== undefined);
      const suffix = flags.length === 0 ? "" : ` [${flags.join(", ")}]`;
      lines.push(
        `  ${field.field}  ${field.selector}  ${field.value_kind}  ${String(field.bytes)} bytes${suffix}`
      );
      lines.push(`    ${field.preview}`);
      lines.push(`    (${field.path})`);
    }
  }

  lines.push("", "Missing required fields");
  if (report.missing.length === 0) {
    lines.push("  (none)");
  } else {
    for (const field of report.missing) {
      lines.push(`  ${field.field}  ${field.selector}  (${field.path})`);
    }
  }

  lines.push("", "Omitted paths");
  if (report.omitted.length === 0) {
    lines.push("  (none)");
  } else {
    for (const field of report.omitted) {
      lines.push(`  ${field.field}  ${field.selector}`);
      lines.push(`    ${field.reason} (${field.path})`);
    }
  }

  lines.push("", "Redacted values");
  if (report.redacted.length === 0) {
    lines.push("  (none)");
  } else {
    for (const field of report.redacted) {
      lines.push(`  ${field.field}  ${field.preview}  (${field.path})`);
    }
  }

  lines.push("", "Truncation");
  if (report.truncation.length === 0) {
    lines.push("  (none)");
  } else {
    for (const item of report.truncation) {
      lines.push(
        `  ${item.field}  ${item.decision}  ${String(item.actual_bytes)} bytes exceeds ${String(item.limit_bytes)}-byte limit  (${item.path})`
      );
    }
  }

  lines.push("", "Diagnostics");
  for (const item of report.diagnostics) {
    const suffix = item.path === undefined ? "" : ` (${item.path})`;
    lines.push(`${marker[item.level]} ${item.code}: ${item.message}${suffix}`);
  }

  if (report.evidence !== undefined && report.evidence !== null) {
    lines.push("", "Canonical evidence payload");
    lines.push(`  ${String(report.evidence.bytes)} bytes`);
    lines.push(`  sha256 ${report.evidence.sha256}`);
    lines.push(report.evidence.canonical);
  } else {
    lines.push("", "Canonical evidence payload");
    lines.push("  (not produced; mapping or validation failed)");
  }

  lines.push("", report.disclaimer);
  lines.push(
    report.ok
      ? "Mapping preview complete. No target, cloud, or model call was made."
      : "Mapping preview found problems. No hosted run started and no credits were consumed."
  );
  return `${sanitizeTerminal(lines.join("\n"))}\n`;
}

export function formatPreviewMappingJson(report: MappingPreviewReport): string {
  return `${JSON.stringify(
    {
      schema_version: report.schema_version,
      ok: report.ok,
      offline: report.offline,
      credits_consumed: report.credits_consumed,
      operation: report.operation,
      config_path: report.config_path,
      fixture_path: report.fixture_path,
      extracted: report.extracted,
      missing: report.missing,
      omitted: report.omitted,
      redacted: report.redacted,
      truncation: report.truncation,
      diagnostics: report.diagnostics,
      evidence:
        report.evidence === null
          ? null
          : {
              protocol_version: report.evidence.protocol_version,
              canonical: report.evidence.canonical,
              sha256: report.evidence.sha256,
              bytes: report.evidence.bytes,
              result: report.evidence.result
            },
      disclaimer: report.disclaimer
    },
    null,
    2
  )}\n`;
}

export function createPreviewMappingCommand(dependencies: PreviewMappingCommandDependencies = {}): Command {
  return new Command("preview-mapping")
    .description(
      "Preview response mappings and the exact sanitized evidence payload from a local JSON fixture without calling the target"
    )
    .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
    .option("--operation <kind>", "send, observe, cleanup, or prepare", "send")
    .option("--fixture <path>", "synthetic JSON response fixture")
    .option("--probe-keys <keys>", "comma-separated observe probe keys (default: configured allowlist)")
    .option("--json", "emit stable machine-readable preview")
    .action(
      async (commandOptions: {
        config: string;
        operation: string;
        fixture?: string;
        probeKeys?: string;
        json?: boolean;
      }) => {
        const report = await runPreviewMapping({
          config: commandOptions.config,
          cwd: dependencies.cwd?.() ?? process.cwd(),
          operation: commandOptions.operation,
          ...(commandOptions.fixture === undefined ? {} : { fixture: commandOptions.fixture }),
          ...(commandOptions.probeKeys === undefined ? {} : { probeKeys: commandOptions.probeKeys })
        });
        (dependencies.stdout ?? process.stdout).write(
          commandOptions.json === true ? formatPreviewMappingJson(report) : formatPreviewMappingHuman(report)
        );
        if (!report.ok) {
          (dependencies.setExitCode ?? ((code) => { process.exitCode = code; }))(EXIT.CONFIG);
        }
      }
    );
}

export const previewMappingFormatters = {
  human: formatPreviewMappingHuman,
  json: formatPreviewMappingJson
} as const;

async function loadPreviewConfig(
  configPath: string,
  diagnostics: Diagnostic[]
): Promise<AugmentWorksConfig | undefined> {
  let source: string;
  try {
    source = await readBoundedRegularFile(configPath, MAX_CONFIG_BYTES, "configuration");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    diagnostics.push({
      level: "error",
      code: missing
        ? "CONFIG_FILE_NOT_FOUND"
        : error instanceof BoundedFileError
          ? error.code
          : "CONFIG_FILE_UNREADABLE",
      message:
        missing
          ? `Configuration file not found: ${configPath}`
          : error instanceof AwError
            ? error.message
            : `Could not read configuration file: ${configPath}`,
      path: configPath
    });
    return undefined;
  }

  let rawConfig: unknown;
  try {
    rawConfig = parseYamlStrict(source);
  } catch (error) {
    if (error instanceof StrictYamlError) {
      diagnostics.push({
        level: "error",
        code: error.code,
        message: error.message,
        path: error.path ?? configPath
      });
    } else {
      diagnostics.push({
        level: "error",
        code: "YAML_PARSE_ERROR",
        message: "The configuration file is not valid YAML.",
        path: configPath
      });
    }
    return undefined;
  }

  const validation = validateConfigObject(rawConfig);
  diagnostics.push(...validation.diagnostics.filter((item) => item.level === "error"));
  if (validation.config === undefined || validation.diagnostics.some((item) => item.level === "error")) {
    return undefined;
  }
  diagnostics.push({
    level: "ok",
    code: "CONFIG_VALID",
    message: "Configuration schema and mappings are valid."
  });
  return validation.config;
}

function jsonPosition(error: unknown): number | undefined {
  if (!(error instanceof SyntaxError)) return undefined;
  const match = /position\s+(\d+)/u.exec(error.message);
  if (match?.[1] === undefined) return undefined;
  const position = Number(match[1]);
  return Number.isSafeInteger(position) ? position : undefined;
}

async function loadPreviewFixture(path: string): Promise<JsonValue> {
  const source = await readBoundedRegularFile(path, LIMITS.targetResponseBytes, "fixture");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const position = jsonPosition(error);
    throw new BoundedFileError(
      "FIXTURE_JSON_INVALID",
      position === undefined
        ? "The response fixture is not valid JSON."
        : `The response fixture is not valid JSON (at position ${String(position)}).`,
      path
    );
  }
  try {
    return selectResponse(parsed, "$");
  } catch (error) {
    if (error instanceof AwError) {
      throw new BoundedFileError(error.code, error.message, path);
    }
    throw new BoundedFileError("FIXTURE_JSON_INVALID", "The response fixture is not valid JSON.", path);
  }
}

function parseProbeKeys(value: string | undefined, diagnostics: Diagnostic[]): string[] | undefined {
  if (value === undefined) return undefined;
  const keys = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (keys.length === 0) {
    diagnostics.push({
      level: "error",
      code: "INVALID_PROBE_KEYS",
      message: "observe probe keys must be a comma-separated list of observation aliases.",
      path: "--probe-keys"
    });
    return undefined;
  }
  return keys;
}

async function readBoundedRegularFile(path: string, maxBytes: number, label: string): Promise<string> {
  if ((await findUnsafeSymbolicLinkComponent(path)) !== undefined) {
    throw new BoundedFileError(
      label === "fixture" ? "FIXTURE_UNREADABLE" : "CONFIG_FILE_UNREADABLE",
      `The ${label} path cannot contain symbolic links.`,
      path
    );
  }
  const beforeOpen = await lstat(path);
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
    throw new BoundedFileError(
      label === "fixture" ? "FIXTURE_UNREADABLE" : "CONFIG_FILE_UNREADABLE",
      `The ${label} path must be a regular file and cannot be a symbolic link.`,
      path
    );
  }
  if (beforeOpen.size > maxBytes) {
    throw new BoundedFileError(
      label === "fixture" ? "FIXTURE_TOO_LARGE" : "CONFIG_FILE_TOO_LARGE",
      `${label === "fixture" ? "Response fixtures" : "Configuration files"} cannot exceed ${String(maxBytes)} bytes.`,
      path
    );
  }
  const noFollow =
    process.platform !== "win32" && typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const nonBlocking =
    process.platform !== "win32" && typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow | nonBlocking);
    const metadata = await handle.stat();
    if (!metadata.isFile() || !sameFileIdentity(metadata, beforeOpen)) {
      throw new BoundedFileError(
        label === "fixture" ? "FIXTURE_UNREADABLE" : "CONFIG_FILE_UNREADABLE",
        `The ${label} file changed while it was being opened.`,
        path
      );
    }
    if (metadata.size > maxBytes) {
      throw new BoundedFileError(
        label === "fixture" ? "FIXTURE_TOO_LARGE" : "CONFIG_FILE_TOO_LARGE",
        `${label === "fixture" ? "Response fixtures" : "Configuration files"} cannot exceed ${String(maxBytes)} bytes.`,
        path
      );
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remainingWithSentinel = maxBytes - total + 1;
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remainingWithSentinel));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new BoundedFileError(
          label === "fixture" ? "FIXTURE_TOO_LARGE" : "CONFIG_FILE_TOO_LARGE",
          `${label === "fixture" ? "Response fixtures" : "Configuration files"} cannot exceed ${String(maxBytes)} bytes.`,
          path
        );
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw new BoundedFileError(
        label === "fixture" ? "FIXTURE_UNREADABLE" : "CONFIG_FILE_UNREADABLE",
        `The ${label} file is not valid UTF-8 text.`,
        path
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new BoundedFileError(
        label === "fixture" ? "FIXTURE_UNREADABLE" : "CONFIG_FILE_UNREADABLE",
        `The ${label} path cannot be a symbolic link.`,
        path
      );
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
