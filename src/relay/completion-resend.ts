import type { CloudClient, CommandCompletionBinding } from "../cloud/client.js";
import type { RelayProtocolVersion } from "../cloud/protocol.js";
import { AwError } from "../errors.js";
import type { JournalCommandState, RelayJournal } from "./journal.js";

const RESEND_ATTEMPTS = 5;
const RESEND_RETRY_CAP_MS = 10_000;

/** The server already closed the command with a result, whatever the run state. */
const CLOSED_CODES = new Set(["RUN_TERMINAL", "RELAY_CONFLICT"]);
/**
 * Once the server run is terminal, a replaced session or binding can never take the
 * result either. Accepting these keeps a run whose session was replaced from staying
 * stuck forever.
 */
const CLOSED_ON_TERMINAL_RUN_CODES = new Set(["STALE_FENCE", "RUN_BINDING_MISMATCH"]);

export type CompletionResendOutcome =
  /** `via` is "accepted" for an identical repeat, or the server code that proved closure. */
  | { readonly kind: "acknowledged"; readonly via: string }
  | { readonly kind: "rejected"; readonly error: AwError };

/**
 * Rebuilds the wire binding of a journaled command. The journal keeps no input or
 * idempotency key, but a completion is bound only by these fields and the
 * protocol version the run was created with.
 */
export function journaledCompletionBinding(
  state: JournalCommandState,
  protocolVersion: RelayProtocolVersion
): CommandCompletionBinding {
  const accepted = state.accepted;
  return {
    protocol_version: protocolVersion,
    command_id: accepted.command_id,
    session_id: accepted.session_id,
    run_id: accepted.run_id,
    packet: accepted.packet,
    config_sha256: accepted.config_sha256,
    sequence: accepted.sequence,
    fencing_epoch: accepted.fencing_epoch
  };
}

/**
 * AUG-404: re-sends the completion the journal recorded for a command whose
 * acknowledgement was lost, and appends `acknowledged` once the server either
 * accepts it as an identical repeat or proves the command already closed. Never
 * re-runs the operation itself. Retryable failures are retried a few times and
 * then thrown; any other rejection is returned and leaves the journal unchanged.
 */
export async function resendJournaledCompletion(options: {
  readonly cloud: Pick<CloudClient, "completeOperation" | "failOperation">;
  readonly journal: RelayJournal;
  readonly state: JournalCommandState;
  readonly protocolVersion: RelayProtocolVersion;
  readonly runTerminal: boolean;
  readonly signal?: AbortSignal | undefined;
}): Promise<CompletionResendOutcome> {
  const { state } = options;
  const completion = state.completion;
  if (completion === undefined) {
    throw new AwError({
      code: "JOURNAL_CORRUPT",
      category: "local",
      message: "A relay command without a durable completion cannot be re-sent."
    });
  }
  const command = journaledCompletionBinding(state, options.protocolVersion);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const ack =
        completion.disposition === "completed"
          ? await options.cloud.completeOperation(
              command,
              completion.result,
              completion.resultSha256,
              options.signal
            )
          : await options.cloud.failOperation(
              command,
              completion.error,
              completion.disposition,
              completion.resultSha256,
              options.signal
            );
      if (ack.command_id !== command.command_id) {
        throw new AwError({
          code: "COMMAND_ACK_MISMATCH",
          category: "protocol",
          message: "The relay acknowledged a different command.",
          operation: state.accepted.kind,
          commandId: command.command_id
        });
      }
      await options.journal.acknowledge(command.command_id);
      return { kind: "acknowledged", via: "accepted" };
    } catch (error) {
      if (!(error instanceof AwError)) throw error;
      if (
        CLOSED_CODES.has(error.code) ||
        (options.runTerminal && CLOSED_ON_TERMINAL_RUN_CODES.has(error.code))
      ) {
        await options.journal.acknowledge(command.command_id);
        return { kind: "acknowledged", via: error.code };
      }
      if (
        error.retryable &&
        error.code !== "RELAY_REQUEST_CANCELLED" &&
        attempt < RESEND_ATTEMPTS - 1 &&
        options.signal?.aborted !== true
      ) {
        await pause(retryPauseMs(error, attempt), options.signal);
        continue;
      }
      if (error.retryable || error.category === "auth") throw error;
      return { kind: "rejected", error };
    }
  }
}

function retryPauseMs(error: AwError, attempt: number): number {
  const advertised = error.details?.["retry_after_ms"];
  const backoff = Math.min(250 * 2 ** attempt, 2_000);
  return typeof advertised === "number"
    ? Math.min(Math.max(advertised, backoff), RESEND_RETRY_CAP_MS)
    : backoff;
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const interrupted = () =>
      new AwError({ code: "INTERRUPTED", category: "local", message: "The connector was interrupted." });
    if (signal?.aborted) {
      reject(interrupted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(interrupted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}
