import { AwError } from "../errors.js";

export function mapReleasePolicyError(error: unknown): unknown {
  if (!(error instanceof AwError)) return error;
  const status = error.details?.["http_status"];
  if (typeof status !== "number") {
    if (error.code === "MISSING_BASELINE" && error.category !== "config") {
      return retarget(error, "MISSING_BASELINE", "config", error.message);
    }
    return error;
  }
  if (status === 401 || status === 403) {
    if (error.category === "auth") return error;
    return retarget(
      error,
      error.code === "CLOUD_AUTH_REJECTED" || error.code === "API_KEY_REVOKED"
        ? error.code
        : "CLOUD_AUTH_REJECTED",
      "auth",
      error.message
    );
  }
  if (status === 409) {
    return retarget(
      error,
      "PROMOTION_CONFLICT",
      "protocol",
      "The baseline pin changed. Re-read baseline status and retry with the current expectedPromotionRevision. This did not start a test or consume credits."
    );
  }
  if (status === 404) {
    const code =
      error.code === "MISSING_RUN" || error.code === "MISSING_BASELINE"
        ? error.code
        : "MISSING_BASELINE";
    return retarget(
      error,
      code,
      "config",
      code === "MISSING_RUN"
        ? "The candidate run was not found. Re-query the original run ID. This did not start a test or consume credits."
        : "The required baseline pin was not found. Comparison does not invent a pin or promote automatically."
    );
  }
  if (status === 400 || status === 422) {
    return retarget(
      error,
      error.code === "CLOUD_REQUEST_FAILED" ? "INVALID_COMPARISON_REQUEST" : error.code,
      "config",
      error.message
    );
  }
  return error;
}

export function createsBillableRunError(): AwError {
  return new AwError({
    code: "CREATES_BILLABLE_RUN",
    category: "protocol",
    message:
      "The comparison API advertised createsBillableRun. Observation commands must not start, reserve, or charge a run. No release decision was taken from this response."
  });
}

export function createForbiddenError(): AwError {
  return new AwError({
    code: "BASELINE_CREATE_FORBIDDEN",
    category: "auth",
    message:
      "This credential cannot create a baseline. Sign in as a workspace owner, or use a key the server grants baseline:create."
  });
}

export function promotionForbiddenError(): AwError {
  return new AwError({
    code: "PROMOTION_FORBIDDEN",
    category: "auth",
    message:
      "This credential cannot promote a baseline. Machine principals are read-only for pins unless the server grants baseline:promote. Promotion is never automatic."
  });
}

function retarget(
  error: AwError,
  code: string,
  category: AwError["category"],
  message: string
): AwError {
  return new AwError({
    code,
    category,
    message,
    retryable: error.retryable,
    ...(error.operation === undefined ? {} : { operation: error.operation }),
    ...(error.commandId === undefined ? {} : { commandId: error.commandId }),
    ...(error.details === undefined ? {} : { details: error.details }),
    cause: error
  });
}
