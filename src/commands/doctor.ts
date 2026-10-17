import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Command } from "commander";

import {
  assessmentDiagnostics,
  loadAssessmentFile,
  type LoadedAssessment
} from "../assessment/index.js";
import { assessmentWireBoundDiagnostics } from "../assessment/wire-bounds.js";
import { EXIT, AwError } from "../errors.js";
import { inspectConfig } from "../config/load.js";
import type { ConfigInspection, Diagnostic } from "../config/types.js";
import { PLACEHOLDER_MARKER, placeholderPaths } from "../target/pull.js";

export interface DoctorOptions {
  readonly config?: string;
  readonly cwd?: string;
  readonly processEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly offline?: boolean;
  readonly assessment?: string;
  readonly profile?: string;
}

export interface DoctorReport extends ConfigInspection {
  readonly ok: boolean;
  readonly configPath: string;
  readonly offline: true;
  readonly assessment?: LoadedAssessment;
}

export interface DoctorCommandDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly cwd?: () => string;
  readonly processEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly setExitCode?: (code: number) => void;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.config ?? "augmentworks.yaml");
  const inspection = await inspectConfig({
    configPath,
    cwd,
    processEnv: options.processEnv ?? process.env
  });
  const diagnostics: Diagnostic[] = [...inspection.diagnostics];
  if (inspection.resolvedConfig !== undefined) {
    for (const path of placeholderPaths(inspection.resolvedConfig.config)) {
      diagnostics.push({
        level: "error",
        code: "PLACEHOLDER_UNFILLED",
        message: `${path} is still a ${PLACEHOLDER_MARKER} placeholder from target pull. Set it to the real value from your agent, then run doctor again.`,
        path
      });
    }
  }
  let assessment: LoadedAssessment | undefined;
  const defaultAssessmentPath = resolve(dirname(configPath), "augmentworks.assessment.yaml");
  const assessmentPath =
    options.assessment !== undefined
      ? options.assessment
      : (await exists(defaultAssessmentPath))
        ? defaultAssessmentPath
        : undefined;
  if (assessmentPath !== undefined) {
    try {
      assessment = await loadAssessmentFile({
        path: assessmentPath,
        cwd,
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      diagnostics.push(...assessmentDiagnostics(assessment));
      diagnostics.push(
        ...(await assessmentWireBoundDiagnostics(assessment, inspection.resolvedConfig))
      );
    } catch (error) {
      if (error instanceof AwError) {
        diagnostics.push({
          level: "error",
          code: error.code,
          message: error.message
        });
      } else {
        diagnostics.push({
          level: "error",
          code: "ASSESSMENT_FILE_INVALID",
          message: "The assessment file could not be validated."
        });
      }
    }
  } else {
    diagnostics.push({
      level: "warning",
      code: "ASSESSMENT_FILE_ABSENT",
      message:
        "No augmentworks.assessment.yaml beside the config. Hosted test --assessment needs that file; run init to generate the packaged starter."
    });
  }
  diagnostics.push({
    level: "ok",
    code: "MAPPING_PREVIEW_AVAILABLE",
    message:
      "Doctor does not inspect a response shape. Use preview-mapping --operation send --fixture <file.json> to see extracted fields and the exact evidence payload that would leave this machine."
  });
  diagnostics.push({
    level: "ok",
    code: "CONNECTION_PROBE_AVAILABLE",
    message:
      "Doctor does not call the target. Use probe to print a bounded plan, then probe --yes to check auth, selectors, session identifiers, and cleanup. Init and doctor never start a probe."
  });
  diagnostics.push({
    level: "ok",
    code: "OFFLINE_CHECK_COMPLETE",
    message: "No target hooks or cloud operations were invoked."
  });
  return {
    ok: !diagnostics.some((item) => item.level === "error"),
    configPath,
    offline: true,
    diagnostics,
    ...(inspection.resolvedConfig === undefined ? {} : { resolvedConfig: inspection.resolvedConfig }),
    ...(assessment === undefined ? {} : { assessment })
  };
}

function formatHuman(report: DoctorReport): string {
  const marker = { ok: "OK", warning: "WARN", error: "ERROR" } as const;
  const lines = report.diagnostics.map((item) => {
    const suffix = item.path === undefined ? "" : ` (${item.path})`;
    return `${marker[item.level]} ${item.code}: ${item.message}${suffix}`;
  });
  lines.push(report.ok ? "Doctor passed." : "Doctor found configuration errors.");
  return `${lines.join("\n")}\n`;
}

function formatJson(report: DoctorReport): string {
  return `${JSON.stringify(
    {
      ok: report.ok,
      config_path: report.configPath,
      offline: report.offline,
      capability_level: report.resolvedConfig?.capabilities.level ?? null,
      conversation_strategy: report.resolvedConfig?.conversation.strategy ?? null,
      multi_turn: report.resolvedConfig?.conversation.multiTurn ?? null,
      config_digest: report.resolvedConfig?.configDigest ?? null,
      assessment:
        report.assessment === undefined
          ? null
          : {
              path: report.assessment.path,
              profile: report.assessment.profile,
              evaluation_mode: report.assessment.evaluationMode,
              yaml_sha256: report.assessment.yamlSha256,
              freeze_sha256: report.assessment.freezeSha256,
              disclosure_version: report.assessment.disclosureVersion,
              references: report.assessment.localReferences.map((entry) => ({
                id: entry.id,
                path: entry.relativePath,
                sha256: entry.sha256
              }))
            },
      diagnostics: report.diagnostics
    },
    null,
    2
  )}\n`;
}

export function createDoctorCommand(dependencies: DoctorCommandDependencies = {}): Command {
  return new Command("doctor")
    .description("Validate configuration, assessment files, and local wire bounds without running target hooks")
    .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
    .option("--assessment <path>", "validate an assessment file without running tests")
    .option("--profile <profile>", "quick, full, combined, or custom")
    .option("--json", "emit stable machine-readable diagnostics")
    .option("--offline", "validate locally without checking cloud authentication", true)
    .action(
      async (commandOptions: {
        config: string;
        assessment?: string;
        profile?: string;
        json?: boolean;
        offline?: boolean;
      }) => {
        const report = await runDoctor({
          config: commandOptions.config,
          cwd: dependencies.cwd?.() ?? process.cwd(),
          processEnv: dependencies.processEnv ?? process.env,
          offline: commandOptions.offline !== false,
          ...(commandOptions.assessment === undefined ? {} : { assessment: commandOptions.assessment }),
          ...(commandOptions.profile === undefined ? {} : { profile: commandOptions.profile })
        });
        (dependencies.stdout ?? process.stdout).write(
          commandOptions.json === true ? formatJson(report) : formatHuman(report)
        );
        if (!report.ok) (dependencies.setExitCode ?? ((code) => { process.exitCode = code; }))(EXIT.CONFIG);
      }
    );
}

export const doctorFormatters = { human: formatHuman, json: formatJson } as const;
