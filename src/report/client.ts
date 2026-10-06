import { createHash } from "node:crypto";

import { AwError, EXIT } from "../errors.js";
import { CLI_VERSION } from "../version.js";
import {
  classifyHostedOutcome,
  coverageKnowledge,
  type HostedOutcomeClassification
} from "../outcome/classify.js";
import type { AccessTokenProvider } from "../auth/types.js";
import { remapAuthError } from "../auth/client.js";
import type { CredentialSource } from "../auth/types.js";
import {
  parseCriterionWireDetail,
  parseCriterionWirePage,
  criterionWireVerdictDiagnostics,
  type CriterionWireContext,
  type CriterionWireFailure
} from "./criterion-wire.js";
import { reportConsistencyDiagnostics } from "./consistency.js";
import {
  CRITERION_DETAIL_SCHEMA_VERSION,
  CRITERION_MAX_PAGES,
  CriterionDetailSchema,
  REPORT_MAX_PAGES,
  REPORT_PAGE_BYTES_MAX,
  REPORT_RETRY_AFTER_CAP_MS,
  REPORT_RETRY_BUDGET_MS,
  REPORT_RETRY_MAX_ATTEMPTS,
  RUN_REPORT_EXPORT_SCHEMA_VERSION,
  RUN_REPORT_SCHEMA_VERSION,
  ReportErrorSchema,
  RunReportSchema,
  reportPath,
  liveInformationalReportPath,
  authorizedReportPath,
  LIVE_INFORMATIONAL_REPORT_SCOPE,
  AUTHORIZED_REPORT_SCOPE,
  RUN_REPORT_LIVE_SCOPE_SCHEMA_VERSION,
  RUN_REPORT_AUTHORIZED_SCOPE_SCHEMA_VERSION,
  LiveInformationalReportSchema,
  LiveInformationalReportErrorSchema,
  AuthorizedReportOverlaySchema,
  AuthorizedReportOverlayErrorSchema,
  type CriterionDetail,
  type EvaluationBinding,
  type ExportDiagnostic,
  type LiveInformationalReport,
  type AuthorizedReportOverlay,
  type RunReport,
  type RunReportAttempt,
  type RunReportExport
} from "./schema.js";

type FetchImplementation = typeof fetch;

export interface RunReportClientOptions {
  readonly apiOrigin: URL;
  readonly accessTokenProvider: AccessTokenProvider;
  readonly credentialSource?: CredentialSource;
  readonly fetch?: FetchImplementation;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Authenticated workspace ID pinned from the existing session before the first request. */
  readonly expectedWorkspaceId?: string;
}

export class ReportProtocolError extends AwError {
  readonly httpStatus: number | undefined;
  readonly retrieved: false = false;
  readonly complete: false = false;

  constructor(options: {
    code: string;
    message: string;
    category?: "auth" | "protocol" | "relay";
    retryable?: boolean;
    httpStatus?: number;
    cause?: unknown;
  }) {
    super({
      code: options.code,
      category: options.category ?? "protocol",
      message: options.message,
      retryable: options.retryable ?? false,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...(options.httpStatus === undefined ? {} : { details: { http_status: options.httpStatus } })
    });
    this.name = "ReportProtocolError";
    this.httpStatus = options.httpStatus;
  }
}

export async function exportHostedRunReport(
  runId: string,
  options: RunReportClientOptions
): Promise<RunReportExport> {
  const client = new RunReportClient(options);
  try {
    return await client.exportRun(runId);
  } catch (error) {
    const remapped = remapAuthError(error, options.credentialSource ?? "environment");
    if (remapped instanceof AwError) {
      return failureExport(remapped);
    }
    throw remapped;
  }
}

export async function exportHostedLiveInformationalReport(
  runId: string,
  options: RunReportClientOptions
): Promise<LiveInformationalReport | Record<string, unknown>> {
  const client = new RunReportClient(options);
  try {
    return await client.exportLiveInformational(runId);
  } catch (error) {
    const remapped = remapAuthError(error, options.credentialSource ?? "environment");
    if (remapped instanceof AwError) {
      return liveFailureExport(remapped);
    }
    throw remapped;
  }
}

export async function exportHostedAuthorizedReport(
  runId: string,
  options: RunReportClientOptions
): Promise<AuthorizedReportOverlay | Record<string, unknown>> {
  const client = new RunReportClient(options);
  try {
    return await client.exportAuthorized(runId);
  } catch (error) {
    const remapped = remapAuthError(error, options.credentialSource ?? "environment");
    if (remapped instanceof AwError) {
      return authorizedFailureExport(remapped);
    }
    throw remapped;
  }
}

const AUTH_FAILURE_CODES = new Set([
  "AUTH_REQUIRED",
  "AUTH_ENV_CONFLICT",
  "API_KEY_REVOKED",
  "TOKEN_REVOKED",
  "CLOUD_AUTH_REJECTED",
  "SCOPE_DENIED",
  "UNSAFE_CLOUD_URL",
  "HTTP_401",
  "HTTP_403",
  "CREDENTIAL_STORE",
  "CREDENTIAL_STORE_UNAVAILABLE"
]);

export function classifyRunReportExport(document: RunReportExport): HostedOutcomeClassification & {
  readonly retrieved: boolean;
  readonly complete: boolean;
} {
  if (!document.retrieved || document.report === undefined) {
    const code = document.error?.code;
    if (code === "INTERRUPTED") {
      return {
        retrieved: false,
        complete: false,
        work: "terminal",
        waitTerminal: true,
        assessment: "interrupted",
        exitCode: EXIT.INTERRUPTED,
        deterministicOnly: false
      };
    }
    const auth = code !== undefined && AUTH_FAILURE_CODES.has(code);
    return {
      retrieved: false,
      complete: false,
      work: "terminal",
      waitTerminal: true,
      assessment: "unknown",
      exitCode: auth ? EXIT.AUTH : EXIT.RELAY,
      deterministicOnly: false
    };
  }
  if (!document.complete) {
    return {
      retrieved: true,
      complete: false,
      work: "terminal",
      waitTerminal: true,
      assessment: "incomplete",
      exitCode: EXIT.EVALUATION_INCOMPLETE,
      deterministicOnly: false
    };
  }
  const classified = classifyHostedOutcome({
    executionStatus: document.report.executionStatus,
    evaluationStatus: document.report.evaluationStatus,
    outcome: document.report.outcome,
    coverageKnown: coverageKnowledge(document.report.coverage)
  });
  if (classified.exitCode === EXIT.OK && document.report.reportReady !== true) {
    return {
      retrieved: true,
      complete: true,
      work: classified.work,
      waitTerminal: classified.waitTerminal,
      assessment: "incomplete",
      exitCode: EXIT.EVALUATION_INCOMPLETE,
      deterministicOnly: classified.deterministicOnly
    };
  }
  return {
    retrieved: true,
    complete: true,
    ...classified
  };
}

export function failureExport(error: AwError): RunReportExport {
  return {
    schemaVersion: RUN_REPORT_EXPORT_SCHEMA_VERSION,
    retrieved: false,
    complete: false,
    diagnostics: [
      {
        code: error.code,
        message: error.message,
        retryable: error.retryable
      }
    ],
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(typeof error.details?.["http_status"] === "number"
        ? { httpStatus: error.details["http_status"] }
        : {})
    }
  };
}

export function liveFailureExport(error: AwError): Record<string, unknown> {
  return {
    schemaVersion: RUN_REPORT_LIVE_SCOPE_SCHEMA_VERSION,
    retrieved: false,
    complete: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(typeof error.details?.["http_status"] === "number"
        ? { httpStatus: error.details["http_status"] }
        : {})
    }
  };
}

export function authorizedFailureExport(error: AwError): Record<string, unknown> {
  return {
    schemaVersion: RUN_REPORT_AUTHORIZED_SCOPE_SCHEMA_VERSION,
    retrieved: false,
    complete: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(typeof error.details?.["http_status"] === "number"
        ? { httpStatus: error.details["http_status"] }
        : {})
    }
  };
}

class RunReportClient {
  readonly apiOrigin: URL;
  readonly #accessTokenProvider: AccessTokenProvider;
  readonly #credentialSource: CredentialSource;
  readonly #fetch: FetchImplementation;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #signal: AbortSignal | undefined;
  readonly #expectedWorkspaceId: string | undefined;
  #pinnedWorkspaceId: string | undefined;
  #retryBudgetMs: number;

  constructor(options: RunReportClientOptions) {
    this.apiOrigin = new URL(options.apiOrigin.origin);
    this.#accessTokenProvider = options.accessTokenProvider;
    this.#credentialSource = options.credentialSource ?? "environment";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#signal = options.signal;
    this.#expectedWorkspaceId = options.expectedWorkspaceId;
    this.#retryBudgetMs = REPORT_RETRY_BUDGET_MS;
  }

  async exportLiveInformational(runId: string): Promise<LiveInformationalReport> {
    const url = this.#sameOriginUrl(liveInformationalReportPath(runId));
    const payload = await this.#getJson(url);
    const parsed = LiveInformationalReportSchema.safeParse(payload);
    if (!parsed.success) {
      const errorEnvelope = LiveInformationalReportErrorSchema.safeParse(payload);
      if (errorEnvelope.success) {
        throw new ReportProtocolError({
          code: errorEnvelope.data.error.code,
          message: errorEnvelope.data.error.message,
          retryable: errorEnvelope.data.error.retryable,
          category: "relay"
        });
      }
      const v1 = RunReportSchema.safeParse(payload);
      throw new ReportProtocolError({
        code: "REPORT_SCOPE_SCHEMA_INVALID",
        message: v1.success
          ? "AugmentWorks returned aw-run-report/1 for --scope live-informational. The live overlay must be requested and parsed separately."
          : "AugmentWorks returned a report that does not match aw-run-report-live-scope/1."
      });
    }
    if (parsed.data.runId !== runId) {
      throw new ReportProtocolError({
        code: "REPORT_ID_MISMATCH",
        message: "The live informational report runId does not match the requested run."
      });
    }
    if (this.#expectedWorkspaceId !== undefined && parsed.data.workspaceId !== this.#expectedWorkspaceId) {
      throw new ReportProtocolError({
        code: "REPORT_WORKSPACE_MISMATCH",
        message: `A live informational report workspaceId did not match the authenticated workspace. Retry: augmentworks run report ${runId} --scope ${LIVE_INFORMATIONAL_REPORT_SCOPE} --json. Do not start another billed assessment.`
      });
    }
    return parsed.data;
  }

  async exportAuthorized(runId: string): Promise<AuthorizedReportOverlay> {
    const url = this.#sameOriginUrl(authorizedReportPath(runId));
    const payload = await this.#getJson(url);
    const parsed = AuthorizedReportOverlaySchema.safeParse(payload);
    if (!parsed.success) {
      const errorEnvelope = AuthorizedReportOverlayErrorSchema.safeParse(payload);
      if (errorEnvelope.success) {
        throw new ReportProtocolError({
          code: errorEnvelope.data.error.code,
          message: errorEnvelope.data.error.message,
          retryable: errorEnvelope.data.error.retryable,
          category: "relay"
        });
      }
      const v1 = RunReportSchema.safeParse(payload);
      throw new ReportProtocolError({
        code: "REPORT_SCOPE_SCHEMA_INVALID",
        message: v1.success
          ? "AugmentWorks returned aw-run-report/1 for --scope authorized-1. The authorized overlay must be requested and parsed separately."
          : "AugmentWorks returned a report that does not match aw-run-report-authorized-scope/1."
      });
    }
    if (parsed.data.runId !== runId) {
      throw new ReportProtocolError({
        code: "REPORT_ID_MISMATCH",
        message: "The authorized report runId does not match the requested run."
      });
    }
    if (this.#expectedWorkspaceId !== undefined && parsed.data.workspaceId !== this.#expectedWorkspaceId) {
      throw new ReportProtocolError({
        code: "REPORT_WORKSPACE_MISMATCH",
        message: `An authorized report workspaceId did not match the authenticated workspace. Retry: augmentworks run report ${runId} --scope ${AUTHORIZED_REPORT_SCOPE} --json. Do not start another billed assessment.`
      });
    }
    if (
      parsed.data.evidenceStatus === "unavailable" ||
      parsed.data.evidenceStatus === "expired" ||
      parsed.data.evidenceStatus === "purged" ||
      parsed.data.representationHashes.length === 0
    ) {
      throw new ReportProtocolError({
        code: "INSUFFICIENT_EVIDENCE",
        message: `Missing or mismatched authorized evidence is incomplete. Retry: augmentworks run report ${runId} --scope ${AUTHORIZED_REPORT_SCOPE} --json. Inspect this original run; do not start another billed assessment.`,
        category: "relay"
      });
    }
    if (parsed.data.expectedCoverage !== undefined) {
      const expected = parsed.data.expectedCoverage;
      const actual = parsed.data.actualCounts;
      if (
        actual.messages !== expected.messages ||
        actual.commands !== expected.commands ||
        actual.actions !== expected.actions
      ) {
        throw new ReportProtocolError({
          code: "EVIDENCE_REPRESENTATION_MISMATCH",
          message: `Authorized report coverage does not match the admitted scope. Retry: augmentworks run report ${runId} --scope ${AUTHORIZED_REPORT_SCOPE} --json. Do not start another billed assessment.`,
          category: "relay"
        });
      }
    }
    return parsed.data;
  }

  async exportRun(runId: string): Promise<RunReportExport> {
    const diagnostics: ExportDiagnostic[] = [];
    const pages: RunReport[] = [];
    const seenCursors = new Set<string>();
    let nextUrl = this.#sameOriginUrl(reportPath(runId));
    let pinnedBinding: EvaluationBinding | null | undefined;
    let generationCursorBound = false;
    const attemptTotals = new ClaimedCount();

    for (let pageIndex = 0; pageIndex < REPORT_MAX_PAGES; pageIndex += 1) {
      const page = await this.#getReportPage(nextUrl);
      this.#assertReportWorkspace(page);
      if (pageIndex === 0) {
        if (page.runId !== runId) {
          throw new ReportProtocolError({
            code: "REPORT_ID_MISMATCH",
            message: "The hosted report runId does not match the requested run."
          });
        }
        pinnedBinding = page.evaluationBinding;
        generationCursorBound = page.evaluationBinding === null;
      } else {
        this.#assertPinnedPage(page, runId, pinnedBinding, generationCursorBound);
      }
      if (attemptTotals.observe(page.page.totalAttempts) === "conflict") {
        diagnostics.push({
          code: "REPORT_TOTAL_CONFLICT",
          message: retrievalRecoveryMessage(
            runId,
            "Report pages disagreed on totalAttempts."
          )
        });
        pages.push(page);
        return this.#assemble(pages, [], diagnostics, false);
      }
      pages.push(page);
      if (!page.page.hasMore) {
        if (page.page.nextCursor !== null) {
          diagnostics.push({
            code: "REPORT_CURSOR_INCONSISTENT",
            message: "The report page set hasMore false but returned a next cursor."
          });
        }
        break;
      }
      const cursor = page.page.nextCursor;
      if (cursor === null || cursor === "") {
        diagnostics.push({
          code: "REPORT_CURSOR_MISSING",
          message: "The report page set hasMore true without a next cursor."
        });
        return this.#assemble(pages, [], diagnostics, false);
      }
      if (seenCursors.has(cursor)) {
        diagnostics.push({
          code: "REPORT_CURSOR_CYCLE",
          message: "The report cursor repeated; refusing to follow a cycle."
        });
        return this.#assemble(pages, [], diagnostics, false);
      }
      seenCursors.add(cursor);
      nextUrl = this.#cursorUrl(reportPath(runId), cursor, pinnedBinding ?? undefined);
      if (pageIndex === REPORT_MAX_PAGES - 1) {
        diagnostics.push({
          code: "REPORT_PAGE_LIMIT",
          message: "The report exceeded the bounded page limit without completing."
        });
        return this.#assemble(pages, [], diagnostics, false);
      }
    }

    const merged = this.#mergePages(pages);
    const claimedTotal = attemptTotals.value;
    const assembled: RunReport = {
      ...merged,
      page: {
        ...merged.page,
        totalAttempts: claimedTotal
      }
    };
    const uniqueAttempts = assembled.attempts.length;
    const last = pages[pages.length - 1];
    const terminated = last !== undefined && last.page.hasMore === false;

    if (claimedTotal !== null && uniqueAttempts > claimedTotal) {
      diagnostics.push({
        code: "REPORT_TOTAL_BOUNDS",
        message: retrievalRecoveryMessage(
          runId,
          `Collected ${String(uniqueAttempts)} distinct attempts; totalAttempts is ${String(claimedTotal)}.`
        )
      });
      return this.#assemble([assembled], [], diagnostics, false);
    }
    if (claimedTotal !== null && uniqueAttempts !== claimedTotal && terminated) {
      diagnostics.push({
        code: "REPORT_TOTAL_BOUNDS",
        message: retrievalRecoveryMessage(
          runId,
          `Collected ${String(uniqueAttempts)} distinct attempts; totalAttempts is ${String(claimedTotal)}.`
        )
      });
      return this.#assemble([assembled], [], diagnostics, false);
    }
    if (claimedTotal === null && terminated) {
      diagnostics.push({
        code: "REPORT_TOTAL_UNKNOWN",
        message: retrievalRecoveryMessage(
          runId,
          "totalAttempts is unknown; retrieved completeness cannot be proved."
        ),
        retryable: true
      });
    }

    const { criteria, complete: criteriaComplete } = await this.#collectCriteria(
      assembled,
      diagnostics
    );
    const evidenceComplete = this.#evidenceComplete(assembled, criteria, diagnostics);
    diagnostics.push(
      ...reportConsistencyDiagnostics({
        report: assembled,
        criteria,
        judgmentsComparable: assembled.evaluationBinding !== null && criteriaComplete
      })
    );
    const complete = criteriaComplete && evidenceComplete && diagnostics.length === 0;
    return this.#assemble([assembled], criteria, diagnostics, complete);
  }

  #assertPinnedPage(
    page: RunReport,
    runId: string,
    pinnedBinding: EvaluationBinding | null | undefined,
    generationCursorBound: boolean
  ): void {
    if (page.runId !== runId) {
      throw new ReportProtocolError({
        code: "REPORT_ID_MISMATCH",
        message: "A later report page returned a different runId."
      });
    }
    if (generationCursorBound) {
      if (page.evaluationBinding !== null) {
        throw new ReportProtocolError({
          code: "REPORT_BINDING_CHANGED",
          message: "The report evaluation binding appeared after an unbound first page. Restart the export."
        });
      }
      return;
    }
    if (pinnedBinding == null || page.evaluationBinding == null) {
      throw new ReportProtocolError({
        code: "REPORT_BINDING_CHANGED",
        message: "The report evaluation binding changed during pagination."
      });
    }
    if (!sameBinding(pinnedBinding, page.evaluationBinding)) {
      throw new ReportProtocolError({
        code: "REPORT_BINDING_CHANGED",
        message: "The report evaluationId, revision, or snapshotHash changed during pagination."
      });
    }
  }

  #assertReportWorkspace(page: RunReport): void {
    if (this.#expectedWorkspaceId !== undefined && page.workspaceId !== this.#expectedWorkspaceId) {
      throw new ReportProtocolError({
        code: "REPORT_WORKSPACE_MISMATCH",
        message: retrievalRecoveryMessage(
          page.runId,
          "A report page workspaceId did not match the authenticated workspace."
        )
      });
    }
    if (this.#pinnedWorkspaceId === undefined) {
      this.#pinnedWorkspaceId = page.workspaceId;
      return;
    }
    if (page.workspaceId !== this.#pinnedWorkspaceId) {
      throw new ReportProtocolError({
        code: "REPORT_WORKSPACE_MISMATCH",
        message: retrievalRecoveryMessage(
          page.runId,
          "A later report page workspaceId did not match the first page."
        )
      });
    }
  }

  #assertOptionalWorkspace(workspaceId: string | undefined, runId: string, label: string): void {
    if (workspaceId === undefined) return;
    const expected = this.#expectedWorkspaceId ?? this.#pinnedWorkspaceId;
    if (expected !== undefined && workspaceId !== expected) {
      throw new ReportProtocolError({
        code: "REPORT_WORKSPACE_MISMATCH",
        message: retrievalRecoveryMessage(
          runId,
          `A ${label} workspaceId did not match the authenticated workspace.`
        )
      });
    }
  }

  #mergePages(pages: readonly RunReport[], skipDuplicateAttempts = false): RunReport {
    const first = pages[0];
    if (first === undefined) {
      throw new ReportProtocolError({
        code: "REPORT_EMPTY",
        message: "The hosted report returned no pages."
      });
    }
    const attempts: RunReportAttempt[] = [];
    const seenAttempts = new Set<string>();
    for (const page of pages) {
      for (const attempt of page.attempts) {
        if (seenAttempts.has(attempt.attemptId)) {
          if (skipDuplicateAttempts) continue;
          throw new ReportProtocolError({
            code: "REPORT_ATTEMPT_DUPLICATE",
            message: "The hosted report repeated an attemptId across pages."
          });
        }
        seenAttempts.add(attempt.attemptId);
        attempts.push(attempt);
      }
    }
    return {
      ...first,
      attempts,
      page: {
        nextCursor: null,
        hasMore: false,
        totalAttempts: pinnedAttemptTotal(pages)
      }
    };
  }

  async #collectCriteria(
    report: RunReport,
    diagnostics: ExportDiagnostic[]
  ): Promise<{ criteria: CriterionDetail[]; complete: boolean }> {
    if (report.evaluationBinding === null) {
      return { criteria: [], complete: true };
    }
    const binding = report.evaluationBinding;
    const collected: CriterionDetail[] = [];
    const seenDetails = new Set<string>();
    for (const attempt of report.attempts) {
      if (attempt.criterionIndexUrl === null) continue;
      const indexUrl = this.#requireSameOriginLink(attempt.criterionIndexUrl, "criterionIndexUrl");
      const { details, complete } = await this.#collectAttemptCriteria(
        indexUrl,
        report.runId,
        attempt.attemptId,
        binding,
        diagnostics,
        report.workspaceId
      );
      for (const detail of details) {
        const key = `${detail.attemptId}:${detail.criterionId}`;
        if (seenDetails.has(key)) {
          diagnostics.push({
            code: "CRITERION_DUPLICATE",
            message: "A criterion detail was repeated across pages."
          });
          return { criteria: collected, complete: false };
        }
        seenDetails.add(key);
        collected.push(detail);
      }
      if (!complete) return { criteria: collected, complete: false };
    }
    return { criteria: collected, complete: true };
  }

  async #collectAttemptCriteria(
    startUrl: URL,
    runId: string,
    attemptId: string,
    binding: EvaluationBinding,
    diagnostics: ExportDiagnostic[],
    workspaceId?: string
  ): Promise<{ details: CriterionDetail[]; complete: boolean }> {
    const details: CriterionDetail[] = [];
    const seenCursors = new Set<string>();
    const criterionTotals = new ClaimedCount();
    const wireContext: CriterionWireContext = {
      runId,
      attemptId,
      binding,
      indexUrl: startUrl,
      ...(workspaceId === undefined ? {} : { workspaceId })
    };
    let nextUrl: URL | undefined = startUrl;
    for (let pageIndex = 0; pageIndex < CRITERION_MAX_PAGES && nextUrl !== undefined; pageIndex += 1) {
      const payload = await this.#getJson(nextUrl);
      const indexParsed = parseCriterionWirePage(payload, wireContext);
      if (!indexParsed.ok) {
        if (indexParsed.fatal) {
          this.#throwWireFailure(indexParsed, runId);
        }
        diagnostics.push(indexParsed.diagnostic);
        return { details, complete: false };
      }
      if (indexParsed.kind === "detail") {
        this.#assertCriterionBinding(indexParsed.detail, runId, attemptId, binding);
        details.push(indexParsed.detail);
        return this.#finishAttemptCriteria(details, diagnostics, {
          runId,
          claimedTotal: null,
          requireClaimedTotal: false
        });
      }
      const index = indexParsed.index;
      this.#assertCriterionIndexBinding(index, runId, attemptId, binding);
      if (criterionTotals.observe(index.page.totalCriteria) === "conflict") {
        diagnostics.push({
          code: "CRITERION_TOTAL_CONFLICT",
          message: retrievalRecoveryMessage(
            runId,
            "Criterion index pages disagreed on totalCriteria."
          )
        });
        return { details, complete: false };
      }
      for (const item of index.criteria) {
        if (item.detailUrl !== null && item.detailUrl !== undefined && item.evidence === undefined) {
          const detailUrl = this.#requireSameOriginLink(item.detailUrl, "criterion detailUrl");
          const detailPayload = await this.#getJson(detailUrl);
          const detail = parseCriterionWireDetail(detailPayload, wireContext);
          if (!detail.ok) {
            if (detail.fatal) {
              this.#throwWireFailure(detail, runId);
            }
            diagnostics.push(detail.diagnostic);
            return { details, complete: false };
          }
          this.#assertCriterionBinding(detail.detail, runId, attemptId, binding);
          details.push(detail.detail);
          continue;
        }
        const wireVerdict =
          "wireVerdict" in item ? (item as { wireVerdict?: unknown }).wireVerdict : undefined;
        const embedded = CriterionDetailSchema.safeParse({
          schemaVersion: CRITERION_DETAIL_SCHEMA_VERSION,
          runId: index.runId,
          ...(index.workspaceId === undefined ? {} : { workspaceId: index.workspaceId }),
          evaluationId: index.evaluationId,
          evaluationRevision: index.evaluationRevision,
          snapshotHash: index.snapshotHash,
          attemptId: index.attemptId,
          criterionId: item.criterionId,
          ...(item.criterionKey === undefined ? {} : { criterionKey: item.criterionKey }),
          required: item.required,
          verdict: item.verdict,
          evidence: item.evidence ?? {
            availability: "missing",
            text: null,
            sha256: null,
            truncated: false
          },
          ...(wireVerdict === undefined ? {} : { wireVerdict })
        });
        if (!embedded.success) {
          diagnostics.push({
            code: "CRITERION_SCHEMA_INVALID",
            message: "An embedded criterion projection was not a valid detail document."
          });
          return { details, complete: false };
        }
        details.push(embedded.data);
      }
      if (!index.page.hasMore) {
        nextUrl = undefined;
        break;
      }
      const cursor = index.page.nextCursor;
      if (cursor === null || cursor === "") {
        diagnostics.push({
          code: "CRITERION_CURSOR_MISSING",
          message: "A criterion index set hasMore true without a next cursor."
        });
        return { details, complete: false };
      }
      if (seenCursors.has(cursor)) {
        diagnostics.push({
          code: "CRITERION_CURSOR_CYCLE",
          message: "A criterion cursor repeated; refusing to follow a cycle."
        });
        return { details, complete: false };
      }
      seenCursors.add(cursor);
      nextUrl = this.#cursorUrl(startUrl.pathname + startUrl.search, cursor, binding);
    }
    if (nextUrl !== undefined) {
      diagnostics.push({
        code: "CRITERION_PAGE_LIMIT",
        message: "Criterion pagination exceeded the bounded page limit without completing."
      });
      return { details, complete: false };
    }
    return this.#finishAttemptCriteria(details, diagnostics, {
      runId,
      claimedTotal: criterionTotals.value,
      requireClaimedTotal: true
    });
  }

  #finishAttemptCriteria(
    details: CriterionDetail[],
    diagnostics: ExportDiagnostic[],
    options: {
      readonly runId: string;
      readonly claimedTotal: number | null;
      readonly requireClaimedTotal: boolean;
    }
  ): { details: CriterionDetail[]; complete: boolean } {
    const uniqueIds = new Set(details.map((item) => item.criterionId));
    if (uniqueIds.size !== details.length) {
      diagnostics.push({
        code: "CRITERION_DUPLICATE",
        message: "A criterion detail was repeated across pages."
      });
      return { details, complete: false };
    }
    if (options.requireClaimedTotal) {
      const claimed = options.claimedTotal;
      if (claimed !== null && uniqueIds.size !== claimed) {
        diagnostics.push({
          code: "CRITERION_TOTAL_BOUNDS",
          message: retrievalRecoveryMessage(
            options.runId,
            `Collected ${String(uniqueIds.size)} distinct criteria; totalCriteria is ${String(claimed)}.`
          )
        });
        return { details, complete: false };
      }
      if (claimed === null) {
        diagnostics.push({
          code: "CRITERION_TOTAL_UNKNOWN",
          message: retrievalRecoveryMessage(
            options.runId,
            "totalCriteria is unknown; retrieved completeness cannot be proved."
          ),
          retryable: true
        });
        return { details, complete: false };
      }
    }
    const verdictDiagnostics = criterionWireVerdictDiagnostics(details);
    if (verdictDiagnostics.length > 0) {
      diagnostics.push(...verdictDiagnostics);
      return { details, complete: false };
    }
    return { details, complete: true };
  }

  #throwWireFailure(failure: CriterionWireFailure, runId: string): never {
    if (failure.mismatch === "workspace") {
      throw new ReportProtocolError({
        code: "REPORT_WORKSPACE_MISMATCH",
        message: retrievalRecoveryMessage(
          runId,
          "A criterion document workspaceId did not match the authenticated workspace."
        )
      });
    }
    throw new ReportProtocolError({
      code: failure.diagnostic.code,
      message: failure.diagnostic.message
    });
  }

  #assertCriterionIndexBinding(
    index: {
      runId: string;
      workspaceId?: string | undefined;
      evaluationId: string;
      evaluationRevision: number;
      snapshotHash: string;
      attemptId: string;
    },
    runId: string,
    attemptId: string,
    binding: EvaluationBinding
  ): void {
    if (index.runId !== runId || index.attemptId !== attemptId) {
      throw new ReportProtocolError({
        code: "CRITERION_ID_MISMATCH",
        message: "A criterion index did not match the parent run or attempt."
      });
    }
    this.#assertOptionalWorkspace(index.workspaceId, runId, "criterion index");
    if (
      index.evaluationId !== binding.evaluationId ||
      index.evaluationRevision !== binding.evaluationRevision ||
      index.snapshotHash !== binding.snapshotHash
    ) {
      throw new ReportProtocolError({
        code: "CRITERION_BINDING_MISMATCH",
        message: "A criterion index was not pinned to the report evaluation binding."
      });
    }
  }

  #assertCriterionBinding(
    detail: CriterionDetail,
    runId: string,
    attemptId: string,
    binding: EvaluationBinding
  ): void {
    if (detail.runId !== runId || detail.attemptId !== attemptId) {
      throw new ReportProtocolError({
        code: "CRITERION_ID_MISMATCH",
        message: "A criterion detail did not match the parent run or attempt."
      });
    }
    this.#assertOptionalWorkspace(detail.workspaceId, runId, "criterion detail");
    if (
      detail.evaluationId !== binding.evaluationId ||
      detail.evaluationRevision !== binding.evaluationRevision ||
      detail.snapshotHash !== binding.snapshotHash
    ) {
      throw new ReportProtocolError({
        code: "CRITERION_BINDING_MISMATCH",
        message: "A criterion detail was not pinned to the report evaluation binding."
      });
    }
  }

  #evidenceComplete(
    report: RunReport,
    criteria: readonly CriterionDetail[],
    diagnostics: ExportDiagnostic[]
  ): boolean {
    let complete = true;
    for (const attempt of report.attempts) {
      if (attempt.mappedResponse.truncated) {
        diagnostics.push({
          code: "MAPPED_RESPONSE_TRUNCATED",
          message: `Attempt ${attempt.attemptId} mappedResponse is truncated.`
        });
        complete = false;
      }
      if (
        attempt.mappedResponse.availability === "missing" ||
        attempt.mappedResponse.availability === "purged"
      ) {
        diagnostics.push({
          code: "MAPPED_RESPONSE_UNAVAILABLE",
          message: `Attempt ${attempt.attemptId} mappedResponse is ${attempt.mappedResponse.availability}.`
        });
        complete = false;
      }
      if (
        attempt.mappedResponse.text !== null &&
        attempt.mappedResponse.sha256 !== null &&
        sha256Utf8(attempt.mappedResponse.text) !== attempt.mappedResponse.sha256
      ) {
        diagnostics.push({
          code: "MAPPED_RESPONSE_HASH_MISMATCH",
          message: `Attempt ${attempt.attemptId} mappedResponse sha256 does not match text.`
        });
        complete = false;
      }
    }
    for (const criterion of criteria) {
      if (criterion.evidence.truncated) {
        diagnostics.push({
          code: "CRITERION_EVIDENCE_TRUNCATED",
          message: `Criterion ${criterion.criterionId} evidence is truncated.`
        });
        complete = false;
      }
      if (criterion.required && (criterion.evidence.availability === "missing" || criterion.evidence.availability === "purged")) {
        diagnostics.push({
          code: "CRITERION_EVIDENCE_MISSING",
          message: `Required criterion ${criterion.criterionId} evidence is ${criterion.evidence.availability}.`
        });
        complete = false;
      }
      if (
        criterion.evidence.text !== null &&
        criterion.evidence.sha256 !== null &&
        sha256Utf8(criterion.evidence.text) !== criterion.evidence.sha256
      ) {
        diagnostics.push({
          code: "CRITERION_EVIDENCE_HASH_MISMATCH",
          message: `Criterion ${criterion.criterionId} evidence sha256 does not match text.`
        });
        complete = false;
      }
    }
    return complete;
  }

  #assemble(
    pages: readonly RunReport[],
    criteria: readonly CriterionDetail[],
    diagnostics: readonly ExportDiagnostic[],
    complete: boolean
  ): RunReportExport {
    const report =
      pages.length === 1 ? pages[0] : this.#mergePages(pages, !complete);
    if (report === undefined) {
      throw new ReportProtocolError({
        code: "REPORT_EMPTY",
        message: "The hosted report returned no pages."
      });
    }
    return {
      schemaVersion: RUN_REPORT_EXPORT_SCHEMA_VERSION,
      retrieved: true,
      complete,
      report,
      criteria: criteria.map((item) => ({ ...item })),
      diagnostics: [...diagnostics]
    };
  }

  async #getReportPage(url: URL): Promise<RunReport> {
    const payload = await this.#getJson(url);
    const parsed = RunReportSchema.safeParse(payload);
    if (parsed.success) return parsed.data;
    const errorEnvelope = ReportErrorSchema.safeParse(payload);
    if (errorEnvelope.success) {
      throw new ReportProtocolError({
        code: errorEnvelope.data.error.code,
        message: errorEnvelope.data.error.message,
        retryable: errorEnvelope.data.error.retryable,
        category: "relay"
      });
    }
    throw new ReportProtocolError({
      code: "REPORT_SCHEMA_INVALID",
      message: "AugmentWorks returned a report that does not match aw-run-report/1."
    });
  }

  async #getJson(url: URL): Promise<unknown> {
    this.#assertSameOrigin(url);
    let lastError: AwError | undefined;
    for (let attempt = 0; attempt < REPORT_RETRY_MAX_ATTEMPTS; attempt += 1) {
      throwIfAborted(this.#signal);
      const accessToken = await this.#accessTokenProvider(
        this.#signal === undefined ? {} : { signal: this.#signal }
      );
      const controller = new AbortController();
      const onAbort = (): void => controller.abort(this.#signal?.reason);
      this.#signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("request timeout")), 30_000);
      timer.unref?.();
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            "X-AugmentWorks-CLI-Version": CLI_VERSION
          }
        });
      } catch (cause) {
        clearTimeout(timer);
        this.#signal?.removeEventListener("abort", onAbort);
        if (this.#signal?.aborted === true) {
          throw new AwError({
            code: "INTERRUPTED",
            category: "local",
            message: "The report request was interrupted.",
            cause
          });
        }
        throw new ReportProtocolError({
          code: "REPORT_UNREACHABLE",
          message: "Could not reach the AugmentWorks report API.",
          retryable: true,
          category: "relay",
          cause
        });
      }
      clearTimeout(timer);
      this.#signal?.removeEventListener("abort", onAbort);

      if (response.status >= 300 && response.status < 400) {
        throw new ReportProtocolError({
          code: "UNSAFE_REPORT_REDIRECT",
          message: "The report API returned a redirect; the CLI does not follow redirects with the bearer.",
          httpStatus: response.status
        });
      }

      const text = await readBoundedText(response, REPORT_PAGE_BYTES_MAX);
      let payload: unknown;
      try {
        payload = text === "" ? {} : JSON.parse(text);
      } catch (cause) {
        throw new ReportProtocolError({
          code: "REPORT_SCHEMA_INVALID",
          message: "AugmentWorks returned a report page that is not JSON.",
          httpStatus: response.status,
          cause
        });
      }

      if (response.status === 401 || response.status === 403) {
        const remapped = remapAuthError(
          new AwError({
            code: response.status === 401 ? "TOKEN_REVOKED" : "SCOPE_DENIED",
            category: "auth",
            message:
              response.status === 401
                ? "The AugmentWorks credential is expired or revoked."
                : "The AugmentWorks credential does not have the required report actions.",
            details: { http_status: response.status }
          }),
          this.#credentialSource
        );
        throw remapped;
      }
      if (response.status === 404) {
        throw new ReportProtocolError({
          code: "REPORT_NOT_FOUND",
          message: "The hosted run report was not found or is not visible to this credential.",
          httpStatus: 404,
          category: "relay"
        });
      }
      if (response.status === 409) {
        throw new ReportProtocolError({
          code: "REPORT_BINDING_CONFLICT",
          message: "The hosted report evaluation binding is incompatible with this request. Restart the export.",
          httpStatus: 409
        });
      }
      if (response.status === 410) {
        throw new ReportProtocolError({
          code: "REPORT_PURGED",
          message: "The hosted report content has been purged or expired.",
          httpStatus: 410
        });
      }
      if (response.status === 429 || response.status === 503) {
        lastError = new ReportProtocolError({
          code: response.status === 429 ? "REPORT_RATE_LIMITED" : "REPORT_UNAVAILABLE",
          message:
            response.status === 429
              ? "The report API rate-limited this read."
              : "The report API is temporarily unavailable.",
          retryable: true,
          httpStatus: response.status,
          category: "relay"
        });
        const delay = retryAfterMs(response.headers.get("retry-after"));
        if (delay === undefined || this.#retryBudgetMs <= 0 || attempt === REPORT_RETRY_MAX_ATTEMPTS - 1) {
          throw lastError;
        }
        const wait = Math.min(delay, REPORT_RETRY_AFTER_CAP_MS, this.#retryBudgetMs);
        this.#retryBudgetMs -= wait;
        await this.#sleep(wait, this.#signal);
        continue;
      }
      if (!response.ok) {
        const envelope = ReportErrorSchema.safeParse(payload);
        throw new ReportProtocolError({
          code: envelope.success ? envelope.data.error.code : "REPORT_REQUEST_FAILED",
          message: envelope.success
            ? envelope.data.error.message
            : `The report API rejected the request with HTTP ${String(response.status)}.`,
          retryable: envelope.success ? envelope.data.error.retryable : response.status >= 500,
          httpStatus: response.status,
          category: "relay"
        });
      }
      return payload;
    }
    throw lastError ??
      new ReportProtocolError({
        code: "REPORT_UNAVAILABLE",
        message: "The report API did not return a successful read.",
        retryable: true,
        category: "relay"
      });
  }

  #cursorUrl(basePath: string, cursor: string, binding?: EvaluationBinding): URL {
    if (/^https?:\/\//iu.test(cursor)) {
      const absolute = this.#sameOriginUrl(cursor);
      return this.#pinBinding(absolute, binding);
    }
    const url = this.#sameOriginUrl(basePath);
    url.searchParams.set("cursor", cursor);
    return this.#pinBinding(url, binding);
  }

  #pinBinding(url: URL, binding?: EvaluationBinding): URL {
    if (binding === undefined) return url;
    url.searchParams.set("evaluationId", binding.evaluationId);
    url.searchParams.set("evaluationRevision", String(binding.evaluationRevision));
    url.searchParams.set("snapshotHash", binding.snapshotHash);
    return url;
  }

  #requireSameOriginLink(value: string, field: string): URL {
    try {
      return this.#sameOriginUrl(value);
    } catch (cause) {
      throw new ReportProtocolError({
        code: "UNSAFE_REPORT_LINK",
        message: `Refusing to follow ${field} to a different origin with the bearer credential.`,
        cause
      });
    }
  }

  #sameOriginUrl(value: string): URL {
    let url: URL;
    try {
      url = new URL(value, this.apiOrigin);
    } catch (cause) {
      throw new ReportProtocolError({
        code: "UNSAFE_REPORT_LINK",
        message: "The report contained an invalid URL.",
        cause
      });
    }
    this.#assertSameOrigin(url);
    return url;
  }

  #assertSameOrigin(url: URL): void {
    if (url.origin !== this.apiOrigin.origin || url.username !== "" || url.password !== "") {
      throw new ReportProtocolError({
        code: "UNSAFE_REPORT_LINK",
        message: "Refusing to follow a report link to a different origin with the bearer credential."
      });
    }
  }
}

function sameBinding(left: EvaluationBinding, right: EvaluationBinding): boolean {
  return (
    left.evaluationId === right.evaluationId &&
    left.evaluationRevision === right.evaluationRevision &&
    left.snapshotHash === right.snapshotHash
  );
}

class ClaimedCount {
  #value: number | null = null;

  observe(incoming: number | null): "ok" | "conflict" {
    if (incoming === null) return "ok";
    if (this.#value === null) {
      this.#value = incoming;
      return "ok";
    }
    return this.#value === incoming ? "ok" : "conflict";
  }

  get value(): number | null {
    return this.#value;
  }
}

function pinnedAttemptTotal(pages: readonly RunReport[]): number | null {
  const claimed = new ClaimedCount();
  for (const page of pages) {
    if (claimed.observe(page.page.totalAttempts) === "conflict") {
      return claimed.value;
    }
  }
  return claimed.value;
}

function retrievalRecoveryMessage(runId: string, detail: string): string {
  const message = `${detail} Retry: augmentworks run report ${runId} --json. Do not start another billed assessment.`;
  return message.length <= 500 ? message : message.slice(0, 500);
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null || header.trim() === "") return 1_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(header);
  if (!Number.isFinite(date)) return 1_000;
  return Math.max(0, date - Date.now());
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    throw new ReportProtocolError({
      code: "REPORT_PAGE_TOO_LARGE",
      message: "The report page exceeds the 512KiB bound."
    });
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new ReportProtocolError({
        code: "REPORT_PAGE_TOO_LARGE",
        message: "The report page exceeds the 512KiB bound."
      });
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new AwError({
      code: "INTERRUPTED",
      category: "local",
      message: "The report request was interrupted."
    });
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        new AwError({
          code: "INTERRUPTED",
          category: "local",
          message: "The report request was interrupted."
        })
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
