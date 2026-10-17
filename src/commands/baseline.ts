import { Command } from "commander";

import { AwError, EXIT, exitCodeFor } from "../errors.js";
import {
  BASELINE_CREATE_ACTION,
  BASELINE_PROMOTE_ACTION,
  FEATURE_PACKAGE_VERSION,
  RELEASE_POLICY_SCHEMA_VERSION
} from "../baseline/schema.js";
import { normalizeApplicationsResponse } from "../baseline/applications.js";
import {
  createForbiddenError,
  createsBillableRunError,
  mapReleasePolicyError,
  promotionForbiddenError
} from "../baseline/errors.js";
import {
  applicationsSuccessJson,
  formatApplicationsHuman,
  formatCreatedHuman,
  formatPromotionHuman,
  observationFailureJson,
  portalBaselinesUrl,
  promotionSuccessJson
} from "../baseline/format.js";
import { parseBaselineName, parseBoundIdentifier, parseExpectedRevision } from "../baseline/ids.js";
import { normalizePromoteResponse } from "../baseline/protocol.js";
import {
  authenticateHostedSession,
  type HostedAuthDependencies,
  type HostedAuthOptions
} from "./hosted-auth.js";
import { addWorkspaceOption } from "../auth/workspace-expectation.js";

export interface BaselineCommandOptions extends HostedAuthOptions {
  readonly run?: string;
  readonly baseline?: string;
  readonly expectedRevision?: string;
  readonly name?: string;
  readonly application?: string;
  readonly environment?: string;
  readonly json?: boolean;
}

export interface BaselineCommandDependencies extends HostedAuthDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly setExitCode?: (code: number) => void;
}

export function createBaselineCommand(dependencies: BaselineCommandDependencies = {}): Command {
  const baseline = new Command("baseline").description(
    "Inspect pinned baselines, create the first pin from a finished run, or explicitly promote a candidate run as the pin"
  );
  addWorkspaceOption(
    baseline
      .command("status")
      .description("List application and baseline identities without selecting or promoting a pin")
      .option("--json", "write one machine-readable applications object to stdout")
      .option(
        "--allow-file-credentials",
        "allow a warned mode-0600 credential file when OS credential storage is unavailable"
      )
  ).action(async (values: BaselineCommandOptions) => {
    await executeBaseline("status", values, dependencies);
  });
  addWorkspaceOption(
    baseline
      .command("create")
      .description(
        "Create a named baseline pin from a finished, fully graded run. Does not start a test or consume credits"
      )
      .option("--run <run-id>", "finished run to pin")
      .option("--name <name>", "baseline name, for example main")
      .option("--application <name>", "application name; created if it does not exist")
      .option("--environment <name>", "environment name, for example production; created if it does not exist")
      .option("--json", "write one machine-readable baseline object to stdout")
      .option(
        "--allow-file-credentials",
        "allow a warned mode-0600 credential file when OS credential storage is unavailable"
      )
  ).action(async (values: BaselineCommandOptions) => {
    await executeBaseline("create", values, dependencies);
  });
  addWorkspaceOption(
    baseline
      .command("promote")
      .description(
        "Promote an explicit candidate run onto a baseline pin when the credential allows it. Never automatic"
      )
      .option("--run <run-id>", "candidate run ID")
      .option("--baseline <baseline-id>", "baseline pin ID")
      .option("--expected-revision <n>", "current promotion revision to refuse stale concurrent updates")
      .option("--json", "write one machine-readable promotion object to stdout")
      .option(
        "--allow-file-credentials",
        "allow a warned mode-0600 credential file when OS credential storage is unavailable"
      )
  ).action(async (values: BaselineCommandOptions) => {
    await executeBaseline("promote", values, dependencies);
  });
  return baseline;
}

async function executeBaseline(
  action: "status" | "create" | "promote",
  values: BaselineCommandOptions,
  dependencies: BaselineCommandDependencies
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
    const session = await authenticateHostedSession(values, dependencies);
    if (action === "status") {
      const raw =
        values.signal === undefined
          ? await session.cloud.listApplications()
          : await session.cloud.listApplications(values.signal);
      const document = normalizeApplicationsResponse(raw);
      const portalUrl = portalBaselinesUrl(session.apiOrigin);
      if (json) stdout.write(applicationsSuccessJson(document, portalUrl));
      else stdout.write(formatApplicationsHuman(document, portalUrl));
      return;
    }
    if (action === "create") {
      const runId = parseBoundIdentifier(values.run, "run");
      const name = parseBaselineName(values.name, "name");
      const applicationName = parseBaselineName(values.application, "application");
      const environmentName = parseBaselineName(values.environment, "environment");
      const actions = session.identity.actions;
      if (actions !== undefined && !actions.includes(BASELINE_CREATE_ACTION)) {
        throw createForbiddenError();
      }
      const request = {
        schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
        packageVersion: FEATURE_PACKAGE_VERSION,
        name,
        applicationName,
        environmentName,
        runId
      } as const;
      const raw =
        values.signal === undefined
          ? await session.cloud.createBaseline(request)
          : await session.cloud.createBaseline(request, values.signal);
      const result = normalizePromoteResponse(raw);
      if (result.createsBillableRun === true) throw createsBillableRunError();
      const returnedRun = result.candidateRunId ?? result.runId;
      if (returnedRun !== undefined && returnedRun !== runId) {
        throw new AwError({
          code: "RELEASE_IDENTITY_MISMATCH",
          category: "protocol",
          message: "AugmentWorks returned a baseline for a different run."
        });
      }
      if (json) stdout.write(promotionSuccessJson(result, "created"));
      else stdout.write(formatCreatedHuman(result));
      return;
    }
    const candidateRunId = parseBoundIdentifier(values.run, "run");
    const baselineId = parseBoundIdentifier(values.baseline, "baseline");
    const expectedPromotionRevision = parseExpectedRevision(values.expectedRevision);
    const actions = session.identity.actions;
    if (actions !== undefined && !actions.includes(BASELINE_PROMOTE_ACTION)) {
      throw promotionForbiddenError();
    }
    const request = {
      schemaVersion: RELEASE_POLICY_SCHEMA_VERSION,
      packageVersion: FEATURE_PACKAGE_VERSION,
      runId: candidateRunId,
      expectedPromotionRevision
    } as const;
    const raw =
      values.signal === undefined
        ? await session.cloud.promoteBaseline(baselineId, request)
        : await session.cloud.promoteBaseline(baselineId, request, values.signal);
    const result = normalizePromoteResponse(raw);
    if (result.createsBillableRun === true) throw createsBillableRunError();
    const returnedRun = result.candidateRunId ?? result.runId;
    if (returnedRun !== undefined && returnedRun !== candidateRunId) {
      throw new AwError({
        code: "RELEASE_IDENTITY_MISMATCH",
        category: "protocol",
        message: "AugmentWorks returned a promotion for a different candidate run."
      });
    }
    const returnedBaseline = result.baselineId;
    if (returnedBaseline !== undefined && returnedBaseline !== baselineId) {
      throw new AwError({
        code: "RELEASE_IDENTITY_MISMATCH",
        category: "protocol",
        message: "AugmentWorks returned a promotion for a different baseline pin."
      });
    }
    if (json) stdout.write(promotionSuccessJson(result));
    else stdout.write(formatPromotionHuman(result));
  } catch (error) {
    const mapped = mapReleasePolicyError(error);
    const awError =
      mapped instanceof AwError
        ? mapped
        : new AwError({
            code: "INTERNAL",
            category: "local",
            message: "The baseline command could not be completed."
          });
    if (!json) throw awError;
    stdout.write(observationFailureJson(awError, exitCodeFor(awError)));
    stderr.write(`${awError.message}\n`);
    if (exitCodeFor(awError) !== EXIT.OK) setExitCode(exitCodeFor(awError));
  }
}
