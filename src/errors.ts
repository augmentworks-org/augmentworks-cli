export type ErrorCategory =
  | "config"
  | "auth"
  | "relay"
  | "protocol"
  | "target"
  | "evidence"
  | "cleanup"
  | "local"
  | "billing";

export type OperationKind = "prepare" | "send" | "observe" | "cleanup";

export class AwError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly operation: OperationKind | undefined;
  readonly commandId: string | undefined;
  readonly details: Readonly<Record<string, string | number | boolean>> | undefined;
  #runId: string | undefined;

  constructor(options: {
    code: string;
    category: ErrorCategory;
    message: string;
    retryable?: boolean | undefined;
    operation?: OperationKind | undefined;
    commandId?: string | undefined;
    details?: Readonly<Record<string, string | number | boolean>> | undefined;
    runId?: string | undefined;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "AwError";
    this.code = options.code;
    this.category = options.category;
    this.retryable = options.retryable ?? false;
    this.operation = options.operation;
    this.commandId = options.commandId;
    this.details = options.details;
    this.#runId = options.runId;
  }

  /** The hosted run this error happened in, when one was bound (AUG-412). */
  get runId(): string | undefined {
    return this.#runId;
  }

  /** Records the run this error happened in. The first run recorded wins. */
  bindRunId(runId: string): this {
    this.#runId ??= runId;
    return this;
  }

  toSafeJSON(): Record<string, unknown> {
    return {
      code: this.code,
      category: this.category,
      safe_message: this.message,
      retryable: this.retryable,
      ...(this.#runId === undefined ? {} : { run_id: this.#runId }),
      ...(this.operation === undefined ? {} : { operation: this.operation }),
      ...(this.commandId === undefined ? {} : { command_id: this.commandId }),
      ...(this.details === undefined ? {} : { details: this.details })
    };
  }
}

/** Tags an error with the run it happened in, so the JSON error output names the run. */
export function withRunId(error: unknown, runId: string): unknown {
  if (error instanceof AwError) error.bindRunId(runId);
  return error;
}

export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  CONFIG: 2,
  AUTH: 3,
  RELAY: 4,
  TARGET: 5,
  CLEANUP: 6,
  ASSESSMENT_FAILED: 10,
  EVALUATION_INCOMPLETE: 11,
  EVALUATION_ERROR: 12,
  BILLING: 13,
  INTERRUPTED: 130
} as const;

export function exitCodeFor(error: unknown): number {
  if (!(error instanceof AwError)) return EXIT.INTERNAL;
  if (error.code === "EVALUATION_INCOMPLETE") return EXIT.EVALUATION_INCOMPLETE;
  if (error.code === "EVALUATION_ERROR") return EXIT.EVALUATION_ERROR;
  if (error.code === "ASSESSMENT_FAILED") return EXIT.ASSESSMENT_FAILED;
  switch (error.category) {
    case "config":
      return EXIT.CONFIG;
    case "auth":
      return EXIT.AUTH;
    case "relay":
    case "protocol":
      return EXIT.RELAY;
    case "target":
    case "evidence":
      return EXIT.TARGET;
    case "cleanup":
      return EXIT.CLEANUP;
    case "billing":
      return EXIT.BILLING;
    case "local":
      return error.code === "INTERRUPTED" ? EXIT.INTERRUPTED : EXIT.INTERNAL;
  }
}

export function sanitizeTerminal(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
