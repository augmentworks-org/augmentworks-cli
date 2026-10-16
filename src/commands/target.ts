import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { Command, Option } from "commander";

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
  type TargetEnvironment,
  type TargetRegistration,
  type VerificationMethod
} from "../target/protocol.js";
import { loadTargetConfig, ownerLoginRequiredError, shellWord, type TargetDoctor } from "../target/common.js";
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
  return target;
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

function parseEnvironment(value: string | undefined): TargetEnvironment {
  if (value === undefined) {
    throw new AwError({
      code: "TARGET_ENVIRONMENT_REQUIRED",
      category: "config",
      message: "Pass --env development, --env staging or --env production to say which environment of the agent this is."
    });
  }
  if (!(TARGET_ENVIRONMENTS as readonly string[]).includes(value)) {
    throw new AwError({
      code: "TARGET_ENVIRONMENT_REQUIRED",
      category: "config",
      message: "--env must be development, staging or production."
    });
  }
  return value as TargetEnvironment;
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

async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((resolveAnswer) => {
      rl.question(question, resolveAnswer);
    });
  } finally {
    rl.close();
  }
}

