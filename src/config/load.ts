import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { AwError } from "../errors.js";
import { sameFileIdentity } from "../system/file-identity.js";
import { findUnsafeSymbolicLinkComponent } from "../system/path-safety.js";
import { loadEnvironment } from "./environment.js";
import { resolveConfig } from "./resolve.js";
import type { ConfigInspection, Diagnostic, InspectConfigOptions, ResolvedConfig } from "./types.js";
import { validateConfigObject } from "./validate.js";
import { parseYamlStrict, StrictYamlError } from "./yaml.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const CONFIG_READ_CHUNK_BYTES = 64 * 1024;

class ConfigFileError extends Error {
  readonly diagnosticCode: "CONFIG_FILE_TOO_LARGE" | "CONFIG_FILE_UNREADABLE";

  constructor(
    diagnosticCode: "CONFIG_FILE_TOO_LARGE" | "CONFIG_FILE_UNREADABLE",
    message: string
  ) {
    super(message);
    this.name = "ConfigFileError";
    this.diagnosticCode = diagnosticCode;
  }
}

function errorDiagnostic(code: string, message: string, path?: string): Diagnostic {
  return { level: "error", code, message, ...(path === undefined ? {} : { path }) };
}

export async function inspectConfig(options: InspectConfigOptions = {}): Promise<ConfigInspection> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const requestedPath = resolve(cwd, options.configPath ?? "augmentworks.yaml");
  const configPath = requestedPath;
  let source: string;
  try {
    source = await readConfigFile(configPath);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    const fileError = error instanceof ConfigFileError ? error : undefined;
    return {
      diagnostics: [
        errorDiagnostic(
          missing ? "CONFIG_FILE_NOT_FOUND" : (fileError?.diagnosticCode ?? "CONFIG_FILE_UNREADABLE"),
          missing
            ? `Configuration file not found: ${requestedPath}`
            : (fileError?.message ?? `Could not read configuration file: ${requestedPath}`),
          requestedPath
        )
      ]
    };
  }

  let rawConfig: unknown;
  try {
    rawConfig = parseYamlStrict(source);
  } catch (error) {
    if (error instanceof StrictYamlError) {
      return { diagnostics: [errorDiagnostic(error.code, error.message, error.path ?? configPath)] };
    }
    return { diagnostics: [errorDiagnostic("YAML_PARSE_ERROR", "The configuration file is not valid YAML.", configPath)] };
  }

  const validation = validateConfigObject(rawConfig);
  const diagnostics: Diagnostic[] = [
    { level: "ok", code: "CONFIG_FILE_LOADED", message: `Loaded ${configPath}.`, path: configPath },
    ...validation.diagnostics
  ];
  if (validation.config === undefined || diagnostics.some((item) => item.level === "error")) return { diagnostics };
  diagnostics.push({ level: "ok", code: "CONFIG_VALID", message: "Configuration schema and mappings are valid." });

  const configDirectory = dirname(configPath);
  const environmentResult = await loadEnvironment(resolve(configDirectory, ".env"), options.processEnv ?? process.env);
  diagnostics.push(...environmentResult.diagnostics);
  if (environmentResult.diagnostics.some((item) => item.level === "error")) return { diagnostics };

  const resolution = resolveConfig(
    validation.config,
    configPath,
    configDirectory,
    environmentResult.environment,
    diagnostics.filter((item) => item.level === "warning")
  );
  diagnostics.push(...resolution.diagnostics.filter((item) => !diagnostics.includes(item)));
  if (resolution.resolvedConfig === undefined) return { diagnostics };
  diagnostics.push({
    level: "ok",
    code: "CONNECTOR_READY",
    message: `Connector capability level: ${resolution.resolvedConfig.capabilities.level}.`
  });
  return { diagnostics, resolvedConfig: resolution.resolvedConfig };
}

async function readConfigFile(path: string): Promise<string> {
  await assertNoSymbolicLinkComponents(path);
  const beforeOpen = await lstat(path);
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
    throw new ConfigFileError(
      "CONFIG_FILE_UNREADABLE",
      "The configuration path must be a regular file and cannot be a symbolic link."
    );
  }
  if (beforeOpen.size > MAX_CONFIG_BYTES) throw configTooLarge();
  const noFollow =
    process.platform !== "win32" && typeof fsConstants.O_NOFOLLOW === "number"
      ? fsConstants.O_NOFOLLOW
      : 0;
  const nonBlocking =
    process.platform !== "win32" && typeof fsConstants.O_NONBLOCK === "number"
      ? fsConstants.O_NONBLOCK
      : 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow | nonBlocking);
    const metadata = await handle.stat();
    if (!metadata.isFile() || !sameFileIdentity(metadata, beforeOpen)) {
      throw new ConfigFileError(
        "CONFIG_FILE_UNREADABLE",
        "The configuration file changed while it was being opened."
      );
    }
    if (metadata.size > MAX_CONFIG_BYTES) throw configTooLarge();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remainingWithSentinel = MAX_CONFIG_BYTES - total + 1;
      const buffer = Buffer.allocUnsafe(Math.min(CONFIG_READ_CHUNK_BYTES, remainingWithSentinel));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_CONFIG_BYTES) throw configTooLarge();
      chunks.push(buffer.subarray(0, bytesRead));
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw new ConfigFileError(
        "CONFIG_FILE_UNREADABLE",
        "The configuration file is not valid UTF-8 text."
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ConfigFileError(
        "CONFIG_FILE_UNREADABLE",
        "The configuration path cannot be a symbolic link."
      );
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertNoSymbolicLinkComponents(path: string): Promise<void> {
  if ((await findUnsafeSymbolicLinkComponent(path)) === undefined) return;
  throw new ConfigFileError(
    "CONFIG_FILE_UNREADABLE",
    "The configuration path cannot contain symbolic links."
  );
}

function configTooLarge(): ConfigFileError {
  return new ConfigFileError(
    "CONFIG_FILE_TOO_LARGE",
    "Configuration files cannot exceed 1 MiB."
  );
}

export function unresolvedConfigError(inspection: ConfigInspection): AwError {
  const firstError = inspection.diagnostics.find((item) => item.level === "error");
  return new AwError({
    code: firstError?.code ?? "CONFIG_INVALID",
    category: "config",
    message: firstError?.message ?? "The AugmentWorks configuration is invalid.",
    ...(firstError?.path === undefined ? {} : { details: { path: firstError.path } })
  });
}

export async function loadConfig(options: InspectConfigOptions = {}): Promise<ResolvedConfig> {
  const inspection = await inspectConfig(options);
  if (inspection.resolvedConfig !== undefined) return inspection.resolvedConfig;
  throw unresolvedConfigError(inspection);
}
