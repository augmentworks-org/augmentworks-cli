import { AwError } from "../errors.js";
import type { AccessTokenProvider, AccessTokenRequest } from "../auth/types.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import { assertJsonLimits, LIMITS } from "../util/limits.js";
import { CLI_VERSION } from "../version.js";
import {
  CommandAckSchema,
  ConnectorSessionResponseSchema,
  CreateSessionRequestSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  PollResponseSchema,
  RELAY_PROTOCOL_VERSION,
  RetryEvaluationResponseSchema,
  RunStatusResponseSchema,
  SessionPollResponseSchema,
  parseRelayCommand,
  type CommandAck,
  type ConnectorSessionResponse,
  type CreateSessionRequest,
  type CreateRunRequest,
  type CreateRunResponse,
  type PollResponse,
  type RelayCommand,
  type RelayResult,
  type RelayProtocolVersion,
  type RetryEvaluationResponse,
  type RunStatusResponse,
  type SessionPollResponse
} from "./protocol.js";
import {
  ReconcileRunIntentRequestSchema,
  ReconcileRunIntentResponseSchema,
  readTypedCreateRejection,
  reconcileIdentityMismatch,
  recoveryUnsupportedError,
  type ReconcileRunIntentRequest,
  type ReconcileRunIntentResponse
} from "./recovery-protocol.js";
import { billingHttpError, mapBillingAdmissionError, profileRecoveryUrl } from "../billing/errors.js";
import {
  parseBillingCapabilitiesResponse,
  parseBillingQuoteResponse,
  parseBillingRunStatusResponse,
  parseBillingUsageResponse
} from "../billing/validate.js";
import { BILLING_PRIMARY_PATHS } from "../billing/protocol.js";
import type { BillingCapabilities, BillingQuote, BillingRunStatus, BillingUsage } from "../billing/protocol.js";
import { nativeSuiteContentHash, parseNativeSuiteCreateDocument } from "../suite/native.js";
import { LIVE_ERROR_CODES, liveRecoveryCopy, type LiveErrorCode } from "../suite/live-target.js";
import {
  SuiteCreateResponseSchema,
  SuiteRevisionReadSchema,
  normalizeSuiteIdentity,
  parseFeaturePackageError,
  type SuiteCreateResponse,
  type SuiteRevisionRead
} from "../suite/protocol.js";
import { mapReleasePolicyError } from "../baseline/errors.js";
import { RELEASE_POLICY_PATHS } from "../baseline/schema.js";
import {
  EvaluateComparisonRequestSchema,
  EvaluateReleaseRequestSchema,
  CreateBaselineRequestSchema,
  PromoteBaselineRequestSchema,
  type EvaluateComparisonRequest,
  type EvaluateReleaseRequest,
  type CreateBaselineRequest,
  type PromoteBaselineRequest
} from "../baseline/protocol.js";
import {
  InvestigationExportRequestSchema,
  investigationPath,
  type InvestigationExportRequest
} from "../investigation/schema.js";
import { mapInvestigationHttpError } from "../investigation/protocol.js";
import {
  CompileSuiteSelectionRequestSchema,
  EvaluateManifestGateRequestSchema,
  MANIFEST_GATE_MAX_BYTES,
  MANIFEST_GATE_RETRY_AFTER_CAP_MS,
  MANIFEST_GATE_RETRY_ATTEMPTS,
  SELECTION_PATHS,
  type CompileSuiteSelectionRequest,
  type EvaluateManifestGateRequest,
  type SuiteSelectionManifest
} from "../selection/schema.js";
import { mapSavedSuiteCompileError, parseCompiledSuiteSelectionManifest } from "../selection/parse.js";
import { selectionError } from "../selection/errors.js";
import {
  CAPABILITIES_PATH,
  EXECUTION_SCOPE_PATH_TEMPLATE
} from "../real-data/constants.js";
import { DISABLED_REAL_DATA_CAPABILITIES } from "../real-data/capabilities.js";
import {
  looksLikeExecutionScopeResponse,
  parseCapabilities,
  parseExecutionScopeResponse,
  type ExecutionScopeResponse,
  type RealDataCapabilities
} from "../real-data/documents.js";
import { isRealDataErrorCode, realDataHttpRetryable, realDataRecoveryCopy } from "../real-data/errors.js";

export interface CloudClientOptions {
  apiUrl: string | URL;
  accessToken: string;
  accessTokenProvider?: AccessTokenProvider;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

export interface PollOperationOptions {
  runId: string;
  sessionId: string;
  afterSequence: number;
  fencingEpoch: number;
  waitMs?: number;
  signal?: AbortSignal;
  protocolVersion?: RelayProtocolVersion;
}

export interface SafeRelayFailure {
  code: string;
  safe_message: string;
  retryable: boolean;
}

export type FailureDisposition = "failed" | "outcome_indeterminate";

export class CloudClient {
  readonly apiUrl: URL;
  readonly requestTimeoutMs: number;
  #accessToken: string;
  readonly #accessTokenProvider: AccessTokenProvider | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: CloudClientOptions) {
    this.apiUrl = normalizeApiUrl(options.apiUrl);
    this.#accessToken = requireAccessToken(options.accessToken);
    this.#accessTokenProvider = options.accessTokenProvider;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async createRun(request: CreateRunRequest, signal?: AbortSignal): Promise<CreateRunResponse> {
    const validated = CreateRunRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new AwError({
        code: "INVALID_RUN_REQUEST",
        category: "protocol",
        message: "The assessment request does not match the aw-relay create-run contract."
      });
    }
    const requestSha256 = sha256(canonicalize(validated.data));
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const value = await this.#request(
          "POST",
          "/v1/relay/runs",
          validated.data,
          signal,
          this.requestTimeoutMs,
          false,
          { "Idempotency-Key": validated.data.create_request_id }
        );
        const response = parseResponse(CreateRunResponseSchema, value, "create-run response");
        if (
          response.create_request_id !== validated.data.create_request_id ||
          response.create_request_sha256 !== requestSha256
        ) {
          throw new AwError({
            code: "RUN_BINDING_MISMATCH",
            category: "protocol",
            message: "AugmentWorks returned a run for a different create request."
          });
        }
        return response;
      } catch (error) {
        lastError = annotateCreateRunError(error, validated.data, requestSha256);
        if (
          !(lastError instanceof AwError) ||
          !lastError.retryable ||
          attempt === 2 ||
          signal?.aborted ||
          isTypedRejectedUncreated(lastError)
        ) {
          throw lastError;
        }
        await retryDelay(Math.min(100 * 2 ** attempt, 500), signal);
      }
    }
    throw lastError;
  }

  async reconcileRunIntent(
    request: ReconcileRunIntentRequest,
    signal?: AbortSignal
  ): Promise<ReconcileRunIntentResponse> {
    const validated = ReconcileRunIntentRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new AwError({
        code: "INVALID_RECOVERY_REQUEST",
        category: "protocol",
        message: "The run-intent reconciliation request is invalid."
      });
    }
    let value: unknown;
    try {
      value = await this.#request(
        "POST",
        "/v1/relay/run-intents:reconcile",
        validated.data,
        signal
      );
    } catch (error) {
      if (isMissingRecoveryCapability(error)) throw recoveryUnsupportedError(error);
      throw error;
    }
    const response = parseResponse(
      ReconcileRunIntentResponseSchema,
      value,
      "run-intent reconcile response"
    );
    if (reconcileIdentityMismatch(response, validated.data)) {
      throw new AwError({
        code: "RUN_BINDING_MISMATCH",
        category: "protocol",
        message: "AugmentWorks returned a reconciliation result for a different create request."
      });
    }
    if (response.outcome === "bound") {
      if (
        response.binding.create_request_id !== validated.data.create_request_id ||
        response.binding.create_request_sha256 !== validated.data.create_request_sha256
      ) {
        throw new AwError({
          code: "RUN_BINDING_MISMATCH",
          category: "protocol",
          message: "AugmentWorks returned a run binding for a different create request."
        });
      }
      if (
        validated.data.run_id !== undefined &&
        response.binding.run_id !== validated.data.run_id
      ) {
        throw new AwError({
          code: "RUN_BINDING_MISMATCH",
          category: "protocol",
          message: "AugmentWorks returned a run binding that does not match the local run ID."
        });
      }
    }
    return response;
  }

  async createConnectorSession(
    request: CreateSessionRequest,
    signal?: AbortSignal
  ): Promise<ConnectorSessionResponse> {
    const validated = CreateSessionRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new AwError({
        code: "INVALID_SESSION_REQUEST",
        category: "protocol",
        message: "The connector session request does not match aw-relay/0.1."
      });
    }
    const value = await this.#request("POST", "/v1/relay/sessions", validated.data, signal);
    return parseResponse(ConnectorSessionResponseSchema, value, "connector-session response");
  }

  async pollConnectorSession(options: {
    sessionId: string;
    fencingEpoch: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<SessionPollResponse | null> {
    const waitMs = Math.min(Math.max(options.waitMs ?? 25_000, 0), 30_000);
    const value = await this.#request(
      "POST",
      `/v1/relay/sessions/${segment(options.sessionId)}:poll`,
      {
        protocol_version: RELAY_PROTOCOL_VERSION,
        fencing_epoch: options.fencingEpoch,
        wait_seconds: Math.ceil(waitMs / 1_000)
      },
      options.signal,
      waitMs + 10_000,
      true
    );
    if (value === undefined) return null;
    return parseResponse(SessionPollResponseSchema, value, "connector-session poll response");
  }

  async closeConnectorSession(
    sessionId: string,
    fencingEpoch: number,
    signal?: AbortSignal
  ): Promise<ConnectorSessionResponse> {
    const value = await this.#request(
      "POST",
      `/v1/relay/sessions/${segment(sessionId)}:close`,
      { protocol_version: RELAY_PROTOCOL_VERSION, fencing_epoch: fencingEpoch },
      signal
    );
    return parseResponse(ConnectorSessionResponseSchema, value, "connector-session close response");
  }

  async pollOperation(options: PollOperationOptions): Promise<PollResponse | null> {
    if (!Number.isInteger(options.afterSequence) || options.afterSequence < 0) {
      throw new AwError({
        code: "INVALID_RELAY_CURSOR",
        category: "protocol",
        message: "The relay cursor is invalid."
      });
    }
    const waitMs = Math.min(Math.max(options.waitMs ?? 25_000, 0), 30_000);
    const value = await this.#request(
      "POST",
      `/v1/relay/sessions/${segment(options.sessionId)}/commands:poll`,
      {
        protocol_version: options.protocolVersion ?? RELAY_PROTOCOL_VERSION,
        run_id: options.runId,
        after_sequence: options.afterSequence,
        fencing_epoch: options.fencingEpoch,
        wait_seconds: Math.ceil(waitMs / 1_000)
      },
      options.signal,
      waitMs + 10_000,
      true
    );
    if (value === undefined) return null;
    const response = parseResponse(PollResponseSchema, value, "poll response");
    return response.command === null
      ? response
      : { ...response, command: parseRelayCommand(response.command) };
  }

  async completeOperation(
    command: RelayCommand,
    result: RelayResult,
    resultSha256 = sha256(canonicalize(result)),
    signal?: AbortSignal
  ): Promise<CommandAck> {
    const value = await this.#request(
      "POST",
      `/v1/relay/commands/${segment(command.command_id)}:complete`,
      commandBoundBody(command, { result, result_sha256: resultSha256 }),
      signal
    );
    return parseResponse(CommandAckSchema, value, "completion acknowledgement");
  }

  async failOperation(
    command: RelayCommand,
    failure: SafeRelayFailure,
    disposition: FailureDisposition,
    failureSha256 = sha256(canonicalize({ disposition, error: failure })),
    signal?: AbortSignal
  ): Promise<CommandAck> {
    const value = await this.#request(
      "POST",
      `/v1/relay/commands/${segment(command.command_id)}:fail`,
      commandBoundBody(command, {
        disposition,
        error: failure,
        result_sha256: failureSha256
      }),
      signal
    );
    return parseResponse(CommandAckSchema, value, "failure acknowledgement");
  }

  async cancelRun(
    runId: string,
    reason = "user_requested",
    signal?: AbortSignal,
    protocolVersion: RelayProtocolVersion = RELAY_PROTOCOL_VERSION
  ): Promise<RunStatusResponse> {
    const value = await this.#request(
      "POST",
      `/v1/relay/runs/${segment(runId)}:cancel`,
      { protocol_version: protocolVersion, reason: reason.slice(0, 120) },
      signal
    );
    return parseResponse(RunStatusResponseSchema, value, "cancellation response");
  }

  async getRunStatus(runId: string, signal?: AbortSignal): Promise<RunStatusResponse> {
    const value = await this.#request(
      "GET",
      `/v1/relay/runs/${segment(runId)}`,
      undefined,
      signal
    );
    return parseResponse(RunStatusResponseSchema, value, "run status response");
  }

  async getBillingUsage(signal?: AbortSignal): Promise<BillingUsage> {
    const value = await this.#requestBilling("GET", BILLING_PRIMARY_PATHS.usage, undefined, signal);
    return parseBillingUsageResponse(value);
  }

  async createSuiteRevision(
    request: {
      readonly contentHash: string;
      readonly document: unknown;
    },
    signal?: AbortSignal
  ): Promise<SuiteCreateResponse> {
    let validated: Record<string, unknown>;
    try {
      validated = parseNativeSuiteCreateDocument(request.document);
    } catch (error) {
      if (error instanceof AwError) throw error;
      throw new AwError({
        code: "INVALID_SUITE_REQUEST",
        category: "protocol",
        message: "The customer suite create request does not match the hosted aw-customer-suite/1 or aw-customer-suite/2 source contract."
      });
    }
    if (nativeSuiteContentHash(validated) !== request.contentHash) {
      throw new AwError({
        code: "INVALID_SUITE_REQUEST",
        category: "protocol",
        message: "The customer suite create request does not match the hosted aw-customer-suite/1 or aw-customer-suite/2 source contract."
      });
    }
    const value = await this.#request("POST", "/v1/suites", validated, signal);
    return parseResponse(
      SuiteCreateResponseSchema,
      normalizeSuiteIdentity(value),
      "suite create response"
    );
  }

  async getSuiteRevision(
    suiteId: string,
    revisionId: string,
    signal?: AbortSignal
  ): Promise<SuiteRevisionRead> {
    const value = await this.#request(
      "GET",
      `/v1/suites/${segment(suiteId)}/revisions/${segment(revisionId)}`,
      undefined,
      signal
    );
    return parseResponse(
      SuiteRevisionReadSchema,
      normalizeSuiteIdentity(value),
      "suite revision response"
    );
  }

  async exportInvestigation(
    request: InvestigationExportRequest,
    signal?: AbortSignal
  ): Promise<unknown> {
    const validated = InvestigationExportRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new AwError({
        code: "INVALID_INVESTIGATION_REQUEST",
        category: "config",
        message: "The investigation request does not match aw-investigation-export/1."
      });
    }
    try {
      return await this.#request(
        "POST",
        investigationPath(validated.data),
        validated.data,
        signal
      );
    } catch (error) {
      throw mapInvestigationHttpError(error);
    }
  }

  async getInvestigation(
    request: Omit<InvestigationExportRequest, "schemaVersion" | "packageVersion">,
    signal?: AbortSignal
  ): Promise<unknown> {
    try {
      return await this.#request("GET", investigationPath(request), undefined, signal);
    } catch (error) {
      throw mapInvestigationHttpError(error);
    }
  }

  async listApplications(signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.#request("GET", RELEASE_POLICY_PATHS.applications, undefined, signal);
    } catch (error) {
      throw mapReleasePolicyError(error);
    }
  }

  async evaluateComparison(
    request: EvaluateComparisonRequest,
    signal?: AbortSignal
  ): Promise<unknown> {
    const validated = EvaluateComparisonRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new AwError({
        code: "INVALID_COMPARISON_REQUEST",
        category: "config",
        message: "The comparison request does not match aw-comparison/1."
      });
    }
    try {
      return await this.#request(
        "POST",
        RELEASE_POLICY_PATHS.comparisonEvaluate,
        validated.data,
        signal
      );
    } catch (error) {
      throw mapReleasePolicyError(error);
    }
  }

  async evaluateReleaseGate(
    request: EvaluateReleaseRequest,
    signal?: AbortSignal
  ): Promise<unknown> {
    const validated = EvaluateReleaseRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new AwError({
        code: "INVALID_COMPARISON_REQUEST",
        category: "config",
        message: "The release-gate request does not match aw-release-policy/1."
      });
    }
    try {
      return await this.#request(
        "POST",
        RELEASE_POLICY_PATHS.releaseGateEvaluate,
        validated.data,
        signal
      );
    } catch (error) {
      throw mapReleasePolicyError(error);
    }
  }

  async compileSuiteSelection(
    request: CompileSuiteSelectionRequest,
    signal?: AbortSignal
  ): Promise<SuiteSelectionManifest> {
    const validated = CompileSuiteSelectionRequestSchema.safeParse(request);
    if (!validated.success) {
      throw selectionError(
        "INVALID_SELECTION_REQUEST",
        "The suite-selection compile request does not match aw-suite-selection/1."
      );
    }
    try {
      const value = await this.#request("POST", SELECTION_PATHS.compile, validated.data, signal);
      return parseCompiledSuiteSelectionManifest(value, validated.data);
    } catch (error) {
      throw mapSavedSuiteCompileError(error, validated.data);
    }
  }

  async evaluateManifestReleasePolicy(
    request: EvaluateManifestGateRequest,
    signal?: AbortSignal
  ): Promise<unknown> {
    const validated = EvaluateManifestGateRequestSchema.safeParse(request);
    if (!validated.success) {
      throw selectionError(
        "INVALID_MANIFEST_GATE_REQUEST",
        "The manifest release-gate request does not match aw-manifest-release-gate-request/2."
      );
    }
    if (Buffer.byteLength(canonicalize(validated.data), "utf8") > MANIFEST_GATE_MAX_BYTES) {
      throw selectionError(
        "MANIFEST_GATE_CONTRACT_UNSUPPORTED",
        "The identity-only release-gate request exceeds 64 KiB.",
        { category: "protocol" }
      );
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < MANIFEST_GATE_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.#request(
          "POST",
          SELECTION_PATHS.evaluateManifest,
          validated.data,
          signal
        );
      } catch (error) {
        lastError = error;
        const status = error instanceof AwError ? error.details?.["http_status"] : undefined;
        const retryableHttp =
          error instanceof AwError &&
          error.retryable === true &&
          typeof status === "number" &&
          (status === 408 || status === 429 || status >= 500);
        if (!retryableHttp || attempt === MANIFEST_GATE_RETRY_ATTEMPTS - 1 || signal?.aborted === true) {
          throw error;
        }
        const advertised = error.details?.["retry_after_ms"];
        const wait =
          typeof advertised === "number" && Number.isFinite(advertised)
            ? Math.min(Math.max(0, advertised), MANIFEST_GATE_RETRY_AFTER_CAP_MS)
            : Math.min(100 * 2 ** attempt, 500);
        await retryDelay(wait, signal);
      }
    }
    throw lastError;
  }

  async createBaseline(request: CreateBaselineRequest, signal?: AbortSignal): Promise<unknown> {
    const validated = CreateBaselineRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new AwError({
        code: "INVALID_COMPARISON_REQUEST",
        category: "config",
        message: "The baseline create request does not match aw-release-policy/1."
      });
    }
    try {
      return await this.#request("POST", RELEASE_POLICY_PATHS.baselines, validated.data, signal);
    } catch (error) {
      throw mapReleasePolicyError(error);
    }
  }

  async promoteBaseline(
    baselineId: string,
    request: PromoteBaselineRequest,
    signal?: AbortSignal
  ): Promise<unknown> {
    const validated = PromoteBaselineRequestSchema.safeParse(request);
    if (!validated.success) {
      throw new AwError({
        code: "INVALID_COMPARISON_REQUEST",
        category: "config",
        message: "The baseline promotion request does not match aw-release-policy/1."
      });
    }
    try {
      return await this.#request(
        "POST",
        RELEASE_POLICY_PATHS.baselinePromote.replace("{baselineId}", segment(baselineId)),
        validated.data,
        signal
      );
    } catch (error) {
      throw mapReleasePolicyError(error);
    }
  }

  async createBillingQuote(
    request: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<BillingQuote> {
    const value = await this.#requestBilling(
      "POST",
      BILLING_PRIMARY_PATHS.quote,
      request,
      signal
    );
    return parseBillingQuoteResponse(value);
  }

  async getBillingRunStatus(runId: string, signal?: AbortSignal): Promise<BillingRunStatus> {
    const value = await this.#requestBilling(
      "GET",
      `${BILLING_PRIMARY_PATHS.status}?runId=${encodeURIComponent(runId)}`,
      undefined,
      signal
    );
    return parseBillingRunStatusResponse(value);
  }

  async retryEvaluation(runId: string, signal?: AbortSignal): Promise<RetryEvaluationResponse> {
    const value = await this.#request(
      "POST",
      `/v1/relay/runs/${segment(runId)}:retry-evaluation`,
      undefined,
      signal
    );
    return parseResponse(RetryEvaluationResponseSchema, value, "retry-evaluation response");
  }

  async getBillingCapabilities(signal?: AbortSignal): Promise<BillingCapabilities> {
    const value = await this.#requestBilling(
      "GET",
      BILLING_PRIMARY_PATHS.capabilities,
      undefined,
      signal
    );
    return parseBillingCapabilitiesResponse(value);
  }

  async getRealDataCapabilities(signal?: AbortSignal): Promise<RealDataCapabilities> {
    let value: unknown;
    try {
      value = await this.#request("GET", CAPABILITIES_PATH, undefined, signal);
    } catch (error) {
      if (
        error instanceof AwError &&
        (error.details?.["http_status"] === 404 || error.code === "CLOUD_REQUEST_FAILED")
      ) {
        return DISABLED_REAL_DATA_CAPABILITIES;
      }
      throw error;
    }
    // A capabilities document that doesn't parse is an error, never "disabled".
    return parseCapabilities(value);
  }

  async getExecutionScope(scopeId: string, signal?: AbortSignal): Promise<ExecutionScopeResponse> {
    const value = await this.#request(
      "GET",
      EXECUTION_SCOPE_PATH_TEMPLATE.replace("{scopeId}", segment(scopeId)),
      undefined,
      signal
    );
    return parseExecutionScopeResponse(value);
  }

  async getRunExecutionScope(
    runId: string,
    signal?: AbortSignal
  ): Promise<ExecutionScopeResponse | undefined> {
    try {
      const value = await this.#request(
        "GET",
        `/v1/relay/runs/${segment(runId)}/execution-scope`,
        undefined,
        signal
      );
      if (!looksLikeExecutionScopeResponse(value)) return undefined;
      return parseExecutionScopeResponse(value);
    } catch (error) {
      if (error instanceof AwError && error.details?.["http_status"] === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async #requestBilling(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const value = await this.#request(
          method,
          path,
          body,
          signal,
          this.requestTimeoutMs,
          false,
          {},
          true,
          "billing"
        );
        if (value === undefined) {
          throw new AwError({
            code: "INVALID_CLOUD_RESPONSE",
            category: "protocol",
            message: "AugmentWorks returned an empty billing response."
          });
        }
        return value;
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof AwError) ||
          !error.retryable ||
          attempt === 1 ||
          signal?.aborted === true
        ) {
          throw error;
        }
        await retryDelay(Math.min(100 * 2 ** attempt, 500), signal);
      }
    }
    throw lastError;
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    externalSignal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
    allowNoContent = false,
    additionalHeaders: Readonly<Record<string, string>> = {},
    allowAuthRefresh = true,
    errorFamily: "relay" | "billing" = "relay"
  ): Promise<unknown | undefined> {
    throwIfAborted(externalSignal);
    const accessToken = await this.#currentAccessToken(
      externalSignal === undefined ? {} : { signal: externalSignal }
    );
    const url = apiEndpoint(this.apiUrl, path);
    const controller = new AbortController();
    const onAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    if (externalSignal !== undefined && isAbortRequested(externalSignal)) {
      externalSignal.removeEventListener("abort", onAbort);
      throw requestCancelledError();
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("request timeout"));
    }, timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "X-AugmentWorks-CLI-Version": CLI_VERSION,
          ...additionalHeaders,
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(body === undefined ? {} : { body: canonicalize(body) })
      });
    } catch (error) {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
      if (externalSignal?.aborted) {
        throw new AwError({
          code: "RELAY_REQUEST_CANCELLED",
          category: "relay",
          message: "The AugmentWorks request was cancelled.",
          retryable: true,
          cause: error
        });
      }
      throw new AwError({
        code: "RELAY_UNREACHABLE",
        category: "relay",
        message: "Could not reach the AugmentWorks relay.",
        retryable: true,
        cause: error
      });
    }

    if (allowNoContent && response.status === 204) {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
      return undefined;
    }
    let text: string;
    try {
      text = await readBoundedText(response, LIMITS.envelopeBytes);
    } catch (error) {
      if (externalSignal?.aborted) {
        throw new AwError({
          code: "RELAY_REQUEST_CANCELLED",
          category: "relay",
          message: "The AugmentWorks request was cancelled.",
          retryable: true,
          cause: error
        });
      }
      if (timedOut) {
        throw new AwError({
          code: "RELAY_UNREACHABLE",
          category: "relay",
          message: "The AugmentWorks relay response timed out.",
          retryable: true,
          cause: error
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
    let value: unknown;
    let nonJsonErrorBody = false;
    try {
      value = text.length === 0 ? undefined : JSON.parse(text);
    } catch (error) {
      if (response.ok || errorFamily === "billing") {
        throw new AwError({
          code: "INVALID_CLOUD_RESPONSE",
          category: "protocol",
          message: "AugmentWorks returned an invalid JSON response.",
          cause: error
        });
      }
      value = undefined;
      nonJsonErrorBody = true;
    }
    if (value !== undefined) assertJsonLimits(value, "AugmentWorks response");
    if (response.status === 401 && allowAuthRefresh && this.#accessTokenProvider !== undefined) {
      const replacement = requireAccessToken(
        await this.#accessTokenProvider({
          forceRefresh: true,
          rejectedAccessToken: accessToken,
          ...(externalSignal === undefined ? {} : { signal: externalSignal })
        })
      );
      this.#accessToken = replacement;
      if (replacement !== accessToken) {
        return await this.#request(
          method,
          path,
          body,
          externalSignal,
          timeoutMs,
          allowNoContent,
          additionalHeaders,
          false,
          errorFamily
        );
      }
    }
    if (!response.ok) {
      if (errorFamily === "billing") {
        throw billingHttpError(
          response.status,
          value,
          method,
          path,
          profileRecoveryUrl(this.apiUrl)
        );
      }
      const httpError = cloudHttpError(
        response.status,
        value,
        method,
        path,
        profileRecoveryUrl(this.apiUrl),
        response.headers.get("retry-after")
      );
      if (!nonJsonErrorBody) throw httpError;
      throw nameNonJsonRoute(httpError, method, path);
    }
    if (value === undefined) {
      throw new AwError({
        code: "INVALID_CLOUD_RESPONSE",
        category: "protocol",
        message: "AugmentWorks returned an empty response."
      });
    }
    return value;
  }

  async #currentAccessToken(request: AccessTokenRequest): Promise<string> {
    if (this.#accessTokenProvider === undefined) return this.#accessToken;
    const current = requireAccessToken(await this.#accessTokenProvider(request));
    this.#accessToken = current;
    return current;
  }
}

function requireAccessToken(value: string): string {
  if (value.trim() === "" || /[\r\n\0]/u.test(value)) {
    throw new AwError({
      code: "AUTH_REQUIRED",
      category: "auth",
      message: "Log in to AugmentWorks before starting an assessment."
    });
  }
  return value;
}

function isAbortRequested(signal?: AbortSignal): boolean {
  return signal !== undefined && signal.aborted;
}

function requestCancelledError(cause?: unknown): AwError {
  return new AwError({
    code: "RELAY_REQUEST_CANCELLED",
    category: "relay",
    message: "The AugmentWorks request was cancelled.",
    retryable: true,
    ...(cause === undefined ? {} : { cause })
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (isAbortRequested(signal)) throw requestCancelledError();
}

async function retryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new AwError({
      code: "RELAY_REQUEST_CANCELLED",
      category: "relay",
      message: "The AugmentWorks request was cancelled.",
      retryable: true
    });
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new AwError({
          code: "RELAY_REQUEST_CANCELLED",
          category: "relay",
          message: "The AugmentWorks request was cancelled.",
          retryable: true
        })
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function normalizeApiUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AwError({
      code: "INVALID_API_URL",
      category: "config",
      message: "AUGMENTWORKS_API_URL is not a valid URL.",
      cause: error
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AwError({
      code: "INVALID_API_URL",
      category: "config",
      message: "The AugmentWorks API URL cannot contain credentials, a query, or a fragment."
    });
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new AwError({
      code: "INSECURE_API_URL",
      category: "config",
      message: "The AugmentWorks API URL must use HTTPS, except for a loopback test server."
    });
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function apiEndpoint(base: URL, path: string): URL {
  const url = new URL(base);
  const parsed = new URL(path, "https://cli.invalid");
  url.pathname = `${base.pathname.replace(/\/$/, "")}${parsed.pathname}`;
  url.search = parsed.search;
  url.hash = "";
  return url;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function commandBoundBody(command: RelayCommand, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol_version: command.protocol_version,
    command_id: command.command_id,
    session_id: command.session_id,
    run_id: command.run_id,
    packet: command.packet,
    config_sha256: command.config_sha256,
    sequence: command.sequence,
    fencing_epoch: command.fencing_epoch,
    ...extra
  };
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw responseTooLarge();
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw responseTooLarge();
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } catch (error) {
    if (error instanceof AwError) throw error;
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "AugmentWorks returned a response that is not valid UTF-8.",
      cause: error
    });
  }
}

function responseTooLarge(): AwError {
  return new AwError({
    code: "RELAY_ENVELOPE_TOO_LARGE",
    category: "protocol",
    message: "The AugmentWorks response exceeds the relay envelope limit."
  });
}

function nameNonJsonRoute(error: AwError, method: "GET" | "POST", path: string): AwError {
  if (error.message.includes(method) && error.message.includes(path)) return error;
  return new AwError({
    code: error.code,
    category: error.category,
    message: `${error.message} ${method} ${path}`,
    retryable: error.retryable,
    ...(error.operation === undefined ? {} : { operation: error.operation }),
    ...(error.commandId === undefined ? {} : { commandId: error.commandId }),
    ...(error.details === undefined ? {} : { details: error.details }),
    cause: error
  });
}

function cloudHttpError(
  status: number,
  value: unknown,
  method?: "GET" | "POST",
  path?: string,
  recoveryUrl?: string,
  retryAfterHeader?: string | null
): AwError {
  const mapped =
    method !== undefined && path !== undefined
      ? mapBillingAdmissionError(
          status,
          value,
          method,
          path,
          recoveryUrl ?? profileRecoveryUrl(new URL("https://augmentworks.ai/"))
        )
      : undefined;
  if (mapped !== undefined) return mapped;
  const featureError = parseFeaturePackageError(value);
  const serverError =
    featureError === undefined
      ? safeServerError(value)
      : { code: featureError.code, message: featureError.message };
  const code =
    serverError?.code ??
    (status === 401 || status === 403
      ? "CLOUD_AUTH_REJECTED"
      : status === 409
        ? "RELAY_CONFLICT"
        : status === 410
          ? "COMMAND_EXPIRED"
          : "CLOUD_REQUEST_FAILED");
  const liveCode = isLiveErrorCode(code);
  const realDataCode = isRealDataErrorCode(code);
  const category = liveCode || realDataCode
    ? realDataCode
      ? realDataErrorCategorySafe(code)
      : "config"
    : status === 401 || status === 403
      ? "auth"
      : status === 409 || status === 410
        ? "protocol"
        : "relay";
  const setupUrl = serverError?.setupUrl;
  const disclosureMissing = isDisclosureError(code);
  const rawMessage =
    serverError?.message ??
    (category === "auth"
      ? "AugmentWorks rejected the connector credential."
      : "The AugmentWorks relay rejected the request.");
  const message = liveCode
    ? liveRecoveryCopy(code, rawMessage)
    : realDataCode
      ? realDataRecoveryCopy(code, rawMessage)
      : rawMessage;
  const disclosureSuffix = disclosureMissing
    ? setupUrl === undefined
      ? " Complete the authenticated judging disclosure, then re-run the same test command. Target work was not started."
      : ` Complete setup at ${setupUrl}, then re-run the same test command. Target work was not started.`
    : setupUrl === undefined
      ? ""
      : ` Setup: ${setupUrl}`;
  const details: Record<string, string | number | boolean> = { http_status: status };
  if (method !== undefined) details["http_method"] = method;
  if (path !== undefined) details["http_path"] = path;
  if (setupUrl !== undefined) details["setup_url"] = setupUrl;
  const retryAfterMs = parseRetryAfterHeaderMs(retryAfterHeader ?? null);
  if (retryAfterMs !== undefined) details["retry_after_ms"] = retryAfterMs;
  const rejectionFields = typedRejectionDetails(value);
  if (rejectionFields !== undefined) {
    details["create_disposition"] = rejectionFields.create_disposition;
    details["create_request_id"] = rejectionFields.create_request_id;
    details["create_request_sha256"] = rejectionFields.create_request_sha256;
  }
  return new AwError({
    code,
    category: disclosureMissing ? "relay" : category,
    message: `${message}${disclosureSuffix}`,
    retryable: realDataCode
      ? realDataHttpRetryable(code, status, method)
      : status === 408 || status === 429 || status >= 500,
    details
  });
}

function isLiveErrorCode(code: string): code is LiveErrorCode {
  return (LIVE_ERROR_CODES as readonly string[]).includes(code);
}

function realDataErrorCategorySafe(code: string): "config" | "auth" | "relay" | "evidence" {
  if (
    code === "TARGET_AUTHORITY_REQUIRED" ||
    code === "TARGET_AUTHORITY_REVOKED"
  ) {
    return "auth";
  }
  if (code === "INSUFFICIENT_EVIDENCE" || code === "EVIDENCE_REPRESENTATION_MISMATCH") {
    return "evidence";
  }
  if (
    code === "EXECUTION_BUDGET_EXHAUSTED" ||
    code === "EXECUTION_RELEASE_UNAVAILABLE" ||
    code === "ACTION_OUTCOME_INDETERMINATE"
  ) {
    return "relay";
  }
  return "config";
}

function isDisclosureError(code: string): boolean {
  return (
    code === "DISCLOSURE_REQUIRED" ||
    code === "DISCLOSURE_MISSING" ||
    code === "JUDGE_DISCLOSURE_REQUIRED" ||
    code === "JUDGE_DISCLOSURE_MISSING" ||
    code === "MISSING_DISCLOSURE"
  );
}

function typedRejectionDetails(
  value: unknown
):
  | {
      create_disposition: "rejected_uncreated";
      create_request_id: string;
      create_request_sha256: string;
    }
  | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const error = (value as Record<string, unknown>)["error"];
  if (error === null || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (
    record["create_disposition"] !== "rejected_uncreated" ||
    typeof record["create_request_id"] !== "string" ||
    typeof record["create_request_sha256"] !== "string"
  ) {
    return undefined;
  }
  return {
    create_disposition: "rejected_uncreated",
    create_request_id: record["create_request_id"],
    create_request_sha256: record["create_request_sha256"]
  };
}

function annotateCreateRunError(
  error: unknown,
  request: CreateRunRequest,
  requestSha256: string
): unknown {
  if (!(error instanceof AwError)) return error;
  const rejection = readTypedCreateRejection(
    {
      error: {
        code: error.code,
        message: error.message,
        create_disposition: error.details?.["create_disposition"],
        create_request_id: error.details?.["create_request_id"],
        create_request_sha256: error.details?.["create_request_sha256"]
      }
    },
    request,
    requestSha256
  );
  if (rejection === undefined) {
    if (error.details?.["create_disposition"] !== "rejected_uncreated") return error;
    const details = { ...error.details };
    delete details["create_disposition"];
    delete details["create_request_id"];
    delete details["create_request_sha256"];
    return new AwError({
      code: error.code,
      category: error.category,
      message: error.message,
      retryable: error.retryable,
      details,
      cause: error
    });
  }
  return new AwError({
    code: error.code,
    category: error.category,
    message: error.message,
    retryable: false,
    details: {
      ...error.details,
      create_disposition: "rejected_uncreated",
      create_request_id: request.create_request_id,
      create_request_sha256: requestSha256
    },
    cause: error
  });
}

export function isTypedRejectedUncreated(error: unknown): boolean {
  return (
    error instanceof AwError &&
    error.details?.["create_disposition"] === "rejected_uncreated" &&
    typeof error.details["create_request_id"] === "string" &&
    typeof error.details["create_request_sha256"] === "string"
  );
}

function isMissingRecoveryCapability(error: unknown): boolean {
  if (!(error instanceof AwError)) return false;
  const status = error.details?.["http_status"];
  const path = error.details?.["http_path"];
  if (path !== "/v1/relay/run-intents:reconcile") return false;
  if (status !== 404 && status !== 405 && status !== 501) return false;
  return error.code === "CLOUD_REQUEST_FAILED" || error.code === "NOT_FOUND";
}

function safeServerError(
  value: unknown
): { code: string; message: string; setupUrl?: string } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const error = (value as Record<string, unknown>)["error"];
  if (error === null || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const code = record["code"];
  const message = record["message"];
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(code)) return undefined;
  if (typeof message !== "string" || message.length < 1 || message.length > 500) return undefined;
  const setupCandidate = record["setup_url"] ?? record["setupUrl"];
  const setupUrl =
    typeof setupCandidate === "string" && isHttpUrl(setupCandidate) ? setupCandidate : undefined;
  return {
    code,
    message: message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""),
    ...(setupUrl === undefined ? {} : { setupUrl })
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function parseRetryAfterHeaderMs(header: string | null): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const date = Date.parse(header);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function parseResponse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: `AugmentWorks returned an invalid ${label}.`
    });
  }
  return parsed.data;
}
