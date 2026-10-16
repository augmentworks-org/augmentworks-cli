import { resolve } from "node:path";

import type { ResolvedConfig } from "../config/types.js";
import { HttpConnector } from "../connector/http.js";
import { AwError, EXIT, sanitizeTerminal } from "../errors.js";
import {
  preflightLocalOutputDirectory,
  writeLocalArtifacts,
  type LocalArtifactPaths
} from "../local/artifacts.js";
import { assertLocalPacketCompatible } from "../local/compatibility.js";
import { openLocalReport } from "../local/open-report.js";
import {
  loadLocalPacket,
  type LoadedLocalPacket
} from "../local/packet.js";
import {
  LocalRunner,
  type LocalConnector,
  type LocalProgressEvent,
  type LocalRunnerOptions
} from "../local/runner.js";
import { LOCAL_TRUST_LABEL, isLocalAuthorizedPacket, type LocalRunResult } from "../local/types.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import { persistExecutionScopeBinding, localBinding } from "../real-data/scope-store.js";
import { loadRevokedLocalScopeIds } from "../real-data/local-revoke.js";
import { assertLocalScopeNotRevoked, localTargetBoundary } from "../real-data/boundary.js";
import { privacyContextFromDocuments } from "../real-data/r06-service.js";

export interface LocalTestOptions {
  readonly config?: string;
  readonly packet: string;
  readonly outputDirectory?: string;
  readonly open?: boolean;
  readonly json?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly handleSignals?: boolean;
  readonly runDeadlineMs?: number;
  readonly stateDirectory?: string;
}

export interface LocalTestResult {
  readonly result: LocalRunResult;
  readonly artifacts: LocalArtifactPaths;
  readonly interrupted: boolean;
}

export interface LocalSignalHost {
  on(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
  exit(code: number): never;
}

export interface LocalTestDependencies {
  readonly doctor?: (options: Parameters<typeof runDoctor>[0]) => Promise<DoctorReport>;
  readonly packetLoader?: (options: Parameters<typeof loadLocalPacket>[0]) => Promise<LoadedLocalPacket>;
  readonly connector?: (config: ResolvedConfig) => LocalConnector;
  readonly runner?: (options: LocalRunnerOptions) => LocalRunner;
  readonly writeArtifacts?: typeof writeLocalArtifacts;
  readonly openReport?: typeof openLocalReport;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly signals?: LocalSignalHost;
  readonly onProgress?: (event: LocalProgressEvent) => void;
}

export async function runLocalTest(
  options: LocalTestOptions,
  dependencies: LocalTestDependencies = {}
): Promise<LocalTestResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const doctor = dependencies.doctor ?? runDoctor;
  const report = await doctor({
    config: options.config ?? "augmentworks.yaml",
    cwd,
    processEnv: env,
    offline: true
  });
  if (!report.ok || report.resolvedConfig === undefined) {
    const diagnostic = report.diagnostics.find(({ level }) => level === "error");
    throw new AwError({
      code: diagnostic?.code ?? "DOCTOR_FAILED",
      category: "config",
      message: diagnostic?.message ?? "Doctor found configuration errors."
    });
  }

  const loaded = await (dependencies.packetLoader ?? loadLocalPacket)({
    reference: options.packet,
    cwd
  });
  assertLocalPacketCompatible(loaded.manifest, report.resolvedConfig);
  if (isLocalAuthorizedPacket(loaded.manifest)) {
    const revoked = await loadRevokedLocalScopeIds({
      ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }),
      env
    });
    assertLocalScopeNotRevoked(loaded.manifest.execution_scope, revoked);
  }
  const dataPolicy =
    isLocalAuthorizedPacket(loaded.manifest)
      ? privacyContextFromDocuments(
          loaded.manifest.data_policy,
          loaded.manifest.redaction_profile,
          report.resolvedConfig.secrets
        )
      : undefined;
  const connector =
    dependencies.connector?.(report.resolvedConfig) ??
    new HttpConnector(report.resolvedConfig, {
      ...(dataPolicy === undefined ? {} : { dataPolicy })
    });
  const stderr = dependencies.stderr ?? process.stderr;
  const progress =
    dependencies.onProgress ??
    (options.json === true
      ? undefined
      : (event: LocalProgressEvent) => writeLocalProgress(stderr, event));
  const runnerOptions: LocalRunnerOptions = {
    connector,
    packet: loaded.manifest,
    packetSha256: loaded.binding.sha256,
    targetName: report.resolvedConfig.config.target.name,
    configSha256: report.resolvedConfig.configDigest,
    secrets: report.resolvedConfig.secrets,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.runDeadlineMs === undefined ? {} : { runDeadlineMs: options.runDeadlineMs }),
    ...(progress === undefined ? {} : { onProgress: progress }),
    ...(dataPolicy === undefined ? {} : { dataPolicy })
  };
  const runner = dependencies.runner?.(runnerOptions) ?? new LocalRunner(runnerOptions);
  if (isLocalAuthorizedPacket(loaded.manifest)) {
    await persistExecutionScopeBinding(
      localBinding({
        runId: runner.runId,
        configSha256: report.resolvedConfig.configDigest,
        scope: loaded.manifest.execution_scope,
        boundary: localTargetBoundary(loaded.manifest.execution_scope, report.resolvedConfig),
        dataPolicy: loaded.manifest.data_policy,
        redactionProfile: loaded.manifest.redaction_profile
      }),
      {
        ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }),
        env
      }
    );
    writeLine(
      stderr,
      "Local authorized scope is customer-declared. Remote revocation is not observed while offline."
    );
  }
  const outputDirectory = resolve(
    cwd,
    ...(options.outputDirectory === undefined
      ? [".augmentworks", "runs", runner.runId]
      : [options.outputDirectory])
  );
  await preflightLocalOutputDirectory(outputDirectory);

  writeLine(stderr, "LOCAL MODE — only the configured target will be contacted.");
  writeLine(stderr, LOCAL_TRUST_LABEL);
  const removeSignals =
    options.handleSignals === false
      ? () => undefined
      : installLocalInterruptHandler(runner, {
          host: dependencies.signals ?? (process as LocalSignalHost),
          stderr
        });
  let result: LocalRunResult;
  try {
    result = await runner.run();
  } finally {
    removeSignals();
  }
  const artifacts = await (dependencies.writeArtifacts ?? writeLocalArtifacts)({
    result,
    outputDirectory,
    secrets: report.resolvedConfig.secrets,
    ...(dataPolicy === undefined ? {} : { dataPolicy })
  });
  writeLine(stderr, `Local reports: ${sanitizeLocalLine(artifacts.directory)}`);
  if (options.open === true) {
    try {
      await (dependencies.openReport ?? openLocalReport)(artifacts.html);
    } catch (error) {
      if (!(error instanceof AwError) || error.code !== "LOCAL_REPORT_OPEN_FAILED") throw error;
      writeLine(stderr, "The local report could not be opened automatically; use the path below.");
    }
  }
  return { result: artifacts.safeResult, artifacts, interrupted: runner.interrupted };
}

export function localExitCode(local: LocalTestResult): number {
  if (local.result.attempts.some(({ cleanup_status }) => cleanup_status === "failed")) {
    return EXIT.CLEANUP;
  }
  if (local.interrupted) return EXIT.INTERRUPTED;
  if (local.result.outcome === "error") return EXIT.TARGET;
  if (local.result.outcome === "failed" || local.result.outcome === "inconclusive") {
    return EXIT.ASSESSMENT_FAILED;
  }
  return EXIT.OK;
}

export function formatLocalTestJson(local: LocalTestResult): string {
  return `${JSON.stringify(local.result)}\n`;
}

export function formatLocalTestHuman(local: LocalTestResult): string {
  return [
    `Local assessment ${sanitizeLocalLine(local.result.outcome)}.`,
    `JSON: ${sanitizeLocalLine(local.artifacts.json)}`,
    `JUnit: ${sanitizeLocalLine(local.artifacts.junit)}`,
    `HTML: ${sanitizeLocalLine(local.artifacts.html)}`,
    LOCAL_TRUST_LABEL
  ].join("\n") + "\n";
}

export function installLocalInterruptHandler(
  runner: Pick<LocalRunner, "requestCancellation">,
  options: { host: LocalSignalHost; stderr: Pick<NodeJS.WriteStream, "write"> }
): () => void {
  let count = 0;
  const listener = (): void => {
    count += 1;
    if (count >= 2) options.host.exit(EXIT.INTERRUPTED);
    writeLine(
      options.stderr,
      "Cancellation requested; draining cleanup. Press Ctrl+C again to exit now."
    );
    runner.requestCancellation();
  };
  options.host.on("SIGINT", listener);
  return () => options.host.off("SIGINT", listener);
}

function writeLocalProgress(
  stream: Pick<NodeJS.WriteStream, "write">,
  event: LocalProgressEvent
): void {
  if (event.type === "run_started") {
    writeLine(stream, `Starting ${event.attempts} local attempt(s).`);
  } else if (event.type === "attempt_started") {
    writeLine(
      stream,
      `Running ${sanitizeLocalLine(event.scenarioKey)} repetition ${event.repetitionIndex + 1}.`
    );
  } else if (event.type === "operation_failed") {
    writeLine(
      stream,
      `${event.kind} failed [${sanitizeLocalLine(event.code)}]${event.indeterminate ? " (outcome indeterminate)" : ""}.`
    );
  } else if (event.type === "attempt_completed") {
    writeLine(stream, `Attempt ${sanitizeLocalLine(event.attempt.status)}.`);
  }
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, message: string): void {
  stream.write(`${message}\n`);
}

function sanitizeLocalLine(value: string): string {
  return sanitizeTerminal(value)
    .replace(/[\r\n\u2028\u2029]/gu, " ")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
    .trim();
}
