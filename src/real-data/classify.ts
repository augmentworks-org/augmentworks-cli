import { AwError, EXIT } from "../errors.js";
import { isRealDataErrorCode, PLAIN_RECOVERY_CODES, recoveryAdvice } from "./errors.js";
import type { RealDataErrorCode } from "./constants.js";
import { gradingStillPending, type JudgeJobProgress } from "../outcome/classify.js";

export const REAL_DATA_FAILURE_CLASSES = [
  "blocked_setup",
  "revoked_authority",
  "budget_exhausted",
  "execution_timeout",
  "pending_grading",
  "insufficient_evidence",
  "test_failure"
] as const;

export type RealDataFailureClass = (typeof REAL_DATA_FAILURE_CLASSES)[number];

export type ClassifiedRealDataFailure = {
  readonly class: RealDataFailureClass;
  readonly code: string;
  readonly fix: string;
  readonly exitCode: number;
};

const FIX: Record<RealDataErrorCode, { readonly class: RealDataFailureClass; readonly fix: string }> = {
  UNSUPPORTED_EXECUTION_SCOPE: {
    class: "blocked_setup",
    fix: "Ask the workspace owner to advertise aw-execution-scope/1, or run `augmentworks test --local --packet <aw-packet/local-authorized-1>`."
  },
  INVALID_EXECUTION_SCOPE: {
    class: "blocked_setup",
    fix: "Re-fetch the server-admitted scope. Do not reconstruct authority from YAML. `augmentworks suite preflight` checks the binding without contacting the target."
  },
  UNSUPPORTED_DATA_POLICY: {
    class: "blocked_setup",
    fix: "Admit aw-data-policy/1 only. Unknown policies fail closed."
  },
  TARGET_AUTHORITY_REQUIRED: {
    class: "blocked_setup",
    fix: recoveryAdvice("TARGET_AUTHORITY_REQUIRED", "")
  },
  TARGET_AUTHORITY_REVOKED: {
    class: "revoked_authority",
    fix: recoveryAdvice("TARGET_AUTHORITY_REVOKED", "")
  },
  TARGET_AUTHORITY_EXPIRED: {
    class: "revoked_authority",
    fix: recoveryAdvice("TARGET_AUTHORITY_EXPIRED", "")
  },
  TARGET_SCOPE_MISMATCH: {
    class: "blocked_setup",
    fix: recoveryAdvice("TARGET_SCOPE_MISMATCH", "")
  },
  DATA_POLICY_FORBIDDEN: {
    class: "blocked_setup",
    fix: "Choose an approved data policy. Do not disable redaction."
  },
  ACTION_BOUNDARY_REQUIRED: {
    class: "blocked_setup",
    fix: "This scope does not permit that operation. Do not run cleanup unless the admitted scope allows it."
  },
  ACTION_NOT_ALLOWED: {
    class: "blocked_setup",
    fix: "This scope does not permit that operation. Controlled actions are a later integration."
  },
  EXECUTION_SCOPE_STALE: {
    class: "blocked_setup",
    fix: "Re-fetch the server-admitted scope for this suite/config/quote/run binding."
  },
  DATA_POLICY_STALE: {
    class: "blocked_setup",
    fix: "Fetch the current policy and profile hashes from the admitted scope, then request a new quote."
  },
  REDACTION_PROFILE_MISMATCH: {
    class: "blocked_setup",
    fix: "Fetch the current redaction profile hash from the admitted scope."
  },
  QUOTE_SCOPE_MISMATCH: {
    class: "blocked_setup",
    fix: "Request a new quote for the current suite revision, target boundary, and scope hash. Do not raise --max-credits to bypass the mismatch."
  },
  EVIDENCE_REPRESENTATION_MISMATCH: {
    class: "insufficient_evidence",
    fix: "Inspect this original run with `augmentworks run report <run-id> --scope authorized-1`. Do not start another billed test to retrieve a report."
  },
  ACTION_OUTCOME_INDETERMINATE: {
    class: "execution_timeout",
    fix: "The send already started without a durable outcome. It is not replayable. Inspect the original run; do not retry the charged test."
  },
  DATA_POLICY_BLOCKED: {
    class: "blocked_setup",
    fix: "Content was blocked by the selected policy. The run is not restarted. Preview locally; do not upload raw customer content."
  },
  INSUFFICIENT_EVIDENCE: {
    class: "insufficient_evidence",
    fix: "Wait for grading on this same run (`augmentworks run wait <run-id>`), then `augmentworks run report <run-id>`. Do not re-run a charged test to obtain a report."
  },
  EXECUTION_BUDGET_EXHAUSTED: {
    class: "budget_exhausted",
    fix: recoveryAdvice("EXECUTION_BUDGET_EXHAUSTED", "")
  },
  EXECUTION_RELEASE_UNAVAILABLE: {
    class: "blocked_setup",
    fix: recoveryAdvice("EXECUTION_RELEASE_UNAVAILABLE", "")
  },
  HOSTED_AUTHORITY_INTERCHANGE_FORBIDDEN: {
    class: "blocked_setup",
    fix: "Use `augmentworks test --suite` for hosted aw-execution-scope/1 or `augmentworks test --local --packet` for aw-local-execution-scope/1."
  },
  LOCAL_SCOPE_REVOKED: {
    class: "revoked_authority",
    fix: "This local scope was revoked on this machine. Remote revocation is not observed while offline."
  },
  PRIVACY_SERVICE_UNAVAILABLE: {
    class: "blocked_setup",
    fix: "Minimization requires the privacy service. Credential-only redaction remains. Do not upload verbatim customer records."
  }
};

export function classifyRealDataFailure(error: AwError): ClassifiedRealDataFailure | undefined {
  if (!isRealDataErrorCode(error.code)) return undefined;
  const mapped = FIX[error.code];
  return {
    class: mapped.class,
    code: error.code,
    // These codes cover several situations, so the advice follows the message (AUG-366).
    fix: PLAIN_RECOVERY_CODES.has(error.code) ? recoveryAdvice(error.code, error.message) : mapped.fix,
    exitCode: exitCodeForClass(mapped.class, error)
  };
}

export function hostedOutcomeFailureClass(options: {
  readonly executionStatus: string;
  readonly evaluationStatus?: string | null;
  readonly outcome?: string | null;
  /** AUG-403: partial with every judge job done has finished grading. */
  readonly judgeJobs?: JudgeJobProgress | null;
}): RealDataFailureClass | undefined {
  const evaluation = options.evaluationStatus ?? "absent";
  if (options.executionStatus === "failed" && options.outcome === "error") return "test_failure";
  if (gradingStillPending(evaluation, options.judgeJobs)) return "pending_grading";
  if (options.executionStatus === "failed" || options.outcome === "failed") return "test_failure";
  if (options.outcome === "inconclusive") return "insufficient_evidence";
  if (evaluation === "partial") return "insufficient_evidence";
  return undefined;
}

function exitCodeForClass(failureClass: RealDataFailureClass, error: AwError): number {
  switch (failureClass) {
    case "revoked_authority":
      return EXIT.AUTH;
    case "budget_exhausted":
    case "execution_timeout":
      return EXIT.RELAY;
    case "insufficient_evidence":
    case "pending_grading":
      return EXIT.EVALUATION_INCOMPLETE;
    case "test_failure":
      return EXIT.ASSESSMENT_FAILED;
    default:
      return error.category === "auth" ? EXIT.AUTH : EXIT.CONFIG;
  }
}
