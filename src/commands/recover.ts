import { resolve } from "node:path";

import { Command } from "commander";

import type { ResolvedConfig } from "../config/types.js";
import { HttpConnector } from "../connector/http.js";
import { AwError, EXIT, exitCodeFor, sanitizeTerminal, withRunId } from "../errors.js";
import {
  cancelRecovery,
  inspectRecovery,
  recoveryReportJson,
  resumeRecovery,
  retireRecovery,
  type RecoveryAction,
  type RecoveryContext,
  type RecoveryReport
} from "../relay/recovery.js";
import { RunIntentStore } from "../relay/run-intent.js";
import { RelayRunner, type RelayProgressEvent } from "../relay/runner.js";
import { getStateDirectory } from "../relay/state-dir.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import {
  authenticateHostedSession,
  type HostedAuthDependencies
} from "./hosted-auth.js";
import { addWorkspaceOption } from "../auth/workspace-expectation.js";
import { installRelayInterruptHandler, type SignalHost } from "./test.js";

export interface RecoverOptions {
  readonly config?: string;
  readonly retire?: boolean;
  readonly resume?: boolean;
  readonly cancel?: boolean;
  readonly json?: boolean;
  readonly allowFileCredentials?: boolean;
  readonly workspace?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDirectory?: string;
  readonly signal?: AbortSignal;
  readonly handleSignals?: boolean;
}

export interface RecoverDependencies extends HostedAuthDependencies {
  readonly doctor?: (options: Parameters<typeof runDoctor>[0]) => Promise<DoctorReport>;
  readonly connector?: (config: ResolvedConfig) => HttpConnector;
  readonly runner?: (options: ConstructorParameters<typeof RelayRunner>[0]) => RelayRunner;
  readonly intentStore?: (
    options: ConstructorParameters<typeof RunIntentStore>[0]
  ) => RunIntentStore;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly signals?: SignalHost;
  readonly setExitCode?: (code: number) => void;
  readonly onProgress?: (event: RelayProgressEvent) => void;
}

export async function runRecover(
  options: RecoverOptions = {},
  dependencies: RecoverDependencies = {}
): Promise<RecoveryReport> {
  const action = selectedAction(options);
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const configPath = options.config ?? "augmentworks.yaml";
  const resolvedConfig = await loadOptionalConfig(
    {
      config: configPath,
      cwd,
      env,
      required: action === "resume"
    },
    dependencies
  );
  const session = await authenticateHostedSession(options, dependencies);
  const stateDirectory = options.stateDirectory ?? getStateDirectory(env);
  const intentStore =
    dependencies.intentStore?.({
      apiOrigin: session.apiOrigin,
      tenant: session.tenant,
      stateDirectory,
      env
    }) ??
    new RunIntentStore({
      apiOrigin: session.apiOrigin,
      tenant: session.tenant,
      stateDirectory,
      env
    });
  await intentStore.open();
  try {
    await intentStore.migrateLegacyTenantBinding(async (legacyBinding) => {
      const status = await session.cloud.getRunStatus(legacyBinding.run_id, options.signal);
      return status.run_id === legacyBinding.run_id;
    });
    const noticeStream = dependencies.stderr ?? process.stderr;
    const context = {
      cloud: session.cloud,
      intentStore,
      tenant: session.tenant,
      stateDirectory,
      onNotice: (message: string) => {
        noticeStream.write(`${sanitizeTerminal(message)}\n`);
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(resolvedConfig === undefined ? {} : { resolvedConfig }),
      ...(dependencies.runner === undefined ? {} : { runner: dependencies.runner }),
      ...(dependencies.onProgress === undefined ? {} : { onProgress: dependencies.onProgress })
    };
    const boundRunId = intentStore.intent?.binding?.run_id;
    try {
      return await runRecoveryAction(action, context, options, dependencies);
    } catch (error) {
      // AUG-412: name the recorded run in the error output.
      throw boundRunId === undefined ? error : withRunId(error, boundRunId);
    }
  } finally {
    await intentStore.close();
  }
}

async function runRecoveryAction(
  action: RecoveryAction,
  context: RecoveryContext & {
    readonly resolvedConfig?: ResolvedConfig;
    readonly runner?: (options: ConstructorParameters<typeof RelayRunner>[0]) => RelayRunner;
    readonly onProgress?: (event: RelayProgressEvent) => void;
  },
  options: RecoverOptions,
  dependencies: RecoverDependencies
): Promise<RecoveryReport> {
  const resolvedConfig = context.resolvedConfig;
  if (action === "inspect") return await inspectRecovery(context);
  if (action === "retire") return await retireRecovery(context);
  const stderr = dependencies.stderr ?? process.stderr;
  const runnerFactory = context.runner;
  let removeSignals = (): void => undefined;
  const executionContext = {
    ...context,
    ...(resolvedConfig === undefined
      ? {}
      : {
          connector: dependencies.connector?.(resolvedConfig) ?? new HttpConnector(resolvedConfig)
        }),
    runner: (runnerOptions: ConstructorParameters<typeof RelayRunner>[0]) => {
      const runner = runnerFactory?.(runnerOptions) ?? new RelayRunner(runnerOptions);
      if (options.handleSignals !== false) {
        removeSignals();
        removeSignals = installRelayInterruptHandler(runner, {
          host: dependencies.signals ?? (process as SignalHost),
          stderr
        });
      }
      return runner;
    }
  };
  try {
    if (action === "resume") return (await resumeRecovery(executionContext)).report;
    return (await cancelRecovery(executionContext)).report;
  } finally {
    removeSignals();
  }
}

export function createRecoverCommand(dependencies: RecoverDependencies = {}): Command {
  return addWorkspaceOption(
    new Command("recover")
      .description("Inspect or recover a hosted assessment without creating a new run")
      .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
      .option("--retire", "retire a proven uncreated create or a terminal local execution intent")
      .option("--resume", "resume the recorded assessment after verifying the local target binding")
      .option("--cancel", "request cancellation and drain cleanup for the recorded assessment")
      .option("--json", "write a machine-readable recovery report")
      .option(
        "--allow-file-credentials",
        "allow a warned mode-0600 credential file when OS credential storage is unavailable"
      )
  ).action(
      async (values: {
        config: string;
        retire?: boolean;
        resume?: boolean;
        cancel?: boolean;
        json?: boolean;
        allowFileCredentials?: boolean;
        workspace?: string;
      }) => {
        const stdout = dependencies.stdout ?? process.stdout;
        const stderr = dependencies.stderr ?? process.stderr;
        const setExitCode =
          dependencies.setExitCode ??
          ((code: number) => {
            process.exitCode = code;
          });
        let report: RecoveryReport;
        try {
          report = await runRecover(
            {
              config: values.config,
              ...(values.retire === true ? { retire: true } : {}),
              ...(values.resume === true ? { resume: true } : {}),
              ...(values.cancel === true ? { cancel: true } : {}),
              ...(values.json === true ? { json: true } : {}),
              ...(values.allowFileCredentials === undefined
                ? {}
                : { allowFileCredentials: values.allowFileCredentials }),
              ...(values.workspace === undefined ? {} : { workspace: values.workspace })
            },
            { ...dependencies, stdout, stderr }
          );
        } catch (error) {
          if (values.json !== true || !(error instanceof AwError)) throw error;
          stdout.write(
            `${JSON.stringify({ ok: false, ...error.toSafeJSON(), exit_code: exitCodeFor(error) })}\n`
          );
          setExitCode(exitCodeFor(error));
          return;
        }
        if (values.json === true) {
          stdout.write(recoveryReportJson(report));
        } else {
          writeHuman(stdout, report);
        }
        const exitCode = exitCodeForReport(report);
        if (exitCode !== EXIT.OK) setExitCode(exitCode);
      }
    );
}

function selectedAction(options: RecoverOptions): RecoveryAction {
  const selected = [
    options.retire === true ? "retire" : undefined,
    options.resume === true ? "resume" : undefined,
    options.cancel === true ? "cancel" : undefined
  ].filter((value): value is Exclude<RecoveryAction, "inspect"> => value !== undefined);
  if (selected.length > 1) {
    throw new AwError({
      code: "RECOVERY_FLAGS_CONFLICT",
      category: "config",
      message: "Use only one of --retire, --resume, or --cancel. recover with no flags inspects only."
    });
  }
  return selected[0] ?? "inspect";
}

async function loadOptionalConfig(
  options: {
    config: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    required: boolean;
  },
  dependencies: RecoverDependencies
): Promise<ResolvedConfig | undefined> {
  const doctor = dependencies.doctor ?? runDoctor;
  try {
    const report = await doctor({
      config: options.config,
      cwd: options.cwd,
      processEnv: options.env,
      offline: true
    });
    if (report.ok && report.resolvedConfig !== undefined) return report.resolvedConfig;
    if (!options.required) return undefined;
    const error = report.diagnostics.find((diagnostic) => diagnostic.level === "error");
    throw new AwError({
      code: error?.code ?? "DOCTOR_FAILED",
      category: "config",
      message: error?.message ?? "Doctor found configuration errors."
    });
  } catch (error) {
    if (options.required) throw error;
    if (error instanceof AwError && error.category === "config") return undefined;
    throw error;
  }
}

function writeHuman(stream: Pick<NodeJS.WriteStream, "write">, report: RecoveryReport): void {
  const lines = [
    `Recovery ${report.outcome}.`,
    report.run_id === null ? undefined : `Run ${report.run_id}`,
    report.status === null ? undefined : `Status ${report.status}`,
    report.target_execution === null ? undefined : `Target execution ${report.target_execution}`,
    report.evaluation === null ? undefined : `Evaluation ${report.evaluation}`,
    report.original_error === null
      ? undefined
      : `${report.original_error.code}: ${report.original_error.message}`,
    report.next_action
  ].filter((line): line is string => line !== undefined);
  for (const line of lines) {
    stream.write(`${sanitizeTerminal(line)}\n`);
  }
}

function exitCodeForReport(report: RecoveryReport): number {
  switch (report.outcome) {
    case "idle":
    case "bound":
    case "rejected_uncreated":
    case "retired_uncreated":
    case "resumed":
    case "cancelled":
    case "terminal":
      return EXIT.OK;
    case "cleanup_outstanding":
      return EXIT.CLEANUP;
    case "active_conflict":
      return EXIT.INTERNAL;
    case "unknown":
      return EXIT.RELAY;
  }
}

