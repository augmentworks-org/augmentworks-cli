import { AwError, EXIT, exitCodeFor } from "../errors.js";
import {
  COMPARISON_SCHEMA_VERSION,
  FEATURE_PACKAGE_VERSION,
  RELEASE_POLICY_SCHEMA_VERSION
} from "./schema.js";
import { classifyComparison, classifyReleasePolicy } from "./classify.js";
import { createsBillableRunError, mapReleasePolicyError } from "./errors.js";
import {
  formatReleasePolicyHuman,
  observationFailureJson,
  portalCompareUrl,
  releasePolicyStderrHint,
  releasePolicySuccessJson
} from "./format.js";
import { parseBoundIdentifier } from "./ids.js";
import { normalizeReleasePolicyDocument } from "./protocol.js";
import { parseTimeoutMs, waitForOriginalRun } from "./wait.js";
import {
  authenticateHostedSession,
  type HostedAuthDependencies,
  type HostedAuthOptions
} from "../commands/hosted-auth.js";

export interface PolicyCommandOptions extends HostedAuthOptions {
  readonly run?: string;
  readonly baseline?: string;
  readonly json?: boolean;
  readonly wait?: boolean;
  readonly timeoutMs?: string;
}

export interface PolicyCommandDependencies extends HostedAuthDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly setExitCode?: (code: number) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function runReleasePolicyCommand(
  command: "compare" | "gate",
  values: PolicyCommandOptions,
  dependencies: PolicyCommandDependencies = {}
): Promise<void> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const json = values.json === true;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  try {
    const candidateRunId = parseBoundIdentifier(values.run, "run");
    const baselineId = parseBoundIdentifier(values.baseline, "baseline");
    if (command === "compare" && values.wait === true) {
      throw new AwError({
        code: "WAIT_UNSUPPORTED",
        category: "config",
        message: "Use `gate --wait` to wait on the original run before evaluating the release policy."
      });
    }
    const session = await authenticateHostedSession(values, dependencies);
    if (command === "gate" && values.wait === true) {
      await waitForOriginalRun({
        session,
        runId: candidateRunId,
        timeoutMs: parseTimeoutMs(values.timeoutMs),
        ...(values.signal === undefined ? {} : { signal: values.signal }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep })
      });
    }
    const raw =
      command === "compare"
        ? values.signal === undefined
          ? await session.cloud.evaluateComparison({
              schemaVersion: COMPARISON_SCHEMA_VERSION,
              packageVersion: FEATURE_PACKAGE_VERSION,
              candidateRunId,
              baselineId
            })
          : await session.cloud.evaluateComparison(
              {
                schemaVersion: COMPARISON_SCHEMA_VERSION,
                packageVersion: FEATURE_PACKAGE_VERSION,
                candidateRunId,
                baselineId
              },
              values.signal
            )
        : values.signal === undefined
          ? await session.cloud.evaluateReleaseGate({
              schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
              packageVersion: FEATURE_PACKAGE_VERSION,
              candidateRunId,
              baselineId
            })
          : await session.cloud.evaluateReleaseGate(
              {
                schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
                packageVersion: FEATURE_PACKAGE_VERSION,
                candidateRunId,
                baselineId
              },
              values.signal
            );
    const document = normalizeReleasePolicyDocument(raw, { candidateRunId, baselineId });
    if (document.createsBillableRun) throw createsBillableRunError();
    const classification =
      command === "compare" ? classifyComparison(document) : classifyReleasePolicy(document);
    const portalUrl = document.portalUrl ?? portalCompareUrl(session.apiOrigin, candidateRunId, baselineId);
    if (json) {
      stdout.write(
        releasePolicySuccessJson(document, classification, { command, portalUrl })
      );
      const hint = releasePolicyStderrHint(document, classification, command);
      if (hint !== "") stderr.write(hint);
    } else {
      stdout.write(formatReleasePolicyHuman(document, classification, { command, portalUrl }));
    }
    if (classification.exitCode !== EXIT.OK) setExitCode(classification.exitCode);
  } catch (error) {
    const mapped = mapReleasePolicyError(error);
    const awError =
      mapped instanceof AwError
        ? mapped
        : new AwError({
            code: "INTERNAL",
            category: "local",
            message: "The comparison command could not be completed."
          });
    if (!json) throw awError;
    stdout.write(observationFailureJson(awError, exitCodeFor(awError)));
    stderr.write(
      `${awError.message} Re-query the original run ID. Do not start another billed assessment.\n`
    );
    setExitCode(exitCodeFor(awError));
  }
}
