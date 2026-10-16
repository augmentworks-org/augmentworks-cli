import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { Command, Option } from "commander";
import { parseDocument } from "yaml";

import { inspectCredentialEnvironment } from "../auth/credential-store.js";
import { addWorkspaceOption, formatWorkspaceLabel } from "../auth/workspace-expectation.js";
import type { ResolvedConfig } from "../config/types.js";
import { AwError, exitCodeFor, sanitizeTerminal } from "../errors.js";
import { canonicalAssessedOrigin, configuredEndpoints } from "../real-data/boundary.js";
import { sealDocumentHash } from "../real-data/canonical.js";
import { TARGET_BOUNDARY_SCHEMA_VERSION } from "../real-data/constants.js";
import { isLocalOrPrivateHost } from "../config/resolve.js";
import {
  PERMISSION_REF_PATTERN,
  portalTargetsUrl,
  TARGET_ENVIRONMENTS,
  TARGET_LIMITS,
  type RealDataStatement,
  type RegisterTargetRequest,
  type StoredTarget,
  type TargetDetail,
  type TargetEnvironment,
  type TargetScopeSummary,
  type TargetRegistration,
  type VerificationMethod
} from "../target/protocol.js";
import {
  askOnTerminal,
  loadTargetConfig,
  ownerLoginRequiredError,
  parseEnvironment,
  shellWord,
  type TargetDoctor
} from "../target/common.js";
import { mergeTargetIntoConfig, newConfigFromTarget, PLACEHOLDER_MARKER, type PullResult } from "../target/pull.js";
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  selectTarget,
  verifyTarget,
  type VerifyTargetOutcome,
  type VerifyWaitDependencies
} from "../target/verify.js";
import {
  authenticateHostedSession,
  isHeadlessEnvironment,
  type HostedAuthDependencies,
  type HostedAuthOptions
} from "./hosted-auth.js";

export interface TargetAddOptions extends HostedAuthOptions {
  readonly config?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The `--env` flag: which environment of the agent this is. */
  readonly environment?: string;
  readonly attest?: string;
  readonly permissionRef?: string;
  readonly method?: string;
  readonly yes?: boolean;
  readonly json?: boolean;
}

export interface TargetDependencies extends HostedAuthDependencies {
  readonly doctor?: TargetDoctor;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly setExitCode?: (code: number) => void;
  /** Whether a person can answer questions. Defaults to a TTY outside CI. */
  readonly interactive?: boolean;
  /** Asks one question and returns the typed answer. */
  readonly ask?: (question: string) => Promise<string>;
  readonly newId?: () => string;
  /** Local checks, waits and the private-address probe for `target verify`. */
  readonly verify?: VerifyWaitDependencies;
  readonly signals?: { on(event: "SIGINT", listener: () => void): unknown; off(event: "SIGINT", listener: () => void): unknown };
}

export interface TargetAddResult {
  readonly registration: TargetRegistration;
  readonly name: string;
  readonly environment: TargetEnvironment;
  readonly assessedIdentity: string;
  readonly verificationMethod: VerificationMethod;
  readonly statementAccepted: boolean;
  readonly next: string;
}

type Attestation =
  | { readonly kind: "owned_target" }
  | { readonly kind: "written_permission"; readonly permissionRef: string };

export function createTargetCommand(dependencies: TargetDependencies = {}): Command {
  const target = new Command("target").description(
    "Register the agent in augmentworks.yaml as a workspace target for authorized real-data tests"
  );
  addWorkspaceOption(
    target
      .command("add")
      .description(
        "Register the target in augmentworks.yaml (name, base_url and every operation) with the workspace. Needs a workspace owner's login"
      )
      .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
      .addOption(
        new Option("--env <environment>", "which environment of the agent this is").choices([...TARGET_ENVIRONMENTS])
      )
      .addOption(
        new Option(
          "--attest <kind>",
          "whose agent it is, without a prompt: owned, or written (a client's, with their written permission)"
        ).choices(["owned", "written"])
      )
      .option("--permission-ref <ref>", "reference for the written permission, such as a contract number (not the document)")
      .addOption(
        new Option("--method <method>", "how a public address is verified: an HTTPS file or a DNS TXT record")
          .choices(["https", "dns"])
          .default("https")
      )
      .addOption(new Option("--yes").hideHelp())
      .option("--json", "write one machine-readable registration object to stdout")
      .option(
        "--allow-file-credentials",
        "allow a warned mode-0600 credential file when OS credential storage is unavailable"
      )
  ).action(async (values: Omit<TargetAddOptions, "env" | "environment"> & { env?: string }) => {
    const { env: environment, ...rest } = values;
    await executeTargetAdd({ ...rest, ...(environment === undefined ? {} : { environment }) }, dependencies);
  });
  addWorkspaceOption(
    target
      .command("verify")
      .description(
        "Verify a target you added: wait for the published code on a public address, or confirm a private one from this machine. Needs a workspace owner's login"
      )
      .argument("<name>", "the target's name, as in augmentworks.yaml")
      .addOption(new Option("--env <environment>", "which environment, when the name is in more than one").choices([...TARGET_ENVIRONMENTS]))
      .addOption(
        new Option("--method <method>", "check that the target was added for this method: https or dns").choices([
          "https",
          "dns"
        ])
      )
      .option("--client-ref <ref>", "for a client's agent: the client the written permission covers")
      .option("-c, --config <path>", "configuration that reaches a private address", "augmentworks.yaml")
      .option("--timeout-ms <ms>", "how long to wait for the published code", String(DEFAULT_VERIFY_TIMEOUT_MS))
      .option("--json", "write one machine-readable verification object to stdout")
      .option(
        "--allow-file-credentials",
        "allow a warned mode-0600 credential file when OS credential storage is unavailable"
      )
  ).action(
    async (
      name: string,
      values: Omit<TargetVerifyOptions, "env" | "environment" | "name" | "timeoutMs"> & { env?: string; timeoutMs?: string }
    ) => {
      const { env: environment, timeoutMs, ...rest } = values;
      await executeTargetVerify(
        {
          ...rest,
          name,
          ...(environment === undefined ? {} : { environment }),
          ...(timeoutMs === undefined ? {} : { timeoutMs: parseTimeout(timeoutMs) })
        },
        dependencies
      );
    }
  );
  addWorkspaceOption(
    target
      .command("list")
      .description("List this workspace's targets: status, verification expiry and test scopes")
      .option("--suite <file>", "also check the scope in this aw-suite/3 file")
      .option("--json", "write one machine-readable target list to stdout")
      .option(
        "--allow-file-credentials",
        "allow a warned mode-0600 credential file when OS credential storage is unavailable"
      )
  ).action(async (values: Omit<TargetListOptions, "env">) => {
    await executeTargetCommand(
      async () => await runTargetList(values, dependencies),
      (result) => formatTargetListHuman(result),
      (result) => targetListJson(result),
      values.json === true,
      dependencies
    );
  });
  addWorkspaceOption(
    target
      .command("pull")
      .description(
        "Bring a target added in the portal into augmentworks.yaml: its address and endpoints. Mappings and auth aren't touched"
      )
      .argument("<name>", "the target's name")
      .addOption(new Option("--env <environment>", "which environment, when the name is in more than one").choices([...TARGET_ENVIRONMENTS]))
      .option("-c, --config <path>", "configuration path", "augmentworks.yaml")
      .option("--json", "write one machine-readable result object to stdout")
      .option(
        "--allow-file-credentials",
        "allow a warned mode-0600 credential file when OS credential storage is unavailable"
      )
  ).action(async (name: string, values: Omit<TargetPullOptions, "env" | "environment" | "name"> & { env?: string }) => {
    const { env: environment, ...rest } = values;
    await executeTargetCommand(
      async () =>
        await runTargetPull({ ...rest, name, ...(environment === undefined ? {} : { environment }) }, dependencies),
      (result) => formatTargetPullHuman(result),
      (result) => targetPullJson(result),
      values.json === true,
      dependencies
    );
  });
  return target;
}

async function executeTargetCommand<T>(
  run: () => Promise<T>,
  human: (result: T) => string,
  machine: (result: T) => Record<string, unknown>,
  json: boolean,
  dependencies: TargetDependencies
): Promise<void> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  try {
    const result = await run();
    stdout.write(json ? `${JSON.stringify(machine(result))}\n` : human(result));
  } catch (error) {
    const awError =
      error instanceof AwError
        ? error
        : new AwError({ code: "INTERNAL", category: "local", message: "The target command could not be completed." });
    if (!json) throw awError;
    stdout.write(
      `${JSON.stringify({ ok: false, error: { code: awError.code, message: awError.message }, exitCode: exitCodeFor(awError) })}\n`
    );
    stderr.write(`${sanitizeTerminal(awError.message)}\n`);
    (dependencies.setExitCode ?? ((code: number) => (process.exitCode = code)))(exitCodeFor(awError));
  }
}

export interface TargetListOptions extends HostedAuthOptions {
  readonly suite?: string;
  readonly json?: boolean;
}

export interface TargetListEntry {
  readonly target: StoredTarget;
  readonly detail?: TargetDetail;
  /** Undefined when this login can't read scopes (only owners can). */
  readonly scopes?: readonly TargetScopeSummary[];
}

export interface TargetListResult {
  readonly entries: readonly TargetListEntry[];
  readonly now: number;
  readonly suite?: { readonly path: string; readonly scopeId?: string; readonly warning?: string };
}

/** A scope this close to its expiry is flagged. */
export const SCOPE_EXPIRY_WARNING_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function runTargetList(
  options: TargetListOptions,
  dependencies: TargetDependencies = {}
): Promise<TargetListResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const stderr = dependencies.stderr ?? process.stderr;
  const now = (dependencies.verify?.now ?? Date.now)();
  const suitePath = options.suite === undefined ? undefined : resolve(cwd, options.suite);
  const suiteScopeId = suitePath === undefined ? undefined : await suiteScopeIdOf(suitePath);
  const session = await authenticateHostedSession(options, { ...dependencies, stderr });
  const workspaceId = session.identity.workspaceId;
  const targets = await session.cloud.listTargets(workspaceId, options.signal);
  const entries: TargetListEntry[] = [];
  for (const target of targets) {
    if (target.status === "revoked") {
      entries.push({ target });
      continue;
    }
    const detail = await session.cloud.getTargetDetail(workspaceId, target.targetId, options.signal);
    let scopes: TargetScopeSummary[] | undefined;
    try {
      scopes = await session.cloud.listTargetScopes(workspaceId, target.targetId, options.signal);
    } catch (error) {
      if (!(error instanceof AwError) || error.details?.["http_status"] !== 403) throw error;
    }
    entries.push({ target, detail, ...(scopes === undefined ? {} : { scopes }) });
  }
  const result: TargetListResult = { entries, now };
  if (suitePath === undefined) return result;
  const shown = relative(cwd, suitePath) || suitePath;
  return { ...result, suite: { path: shown, ...suiteWarning(entries, shown, suiteScopeId, now) } };
}

async function suiteScopeIdOf(path: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new AwError({ code: "SUITE_SCOPE_WRITE_FAILED", category: "config", message: `Can't read the suite file ${path}.` });
  }
  const parsed = parseDocument(text).toJS() as { execution_scope?: { scope_id?: unknown } } | null;
  const scopeId = parsed?.execution_scope?.scope_id;
  return typeof scopeId === "string" ? scopeId : undefined;
}

function suiteWarning(
  entries: readonly TargetListEntry[],
  path: string,
  scopeId: string | undefined,
  now: number
): { scopeId?: string; warning?: string } {
  if (scopeId === undefined) {
    return { warning: `${path} has no execution_scope. Add one with \`augmentworks scope create --target <name> --suite ${shellWord(path)}\`.` };
  }
  for (const entry of entries) {
    const scope = entry.scopes?.find((item) => item.scopeId === scopeId);
    if (scope === undefined) continue;
    const renew = `Run \`augmentworks scope create --target ${shellWord(entry.target.name)} --suite ${shellWord(path)}\` for a new one.`;
    const expires = Date.parse(scope.expiresAt);
    if (expires <= now) return { scopeId, warning: `The scope in ${path} expired on ${scope.expiresAt}. ${renew}` };
    const days = Math.ceil((expires - now) / DAY_MS);
    if (days <= SCOPE_EXPIRY_WARNING_DAYS) {
      return { scopeId, warning: `The scope in ${path} expires on ${scope.expiresAt}, in ${days} day${days === 1 ? "" : "s"}. ${renew}` };
    }
    return { scopeId };
  }
  const readable = entries.some((entry) => entry.scopes !== undefined);
  return {
    scopeId,
    warning: readable
      ? `The scope in ${path} (${scopeId}) isn't a scope of any target in this workspace.`
      : `Only a workspace owner can see scopes, so the scope in ${path} wasn't checked.`
  };
}

function targetStatusLabel(entry: TargetListEntry, now: number): string {
  if (entry.target.status === "revoked") return "revoked";
  if (entry.target.status === "pending" || entry.detail === undefined) return "waiting for verification";
  const expires = Date.parse(entry.detail.authority.expiresAt);
  const day = entry.detail.authority.expiresAt.slice(0, 10);
  if (expires <= now) return `verification expired ${day}`;
  if (Date.parse(entry.detail.authority.renewalOpensAt) <= now) return `renew by ${day}`;
  return `verified until ${day}`;
}

export function formatTargetListHuman(result: TargetListResult): string {
  if (result.entries.length === 0) {
    return "This workspace has no targets yet. Add one with `augmentworks target add --env <environment>`.\n";
  }
  const lines: string[] = [];
  for (const entry of result.entries) {
    const target = entry.target;
    lines.push(
      `${sanitizeTerminal(target.name)} (${target.environment})  ${targetStatusLabel(entry, result.now)}  ${sanitizeTerminal(target.assessedIdentity)}`
    );
    if (target.status === "revoked") continue;
    if (entry.scopes === undefined) {
      lines.push("  scopes: only a workspace owner can see them");
      continue;
    }
    if (entry.scopes.length === 0) lines.push("  no test scopes yet");
    for (const scope of entry.scopes) {
      const expires = Date.parse(scope.expiresAt);
      const soon = expires > result.now && expires - result.now <= SCOPE_EXPIRY_WARNING_DAYS * DAY_MS;
      lines.push(
        `  scope ${scope.scopeId} revision ${scope.revision}, ${scope.effects}, expires ${scope.expiresAt.slice(0, 10)} (${scope.state})${soon ? ", expires soon" : ""}`
      );
    }
  }
  if (result.suite?.warning !== undefined) lines.push("", result.suite.warning);
  return `${lines.join("\n")}\n`;
}

export function targetListJson(result: TargetListResult): Record<string, unknown> {
  return {
    ok: true,
    targets: result.entries.map((entry) => ({
      targetId: entry.target.targetId,
      name: entry.target.name,
      environment: entry.target.environment,
      status: entry.target.status,
      assessedIdentity: entry.target.assessedIdentity,
      verificationMethod: entry.target.verificationMethod,
      verifiedUntil: entry.target.status === "verified" ? (entry.detail?.authority.expiresAt ?? null) : null,
      renewalOpensAt: entry.detail?.authority.renewalOpensAt ?? null,
      scopes: entry.scopes ?? null
    })),
    ...(result.suite === undefined ? {} : { suite: result.suite })
  };
}

export interface TargetPullOptions extends HostedAuthOptions {
  readonly name: string;
  readonly environment?: string;
  readonly config?: string;
  readonly json?: boolean;
}

export interface TargetPullResultSummary extends PullResult {
  readonly configPath: string;
  readonly name: string;
}

/**
 * `target pull <name>`: writes the address and endpoints of a target added in
 * the portal into augmentworks.yaml, or creates the file with placeholders.
 */
export async function runTargetPull(
  options: TargetPullOptions,
  dependencies: TargetDependencies = {}
): Promise<TargetPullResultSummary> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const stderr = dependencies.stderr ?? process.stderr;
  const environment = options.environment === undefined ? undefined : parseEnvironment(options.environment);
  const configPath = resolve(cwd, options.config ?? "augmentworks.yaml");
  let existing: string | undefined;
  try {
    existing = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const session = await authenticateHostedSession(options, { ...dependencies, stderr });
  const workspaceId = session.identity.workspaceId;
  const targets = await session.cloud.listTargets(workspaceId, options.signal);
  const selected = selectTarget(targets, options.name, environment);
  const detail = await session.cloud.getTargetDetail(workspaceId, selected.targetId, options.signal);
  const pulled = existing === undefined ? newConfigFromTarget(detail) : mergeTargetIntoConfig(existing, detail);
  if (pulled.created || pulled.changes.length > 0) {
    const temporary = `${configPath}.${process.pid}.tmp`;
    await writeFile(temporary, pulled.text, { encoding: "utf8", flag: "w" });
    await rename(temporary, configPath);
  }
  return { ...pulled, configPath: relative(cwd, configPath) || configPath, name: detail.target.name };
}

export function formatTargetPullHuman(result: TargetPullResultSummary): string {
  const name = sanitizeTerminal(result.name);
  const lines = result.created
    ? [`Created ${result.configPath} for ${name}.`]
    : result.changes.length === 0
      ? [`${result.configPath} already matches ${name}.`]
      : [`Updated ${result.configPath} for ${name}: ${result.changes.join("; ")}.`];
  lines.push(...result.notes.map((note) => sanitizeTerminal(note)));
  lines.push(
    result.created || result.changes.some((change) => change.includes("fill in"))
      ? `Next: replace the ${PLACEHOLDER_MARKER} values, then run augmentworks doctor.`
      : "Next: augmentworks doctor"
  );
  return `${lines.join("\n")}\n`;
}

export function targetPullJson(result: TargetPullResultSummary): Record<string, unknown> {
  return {
    ok: true,
    name: result.name,
    config: result.configPath,
    created: result.created,
    changes: result.changes,
    notes: result.notes
  };
}

export interface TargetVerifyOptions extends HostedAuthOptions {
  readonly name: string;
  readonly environment?: string;
  readonly method?: "https" | "dns";
  readonly clientRef?: string;
  readonly config?: string;
  readonly timeoutMs?: number;
  readonly json?: boolean;
  readonly handleSignals?: boolean;
}

export interface TargetVerifyResult extends VerifyTargetOutcome {
  readonly next?: string;
}

function parseTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AwError({
      code: "INVALID_TIMEOUT",
      category: "config",
      message: "--timeout-ms must be a whole number of milliseconds, 0 or more."
    });
  }
  return parsed;
}

async function executeTargetVerify(options: TargetVerifyOptions, dependencies: TargetDependencies): Promise<void> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const json = options.json === true;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  try {
    const result = await runTargetVerify(options, dependencies);
    stdout.write(json ? `${JSON.stringify(targetVerifyJson(result))}\n` : formatTargetVerifyHuman(result));
  } catch (error) {
    const awError =
      error instanceof AwError
        ? error
        : new AwError({ code: "INTERNAL", category: "local", message: "The target could not be verified." });
    if (!json) throw awError;
    stdout.write(
      `${JSON.stringify({ ok: false, error: { code: awError.code, message: awError.message }, exitCode: exitCodeFor(awError) })}\n`
    );
    stderr.write(`${sanitizeTerminal(awError.message)}\n`);
    setExitCode(exitCodeFor(awError));
  }
}

/**
 * `target verify <name>`: answers the open challenge of a target this
 * workspace added. Running it again resumes with the same code, read back
 * from the target's detail.
 */
export async function runTargetVerify(
  options: TargetVerifyOptions,
  dependencies: TargetDependencies = {}
): Promise<TargetVerifyResult> {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const stderr = dependencies.stderr ?? process.stderr;
  const environment = options.environment === undefined ? undefined : parseEnvironment(options.environment);
  if (inspectCredentialEnvironment(env).mode === "api_key") throw ownerLoginRequiredError("Verifying a target");
  const session = await authenticateHostedSession(options, { ...dependencies, stderr });
  if (session.identity.principalKind === "machine" || session.source === "api_key") {
    throw ownerLoginRequiredError("Verifying a target");
  }
  const workspaceId = session.identity.workspaceId;
  const controller = new AbortController();
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
  const onInterrupt = () => controller.abort();
  const signals = dependencies.signals ?? process;
  if (options.handleSignals !== false) signals.on("SIGINT", onInterrupt);
  let selectedName = options.name;
  try {
    const targets = await session.cloud.listTargets(workspaceId, signal);
    const selected = selectTarget(targets, options.name, environment);
    selectedName = selected.name;
    const detail = await session.cloud.getTargetDetail(workspaceId, selected.targetId, signal);
    const outcome = await verifyTarget(
      {
        cloud: session.cloud,
        workspaceId,
        detail,
        ...(options.method === undefined ? {} : { requestedMethod: options.method }),
        ...(options.clientRef === undefined ? {} : { clientRef: options.clientRef }),
        loadConfig: async () => await loadTargetConfig(options.config ?? "augmentworks.yaml", cwd, env, dependencies.doctor),
        timeoutMs: options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
        signal,
        report: (line) => {
          stderr.write(`${line}\n`);
        }
      },
      dependencies.verify ?? {}
    );
    return outcome;
  } catch (error) {
    if (controller.signal.aborted && error instanceof AwError && error.code === "RELAY_REQUEST_CANCELLED") {
      throw new AwError({
        code: "INTERRUPTED",
        category: "local",
        message: `Stopped. Run \`augmentworks target verify ${shellWord(selectedName)}\` again to keep checking with the same code.`
      });
    }
    throw error;
  } finally {
    if (options.handleSignals !== false) signals.off("SIGINT", onInterrupt);
  }
}

export function formatTargetVerifyHuman(result: TargetVerifyResult): string {
  const name = sanitizeTerminal(result.target.name);
  if (result.alreadyVerified) return `${name} is already verified until ${result.expiresAt}.\n`;
  return [
    ...(result.ownerStatement ? ["Confirmed from this machine. Recorded as your statement, not a hosted check."] : []),
    `${name} is verified until ${result.expiresAt}.`,
    `Next: augmentworks scope create --target ${shellWord(result.target.name)} --suite <your aw-suite/3 file>`,
    ""
  ].join("\n");
}

export function targetVerifyJson(result: TargetVerifyResult): Record<string, unknown> {
  return {
    ok: true,
    targetId: result.target.targetId,
    name: result.target.name,
    environment: result.target.environment,
    verificationMethod: result.method,
    verified: true,
    alreadyVerified: result.alreadyVerified,
    ownerStatement: result.ownerStatement,
    expiresAt: result.expiresAt
  };
}

async function executeTargetAdd(options: TargetAddOptions, dependencies: TargetDependencies): Promise<void> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const json = options.json === true;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  try {
    const result = await runTargetAdd(options, dependencies);
    if (json) {
      stdout.write(`${JSON.stringify(targetAddJson(result))}\n`);
    } else {
      stdout.write(formatTargetAddHuman(result));
    }
  } catch (error) {
    const awError =
      error instanceof AwError
        ? error
        : new AwError({ code: "INTERNAL", category: "local", message: "The target could not be registered." });
    if (!json) throw awError;
    stdout.write(
      `${JSON.stringify({ ok: false, error: { code: awError.code, message: awError.message }, exitCode: exitCodeFor(awError) })}\n`
    );
    stderr.write(`${sanitizeTerminal(awError.message)}\n`);
    setExitCode(exitCodeFor(awError));
  }
}

/**
 * `target add`: registers the agent described by augmentworks.yaml, so its
 * address and endpoints are never typed twice. Whose agent it is and the
 * workspace real-data statement are answered by a person at a prompt, or in CI
 * by `--attest` and a statement already accepted in the portal.
 */
export async function runTargetAdd(
  options: TargetAddOptions,
  dependencies: TargetDependencies = {}
): Promise<TargetAddResult> {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const stderr = dependencies.stderr ?? process.stderr;
  const environment = parseEnvironment(options.environment);
  const flagAttestation = parseAttestFlags(options);
  const resolved = await loadTargetConfig(options.config ?? "augmentworks.yaml", cwd, env, dependencies.doctor);
  const boundary = boundaryFromConfig(resolved);
  const privateAddress = boundary.privateAddress;
  if (privateAddress && options.method === "dns") {
    throw new AwError({
      code: "TARGET_METHOD_UNAVAILABLE",
      category: "config",
      message: `${boundary.assessedIdentity} is a private address, so it can't be checked with DNS. Drop --method dns: target verify confirms it from this machine instead.`
    });
  }
  if (inspectCredentialEnvironment(env).mode === "api_key") throw ownerLoginRequiredError();

  const session = await authenticateHostedSession(options, { ...dependencies, stderr });
  if (session.identity.principalKind === "machine" || session.source === "api_key") {
    throw ownerLoginRequiredError();
  }
  const portalUrl = portalTargetsUrl(session.apiOrigin);
  const interactive =
    dependencies.interactive ??
    (!isHeadlessEnvironment(env, options) && process.stdin.isTTY === true && process.stderr.isTTY === true);
  const ask = dependencies.ask ?? askOnTerminal;

  const attestation = flagAttestation ?? (await askWhoseAgent(interactive, ask, options));
  const statement = await session.cloud.getRealDataStatement(session.identity.workspaceId, options.signal);
  const acceptsStatement = statement.accepted
    ? false
    : await acceptStatement(statement, interactive, ask, stderr, portalUrl);

  const verificationMethod: VerificationMethod =
    attestation.kind === "written_permission"
      ? "reviewed_permission"
      : privateAddress
        ? "connector_challenge"
        : options.method === "dns"
          ? "dns_txt"
          : "https_challenge";
  const targetId = (dependencies.newId ?? randomUUID)();
  const request: RegisterTargetRequest = {
    targetId,
    name: boundary.name,
    environment,
    transport: "direct_http",
    targetBoundaryHash: boundaryHash(targetId, boundary),
    effectBoundary: "no_tools",
    authorizationKind: attestation.kind,
    permissionRef: attestation.kind === "written_permission" ? attestation.permissionRef : "owned",
    verificationMethod,
    assessedIdentity: boundary.assessedIdentity,
    endpoints: boundary.endpoints,
    ...(acceptsStatement ? { attestation: { statementVersion: statement.version, statementHash: statement.hash } } : {})
  };
  let registration: TargetRegistration;
  try {
    registration = await session.cloud.registerTarget(
      session.identity.workspaceId,
      request,
      (dependencies.newId ?? randomUUID)(),
      options.signal
    );
  } catch (error) {
    throw registrationError(error, portalUrl);
  }
  if (!options.json) {
    stderr.write(`Registered in ${formatWorkspaceLabel(session.identity)}.\n`);
  }
  return {
    registration,
    name: boundary.name,
    environment,
    assessedIdentity: boundary.assessedIdentity,
    verificationMethod: registration.challenge.method,
    statementAccepted: acceptsStatement,
    next: `augmentworks target verify ${shellWord(boundary.name)}`
  };
}

function parseAttestFlags(options: TargetAddOptions): Attestation | undefined {
  if (options.attest === undefined) {
    if (options.permissionRef !== undefined) {
      throw new AwError({
        code: "ATTESTATION_REQUIRED",
        category: "config",
        message: "--permission-ref goes with --attest written. Pass both, or leave both out to be asked."
      });
    }
    return undefined;
  }
  if (options.attest === "owned") {
    if (options.permissionRef !== undefined) {
      throw new AwError({
        code: "ATTESTATION_REQUIRED",
        category: "config",
        message: "--permission-ref is only for a client's agent. Use --attest written --permission-ref <ref>, or drop --permission-ref."
      });
    }
    return { kind: "owned_target" };
  }
  if (options.attest === "written") {
    if (options.permissionRef === undefined) {
      throw new AwError({
        code: "ATTESTATION_REQUIRED",
        category: "config",
        message: "--attest written needs --permission-ref <ref>: a reference for the client's written permission, such as a contract number."
      });
    }
    return { kind: "written_permission", permissionRef: parsePermissionRef(options.permissionRef) };
  }
  throw new AwError({
    code: "ATTESTATION_REQUIRED",
    category: "config",
    message: "--attest must be owned or written."
  });
}

function parsePermissionRef(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > TARGET_LIMITS.maxPermissionRefChars ||
    !PERMISSION_REF_PATTERN.test(trimmed)
  ) {
    throw new AwError({
      code: "INVALID_PERMISSION_REF",
      category: "config",
      message: `The permission reference must be 1 to ${TARGET_LIMITS.maxPermissionRefChars} letters, digits, dots, dashes, colons or underscores, starting with a letter or digit, such as MSA-2026-014. Use a reference, not the document itself.`
    });
  }
  return trimmed;
}

async function askWhoseAgent(
  interactive: boolean,
  ask: (question: string) => Promise<string>,
  options: TargetAddOptions
): Promise<Attestation> {
  if (!interactive) {
    throw new AwError({
      code: "ATTESTATION_REQUIRED",
      category: "config",
      message: `Without a prompt, say whose agent this is: --attest owned, or --attest written --permission-ref <ref>.${options.yes === true ? " --yes doesn't answer this." : ""}`
    });
  }
  const answer = (
    await ask(
      "Whose agent is this?\n  1. Ours. We own or operate it.\n  2. A client's. We have their written permission to test it.\nChoose 1 or 2: "
    )
  ).trim();
  if (answer === "1") return { kind: "owned_target" };
  if (answer === "2") {
    const ref = await ask("Reference for the written permission, such as a contract number (not the document): ");
    return { kind: "written_permission", permissionRef: parsePermissionRef(ref) };
  }
  throw new AwError({
    code: "ATTESTATION_REQUIRED",
    category: "config",
    message: "No target was registered. Answer 1 or 2, or pass --attest."
  });
}

async function acceptStatement(
  statement: RealDataStatement,
  interactive: boolean,
  ask: (question: string) => Promise<string>,
  stderr: Pick<NodeJS.WriteStream, "write">,
  portalUrl: string
): Promise<boolean> {
  if (!interactive) {
    throw new AwError({
      code: "STATEMENT_NOT_ACCEPTED",
      category: "auth",
      message: `This workspace hasn't accepted the real-data statement yet, and CI can't accept it. A workspace owner accepts it once at ${portalUrl}, or by running this command in a terminal. No target was registered.`
    });
  }
  stderr.write(
    `\nBefore this workspace runs real-data tests, a workspace owner accepts this statement once:\n\n  ${sanitizeTerminal(statement.text)}\n\n`
  );
  const answer = await ask("Type yes to accept it for the workspace: ");
  if (answer.trim().toLowerCase() !== "yes") {
    throw new AwError({
      code: "STATEMENT_NOT_ACCEPTED",
      category: "auth",
      message: "The statement wasn't accepted, so no target was registered."
    });
  }
  return true;
}

interface ConfigBoundary {
  readonly name: string;
  readonly assessedIdentity: string;
  readonly privateAddress: boolean;
  readonly endpoints: ReadonlyArray<{ readonly method: string; readonly path: string }>;
}

/** The registered boundary, read from augmentworks.yaml exactly as `test` checks it later (AUG-355). */
function boundaryFromConfig(resolved: ResolvedConfig): ConfigBoundary {
  const name = resolved.config.target.name.trim();
  if (name.length === 0 || name.length > TARGET_LIMITS.maxNameChars) {
    throw new AwError({
      code: "TARGET_NAME_INVALID",
      category: "config",
      message: `target.name in augmentworks.yaml must be 1 to ${TARGET_LIMITS.maxNameChars} characters.`
    });
  }
  const hostname = resolved.baseUrl.hostname.replace(/^\[|\]$/gu, "");
  const privateAddress = isLocalOrPrivateHost(hostname);
  const assessedIdentity = canonicalAssessedOrigin(resolved.baseUrl.origin, { allowPrivate: true });
  const seen = new Set<string>();
  const endpoints: Array<{ method: string; path: string }> = [];
  for (const endpoint of configuredEndpoints(resolved)) {
    const key = `${endpoint.method} ${endpoint.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (endpoint.path.length > TARGET_LIMITS.maxEndpointPathChars) {
      throw new AwError({
        code: "TARGET_ENDPOINT_INVALID",
        category: "config",
        message: `The ${endpoint.kind} operation's path is longer than ${TARGET_LIMITS.maxEndpointPathChars} characters.`
      });
    }
    endpoints.push({ method: endpoint.method, path: endpoint.path });
  }
  return { name, assessedIdentity, privateAddress, endpoints };
}

function boundaryHash(targetId: string, boundary: ConfigBoundary): string {
  return sealDocumentHash(
    {
      schemaVersion: TARGET_BOUNDARY_SCHEMA_VERSION,
      targetId,
      revision: 1,
      boundaryHash: "0".repeat(64),
      transport: "direct_http",
      effectBoundary: "no_tools",
      assessedIdentity: boundary.assessedIdentity,
      endpoints: boundary.endpoints.map((endpoint) => ({ method: endpoint.method, path: endpoint.path }))
    },
    "boundaryHash"
  ).boundaryHash;
}

function registrationError(error: unknown, portalUrl: string): unknown {
  if (!(error instanceof AwError)) return error;
  if (error.code === "TARGET_AUTHORITY_REQUIRED" && /statement/iu.test(error.message)) {
    return new AwError({
      code: "STATEMENT_NOT_ACCEPTED",
      category: "auth",
      message: `The real-data statement changed while this ran. Run the command again to read the new version, or accept it at ${portalUrl}. No target was registered.`
    });
  }
  const notOwner =
    error.code === "INSUFFICIENT_PERMISSION" ||
    (error.code === "TARGET_AUTHORITY_REQUIRED" && /owner/iu.test(error.message));
  if (notOwner) {
    return new AwError({
      code: "TARGET_OWNER_LOGIN_REQUIRED",
      category: "auth",
      message: `Only a workspace owner can register a target. Ask an owner to run this command, or to add the target at ${portalUrl}.`
    });
  }
  return error;
}

const METHOD_DESCRIPTION: Record<VerificationMethod, string> = {
  https_challenge: "a file you serve at /.well-known/augmentworks-target",
  dns_txt: "a DNS TXT record",
  connector_challenge: "a check from this machine, because the address is private",
  reviewed_permission: "your record of the client's written permission"
};

export function formatTargetAddHuman(result: TargetAddResult): string {
  return [
    `Added ${sanitizeTerminal(result.name)} (${result.environment}) at ${sanitizeTerminal(result.assessedIdentity)}, revision ${result.registration.targetRevision}. It isn't verified yet.`,
    ...(result.statementAccepted ? ["The workspace accepted the real-data statement."] : []),
    `It's verified by ${METHOD_DESCRIPTION[result.verificationMethod]}. The code expires at ${result.registration.challenge.expiresAt}.`,
    `Next: ${result.next}`,
    ""
  ].join("\n");
}

export function targetAddJson(result: TargetAddResult): Record<string, unknown> {
  return {
    ok: true,
    targetId: result.registration.targetId,
    targetRevision: result.registration.targetRevision,
    name: result.name,
    environment: result.environment,
    assessedIdentity: result.assessedIdentity,
    status: result.registration.status,
    verificationMethod: result.verificationMethod,
    challengeExpiresAt: result.registration.challenge.expiresAt,
    statementAccepted: result.statementAccepted,
    next: result.next
  };
}
