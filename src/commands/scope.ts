import { readFile, rename, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { Command, Option } from "commander";

import { inspectCredentialEnvironment } from "../auth/credential-store.js";
import { addWorkspaceOption } from "../auth/workspace-expectation.js";
import { AwError, exitCodeFor, sanitizeTerminal } from "../errors.js";
import type { ExecutionScope } from "../real-data/documents.js";
import {
  askOnTerminal,
  ownerLoginRequiredError,
  parseEnvironment,
  shellWord
} from "../target/common.js";
import {
  DATA_ORIGIN_CHOICES,
  portalDataPolicyUrl,
  portalTargetsUrl,
  TARGET_ENVIRONMENTS,
  type CreateScopeRequest,
  type DataOrigin,
  type DataPolicySummary,
  type TargetDetail
} from "../target/protocol.js";
import { sizeScopeBudget, suiteWorkload, type SuiteWorkload } from "../target/scope-budget.js";
import { writeSuiteScope } from "../target/suite-scope.js";
import { selectTarget } from "../target/verify.js";
import {
  authenticateHostedSession,
  isHeadlessEnvironment,
  type HostedAuthDependencies,
  type HostedAuthOptions
} from "./hosted-auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A new test scope lasts this long unless the target's authority ends sooner, as in the portal. */
export const SCOPE_DEFAULT_DAYS = 30;

export interface ScopeCreateOptions extends HostedAuthOptions {
  readonly target?: string;
  readonly suite?: string;
  readonly environment?: string;
  readonly policy?: string;
  readonly dataOrigin?: string;
  readonly expires?: string;
  readonly yes?: boolean;
  readonly json?: boolean;
}

export interface ScopeDependencies extends HostedAuthDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly setExitCode?: (code: number) => void;
  readonly interactive?: boolean;
  readonly ask?: (question: string) => Promise<string>;
  readonly now?: () => number;
}

export interface ScopeCreateResult {
  readonly scope: ExecutionScope;
  readonly suitePath: string;
  readonly targetName: string;
  readonly policy: DataPolicySummary;
  readonly next: string;
}

export function createScopeCommand(dependencies: ScopeDependencies = {}): Command {
  const scope = new Command("scope").description("Create test scopes for verified targets");
  addWorkspaceOption(
    scope
      .command("create")
      .description(
        "Create a test scope for a verified target and write it into an aw-suite/3 file. Needs a workspace owner's login. Does not start a test or consume credits"
      )
      .option("--target <name>", "the verified target's name")
      .option("--suite <file>", "the aw-suite/3 file to write the scope into")
      .addOption(new Option("--env <environment>", "which environment, when the name is in more than one").choices([...TARGET_ENVIRONMENTS]))
      .option("--policy <policy-id>", "data policy to use instead of the workspace's current one")
      .addOption(
        new Option("--data-origin <origin>", "where the test data comes from")
          .choices([...DATA_ORIGIN_CHOICES])
          .default("constructed")
      )
      .option("--expires <date>", "last day of the scope, YYYY-MM-DD (default: 30 days, or when the target's verification ends)")
      .option("--yes", "create it without asking, after showing what it allows")
      .option("--json", "write one machine-readable scope object to stdout")
      .option(
        "--allow-file-credentials",
        "allow a warned mode-0600 credential file when OS credential storage is unavailable"
      )
  ).action(async (values: Omit<ScopeCreateOptions, "env" | "environment"> & { env?: string }) => {
    const { env: environment, ...rest } = values;
    await executeScopeCreate({ ...rest, ...(environment === undefined ? {} : { environment }) }, dependencies);
  });
  return scope;
}

async function executeScopeCreate(options: ScopeCreateOptions, dependencies: ScopeDependencies): Promise<void> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const json = options.json === true;
  try {
    const result = await runScopeCreate(options, dependencies);
    stdout.write(json ? `${JSON.stringify(scopeCreateJson(result))}\n` : formatScopeCreateHuman(result));
  } catch (error) {
    const awError =
      error instanceof AwError
        ? error
        : new AwError({ code: "INTERNAL", category: "local", message: "The test scope could not be created." });
    if (!json) throw awError;
    stdout.write(
      `${JSON.stringify({ ok: false, error: { code: awError.code, message: awError.message }, exitCode: exitCodeFor(awError) })}\n`
    );
    stderr.write(`${sanitizeTerminal(awError.message)}\n`);
    (dependencies.setExitCode ?? ((code: number) => (process.exitCode = code)))(exitCodeFor(awError));
  }
}

/**
 * `scope create`: creates an informational test scope for a verified target
 * and writes its id into the suite file, so nobody copies scope ids by hand.
 */
export async function runScopeCreate(
  options: ScopeCreateOptions,
  dependencies: ScopeDependencies = {}
): Promise<ScopeCreateResult> {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const stderr = dependencies.stderr ?? process.stderr;
  const now = (dependencies.now ?? Date.now)();
  const targetName = required(options.target, "--target <name>", "the verified target's name");
  const suiteFile = required(options.suite, "--suite <file>", "the aw-suite/3 file to write the scope into");
  const environment = options.environment === undefined ? undefined : parseEnvironment(options.environment);
  const dataOrigin = (options.dataOrigin ?? "constructed") as DataOrigin;
  if (!(DATA_ORIGIN_CHOICES as readonly string[]).includes(dataOrigin)) {
    throw configError("--data-origin must be constructed, customer_records or mixed.");
  }
  const suitePath = resolve(cwd, suiteFile);
  const source = await readSuite(suitePath);
  // Fail on a file the CLI can't update before anything is created on the server.
  writeSuiteScope(source, { scopeId: "00000000-0000-4000-8000-000000000000", revision: 1 });
  const workload = suiteWorkload(source);
  const budget = sizeScopeBudget(workload);

  if (inspectCredentialEnvironment(env).mode === "api_key") throw ownerLoginRequiredError("Creating a test scope");
  const session = await authenticateHostedSession(options, { ...dependencies, stderr });
  if (session.identity.principalKind === "machine" || session.source === "api_key") {
    throw ownerLoginRequiredError("Creating a test scope");
  }
  const workspaceId = session.identity.workspaceId;
  const targetsUrl = portalTargetsUrl(session.apiOrigin);

  const statement = await session.cloud.getRealDataStatement(workspaceId, options.signal);
  if (!statement.accepted) {
    throw new AwError({
      code: "STATEMENT_NOT_ACCEPTED",
      category: "auth",
      message: `This workspace hasn't accepted the real-data statement, so it can't have test scopes yet. Accept it by running \`augmentworks target add\` in a terminal, or at ${targetsUrl}.`
    });
  }
  const targets = await session.cloud.listTargets(workspaceId, options.signal);
  const selected = selectTarget(targets, targetName, environment);
  const detail = await session.cloud.getTargetDetail(workspaceId, selected.targetId, options.signal);
  assertVerified(detail, now);

  const policies = await session.cloud.listDataPolicies(workspaceId, options.signal);
  const policy = choosePolicy(policies, options.policy, portalDataPolicyUrl(session.apiOrigin));
  const expiresAt = scopeExpiry(options.expires, detail.authority.expiresAt, now);
  const request: CreateScopeRequest = {
    targetId: detail.target.targetId,
    authorityId: detail.authority.authorityId,
    authorityRevision: detail.authority.revision,
    dataPolicyId: policy.policyId,
    dataPolicyRevision: policy.revision,
    environment: detail.target.environment,
    dataOrigin,
    effects: "informational",
    actionPolicyId: null,
    budget,
    expiresAt
  };
  stderr.write(formatScopePlan(detail, policy, request, workload));
  await confirm(options, dependencies, env);

  const scope = await session.cloud.createExecutionScope(workspaceId, request, options.signal);
  if (scope.targetId !== detail.target.targetId || scope.workspaceId !== workspaceId) {
    throw new AwError({
      code: "INVALID_CLOUD_RESPONSE",
      category: "protocol",
      message: "AugmentWorks returned a scope for a different target or workspace. Nothing was written to the suite file."
    });
  }
  // Re-read the suite so an edit made while confirming isn't lost.
  const updated = writeSuiteScope(await readSuite(suitePath), { scopeId: scope.scopeId, revision: scope.revision });
  const temporary = `${suitePath}.${process.pid}.tmp`;
  await writeFile(temporary, updated, "utf8");
  await rename(temporary, suitePath);
  const shown = relative(cwd, suitePath) || suitePath;
  return {
    scope,
    suitePath: shown,
    targetName: detail.target.name,
    policy,
    next: `augmentworks test --suite ${shellWord(shown)}`
  };
}

function required(value: string | undefined, flag: string, what: string): string {
  if (value === undefined || value.trim() === "") throw configError(`Pass ${flag}: ${what}.`);
  return value.trim();
}

function configError(message: string): AwError {
  return new AwError({ code: "SCOPE_OPTIONS_INVALID", category: "config", message });
}

async function readSuite(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new AwError({
      code: "SUITE_SCOPE_WRITE_FAILED",
      category: "config",
      message: `Can't read the suite file ${path}.`
    });
  }
}

function assertVerified(detail: TargetDetail, now: number): void {
  const name = sanitizeTerminal(detail.target.name);
  if (detail.target.status !== "verified") {
    throw new AwError({
      code: "TARGET_NOT_VERIFIED",
      category: "auth",
      message: `${name} isn't verified yet, so it can't have a test scope. Run \`augmentworks target verify ${shellWord(detail.target.name)}\` first.`
    });
  }
  if (Date.parse(detail.authority.expiresAt) <= now) {
    throw new AwError({
      code: "TARGET_AUTHORITY_EXPIRED",
      category: "auth",
      message: `${name}'s verification ended on ${detail.authority.expiresAt}. Renew it with \`augmentworks target verify ${shellWord(detail.target.name)}\` once a renewal is open in Settings → Targets.`
    });
  }
}

function choosePolicy(
  policies: readonly DataPolicySummary[],
  requested: string | undefined,
  policyUrl: string
): DataPolicySummary {
  if (requested !== undefined) {
    const match = policies.find((policy) => policy.policyId === requested.trim());
    if (match === undefined) {
      throw new AwError({
        code: "DATA_POLICY_NOT_FOUND",
        category: "config",
        message: `This workspace has no data policy ${sanitizeTerminal(requested)}. See its policies at ${policyUrl}.`
      });
    }
    return match;
  }
  const current = policies[0];
  if (current === undefined) {
    throw new AwError({
      code: "DATA_POLICY_NOT_FOUND",
      category: "config",
      message: `This workspace has no data policy yet. Set one at ${policyUrl}, then run this again.`
    });
  }
  return current;
}

function scopeExpiry(requested: string | undefined, authorityExpiresAt: string, now: number): string {
  const latest = Date.parse(authorityExpiresAt);
  let wanted: number;
  if (requested === undefined) {
    wanted = now + SCOPE_DEFAULT_DAYS * DAY_MS;
  } else {
    const endOfDay = /^\d{4}-\d{2}-\d{2}$/u.test(requested) ? Date.parse(`${requested}T23:59:59Z`) : Number.NaN;
    if (Number.isNaN(endOfDay) || endOfDay <= now) {
      throw configError("--expires must be a future date written YYYY-MM-DD.");
    }
    wanted = endOfDay;
  }
  return `${new Date(Math.min(wanted, latest)).toISOString().slice(0, 19)}Z`;
}

const ORIGIN_WORDS: Record<DataOrigin, string> = {
  constructed: "made-up test data",
  customer_records: "real customer records",
  mixed: "made-up data and real customer records"
};

function formatScopePlan(
  detail: TargetDetail,
  policy: DataPolicySummary,
  request: CreateScopeRequest,
  workload: SuiteWorkload
): string {
  const budget = request.budget;
  return [
    `This creates a test scope for ${sanitizeTerminal(detail.target.name)} (${detail.target.environment}) at ${sanitizeTerminal(detail.target.assessedIdentity)}:`,
    `  Data policy:  ${policy.policyId} revision ${policy.revision} (${sanitizeTerminal(policy.dataClass)} data, kept ${policy.retentionDays} days)`,
    `  Data origin:  ${request.dataOrigin} (${ORIGIN_WORDS[request.dataOrigin]})`,
    "  Effects:      informational (sends messages and checks replies, no actions)",
    `  Expires:      ${request.expiresAt}`,
    `  Budget:       ${count(budget.maxMessages, "message")}, ${count(budget.maxActions, "action")}, ${count(budget.maxCommands, "command")}, ${count(budget.maxRuntimeSeconds, "second")}, ${count(budget.maxCredits, "credit")} per run,`,
    `                sized to one run of this suite (${count(workload.cases, "case")}). A run that needs more is refused before anything is sent.`,
    ""
  ].join("\n");
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

async function confirm(options: ScopeCreateOptions, dependencies: ScopeDependencies, env: NodeJS.ProcessEnv): Promise<void> {
  if (options.yes === true) return;
  const interactive =
    dependencies.interactive ??
    (!isHeadlessEnvironment(env, options) && process.stdin.isTTY === true && process.stderr.isTTY === true);
  if (!interactive) {
    throw new AwError({
      code: "SCOPE_CONFIRMATION_REQUIRED",
      category: "config",
      message: "Without a prompt, pass --yes to create this scope. Nothing was created."
    });
  }
  const answer = await (dependencies.ask ?? askOnTerminal)("Create this scope? Type yes: ");
  if (!/^(y|yes)$/iu.test(answer.trim())) {
    throw new AwError({ code: "SCOPE_NOT_CREATED", category: "config", message: "Nothing was created." });
  }
}

export function formatScopeCreateHuman(result: ScopeCreateResult): string {
  return [
    `Created scope ${result.scope.scopeId} (revision ${result.scope.revision}) for ${sanitizeTerminal(result.targetName)}, and wrote it into ${sanitizeTerminal(result.suitePath)}.`,
    `It expires at ${result.scope.expiresAt}.`,
    `Next: ${result.next}`,
    ""
  ].join("\n");
}

export function scopeCreateJson(result: ScopeCreateResult): Record<string, unknown> {
  return {
    ok: true,
    scopeId: result.scope.scopeId,
    revision: result.scope.revision,
    target: result.targetName,
    environment: result.scope.environment,
    dataPolicyId: result.scope.dataPolicy.id,
    dataOrigin: result.scope.dataOrigin,
    effects: result.scope.effects,
    budget: result.scope.budget,
    expiresAt: result.scope.expiresAt,
    suite: result.suitePath,
    next: result.next
  };
}
