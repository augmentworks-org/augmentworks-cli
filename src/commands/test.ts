import { resolve } from "node:path";

import { Command } from "commander";

import type { AccessTokenProvider, AuthIdentity } from "../auth/types.js";
import {
  RELAY_PROTOCOL_VERSION,
  type CreateRunRequest,
  type CreateRunResponse,
  type RunStatusResponse
} from "../cloud/protocol.js";
import {
  advertisedTargetCapabilities,
  assertConversationSupportsPacket
} from "../config/conversation.js";
import type { ResolvedConfig } from "../config/types.js";
import { targetBoundarySha256 } from "../config/boundary.js";
import { HttpConnector } from "../connector/http.js";
import { AwError, EXIT, exitCodeFor, sanitizeTerminal } from "../errors.js";
import { classifyHostedOutcome } from "../outcome/classify.js";
import { gradedRunStatus, waitForGradedReport } from "../outcome/graded.js";
import {
  loadAssessmentFile,
  packetRequiresMultiTurn,
  type LoadedAssessment
} from "../assessment/index.js";
import { buildAssessmentReferencePayload } from "../assessment/bundle.js";
import {
  loadCustomerSuiteFile,
  assertSuiteUnchanged,
  type LoadedCustomerSuite
} from "../suite/load.js";
import { suiteCreateFields, suitePacketBinding, type SuiteRevisionPin } from "../suite/admit.js";
import { suiteError } from "../suite/errors.js";
import { suiteRequiresMultiTurn, suiteRequiresObservation } from "../suite/schema.js";
import {
  loadInvestigationFile,
  type LoadedInvestigation
} from "../investigation/load.js";
import { evaluateInvestigationPrerequisites } from "../investigation/prerequisites.js";
import { missingReproductionPrerequisitesError, crossWorkspaceInvestigationError } from "../investigation/errors.js";
import { resolvePinnedInvestigationSelection } from "../investigation/pin.js";
import {
  assertCeilingCoversQuote,
  confirmSpending,
  parseMaxCreditsFlag,
  resolveSpendingCeiling
} from "../billing/consent.js";
import { annotateInsufficientCredits, quoteUnsupportedError } from "../billing/errors.js";
import { estimateSuccessJson, formatEstimateHuman, formatQuoteBreakdown } from "../billing/format.js";
import type { BillingQuote } from "../billing/protocol.js";
import {
  assessmentCreateFields,
  buildBillingQuoteRequest,
  primaryAssessmentPacket,
  quotedCreateIntent
} from "../billing/quote-request.js";
import { assertQuoteCapability, assertQuoteWorkspace, firstPartyBillingPageUrl } from "../billing/validate.js";
import {
  prepareCreateAttempt,
  releaseTerminalIfSafe,
  settleCreateFailure,
  type RecoveryContext
} from "../relay/recovery.js";
import {
  RunIntentStore,
  intentRequestMatches,
  type CreateRunIntentRequest,
  type RunIntent
} from "../relay/run-intent.js";
import { RelayRunner, type RelayProgressEvent } from "../relay/runner.js";
import { getStateDirectory } from "../relay/state-dir.js";
import { assertAllowedBrowserUrl, openBrowserUrl, type BrowserOpener } from "../system/browser.js";
import { HOSTED_ASSESSMENT_OPTION_HELP, HOSTED_TEST_KEEP_TERMINAL } from "../release.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import {
  assertMachineHostedAdmission,
  authenticateHostedSession,
  isHeadlessEnvironment,
  type HostedAuthDependencies
} from "./hosted-auth.js";
import {
  addWorkspaceOption,
  formatOverriddenApiOriginLine,
  formatWorkspaceLabel,
  localWorkspaceFlagUnsupportedError
} from "../auth/workspace-expectation.js";
import {
  formatLocalTestHuman,
  formatLocalTestJson,
  localExitCode,
  runLocalTest,
  type LocalTestDependencies
} from "./local-test.js";
import { compileHostedSelection } from "./selection.js";
import { nativeSuiteContentHash, nativeSuiteSource } from "../suite/native.js";
import { assertLiveSuiteReadyForQuote, liveExecutionPolicyFromSuite } from "../suite/live-policy.js";
import { isAuthorizedCustomerSuite } from "../suite/schema.js";
import {
  dispatchPolicyFromHostedScope,
  persistHostedScopeForRun,
  requireHostedAuthorizedScope,
  resolveDispatchPolicyForBinding,
  executionScopeRefFromNativeDocument
} from "../real-data/hosted.js";
import type { ExecutionScopeResponse, SuiteExecutionScopeRef } from "../real-data/documents.js";
import type { DispatchPolicy } from "../real-data/policy.js";
import { liveDispatchPolicyFromSuite } from "../real-data/policy.js";
import { classifyRealDataFailure, hostedOutcomeFailureClass } from "../real-data/classify.js";
import { formatSelectionHuman } from "../selection/format.js";
import { compileRequestFromAssessment, isSavedSuiteSelection, selectionAdvertisementFromResolved } from "../selection/request.js";
import { loadSuiteSelectionManifest } from "../selection/load.js";
import {
  admitCompiledSelection,
  admitManifestWorkspace,
  assertShardWithinPerRunLimits,
  savedSuitePinFromManifest,
  selectShard,
  shardCreateFields
} from "../selection/admit.js";
import { hostedSelectionUnsupportedLocalError, selectionError } from "../selection/errors.js";
import {
  aggregateExecutionExitCode,
  artifactFromExecution,
  assertResumeSameShard as assertExecutionResumeSameShard,
  assertSelectionExecutionPreflight,
  executionJsonFields,
  formatSelectionResumeCommand,
  interruptExecution,
  markShardAdmitted,
  markShardBlocked,
  markShardCompleted,
  markShardFailed,
  markShardObserving,
  markShardQuoted,
  nextRunnableShard as nextExecutionShard,
  openSelectionExecution,
  parseExecutionId,
  saveSelectionExecution,
  skipRemainingPendingShards as skipExecutionPendingShards,
  type OpenedSelectionExecution,
  type SelectionExecutionKind
} from "../selection/execution.js";
import {
  assertSessionMatchesSelectionTenant,
  selectionTenantFromSession
} from "../selection/tenant.js";
import {
  artifactFromProgress,
  initialProgress,
  writeArtifact
} from "../selection/progress.js";
import type {
  SelectionArtifact,
  SelectionExecution,
  SelectionProgress,
  ShardManifest,
  SuiteSelectionManifest
} from "../selection/schema.js";
import type { CreateRunAssessment } from "../cloud/protocol.js";

export interface TestOptions {
  readonly config?: string;
  readonly packet?: string;
  readonly assessment?: string;
  readonly suite?: string;
  readonly investigation?: string;
  readonly profile?: string;
  readonly manifest?: string;
  readonly shard?: string;
  readonly allShards?: boolean;
  readonly executionId?: string;
  readonly artifactOut?: string;
  readonly open?: boolean;
  readonly json?: boolean;
  readonly estimate?: boolean;
  readonly maxCredits?: string;
  readonly yes?: boolean;
  readonly headless?: boolean;
  readonly allowFileCredentials?: boolean;
  readonly workspace?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDirectory?: string;
  readonly signal?: AbortSignal;
  readonly handleSignals?: boolean;
  readonly onSelectionCheckpoint?: (event: SelectionCheckpointEvent) => Promise<void>;
}

export type SelectionCheckpointEvent =
  | { readonly phase: "quoted"; readonly quoteId: string; readonly quotedUnits: number }
  | {
      readonly phase: "admitted";
      readonly runId: string;
      readonly quoteId?: string;
      readonly quotedUnits?: number;
    }
  | { readonly phase: "observing"; readonly runId: string }
  | { readonly phase: "server_terminal"; readonly runId: string; readonly quoteUnits?: number };

export interface TestResult {
  readonly binding: CreateRunResponse;
  readonly run: RunStatusResponse;
  readonly coverage?: SelectionArtifact;
  readonly quoteUnits?: number;
  readonly execution?: SelectionExecution;
  readonly executionKind?: SelectionExecutionKind;
  readonly aggregateExitCode?: number;
}

export interface EstimateResult {
  readonly quote: BillingQuote;
  readonly localPlanHash: string;
  readonly workspaceLabel: string;
  readonly advertisedCapabilities: CreateRunRequest["target"]["capabilities"];
  readonly apiOrigin: URL;
}

export interface SignalHost {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code: number): never;
}

export interface TestDependencies extends HostedAuthDependencies {
  readonly doctor?: (options: Parameters<typeof runDoctor>[0]) => Promise<DoctorReport>;
  readonly connector?: (config: ResolvedConfig) => HttpConnector;
  readonly runner?: (options: ConstructorParameters<typeof RelayRunner>[0]) => RelayRunner;
  readonly intentStore?: (
    options: ConstructorParameters<typeof RunIntentStore>[0]
  ) => RunIntentStore;
  readonly openBrowser?: BrowserOpener;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly signals?: SignalHost;
  readonly setExitCode?: (code: number) => void;
  readonly onProgress?: (event: RelayProgressEvent) => void;
  readonly local?: LocalTestDependencies;
  readonly isInteractive?: () => boolean;
  readonly confirm?: (prompt: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function runTest(
  options: TestOptions,
  dependencies: TestDependencies = {}
): Promise<TestResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const config = options.config ?? "augmentworks.yaml";
  const doctor = dependencies.doctor ?? runDoctor;
  const report = await doctor({ config, cwd, processEnv: env, offline: true });
  if (!report.ok || report.resolvedConfig === undefined) {
    const error = report.diagnostics.find((diagnostic) => diagnostic.level === "error");
    throw new AwError({
      code: error?.code ?? "DOCTOR_FAILED",
      category: "config",
      message: error?.message ?? "Doctor found configuration errors."
    });
  }

  const selection = await loadHostedSelection(options, cwd, report.resolvedConfig);
  if (usesCompiledSelection(options, selection)) {
    return runCompiledSelectionTest(options, dependencies, {
      cwd,
      env,
      report,
      selection
    });
  }
  return executeHostedSelection(selection, options, dependencies, { cwd, env, report });
}

async function executeHostedSelection(
  selection: HostedSelection,
  options: TestOptions,
  dependencies: TestDependencies,
  context: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly report: DoctorReport;
    readonly pinnedSession?: Awaited<ReturnType<typeof authenticateHostedSession>>;
  }
): Promise<TestResult> {
  const { cwd, env, report } = context;
  if (report.resolvedConfig === undefined) {
    throw new AwError({
      code: "DOCTOR_FAILED",
      category: "config",
      message: "Doctor found configuration errors."
    });
  }
  const maxCredits = parseMaxCreditsFlag(options.maxCredits);
  const interactive = (dependencies.isInteractive ?? (() => defaultInteractive(env, options)))();
  if (
    (selection.kind === "suite" || selection.kind === "investigation" || selection.kind === "shard") &&
    maxCredits === undefined &&
    (options.yes === true || !interactive)
  ) {
    throw new AwError({
      code: "MAX_CREDITS_REQUIRED",
      category: "config",
      message:
        options.yes === true
          ? "--yes is not an unlimited spending budget. Pass --max-credits N with a finite nonnegative integer before a hosted assessment."
          : "Noninteractive hosted tests require --max-credits N. The CLI will not start billed work without an explicit ceiling."
    });
  }
  const session =
    context.pinnedSession ?? (await authenticateHostedSession(options, dependencies));
  if (context.pinnedSession !== undefined) {
    assertSessionMatchesSelectionTenant(
      selectionTenantFromSession(context.pinnedSession),
      session
    );
  }
  assertMachineHostedAdmission(session.identity, {
    suite: selection.kind === "suite" || selection.kind === "shard"
  });
  const admittedScope = await admittedScopeForSelection({
    selection,
    session,
    resolved: report.resolvedConfig,
    cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  const target = hostedTargetBinding(report.resolvedConfig, admittedScope);
  const stderr = dependencies.stderr ?? process.stderr;
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
    const recovery: RecoveryContext = {
      cloud: session.cloud,
      intentStore,
      tenant: session.tenant,
      stateDirectory,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    };
    const resolved = await resolveHostedCreateRequest({
      selection,
      configSha256: report.resolvedConfig.configDigest,
      target,
      existing: intentStore.intent,
      maxCredits,
      yes: options.yes === true,
      session,
      stderr,
      workspaceLabel: formatWorkspaceLabel(session.identity),
      interactive,
      cwd,
      env,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(dependencies.confirm === undefined ? {} : { confirm: dependencies.confirm })
    });
    const request = resolved.request;
    const quoteId =
      resolved.quote?.quoteId ??
      ("quote_id" in request && typeof request.quote_id === "string" ? request.quote_id : undefined);
    if (resolved.quote !== undefined) {
      await emitSelectionCheckpoint(options, {
        phase: "quoted",
        quoteId: resolved.quote.quoteId,
        quotedUnits: resolved.quote.executionUnits
      });
    } else if (quoteId !== undefined) {
      await emitSelectionCheckpoint(options, {
        phase: "quoted",
        quoteId,
        quotedUnits: 0
      });
    }
    let prepared;
    let binding: CreateRunResponse;
    try {
      prepared = await prepareCreateAttempt(recovery, request);
      if (prepared.kind === "resume_bound") {
        binding = prepared.binding;
      } else {
        const loaded =
          prepared.kind === "replay_pending"
            ? { intent: prepared.intent, resumed: true }
            : await intentStore.loadOrCreate(request);
        binding = await createOrRecover(recovery, loaded.intent, options.signal);
      }
    } catch (error) {
      throw annotateHostedAdmissionError(error, {
        apiOrigin: session.apiOrigin,
        workspaceId: session.identity.workspaceId,
        ...(resolved.quote === undefined ? {} : { quote: resolved.quote })
      });
    }
    assertRunBinding(binding, intentStore.intent?.request ?? { ...request, create_request_id: binding.create_request_id });
    if (intentStore.intent?.phase !== "bound") {
      await intentStore.bind(binding);
    }
    await emitSelectionCheckpoint(options, {
      phase: "admitted",
      runId: binding.run_id,
      ...(quoteId === undefined ? {} : { quoteId }),
      ...(resolved.quote === undefined ? {} : { quotedUnits: resolved.quote.executionUnits })
    });

    const dashboard = dashboardUrl(binding.dashboard_url, session.apiOrigin);
    writeLine(
      stderr,
      `${prepared.kind === "resume_bound" || prepared.kind === "replay_pending" ? "Resuming" : "Run"} ${sanitizeTerminal(binding.run_id)}: ${sanitizeTerminal(dashboard.toString())}`
    );
    writeLine(stderr, HOSTED_TEST_KEEP_TERMINAL);
    if (options.open === true && isHeadlessEnvironment(env, options)) {
      writeLine(stderr, "Headless mode does not open a browser.");
    } else if (options.open === true) {
      try {
        await (dependencies.openBrowser ?? ((url) => openBrowserUrl(url, [session.apiOrigin.origin])))(
          dashboard
        );
      } catch (error) {
        if (!(error instanceof AwError) || error.code !== "BROWSER_OPEN_FAILED") throw error;
        writeLine(stderr, "The dashboard could not be opened automatically; use the URL above.");
      }
    }

    if (isTerminal(binding.status)) {
      const run = await settleGradedRun(
        session,
        await session.cloud.getRunStatus(binding.run_id, options.signal),
        dependencies,
        stderr,
        options.signal
      );
      await releaseTerminalIfSafe(recovery, binding, run);
      await emitSelectionCheckpoint(options, {
        phase: "server_terminal",
        runId: run.run_id,
        ...(resolved.quote === undefined ? {} : { quoteUnits: resolved.quote.executionUnits })
      });
      return {
        binding,
        run,
        ...(resolved.quote === undefined ? {} : { quoteUnits: resolved.quote.executionUnits })
      };
    }

    const connector =
      dependencies.connector?.(report.resolvedConfig) ?? new HttpConnector(report.resolvedConfig);
    const progress =
      dependencies.onProgress ??
      (options.json === true
        ? undefined
        : (event: RelayProgressEvent) => writeProgress(stderr, event));
    const livePolicy =
      selection.kind === "suite" ? liveExecutionPolicyFromSuite(selection.suite.document) : undefined;
    const dispatchPolicy = await resolveHostedDispatchPolicy({
      selection,
      cloud: session.cloud,
      workspaceId: session.identity.workspaceId,
      resolved: report.resolvedConfig,
      binding,
      stateDirectory,
      env,
      ...(resolved.quote?.quoteId === undefined ? {} : { quoteId: resolved.quote.quoteId }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    const runnerOptions: ConstructorParameters<typeof RelayRunner>[0] = {
      cloud: session.cloud,
      connector,
      binding,
      stateDirectory,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(progress === undefined ? {} : { onProgress: progress }),
      ...(livePolicy === undefined ? {} : { livePolicy }),
      ...(dispatchPolicy === undefined ? {} : { dispatchPolicy }),
      secrets: report.resolvedConfig.secrets
    };
    const runner = dependencies.runner?.(runnerOptions) ?? new RelayRunner(runnerOptions);
    await emitSelectionCheckpoint(options, { phase: "observing", runId: binding.run_id });
    const removeSignals =
      options.handleSignals === false
        ? () => undefined
        : installRelayInterruptHandler(runner, {
            host: dependencies.signals ?? (process as SignalHost),
            stderr
          });
    try {
      const finished = await runner.run();
      await releaseTerminalIfSafe(recovery, binding, finished);
      const run = await settleGradedRun(session, finished, dependencies, stderr, options.signal);
      await emitSelectionCheckpoint(options, {
        phase: "server_terminal",
        runId: run.run_id,
        ...(resolved.quote === undefined ? {} : { quoteUnits: resolved.quote.executionUnits })
      });
      return {
        binding,
        run,
        ...(resolved.quote === undefined ? {} : { quoteUnits: resolved.quote.executionUnits })
      };
    } finally {
      removeSignals();
    }
  } finally {
    await intentStore.close();
  }
}

const GRADING_WAIT_MS = 15 * 60 * 1000;

/**
 * The relay's `outcome` says the target finished, not that grading passed, so
 * a completed run takes its result from the graded run report.
 */
async function settleGradedRun(
  session: Awaited<ReturnType<typeof authenticateHostedSession>>,
  run: RunStatusResponse,
  dependencies: TestDependencies,
  stderr: Pick<NodeJS.WriteStream, "write">,
  signal: AbortSignal | undefined
): Promise<RunStatusResponse> {
  if (run.status !== "completed" || run.evaluation_status !== undefined) return run;
  const now = dependencies.now ?? Date.now;
  const report = await waitForGradedReport({
    cloud: session.cloud,
    runId: run.run_id,
    workspaceId: session.identity.workspaceId,
    deadline: now() + GRADING_WAIT_MS,
    now,
    ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
    ...(signal === undefined ? {} : { signal }),
    onWaiting: () => writeLine(stderr, "The target finished. Waiting for grading before reporting a result.")
  });
  return gradedRunStatus(run, report);
}

async function emitSelectionCheckpoint(
  options: TestOptions,
  event: SelectionCheckpointEvent
): Promise<void> {
  await options.onSelectionCheckpoint?.(event);
}

function usesCompiledSelection(options: TestOptions, selection: HostedSelection): boolean {
  if (options.manifest !== undefined || options.shard !== undefined || options.allShards === true) {
    return true;
  }
  if (selection.kind === "manifest_file") return true;
  if (selection.kind === "assessment") {
    return selection.assessment.document.selection !== undefined;
  }
  return false;
}

async function resolveCompiledManifest(
  options: TestOptions,
  context: {
    readonly cwd: string;
    readonly report: DoctorReport;
    readonly selection: HostedSelection;
    readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  }
): Promise<SuiteSelectionManifest> {
  if (options.manifest !== undefined) {
    const manifest = await loadSuiteSelectionManifest(options.manifest, context.cwd);
    const assessmentSelection =
      context.selection.kind === "assessment" ? context.selection.assessment.document.selection : undefined;
    admitCompiledSelection(manifest, {
      requestedSavedSuite: isSavedSuiteSelection(assessmentSelection),
      tenant: selectionTenantFromSession(context.session),
      ...(assessmentSelection?.suite_version === undefined ? {} : { suiteVersion: assessmentSelection.suite_version }),
      ...(assessmentSelection?.suite_revision_id === undefined
        ? {}
        : { suiteRevisionId: assessmentSelection.suite_revision_id })
    });
    return manifest;
  }
  if (context.selection.kind !== "assessment" || context.selection.assessment.document.selection === undefined) {
    throw selectionError(
      "MANIFEST_REQUIRED",
      "Pass --manifest from `selection compile` or an assessment file with a selection block."
    );
  }
  if (context.report.resolvedConfig === undefined) {
    throw new AwError({
      code: "DOCTOR_FAILED",
      category: "config",
      message: "Doctor found configuration errors."
    });
  }
  const request = compileRequestFromAssessment(
    context.selection.assessment,
    selectionAdvertisementFromResolved(context.report.resolvedConfig)
  );
  const selection = context.selection.assessment.document.selection;
  const suiteVersion = selection.suite_version;
  const compiled = await compileHostedSelection({
    request,
    session: context.session,
    ...(suiteVersion === undefined ? {} : { suiteVersion }),
    ...(selection.suite_revision_id === undefined ? {} : { suiteRevisionId: selection.suite_revision_id }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  admitManifestWorkspace(compiled, context.session.tenant);
  return compiled;
}

function shardSelectionForContext(
  shard: ShardManifest,
  selection: HostedSelection,
  manifest: SuiteSelectionManifest
): HostedSelection {
  const suitePin = savedSuitePinFromManifest(manifest);
  return selection.kind === "assessment"
    ? shardHostedSelection(shard, {
        assessment: selection.assessment,
        ...(suitePin === undefined ? {} : { suitePin })
      })
    : shardHostedSelection(shard, suitePin === undefined ? {} : { suitePin });
}

function shardHostedSelection(
  shard: ShardManifest,
  extras: {
    readonly assessment?: LoadedAssessment;
    readonly suitePin?: {
      readonly suite_id: string;
      readonly suite_revision_id: string;
      readonly suite_content_hash: string;
    };
  } = {}
): HostedSelection {
  const created = shardCreateFields(shard, {
    ...(extras.assessment === undefined
      ? {}
      : { referenceBundle: buildAssessmentReferencePayload(extras.assessment) }),
    ...(extras.suitePin === undefined ? {} : { suitePin: extras.suitePin })
  });
  return {
    kind: "shard",
    packet: created.packet,
    shardAssessment: created.assessment,
    localPlanHash: shard.planHash
  };
}

async function runCompiledSelectionEstimate(
  options: TestOptions,
  dependencies: TestDependencies,
  context: {
    readonly cwd: string;
    readonly report: DoctorReport;
    readonly selection: HostedSelection;
  }
): Promise<EstimateResult> {
  if (options.allShards === true) {
    throw selectionError(
      "ESTIMATE_ALL_SHARDS_UNSUPPORTED",
      "Estimate one shard at a time with --shard. The CLI does not sum shard quotes into a whole-suite price."
    );
  }
  if (context.report.resolvedConfig === undefined) {
    throw new AwError({
      code: "DOCTOR_FAILED",
      category: "config",
      message: "Doctor found configuration errors."
    });
  }
  const session = await authenticateHostedSession(options, dependencies);
  assertMachineHostedAdmission(session.identity, { suite: true });
  const manifest = await resolveCompiledManifest(options, { ...context, session });
  admitManifestWorkspace(manifest, session.tenant);
  const stderr = dependencies.stderr ?? process.stderr;
  writeLine(stderr, formatSelectionHuman(manifest).trimEnd());
  const shard = selectShard(manifest, options.shard);
  const hosted = shardSelectionForContext(shard, context.selection, manifest);
  const admittedScope = await admittedScopeForSelection({
    selection: hosted,
    session,
    resolved: context.report.resolvedConfig,
    cwd: context.cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  const target = hostedTargetBinding(context.report.resolvedConfig, admittedScope);
  const prepared = await prepareQuotedAssessment({
    selection: hosted,
    session,
    cwd: context.cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  const quote = await requestHostedQuote({
    session,
    assessment: prepared.assessment,
    packet: hosted.packet,
    configSha256: context.report.resolvedConfig.configDigest,
    target,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  return {
    quote,
    localPlanHash: prepared.localPlanHash,
    workspaceLabel: formatWorkspaceLabel(session.identity),
    advertisedCapabilities: target.capabilities,
    apiOrigin: session.apiOrigin
  };
}

async function runCompiledSelectionTest(
  options: TestOptions,
  dependencies: TestDependencies,
  context: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly report: DoctorReport;
    readonly selection: HostedSelection;
  }
): Promise<TestResult> {
  if (context.report.resolvedConfig === undefined) {
    throw new AwError({
      code: "DOCTOR_FAILED",
      category: "config",
      message: "Doctor found configuration errors."
    });
  }
  const stderr = dependencies.stderr ?? process.stderr;
  const stateDirectory = options.stateDirectory ?? getStateDirectory(context.env);
  const maxCredits = parseMaxCreditsFlag(options.maxCredits);

  if (options.allShards === true) {
    return await runAllShardsSelection(options, dependencies, context, {
      stderr,
      stateDirectory,
      maxCredits
    });
  }

  const session = await authenticateHostedSession(options, dependencies);
  assertMachineHostedAdmission(session.identity, { suite: true });
  const manifest = await resolveCompiledManifest(options, { ...context, session });
  admitManifestWorkspace(manifest, session.tenant);
  writeLine(stderr, formatSelectionHuman(manifest).trimEnd());

  const shard = selectShard(manifest, options.shard);
  const result = await executeHostedSelection(
    shardSelectionForContext(shard, context.selection, manifest),
    options,
    dependencies,
    { ...context, pinnedSession: session }
  );
  const progress: SelectionProgress = {
    ...initialProgress(manifest, maxCredits ?? 0),
    shards: manifest.shards.map((entry) =>
      entry.shardId === shard.shardId
        ? {
            shardId: entry.shardId,
            shardIdentityHash: entry.shardIdentityHash,
            status: "completed" as const,
            runId: result.run.run_id
          }
        : {
            shardId: entry.shardId,
            shardIdentityHash: entry.shardIdentityHash,
            status: "pending" as const
          }
    )
  };
  const coverage = await persistCoverageArtifact(options, context.cwd, stateDirectory, manifest, progress);
  return { ...result, coverage };
}

async function runAllShardsSelection(
  options: TestOptions,
  dependencies: TestDependencies,
  context: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly report: DoctorReport;
    readonly selection: HostedSelection;
  },
  extras: {
    readonly stderr: Pick<NodeJS.WriteStream, "write">;
    readonly stateDirectory: string;
    readonly maxCredits: number | undefined;
  }
): Promise<TestResult> {
  if (extras.maxCredits === undefined) {
    throw new AwError({
      code: "MAX_CREDITS_REQUIRED",
      category: "config",
      message:
        "--all-shards requires a finite aggregate --max-credits ceiling. The CLI will not start additional shards after the consented budget."
    });
  }
  if (options.executionId !== undefined) parseExecutionId(options.executionId);
  const localManifest =
    options.manifest === undefined ? undefined : await loadLocalCompiledManifest(options, context);
  if (localManifest !== undefined) {
    await assertSelectionExecutionPreflight({
      stateDirectory: extras.stateDirectory,
      manifest: localManifest,
      aggregateMaxCredits: extras.maxCredits,
      ...(options.executionId === undefined ? {} : { executionId: options.executionId }),
      ...(options.manifest === undefined ? {} : { manifestPath: options.manifest }),
      ...(options.yes === undefined ? {} : { yes: options.yes })
    });
  }
  const session = await authenticateHostedSession(options, dependencies);
  assertMachineHostedAdmission(session.identity, { suite: true });
  const manifest =
    localManifest ?? (await resolveCompiledManifest(options, { ...context, session }));
  admitManifestWorkspace(manifest, session.tenant);
  writeLine(extras.stderr, formatSelectionHuman(manifest).trimEnd());
  for (const shard of manifest.shards) {
    assertShardWithinPerRunLimits(manifest, shard);
  }
  const opened = await openSelectionExecution({
    stateDirectory: extras.stateDirectory,
    manifest,
    aggregateMaxCredits: extras.maxCredits,
    tenant: selectionTenantFromSession(session),
    ...(options.executionId === undefined ? {} : { executionId: options.executionId }),
    ...(options.manifest === undefined ? {} : { manifestPath: options.manifest }),
    ...(options.yes === undefined ? {} : { yes: options.yes })
  });
  writeExecutionLifecycle(extras.stderr, opened);
  const abort = new AbortController();
  const signal = combineOptionalSignals(options.signal, abort.signal);
  let execution = opened.execution;
  const persist = async (next: SelectionExecution): Promise<SelectionExecution> => {
    execution = await saveSelectionExecution(opened.paths, next);
    return execution;
  };
  const removeSignals = installSelectionExecutionInterruptHandler({
    host: dependencies.signals ?? (process as SignalHost),
    stderr: extras.stderr,
    abort,
    checkpoint: async () => {
      execution = await persist(interruptExecution(execution));
    },
    resumeCommand: formatSelectionResumeCommand({
      executionId: opened.execution.executionId,
      maxCredits: extras.maxCredits,
      ...(options.manifest === undefined ? {} : { manifestPath: options.manifest }),
      ...(options.yes === undefined ? {} : { yes: options.yes })
    })
  });
  try {
    const pinnedTenant = selectionTenantFromSession(session);
    let last: TestResult | undefined;
    while (true) {
      if (abort.signal.aborted) {
        execution = await persist(interruptExecution(execution));
        break;
      }
      const next = nextExecutionShard(execution);
      if (next === undefined) break;
      assertExecutionResumeSameShard(execution, next.shardId);
      if (next.state === "pending" && execution.remainingCredits <= 0) {
        execution = await persist(skipExecutionPendingShards(execution, "aggregate_budget"));
        break;
      }
      const shard = selectShard(manifest, next.shardId);
      let shardSession: Awaited<ReturnType<typeof authenticateHostedSession>>;
      try {
        shardSession = await authenticateHostedSession(options, dependencies);
        assertMachineHostedAdmission(shardSession.identity, { suite: true });
        assertSessionMatchesSelectionTenant(pinnedTenant, shardSession, {
          executionId: execution.executionId,
          recoveryAction: "resume_execution"
        });
      } catch (error) {
        if (
          error instanceof AwError &&
          (error.code === "SELECTION_TENANT_MISMATCH" || error.code === "AUTH_TENANT_CHANGED")
        ) {
          execution = await persist(interruptExecution(execution));
        }
        throw error;
      }
      if (next.runId !== null && next.state !== "pending") {
        const recovered = await recoverTerminalShardIfPossible({
          session: shardSession,
          runId: next.runId,
          shard,
          quoteUnits: next.quotedUnits,
          configSha256: context.report.resolvedConfig!.configDigest,
          signal
        });
        if (recovered !== undefined) {
          execution = await persist(
            markShardCompleted(execution, shard.shardId, {
              runId: recovered.run.run_id,
              chargedUnits: next.quotedUnits,
              ...(next.quoteId === null ? {} : { quoteId: next.quoteId })
            })
          );
          last = recovered;
          continue;
        }
      }
      const shardCeiling = String(execution.remainingCredits);
      try {
        last = await executeHostedSelection(
          shardSelectionForContext(shard, context.selection, manifest),
          {
            ...options,
            maxCredits: shardCeiling,
            allShards: false,
            shard: shard.shardId,
            handleSignals: false,
            signal,
            onSelectionCheckpoint: async (event) => {
              if (event.phase === "quoted") {
                const current = execution.shards.find((entry) => entry.shardId === shard.shardId);
                execution = await persist(
                  markShardQuoted(execution, shard.shardId, {
                    quoteId: event.quoteId,
                    quotedUnits:
                      event.quotedUnits > 0 ? event.quotedUnits : current?.quotedUnits ?? 0
                  })
                );
                return;
              }
              if (event.phase === "admitted") {
                execution = await persist(
                  markShardAdmitted(execution, shard.shardId, {
                    runId: event.runId,
                    ...(event.quoteId === undefined ? {} : { quoteId: event.quoteId }),
                    ...(event.quotedUnits === undefined ? {} : { quotedUnits: event.quotedUnits })
                  })
                );
                return;
              }
              if (event.phase === "observing") {
                execution = await persist(markShardObserving(execution, shard.shardId));
              }
            }
          },
          dependencies,
          { ...context, pinnedSession: shardSession }
        );
      } catch (error) {
        if (error instanceof AwError && error.code === "BUDGET_EXCEEDED") {
          execution = await persist(markShardBlocked(execution, shard.shardId));
          execution = await persist(skipExecutionPendingShards(execution, "aggregate_budget"));
          await persistCoverageArtifact(options, context.cwd, extras.stateDirectory, manifest, execution);
          break;
        }
        const interrupted = error instanceof AwError && (error.code === "INTERRUPTED" || abort.signal.aborted);
        execution = await persist(
          interrupted
            ? interruptExecution(execution)
            : markShardFailed(execution, shard.shardId, {
                ...(last?.run.run_id === undefined ? {} : { runId: last.run.run_id })
              })
        );
        await persistCoverageArtifact(options, context.cwd, extras.stateDirectory, manifest, execution);
        throw error;
      }
      const outcome = hostedExitCode(last.run);
      if (outcome === EXIT.OK) {
        if (last.quoteUnits === undefined && next.quotedUnits <= 0) {
          execution = await persist(interruptExecution(execution));
          break;
        }
        execution = await persist(
          markShardCompleted(execution, shard.shardId, {
            runId: last.run.run_id,
            chargedUnits: last.quoteUnits ?? next.quotedUnits,
            ...(next.quoteId === null ? {} : { quoteId: next.quoteId })
          })
        );
        continue;
      }
      if (outcome === EXIT.INTERRUPTED) {
        execution = await persist(interruptExecution(execution));
        break;
      }
      execution = await persist(
        markShardFailed(execution, shard.shardId, {
          runId: last.run.run_id,
          chargedUnits: last.quoteUnits ?? next.quotedUnits
        })
      );
      break;
    }
    execution = await persist(execution);
    const coverage = await persistCoverageArtifact(
      options,
      context.cwd,
      extras.stateDirectory,
      manifest,
      execution
    );
    const aggregateExitCode = aggregateExecutionExitCode(
      execution,
      last === undefined ? undefined : hostedExitCode(last.run)
    );
    if (last === undefined) {
      if (execution.state === "interrupted") {
        throw new AwError({
          code: "INTERRUPTED",
          category: "local",
          message:
            "The multi-shard execution was interrupted. A resumable checkpoint was written. Resume with --execution-id. The CLI will not claim completion.",
          details: {
            execution_id: execution.executionId,
            manifest_hash: execution.manifestHash,
            recovery_action: "resume_execution",
            recovery_command: formatSelectionResumeCommand({
              executionId: execution.executionId,
              maxCredits: extras.maxCredits,
              ...(options.manifest === undefined ? {} : { manifestPath: options.manifest }),
              ...(options.yes === undefined ? {} : { yes: options.yes })
            })
          }
        });
      }
      throw new AwError({
        code: "EVALUATION_INCOMPLETE",
        category: "evidence",
        message:
          "No shard completed this execution. Incomplete coverage cannot make a whole-suite release decision. Resume with --execution-id or start a new rerun after the attempt is terminal.",
        details: {
          execution_id: execution.executionId,
          manifest_hash: execution.manifestHash,
          recovery_action: "start_new_execution"
        }
      });
    }
    return {
      ...last,
      coverage,
      execution,
      executionKind: opened.kind,
      aggregateExitCode
    };
  } finally {
    removeSignals();
    await opened.lock.release().catch(() => undefined);
  }
}

async function loadLocalCompiledManifest(
  options: TestOptions,
  context: {
    readonly cwd: string;
    readonly selection: HostedSelection;
  }
): Promise<SuiteSelectionManifest> {
  const manifest = await loadSuiteSelectionManifest(options.manifest!, context.cwd);
  const assessmentSelection =
    context.selection.kind === "assessment" ? context.selection.assessment.document.selection : undefined;
  admitCompiledSelection(manifest, {
    requestedSavedSuite: isSavedSuiteSelection(assessmentSelection),
    ...(assessmentSelection?.suite_version === undefined ? {} : { suiteVersion: assessmentSelection.suite_version }),
    ...(assessmentSelection?.suite_revision_id === undefined
      ? {}
      : { suiteRevisionId: assessmentSelection.suite_revision_id })
  });
  return manifest;
}

function writeExecutionLifecycle(
  stderr: Pick<NodeJS.WriteStream, "write">,
  opened: OpenedSelectionExecution
): void {
  if (opened.kind === "resumed") {
    writeLine(
      stderr,
      `Resumed execution ${sanitizeTerminal(opened.execution.executionId)}. Interrupted stop reasons do not carry into this attempt.`
    );
    writeLine(
      stderr,
      `Resume this attempt: ${formatSelectionResumeCommand({
        executionId: opened.execution.executionId,
        maxCredits: opened.execution.aggregateMaxCredits
      })}`
    );
    return;
  }
  if (opened.kind === "rerun") {
    writeLine(
      stderr,
      `Started a new execution ${sanitizeTerminal(opened.execution.executionId)} for this immutable manifest. Prior terminal shard results were not inherited.`
    );
    return;
  }
  writeLine(
    stderr,
    `Started execution ${sanitizeTerminal(opened.execution.executionId)}. Omit --execution-id after this attempt is terminal to start a new rerun.`
  );
}

export function installSelectionExecutionInterruptHandler(options: {
  readonly host: SignalHost;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly abort: AbortController;
  readonly checkpoint: () => Promise<void>;
  readonly resumeCommand: string;
}): () => void {
  let count = 0;
  let checkpoint: Promise<void> | undefined;
  const listener = (): void => {
    count += 1;
    if (count >= 2) options.host.exit(EXIT.INTERRUPTED);
    if (checkpoint === undefined) {
      writeLine(
        options.stderr,
        `Interrupted. A resumable checkpoint will be written once. Resume with:\n  ${options.resumeCommand}\nPress Ctrl+C or send SIGTERM again to exit without claiming completion.`
      );
      checkpoint = options.checkpoint().catch(() => undefined);
    }
    if (!options.abort.signal.aborted) options.abort.abort();
  };
  options.host.on("SIGINT", listener);
  options.host.on("SIGTERM", listener);
  return () => {
    options.host.off("SIGINT", listener);
    options.host.off("SIGTERM", listener);
  };
}

function combineOptionalSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second]);
}

async function recoverTerminalShardIfPossible(options: {
  readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  readonly runId: string;
  readonly shard: ShardManifest;
  readonly quoteUnits: number;
  readonly configSha256: string;
  readonly signal?: AbortSignal;
}): Promise<TestResult | undefined> {
  let run: RunStatusResponse;
  try {
    run = await options.session.cloud.getRunStatus(options.runId, options.signal);
  } catch (error) {
    if (error instanceof AwError && error.details?.["http_status"] === 404) {
      throw selectionError(
        "SELECTION_EXECUTION_RESUME_BLOCKED",
        `Local execution recorded run ${options.runId}, but the server no longer has that run. Inspect it with run status. No new quote was requested.`
      );
    }
    throw error;
  }
  if (!isTerminal(run.status)) return undefined;
  if (run.dashboard_url === undefined) {
    throw selectionError(
      "SELECTION_EXECUTION_RESUME_BLOCKED",
      `Run ${options.runId} is terminal on the server but has no dashboard URL to recover locally. Inspect it with run status. No new quote was requested.`
    );
  }
  const packet = options.shard.packetBindings[0];
  const binding: CreateRunResponse = {
    protocol_version: run.protocol_version,
    create_request_id: "crq_local_recovered_checkpoint",
    create_request_sha256: "0".repeat(64),
    create_disposition: "replayed",
    run_id: run.run_id,
    session_id: "recovered",
    packet: {
      key: packet?.key ?? "aw-customer-suite",
      version: packet?.version ?? "1.0.0",
      sha256: packet?.sha256 ?? "0".repeat(64)
    },
    config_sha256: options.configSha256,
    fencing_epoch: 1,
    status: run.status,
    dashboard_url: run.dashboard_url,
    run_expires_at: new Date(Date.now() + 60_000).toISOString(),
    credit_state: run.credit_state
  };
  return {
    binding,
    run,
    ...(options.quoteUnits > 0 ? { quoteUnits: options.quoteUnits } : {})
  };
}

async function persistCoverageArtifact(
  options: TestOptions,
  cwd: string,
  stateDirectory: string,
  manifest: SuiteSelectionManifest,
  source: SelectionProgress | SelectionExecution
): Promise<SelectionArtifact> {
  const coverage =
    "documentKind" in source
      ? artifactFromExecution(manifest, source)
      : artifactFromProgress(manifest, source);
  if (options.artifactOut !== undefined) {
    await writeArtifact(resolve(cwd, options.artifactOut), coverage);
  } else {
    await writeArtifact(resolve(stateDirectory, "selections", `${manifest.manifestHash}.declared-shards.json`), coverage);
  }
  return coverage;
}

async function createOrRecover(
  recovery: RecoveryContext,
  intent: RunIntent,
  signal?: AbortSignal
): Promise<CreateRunResponse> {
  try {
    return await recovery.cloud.createRun(intent.request, signal);
  } catch (error) {
    return await settleCreateFailure(recovery, intent, error);
  }
}

export async function runEstimate(
  options: TestOptions,
  dependencies: TestDependencies = {}
): Promise<EstimateResult> {
  if (
    options.assessment === undefined &&
    options.suite === undefined &&
    options.investigation === undefined &&
    options.manifest === undefined
  ) {
    throw new AwError({
      code: "ESTIMATE_REQUIRES_ASSESSMENT",
      category: "config",
      message:
        "test --estimate requires --assessment, --suite, --investigation, or --manifest. Packet-only hosted tests do not use quotes."
    });
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const config = options.config ?? "augmentworks.yaml";
  const doctor = dependencies.doctor ?? runDoctor;
  const report = await doctor({ config, cwd, processEnv: env, offline: true });
  if (!report.ok || report.resolvedConfig === undefined) {
    const error = report.diagnostics.find((diagnostic) => diagnostic.level === "error");
    throw new AwError({
      code: error?.code ?? "DOCTOR_FAILED",
      category: "config",
      message: error?.message ?? "Doctor found configuration errors."
    });
  }
  const selection = await loadHostedSelection(options, cwd, report.resolvedConfig);
  if (usesCompiledSelection(options, selection)) {
    return runCompiledSelectionEstimate(options, dependencies, {
      cwd,
      report,
      selection
    });
  }
  const session = await authenticateHostedSession(options, dependencies);
  assertMachineHostedAdmission(session.identity, { suite: selection.kind === "suite" });
  const admittedScope = await admittedScopeForSelection({
    selection,
    session,
    resolved: report.resolvedConfig,
    cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  const target = hostedTargetBinding(report.resolvedConfig, admittedScope);
  const prepared = await prepareQuotedAssessment({
    selection,
    session,
    cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  const quote = await requestHostedQuote({
    session,
    assessment: prepared.assessment,
    packet: selection.packet,
    configSha256: report.resolvedConfig.configDigest,
    target,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  return {
    quote,
    localPlanHash: prepared.localPlanHash,
    workspaceLabel: formatWorkspaceLabel(session.identity),
    advertisedCapabilities: target.capabilities,
    apiOrigin: session.apiOrigin
  };
}

type HostedSelection =
  | {
      readonly kind: "packet";
      readonly packet: { key: string; version: string };
      readonly assessment?: undefined;
      readonly suite?: undefined;
      readonly investigation?: undefined;
    }
  | {
      readonly kind: "assessment";
      readonly packet: { key: string; version: string };
      readonly assessment: LoadedAssessment;
      readonly suite?: undefined;
      readonly investigation?: undefined;
    }
  | {
      readonly kind: "suite";
      readonly packet: { key: string; version: string };
      readonly assessment?: undefined;
      readonly suite: LoadedCustomerSuite;
      readonly investigation?: undefined;
    }
  | {
      readonly kind: "investigation";
      readonly packet: { key: string; version: string };
      readonly assessment?: undefined;
      readonly suite?: undefined;
      readonly investigation: LoadedInvestigation;
    }
  | {
      readonly kind: "manifest_file";
      readonly packet: { key: string; version: string };
      readonly assessment?: undefined;
      readonly suite?: undefined;
      readonly investigation?: undefined;
    }
  | {
      readonly kind: "shard";
      readonly packet: { key: string; version: string };
      readonly shardAssessment: CreateRunAssessment;
      readonly localPlanHash: string;
      readonly assessment?: undefined;
      readonly suite?: undefined;
      readonly investigation?: undefined;
    };

async function loadHostedSelection(
  options: TestOptions,
  cwd: string,
  resolved: ResolvedConfig
): Promise<HostedSelection> {
  if (options.investigation !== undefined) {
    const investigation = await loadInvestigationFile(options.investigation, cwd);
    const prerequisites = evaluateInvestigationPrerequisites(investigation.document, resolved);
    if (!prerequisites.readyForPaidExecution) {
      throw missingReproductionPrerequisitesError(prerequisites.blocking.map((finding) => finding.message));
    }
    const sessionRequired = investigation.document.prerequisites.mapping?.session === true;
    assertConversationSupportsPacket({
      resolved,
      packetRequiresMultiTurn: sessionRequired,
      packetLabel: `investigation case ${investigation.document.identities.caseId}`
    });
    return { kind: "investigation", packet: suitePacketBinding(), investigation };
  }
  if (options.suite !== undefined) {
    const suite = await loadCustomerSuiteFile(options.suite, cwd);
    assertConversationSupportsPacket({
      resolved,
      packetRequiresMultiTurn: suiteRequiresMultiTurn(suite.document),
      packetLabel: `suite ${suite.document.suiteId}`
    });
    if (suiteRequiresObservation(suite.document) && !resolved.capabilities.observation) {
      throw suiteError(
        "SUITE_OBSERVATION_INCOMPATIBLE",
        `Suite ${suite.document.suiteId} requires deterministic observations, but this connector does not advertise observation. Configure target.operations.observe. No quote, reservation, or run was created.`
      );
    }
    assertLiveSuiteReadyForQuote(suite.document, resolved);
    return { kind: "suite", packet: suitePacketBinding(suite), suite };
  }
  if (options.assessment !== undefined) {
    const assessment = await loadAssessmentFile({
      path: options.assessment,
      cwd,
      ...(options.profile === undefined ? {} : { profile: options.profile })
    });
    const packet = primaryAssessmentPacket(assessment);
    await assertHostedConversationAdmission(resolved, packet);
    return { kind: "assessment", packet, assessment };
  }
  if (options.manifest !== undefined) {
    return {
      kind: "manifest_file",
      packet: { key: "aw-customer-suite", version: "1.0.0" }
    };
  }
  const packet = parsePacketReference(requirePacket(options.packet));
  await assertHostedConversationAdmission(resolved, packet);
  return { kind: "packet", packet };
}

async function pinCustomerSuite(options: {
  readonly suite: LoadedCustomerSuite;
  readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}): Promise<{
  assessment: import("../cloud/protocol.js").CreateRunAssessment;
  localPlanHash: string;
  pin: SuiteRevisionPin;
}> {
  if (options.session.identity.principalKind === "machine") {
    throw suiteError("SUITE_WRITE_REQUIRES_USER", "Uploading --suite requires a user connector grant. Machine keys may execute an existing immutable revision using --assessment with selection.suite_revision_id, or --manifest. No suite, quote, or run was created.");
  }
  const nativeDocument = nativeSuiteSource(options.suite);
  const nativeHash = nativeSuiteContentHash(nativeDocument);
  const created = await options.session.cloud.createSuiteRevision(
    {
      contentHash: nativeHash,
      document: nativeDocument
    },
    options.signal
  );
  if (created["workspaceId"] !== undefined && created["workspaceId"] !== options.session.identity.workspaceId) {
    throw suiteError("SUITE_WORKSPACE_MISMATCH", "The saved suite belongs to a different workspace. No quote or run was created.");
  }
  if (created.contentHash !== nativeHash || created.suiteId !== options.suite.document.suiteId) {
    throw suiteError(
      "SUITE_REVISION_HASH_MISMATCH",
      "The server-accepted suite content hash does not match the locally validated file. Admission will not pin a different revision.",
      { localHash: nativeHash, serverHash: created.contentHash }
    );
  }
  const current = await loadCustomerSuiteFile(options.suite.sourcePath, options.cwd);
  assertSuiteUnchanged(options.suite, current);
  const pin: SuiteRevisionPin = {
    suiteId: created.suiteId,
    revisionId: created.revisionId,
    contentHash: created.contentHash
  };
  return {
    assessment: suiteCreateFields(options.suite, pin),
    localPlanHash: options.suite.contentHash,
    pin
  };
}

async function resolveHostedDispatchPolicy(options: {
  readonly selection: HostedSelection;
  readonly cloud: import("../cloud/client.js").CloudClient;
  readonly workspaceId: string;
  readonly resolved: ResolvedConfig;
  readonly binding: CreateRunResponse;
  readonly quoteId?: string;
  readonly stateDirectory: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}): Promise<DispatchPolicy | undefined> {
  const persistBase = {
    runId: options.binding.run_id,
    configSha256: options.binding.config_sha256,
    workspaceId: options.workspaceId,
    stateDirectory: options.stateDirectory,
    env: options.env,
    ...(options.quoteId === undefined ? {} : { quoteId: options.quoteId })
  };
  if (options.selection.kind === "suite") {
    if (isAuthorizedCustomerSuite(options.selection.suite.document)) {
      const response = await requireHostedAuthorizedScope(
        options.cloud,
        options.selection.suite.document.executionScope,
        {
          workspaceId: options.workspaceId,
          resolved: options.resolved,
          ...(options.signal === undefined ? {} : { signal: options.signal })
        }
      );
      await persistHostedScopeForRun({
        ...persistBase,
        response,
        suiteId: options.selection.suite.document.suiteId,
        contentHash: options.selection.suite.contentHash
      });
      return dispatchPolicyFromHostedScope(response);
    }
    return liveDispatchPolicyFromSuite(options.selection.suite.document);
  }

  const pin = suitePinFromHostedSelection(options.selection);
  if (pin !== undefined) {
    const revision = await options.cloud.getSuiteRevision(pin.suiteId, pin.revisionId, options.signal);
    const ref = executionScopeRefFromNativeDocument(revision.canonicalDocument);
    if (ref !== undefined) {
      const response = await requireHostedAuthorizedScope(options.cloud, ref, {
        workspaceId: options.workspaceId,
        resolved: options.resolved,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
      await persistHostedScopeForRun({
        ...persistBase,
        response,
        suiteId: pin.suiteId,
        suiteRevisionId: pin.revisionId,
        ...(pin.contentHash === undefined ? {} : { contentHash: pin.contentHash })
      });
      return dispatchPolicyFromHostedScope(response);
    }
  }

  return resolveDispatchPolicyForBinding({
    cloud: options.cloud,
    binding: options.binding,
    workspaceId: options.workspaceId,
    resolved: options.resolved,
    stateDirectory: options.stateDirectory,
    env: options.env,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
}

function suitePinFromHostedSelection(
  selection: HostedSelection
): { suiteId: string; revisionId: string; contentHash?: string } | undefined {
  if (selection.kind === "investigation") {
    const identities = selection.investigation.document.identities;
    return {
      suiteId: identities.suiteId,
      revisionId: identities.suiteRevisionId,
      contentHash: identities.suiteContentHash
    };
  }
  if (selection.kind === "shard") {
    const suiteId = selection.shardAssessment.suite_id;
    const revisionId = selection.shardAssessment.suite_revision_id;
    const contentHash = selection.shardAssessment.suite_content_hash;
    if (suiteId === undefined || revisionId === undefined) return undefined;
    return {
      suiteId,
      revisionId,
      ...(contentHash === undefined ? {} : { contentHash })
    };
  }
  return undefined;
}

async function pinInvestigationCase(options: {
  readonly investigation: LoadedInvestigation;
  readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}): Promise<{
  assessment: import("../cloud/protocol.js").CreateRunAssessment;
  localPlanHash: string;
}> {
  if (options.investigation.document.workspaceId !== options.session.identity.workspaceId) {
    throw crossWorkspaceInvestigationError();
  }
  const pinned = await resolvePinnedInvestigationSelection({
    document: options.investigation.document,
    cloud: options.session.cloud,
    cwd: options.cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  return {
    assessment: pinned.assessment,
    localPlanHash: options.investigation.document.identities.suiteContentHash
  };
}

async function prepareQuotedAssessment(options: {
  readonly selection: HostedSelection;
  readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}): Promise<{
  assessment: import("../cloud/protocol.js").CreateRunAssessment;
  localPlanHash: string;
}> {
  if (options.selection.kind === "assessment") {
    return {
      assessment: assessmentCreateFields(options.selection.assessment),
      localPlanHash: options.selection.assessment.freezeSha256
    };
  }
  if (options.selection.kind === "shard") {
    return {
      assessment: options.selection.shardAssessment,
      localPlanHash: options.selection.localPlanHash
    };
  }
  if (options.selection.kind === "investigation") {
    return pinInvestigationCase({
      investigation: options.selection.investigation,
      session: options.session,
      cwd: options.cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  }
  if (options.selection.kind !== "suite") {
    throw new AwError({
      code: "ESTIMATE_REQUIRES_ASSESSMENT",
      category: "config",
      message: "Quoted hosted tests require --assessment, --suite, or --investigation."
    });
  }
  const pinned = await pinCustomerSuite({
    suite: options.selection.suite,
    session: options.session,
    cwd: options.cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  return { assessment: pinned.assessment, localPlanHash: pinned.localPlanHash };
}

async function resolveHostedCreateRequest(options: {
  readonly selection: HostedSelection;
  readonly configSha256: string;
  readonly target: CreateRunRequest["target"];
  readonly existing: RunIntent | undefined;
  readonly maxCredits: number | undefined;
  readonly yes: boolean;
  readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  readonly signal?: AbortSignal;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly workspaceLabel: string;
  readonly interactive: boolean;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly confirm?: (prompt: string) => Promise<boolean>;
}): Promise<{ request: CreateRunIntentRequest; quote?: BillingQuote }> {
  if (options.selection.kind === "packet") {
    return {
      request: {
        protocol_version: RELAY_PROTOCOL_VERSION,
        packet: options.selection.packet,
        config_sha256: options.configSha256,
        target: options.target
      }
    };
  }

  const assessmentFields =
    options.selection.kind === "assessment"
      ? assessmentCreateFields(options.selection.assessment)
      : options.selection.kind === "shard"
        ? options.selection.shardAssessment
        : undefined;
  const existing = options.existing?.request;
  if (assessmentFields !== undefined && existing?.protocol_version === "aw-relay/0.3") {
    const replayCeiling = options.maxCredits ?? existing.max_credits;
    const candidate = quotedCreateIntent({
      packet: options.selection.packet,
      configSha256: options.configSha256,
      target: options.target,
      assessment: assessmentFields,
      quoteId: existing.quote_id,
      ...(replayCeiling === undefined ? {} : { maxCredits: replayCeiling })
    });
    if (options.existing !== undefined && intentRequestMatches(options.existing, candidate)) {
      return { request: candidate };
    }
  }
  if (options.maxCredits === undefined && (options.yes || !options.interactive)) {
    throw new AwError({
      code: "MAX_CREDITS_REQUIRED",
      category: "config",
      message: options.yes
        ? "--yes is not an unlimited spending budget. Pass --max-credits N with a finite nonnegative integer before a hosted assessment."
        : "Noninteractive hosted tests require --max-credits N. The CLI will not start billed work without an explicit ceiling."
    });
  }

  const prepared =
    options.selection.kind === "suite"
      ? await pinCustomerSuite({
          suite: options.selection.suite,
          session: options.session,
          cwd: options.cwd,
          ...(options.signal === undefined ? {} : { signal: options.signal })
        })
      : options.selection.kind === "investigation"
        ? await pinInvestigationCase({
            investigation: options.selection.investigation,
            session: options.session,
            cwd: options.cwd,
            ...(options.signal === undefined ? {} : { signal: options.signal })
          })
        : options.selection.kind === "shard"
          ? {
              assessment: options.selection.shardAssessment,
              localPlanHash: options.selection.localPlanHash
            }
          : options.selection.kind === "assessment"
            ? {
                assessment: assessmentFields!,
                localPlanHash: options.selection.assessment.freezeSha256
              }
            : (() => {
                throw new AwError({
                  code: "ESTIMATE_REQUIRES_ASSESSMENT",
                  category: "config",
                  message: "Quoted hosted tests require --assessment, --suite, --investigation, or a compiled shard."
                });
              })();

  const quote = await requestHostedQuote({
    session: options.session,
    assessment: prepared.assessment,
    packet: options.selection.packet,
    configSha256: options.configSha256,
    target: options.target,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  if (options.selection.kind === "suite") {
    const current = await loadCustomerSuiteFile(options.selection.suite.sourcePath, options.cwd);
    assertSuiteUnchanged(options.selection.suite, current);
  }
  if (options.selection.kind === "investigation") {
    const confirmedPin = await resolvePinnedInvestigationSelection({
      document: options.selection.investigation.document,
      cloud: options.session.cloud,
      cwd: options.cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    if (
      confirmedPin.pin.revisionId !== options.selection.investigation.document.identities.suiteRevisionId ||
      confirmedPin.caseId !== options.selection.investigation.document.identities.caseId ||
      confirmedPin.pin.contentHash !== options.selection.investigation.document.identities.suiteContentHash
    ) {
      throw suiteError(
        "PINNED_REVISION_UNAVAILABLE",
        "The pinned suite revision changed after the quote. Reproduction will not silently select another revision or reuse the quote."
      );
    }
    writeLine(
      options.stderr,
      `Reproducing pinned case ${sanitizeTerminal(options.selection.investigation.document.identities.caseId)} at suite revision ${sanitizeTerminal(options.selection.investigation.document.identities.suiteRevisionId)}. This is a new quoted run. The original investigation run is unchanged.`
    );
  }
  const ceiling = resolveSpendingCeiling({
    quote,
    maxCredits: options.maxCredits,
    yes: options.yes,
    interactive: options.interactive
  });
  assertCeilingCoversQuote(ceiling, quote);
  writeConsentExplanation(options.stderr, {
    quote,
    workspaceLabel: options.workspaceLabel,
    maxCredits: ceiling,
    apiOrigin: options.session.apiOrigin,
    ...(options.env === undefined ? {} : { env: options.env })
  });
  if (!options.yes) {
    if (!options.interactive) {
      throw new AwError({
        code: "MAX_CREDITS_REQUIRED",
        category: "config",
        message:
          "Noninteractive hosted tests require --max-credits N. The CLI will not start billed work without an explicit ceiling."
      });
    }
    const prompt = `Start this hosted test using at most ${String(ceiling)} credits? [y/N] `;
    const confirmed =
      options.confirm === undefined
        ? await confirmSpending({
            prompt,
            stdin: process.stdin,
            stdout: process.stderr
          })
        : await options.confirm(prompt);
    if (!confirmed) {
      throw new AwError({
        code: "SPENDING_CONSENT_DECLINED",
        category: "billing",
        message: "Hosted test cancelled before admission. No run was created and no credits were reserved."
      });
    }
  }
  return {
    request: quotedCreateIntent({
      packet: options.selection.packet,
      configSha256: options.configSha256,
      target: options.target,
      assessment: prepared.assessment,
      quoteId: quote.quoteId,
      maxCredits: ceiling
    }),
    quote
  };
}

async function requestHostedQuote(options: {
  readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  readonly assessment: import("../cloud/protocol.js").CreateRunAssessment;
  readonly packet: { key: string; version: string };
  readonly configSha256: string;
  readonly target: CreateRunRequest["target"];
  readonly signal?: AbortSignal;
}): Promise<BillingQuote> {
  let capabilities;
  try {
    capabilities =
      options.signal === undefined
        ? await options.session.cloud.getBillingCapabilities()
        : await options.session.cloud.getBillingCapabilities(options.signal);
  } catch (error) {
    if (error instanceof AwError && error.code === "USAGE_UNSUPPORTED") {
      throw quoteUnsupportedError(error.details);
    }
    throw error;
  }
  assertQuoteCapability(capabilities.capabilities);
  const quote = await options.session.cloud.createBillingQuote(
    buildBillingQuoteRequest({
      packet: options.packet,
      configSha256: options.configSha256,
      target: options.target,
      assessment: options.assessment
    }),
    options.signal
  );
  assertQuoteWorkspace(quote, options.session.identity.workspaceId);
  return quote;
}

/**
 * An authorized run is admitted against its execution scope's registered boundary, so
 * the quote and the run carry that hash. Other runs carry the hash of augmentworks.yaml.
 */
function hostedTargetBinding(
  resolved: ResolvedConfig,
  admittedScope?: ExecutionScopeResponse
): CreateRunRequest["target"] {
  return {
    name: resolved.config.target.name,
    boundary_sha256: admittedScope?.scope.targetBoundaryHash ?? targetBoundarySha256(resolved),
    capabilities: advertisedTargetCapabilities(resolved)
  };
}

/**
 * Checks an authorized selection's execution scope, and augmentworks.yaml against its
 * boundary, before anything is uploaded, quoted or created.
 */
async function admittedScopeForSelection(options: {
  readonly selection: HostedSelection;
  readonly session: Awaited<ReturnType<typeof authenticateHostedSession>>;
  readonly resolved: ResolvedConfig;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}): Promise<ExecutionScopeResponse | undefined> {
  const ref = await executionScopeRefForSelection(options.selection, options.session, options.cwd, options.signal);
  if (ref === undefined) return undefined;
  return requireHostedAuthorizedScope(options.session.cloud, ref, {
    workspaceId: options.session.identity.workspaceId,
    resolved: options.resolved,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
}

async function executionScopeRefForSelection(
  selection: HostedSelection,
  session: Awaited<ReturnType<typeof authenticateHostedSession>>,
  cwd: string,
  signal: AbortSignal | undefined
): Promise<SuiteExecutionScopeRef | undefined> {
  const cloud = session.cloud;
  if (selection.kind === "suite") {
    return isAuthorizedCustomerSuite(selection.suite.document) ? selection.suite.document.executionScope : undefined;
  }
  if (selection.kind === "investigation") {
    if (selection.investigation.document.workspaceId !== session.identity.workspaceId) {
      throw crossWorkspaceInvestigationError();
    }
    const pinned = await resolvePinnedInvestigationSelection({
      document: selection.investigation.document,
      cloud: session.cloud,
      cwd,
      ...(signal === undefined ? {} : { signal })
    });
    return isAuthorizedCustomerSuite(pinned.loaded.document) ? pinned.loaded.document.executionScope : undefined;
  }
  const pin = suitePinFromHostedSelection(selection);
  if (pin === undefined) return undefined;
  const revision = await cloud.getSuiteRevision(pin.suiteId, pin.revisionId, signal);
  return executionScopeRefFromNativeDocument(revision.canonicalDocument);
}

async function assertHostedConversationAdmission(
  resolved: ResolvedConfig,
  packet: { key: string; version: string }
): Promise<void> {
  const requiresMultiTurn = await packetRequiresMultiTurn(packet.key, packet.version);
  assertConversationSupportsPacket({
    resolved,
    packetRequiresMultiTurn: requiresMultiTurn,
    packetLabel: `${packet.key}@${packet.version}`
  });
}

function writeConsentExplanation(
  stderr: Pick<NodeJS.WriteStream, "write">,
  input: { quote: BillingQuote; workspaceLabel: string; maxCredits: number; apiOrigin?: URL; env?: NodeJS.ProcessEnv }
): void {
  const remaining =
    input.quote.availableUnitsAtQuote >= input.quote.executionUnits
      ? input.quote.availableUnitsAtQuote - input.quote.executionUnits
      : 0;
  writeLine(stderr, `Workspace: ${sanitizeTerminal(input.workspaceLabel)}`);
  if (input.apiOrigin !== undefined) {
    const originLine = formatOverriddenApiOriginLine(input.apiOrigin, input.env);
    if (originLine !== undefined) writeLine(stderr, originLine);
  }
  writeLine(stderr, `Quoted credits: ${String(input.quote.executionUnits)}`);
  const breakdown = formatQuoteBreakdown(input.quote);
  if (breakdown !== undefined) writeLine(stderr, breakdown);
  writeLine(
    stderr,
    `Available credits at quote: ${String(input.quote.availableUnitsAtQuote)} (snapshot, not a hold)`
  );
  writeLine(stderr, `Estimated remaining: ${String(remaining)} (estimate only)`);
  writeLine(stderr, `Spending ceiling for this run: ${String(input.maxCredits)}`);
  writeLine(
    stderr,
    "AugmentWorks grading is included in standard credits. Your target provider may have separate costs."
  );
  writeLine(
    stderr,
    "This quote is not a reservation. Another run may use credits before this assessment starts."
  );
}

function defaultInteractive(
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly headless?: boolean } = {}
): boolean {
  if (isHeadlessEnvironment(env, options)) return false;
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

function annotateHostedAdmissionError(
  error: unknown,
  options: {
    readonly quote?: BillingQuote;
    readonly apiOrigin: URL;
    readonly workspaceId: string;
  }
): unknown {
  if (!(error instanceof AwError) || error.code !== "INSUFFICIENT_CREDITS") return error;
  let billingPageUrl: string | undefined;
  try {
    billingPageUrl = firstPartyBillingPageUrl(options.apiOrigin, options.workspaceId).toString();
  } catch {
    billingPageUrl = undefined;
  }
  return annotateInsufficientCredits(error, {
    ...(options.quote === undefined
      ? {}
      : { requiredUnits: options.quote.executionUnits, availableUnits: options.quote.availableUnitsAtQuote }),
    ...(billingPageUrl === undefined ? {} : { billingPageUrl })
  });
}

export function createTestCommand(dependencies: TestDependencies = {}): Command {
  return addWorkspaceOption(
    new Command("test")
      .description("Run a deterministic hosted or customer-executed local assessment")
      .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
      .option(
        "--packet <reference>",
        "hosted key@version, or a bundled/local JSON packet with --local"
      )
      .option("--assessment <path>", HOSTED_ASSESSMENT_OPTION_HELP)
      .option(
        "--suite <path>",
        "customer-owned hosted suite file (aw-suite/1, aw-suite/2, or aw-suite/3). Admission uses the server-accepted revision, not a later file edit"
      )
      .option(
        "--investigation <path>",
        "reproduce the exact pinned case from an aw-investigation-export/1 file. Uses a new quote; never selects latest or reuses a consumed quote"
      )
      .option("--profile <profile>", "quick, full, combined, or custom")
      .option(
        "--manifest <path>",
        "immutable server suite-selection manifest from `selection compile` (hosted only)"
      )
      .option("--shard <shard-id>", "execute one compiled shard from --manifest or an assessment selection")
      .option(
        "--all-shards",
        "execute compiled shards in order under one finite aggregate --max-credits ceiling; stops before exceeding consent"
      )
      .option(
        "--execution-id <uuid>",
        "resume one unfinished multi-shard attempt by exact id; omit after a terminal run to start a new execution"
      )
      .option(
        "--artifact-out <path>",
        "write manifestHash and per-shard run IDs for gate --manifest-file"
      )
      .option("--estimate", "compile and quote the hosted assessment without creating a run")
      .option("--max-credits <n>", "explicit maximum customer credits for this hosted run")
      .option("--yes", "skip the interactive spending prompt; still requires --max-credits")
      .option(
        "--headless",
        "explicit noninteractive hosted mode: require AUGMENTWORKS_API_KEY or AUGMENTWORKS_TOKEN, never load a keychain, and never open a browser"
      )
      .option("--local", "run entirely in the customer environment without AugmentWorks services")
      .option("--output-dir <path>", "fresh exact report directory for --local")
      .option("--open", "open the hosted dashboard or generated local HTML report")
      .option("--json", "emit the final run status as JSON")
      .option(
        "--allow-file-credentials",
        "allow a warned mode-0600 credential file when OS credential storage is unavailable"
      )
  ).action(
      async (values: {
        config: string;
        packet?: string;
        assessment?: string;
        suite?: string;
        investigation?: string;
        profile?: string;
        manifest?: string;
        shard?: string;
        allShards?: boolean;
        executionId?: string;
        artifactOut?: string;
        estimate?: boolean;
        maxCredits?: string;
        yes?: boolean;
        headless?: boolean;
        local?: boolean;
        outputDir?: string;
        open?: boolean;
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
        assertTestSelection(values);
        if (values.local === true) {
          if (values.allowFileCredentials === true) {
            throw new AwError({
              code: "LOCAL_FILE_CREDENTIALS_UNSUPPORTED",
              category: "config",
              message:
                "--allow-file-credentials applies only to hosted AugmentWorks authentication and cannot be used with --local."
            });
          }
          const local = await runLocalTest(
            {
              config: values.config,
              packet: requirePacket(values.packet),
              cwd: process.cwd(),
              env: process.env,
              stateDirectory: getStateDirectory(process.env),
              ...(values.outputDir === undefined ? {} : { outputDirectory: values.outputDir }),
              ...(values.open === undefined ? {} : { open: values.open }),
              ...(values.json === undefined ? {} : { json: values.json })
            },
            {
              ...dependencies.local,
              stdout,
              stderr
            }
          );
          stdout.write(values.json === true ? formatLocalTestJson(local) : formatLocalTestHuman(local));
          const exitCode = localExitCode(local);
          if (exitCode !== EXIT.OK) setExitCode(exitCode);
          return;
        }
        if (values.outputDir !== undefined) {
          throw new AwError({
            code: "LOCAL_OUTPUT_REQUIRES_LOCAL_MODE",
            category: "config",
            message: "--output-dir can be used only with --local."
          });
        }
        if (values.estimate === true) {
          try {
            const estimate = await runEstimate(
              {
                config: values.config,
                ...(values.assessment === undefined ? {} : { assessment: values.assessment }),
                ...(values.suite === undefined ? {} : { suite: values.suite }),
                ...(values.investigation === undefined ? {} : { investigation: values.investigation }),
                ...(values.profile === undefined ? {} : { profile: values.profile }),
                ...(values.manifest === undefined ? {} : { manifest: values.manifest }),
                ...(values.shard === undefined ? {} : { shard: values.shard }),
                ...(values.allShards === undefined ? {} : { allShards: values.allShards }),
                ...(values.executionId === undefined ? {} : { executionId: values.executionId }),
                ...(values.allowFileCredentials === undefined
                  ? {}
                  : { allowFileCredentials: values.allowFileCredentials }),
                ...(values.headless === undefined ? {} : { headless: values.headless }),
                ...(values.workspace === undefined ? {} : { workspace: values.workspace })
              },
              dependencies
            );
            if (values.json === true) {
              const payload = JSON.parse(
                estimateSuccessJson({
                  quote: estimate.quote,
                  localPlanHash: estimate.localPlanHash
                })
              ) as Record<string, unknown>;
              payload["advertisedCapabilities"] = estimate.advertisedCapabilities;
              stdout.write(`${JSON.stringify(payload)}\n`);
            } else {
              stdout.write(
                `${formatEstimateHuman({
                  quote: estimate.quote,
                  workspaceLabel: estimate.workspaceLabel,
                  localPlanHash: estimate.localPlanHash,
                  apiOrigin: estimate.apiOrigin
                }).trimEnd()}\n${formatAdvertisedConversation(estimate.advertisedCapabilities)}\n`
              );
            }
          } catch (error) {
            if (values.json !== true) throw error;
            const awError =
              error instanceof AwError
                ? error
                : new AwError({
                    code: "INTERNAL",
                    category: "local",
                    message: "The estimate command could not be completed."
                  });
            stdout.write(
              `${JSON.stringify({
                ok: false,
                ...awError.toSafeJSON(),
                exit_code: exitCodeFor(awError)
              })}\n`
            );
            setExitCode(exitCodeFor(awError));
          }
          return;
        }
        try {
          const result = await runTest(
            {
              config: values.config,
              ...(values.packet === undefined ? {} : { packet: values.packet }),
              ...(values.assessment === undefined ? {} : { assessment: values.assessment }),
              ...(values.suite === undefined ? {} : { suite: values.suite }),
              ...(values.investigation === undefined ? {} : { investigation: values.investigation }),
              ...(values.profile === undefined ? {} : { profile: values.profile }),
              ...(values.manifest === undefined ? {} : { manifest: values.manifest }),
              ...(values.shard === undefined ? {} : { shard: values.shard }),
              ...(values.allShards === undefined ? {} : { allShards: values.allShards }),
              ...(values.executionId === undefined ? {} : { executionId: values.executionId }),
              ...(values.artifactOut === undefined ? {} : { artifactOut: values.artifactOut }),
              ...(values.open === undefined ? {} : { open: values.open }),
              ...(values.json === undefined ? {} : { json: values.json }),
              ...(values.maxCredits === undefined ? {} : { maxCredits: values.maxCredits }),
              ...(values.yes === undefined ? {} : { yes: values.yes }),
              ...(values.allowFileCredentials === undefined
                ? {}
                : { allowFileCredentials: values.allowFileCredentials }),
              ...(values.headless === undefined ? {} : { headless: values.headless }),
              ...(values.workspace === undefined ? {} : { workspace: values.workspace })
            },
            dependencies
          );
          if (values.json === true) {
            stdout.write(`${JSON.stringify(hostedJsonResult(result))}\n`);
          } else {
            writeHostedResult(stdout, result);
          }
          const exitCode = result.aggregateExitCode ?? hostedExitCode(result.run);
          if (exitCode !== EXIT.OK) setExitCode(exitCode);
        } catch (error) {
          if (values.json !== true) throw error;
          const awError =
            error instanceof AwError
              ? error
              : new AwError({
                  code: "INTERNAL",
                  category: "local",
                  message: "The hosted test command could not be completed."
                });
          if (
            awError.code === "SELECTION_RESUME_REQUIRED" ||
            awError.code === "SELECTION_PROGRESS_MIGRATION_REQUIRED" ||
            awError.code === "SELECTION_EXECUTION_CORRUPT" ||
            awError.code === "SELECTION_EXECUTION_TERMINAL" ||
            awError.code === "SELECTION_TENANT_MISMATCH" ||
            awError.code === "SELECTION_LEGACY_UNBOUND"
          ) {
            writeLine(stderr, awError.message);
          }
          const classified = classifyRealDataFailure(awError);
          stdout.write(
            `${JSON.stringify({
              ok: false,
              ...awError.toSafeJSON(),
              exit_code: classified?.exitCode ?? exitCodeFor(awError),
              ...(classified === undefined
                ? {}
                : { class: classified.class, fix: classified.fix })
            })}\n`
          );
          setExitCode(classified?.exitCode ?? exitCodeFor(awError));
        }
      }
    );
}

export function installRelayInterruptHandler(
  runner: Pick<RelayRunner, "requestCancellation">,
  options: { host: SignalHost; stderr: Pick<NodeJS.WriteStream, "write"> }
): () => void {
  let count = 0;
  const listener = () => {
    count += 1;
    if (count >= 2) options.host.exit(EXIT.INTERRUPTED);
    writeLine(
      options.stderr,
      "Cancellation requested; draining cleanup. Press Ctrl+C again to exit now."
    );
    void runner.requestCancellation("sigint").catch((error: unknown) => {
      const message =
        error instanceof AwError ? error.message : "Could not send cancellation to AugmentWorks.";
      writeLine(options.stderr, message);
    });
  };
  options.host.on("SIGINT", listener);
  return () => {
    options.host.off("SIGINT", listener);
  };
}

export function parsePacketReference(value: string): {
  key: string;
  version: string;
} {
  const match =
    /^([A-Za-z0-9][A-Za-z0-9._:/-]{0,159})@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(
      value.trim()
    );
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new AwError({
      code: "INVALID_PACKET_REFERENCE",
      category: "config",
      message: "Packet must use the form key@version, for example support-refunds@0.1.0."
    });
  }
  return { key: match[1], version: match[2] };
}

export function hostedExitCode(run: RunStatusResponse): number {
  return classifyHostedOutcome({
    executionStatus: run.status,
    evaluationStatus: run.evaluation_status,
    outcome: run.outcome ?? null
  }).exitCode;
}

function assertTestSelection(values: {
  packet?: string;
  assessment?: string;
  suite?: string;
  investigation?: string;
  profile?: string;
  manifest?: string;
  shard?: string;
  allShards?: boolean;
  executionId?: string;
  artifactOut?: string;
  local?: boolean;
  estimate?: boolean;
  maxCredits?: string;
  yes?: boolean;
  headless?: boolean;
  workspace?: string;
}): void {
  const hostedSelection =
    values.manifest !== undefined || values.shard !== undefined || values.allShards === true;
  if (hostedSelection && values.local === true) {
    throw hostedSelectionUnsupportedLocalError();
  }
  if (values.executionId !== undefined && values.allShards !== true) {
    throw selectionError(
      "EXECUTION_ID_REQUIRES_ALL_SHARDS",
      "--execution-id resumes one multi-shard attempt and can be used only with --all-shards."
    );
  }
  if (values.executionId !== undefined && values.estimate === true) {
    throw selectionError(
      "EXECUTION_ID_ESTIMATE_UNSUPPORTED",
      "--execution-id cannot be used with --estimate. Estimate one shard at a time with --shard."
    );
  }
  if (values.executionId !== undefined) parseExecutionId(values.executionId);
  if (values.shard !== undefined && values.allShards === true) {
    throw selectionError(
      "SHARD_SELECTOR_CONFLICT",
      "Use either --shard <id> or --all-shards, not both."
    );
  }
  if (values.allShards === true && values.estimate === true) {
    throw selectionError(
      "ESTIMATE_ALL_SHARDS_UNSUPPORTED",
      "Estimate one shard at a time with --shard. The CLI does not sum shard quotes into a whole-suite price."
    );
  }
  if (
    (values.shard !== undefined || values.allShards === true) &&
    values.manifest === undefined &&
    values.assessment === undefined
  ) {
    throw selectionError(
      "SHARD_REQUIRES_MANIFEST",
      "--shard and --all-shards require --manifest or an assessment file with a selection block."
    );
  }
  if (values.estimate === true && values.local === true) {
    throw new AwError({
      code: "ESTIMATE_LOCAL_UNSUPPORTED",
      category: "config",
      message: "--estimate cannot be used with --local. Local tests make no billing calls."
    });
  }
  if (values.maxCredits !== undefined && values.local === true) {
    throw new AwError({
      code: "MAX_CREDITS_LOCAL_UNSUPPORTED",
      category: "config",
      message: "--max-credits applies only to hosted tests."
    });
  }
  if (
    values.maxCredits !== undefined &&
    values.assessment === undefined &&
    values.suite === undefined &&
    values.investigation === undefined &&
    values.manifest === undefined
  ) {
    throw new AwError({
      code: "MAX_CREDITS_REQUIRES_ASSESSMENT",
      category: "config",
      message:
        "--max-credits applies to quoted hosted assessments, suites, investigation reproductions, and compiled shards. Packet-only tests do not send a spending ceiling."
    });
  }
  if (values.yes === true && values.local === true) {
    throw new AwError({
      code: "YES_LOCAL_UNSUPPORTED",
      category: "config",
      message: "--yes spending consent applies only to hosted tests."
    });
  }
  if (values.headless === true && values.local === true) {
    throw new AwError({
      code: "HEADLESS_LOCAL_UNSUPPORTED",
      category: "config",
      message:
        "--headless applies only to hosted AugmentWorks authentication. Local tests do not use a workspace API key."
    });
  }
  if (values.workspace !== undefined && values.local === true) {
    throw localWorkspaceFlagUnsupportedError();
  }
  if (
    values.estimate === true &&
    values.assessment === undefined &&
    values.suite === undefined &&
    values.investigation === undefined &&
    values.manifest === undefined
  ) {
    throw new AwError({
      code: "ESTIMATE_REQUIRES_ASSESSMENT",
      category: "config",
      message: "test --estimate requires --assessment, --suite, --investigation, or --manifest."
    });
  }
  if (values.assessment !== undefined && values.local === true) {
    throw new AwError({
      code: "ASSESSMENT_LOCAL_UNSUPPORTED",
      category: "config",
      message:
        "--assessment is a hosted compiler and cannot be used with --local. Hybrid packets are also rejected in local mode."
    });
  }
  if (values.suite !== undefined && values.local === true) {
    throw new AwError({
      code: "HOSTED_SUITE_UNSUPPORTED_LOCAL",
      category: "config",
      message:
        "--suite is a hosted customer-owned suite and cannot be used with --local. Validate offline with `augmentworks suite validate` / `suite preview`."
    });
  }
  if (values.investigation !== undefined && values.local === true) {
    throw new AwError({
      code: "HOSTED_INVESTIGATION_UNSUPPORTED_LOCAL",
      category: "config",
      message:
        "--investigation reproduces a hosted semantic case and cannot be used with --local. Inspect offline with `augmentworks investigation inspect`."
    });
  }
  if (values.assessment !== undefined && values.packet !== undefined) {
    throw new AwError({
      code: "ASSESSMENT_PACKET_CONFLICT",
      category: "config",
      message: "Use either --assessment or --packet, not both."
    });
  }
  if (
    values.manifest !== undefined &&
    (values.packet !== undefined || values.suite !== undefined || values.investigation !== undefined)
  ) {
    throw selectionError(
      "MANIFEST_SELECTION_CONFLICT",
      "Use --manifest with an optional assessment selection, not with --packet, --suite, or --investigation."
    );
  }
  if (values.suite !== undefined && (values.assessment !== undefined || values.packet !== undefined)) {
    throw new AwError({
      code: "SUITE_SELECTION_CONFLICT",
      category: "config",
      message: "Use either --suite, --assessment, or --packet, not a combination."
    });
  }
  if (
    values.investigation !== undefined &&
    (values.suite !== undefined || values.assessment !== undefined || values.packet !== undefined)
  ) {
    throw new AwError({
      code: "INVESTIGATION_SELECTION_CONFLICT",
      category: "config",
      message: "Use either --investigation, --suite, --assessment, or --packet, not a combination."
    });
  }
  if (values.profile !== undefined && values.assessment === undefined) {
    throw new AwError({
      code: "ASSESSMENT_PROFILE_REQUIRES_FILE",
      category: "config",
      message: "--profile requires --assessment."
    });
  }
  if (
    values.assessment === undefined &&
    values.packet === undefined &&
    values.suite === undefined &&
    values.investigation === undefined &&
    values.manifest === undefined
  ) {
    throw new AwError({
      code: "PACKET_OR_ASSESSMENT_REQUIRED",
      category: "config",
      message: "Provide --packet, --assessment, --suite, --investigation, or --manifest."
    });
  }
}

function requirePacket(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new AwError({
      code: "PACKET_OR_ASSESSMENT_REQUIRED",
      category: "config",
      message: "Provide --packet, --assessment, --suite, --investigation, or --manifest."
    });
  }
  return value;
}

function hostedJsonResult(result: TestResult): Record<string, unknown> {
  const failureClass = hostedOutcomeFailureClass({
    executionStatus: result.run.status,
    ...(result.run.evaluation_status === undefined
      ? {}
      : { evaluationStatus: result.run.evaluation_status }),
    outcome: result.run.outcome ?? null
  });
  return {
    run_id: result.run.run_id,
    status: result.run.status,
    credit_state: result.run.credit_state,
    outcome: result.run.outcome ?? null,
    dashboard_url: result.binding.dashboard_url,
    ...(result.run.evaluation_status === undefined
      ? {}
      : { evaluation_status: result.run.evaluation_status }),
    ...(failureClass === undefined ? {} : { class: failureClass }),
    ...(result.execution === undefined ? {} : executionJsonFields(result.execution)),
    ...(result.coverage === undefined ? {} : { coverage: result.coverage })
  };
}

function formatAdvertisedConversation(
  capabilities: CreateRunRequest["target"]["capabilities"]
): string {
  if (capabilities.multi_turn === true && capabilities.conversation?.strategy === "explicit_session_v1") {
    return "Advertised conversation: explicit_session_v1 (multi_turn=true). Estimate and execute send this same declaration.";
  }
  return "Advertised conversation: single-turn (multi_turn omitted). Estimate and execute send this same declaration.";
}

function writeHostedResult(stdout: Pick<NodeJS.WriteStream, "write">, result: TestResult): void {
  writeLine(stdout, `Run ${sanitizeTerminal(result.binding.dashboard_url)}`);
  if (result.run.evaluation_status !== undefined) {
    writeLine(stdout, `Grading: ${sanitizeTerminal(result.run.evaluation_status)}`);
  }
  if (
    result.run.evaluation_status === "pending" ||
    result.run.evaluation_status === "partial"
  ) {
    writeLine(
      stdout,
      "Your test evidence is saved. Grading is pending on the original run. Do not re-run the test command."
    );
    writeLine(
      stdout,
      `Wait: augmentworks run wait ${sanitizeTerminal(result.run.run_id)}`
    );
    writeLine(
      stdout,
      `Status: augmentworks run status ${sanitizeTerminal(result.run.run_id)}`
    );
    return;
  }
  if (result.run.evaluation_status === "error") {
    writeLine(
      stdout,
      `Required response evaluation did not complete. Inspect the original run with: augmentworks run status ${sanitizeTerminal(result.run.run_id)}`
    );
    return;
  }
  writeLine(
    stdout,
    `Assessment ${sanitizeTerminal(result.run.status)}${
      result.run.outcome == null ? "" : ` (${sanitizeTerminal(result.run.outcome)})`
    }.`
  );
  if (result.execution !== undefined) {
    const fields = executionJsonFields(result.execution);
    writeLine(
      stdout,
      `Execution ${sanitizeTerminal(result.execution.executionId)} (${sanitizeTerminal(result.execution.state)}); declared ${String(fields["completed_shard_count"])} / expected ${String(fields["expected_shard_count"])} shards; remaining ${String(fields["remaining_credits"])} of ${String(fields["aggregate_max_credits"])} credits.`
    );
    if (result.executionKind === "resumed") {
      writeLine(stdout, "This output is a resume of the same attempt, not a new rerun.");
    } else if (result.executionKind === "rerun") {
      writeLine(stdout, "This output is a new rerun. It does not inherit prior terminal shard results.");
    }
    if (fields["recovery_action"] === "resume_execution") {
      writeLine(
        stdout,
        `Resume this attempt: ${formatSelectionResumeCommand({
          executionId: result.execution.executionId,
          maxCredits: result.execution.aggregateMaxCredits
        })}`
      );
    } else if (fields["recovery_action"] === "start_new_execution") {
      writeLine(
        stdout,
        "Start a new rerun of this immutable manifest by omitting --execution-id after this attempt is terminal."
      );
    }
  }
  if (result.coverage !== undefined) {
    writeLine(
      stdout,
      `Coverage manifest ${sanitizeTerminal(result.coverage.manifestHash)}; declared ${String(result.coverage.declaredShards.length)} / expected ${String(result.coverage.expectedShardIds.length)} shards.`
    );
    if (
      result.coverage.missingShardIds.length > 0 ||
      result.coverage.skippedShardIds.length > 0 ||
      result.coverage.failedShardIds.length > 0
    ) {
      writeLine(
        stdout,
        `Incomplete coverage: missing=${result.coverage.missingShardIds.join(",") || "none"} skipped=${result.coverage.skippedShardIds.join(",") || "none"} failed=${result.coverage.failedShardIds.join(",") || "none"}. Whole-suite gate cannot pass.`
      );
    }
  }
}

function assertRunBinding(binding: CreateRunResponse, request: CreateRunRequest): void {
  if (
    binding.create_request_id !== request.create_request_id ||
    binding.packet.key !== request.packet.key ||
    binding.packet.version !== request.packet.version ||
    binding.config_sha256 !== request.config_sha256
  ) {
    throw new AwError({
      code: "RUN_BINDING_MISMATCH",
      category: "protocol",
      message: "AugmentWorks created a run with a different packet or configuration binding."
    });
  }
}

function isTerminal(status: CreateRunResponse["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function dashboardUrl(value: string, apiOrigin: URL): URL {
  const url = new URL(value);
  assertAllowedBrowserUrl(url, [apiOrigin.origin]);
  if (url.search !== "" || url.hash !== "") {
    throw new AwError({
      code: "UNSAFE_DASHBOARD_URL",
      category: "protocol",
      message: "The dashboard URL cannot contain a query string or fragment."
    });
  }
  return url;
}

function writeProgress(stream: Pick<NodeJS.WriteStream, "write">, event: RelayProgressEvent): void {
  if (event.type === "operation_started") {
    writeLine(stream, `→ ${event.kind} (${event.sequence})`);
  } else if (event.type === "operation_completed") {
    writeLine(stream, `✓ ${event.kind}${event.replayed ? " (replayed safely)" : ""}`);
  } else if (event.type === "operation_failed") {
    writeLine(stream, `✗ ${event.kind}: ${sanitizeTerminal(event.code)}`);
  }
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, value: string): void {
  stream.write(`${sanitizeTerminal(value)}\n`);
}

export type { AccessTokenProvider, AuthIdentity };
