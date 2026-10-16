import { Command, CommanderError } from "commander";

import { createDemoCommand } from "./commands/demo.js";
import { createActionCommand } from "./commands/action.js";
import { createRecoverCommand } from "./commands/recover.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { createPreviewMappingCommand } from "./commands/preview-mapping.js";
import { createProbeCommand } from "./commands/probe.js";
import { createInitCommand } from "./commands/init.js";
import { createLoginCommand } from "./commands/login.js";
import { createLogoutCommand } from "./commands/logout.js";
import { createSchemaCommand } from "./commands/schema.js";
import { createSuiteCommand } from "./commands/suite.js";
import { createCatalogCommand } from "./commands/catalog.js";
import { createSelectionCommand } from "./commands/selection.js";
import { createTestCommand } from "./commands/test.js";
import { createRunCommand } from "./commands/run.js";
import { createCompareCommand } from "./commands/compare.js";
import { createGateCommand } from "./commands/gate.js";
import { createBaselineCommand } from "./commands/baseline.js";
import { createTargetCommand } from "./commands/target.js";
import { createScopeCommand } from "./commands/scope.js";
import { createInvestigationCommand } from "./commands/investigation.js";
import { createUsageCommand } from "./commands/usage.js";
import { createBillingCommand } from "./commands/billing.js";
import { createWhoamiCommand } from "./commands/whoami.js";
import { AwError, exitCodeFor, sanitizeTerminal } from "./errors.js";
import { CLI_VERSION } from "./version.js";
import { installLandedPrivacyService } from "./real-data/privacy.js";
import { isRealDataErrorCode } from "./real-data/errors.js";

export interface CliIo {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
}

interface CliState {
  requestedExitCode: number;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

const states = new WeakMap<Command, CliState>();

export function createCli(io: CliIo = {}): Command {
  installLandedPrivacyService();
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const state: CliState = { requestedExitCode: 0, stderr };
  const requestExitCode = (code: number): void => {
    state.requestedExitCode = Math.max(state.requestedExitCode, code);
  };
  const stdoutLine = (message: string): void => {
    stdout.write(`${message}\n`);
  };
  const stderrLine = (message: string): void => {
    stderr.write(`${message}\n`);
  };

  const program = new Command()
    .name("augmentworks")
    .description("Deterministic hosted and customer-executed local AI agent testing")
    .version(CLI_VERSION, "-V, --version", "print the CLI version")
    .showSuggestionAfterError(true)
    .showHelpAfterError()
    .configureOutput({
      writeOut: (value) => stdout.write(value),
      writeErr: (value) => stderr.write(value),
      outputError: (value, write) => write(sanitizeTerminal(value))
    });

  program.addCommand(createLoginCommand({ stdout: stdoutLine, stderr: stderrLine }));
  program.addCommand(createLogoutCommand({ stdout: stdoutLine, stderr: stderrLine }));
  program.addCommand(createWhoamiCommand({ stdout: stdoutLine, stderr: stderrLine }));
  program.addCommand(createUsageCommand({ stdout: stdoutLine, stderr: stderrLine, setExitCode: requestExitCode }));
  program.addCommand(createBillingCommand({ stdout: stdoutLine, stderr: stderrLine, setExitCode: requestExitCode }));
  program.addCommand(createInitCommand({ stdout }));
  program.addCommand(createDoctorCommand({ stdout, setExitCode: requestExitCode }));
  program.addCommand(createPreviewMappingCommand({ stdout, setExitCode: requestExitCode }));
  program.addCommand(createProbeCommand({ stdout, setExitCode: requestExitCode }));
  program.addCommand(createDemoCommand({ stdout, stderr, setExitCode: requestExitCode }));
  program.addCommand(createCatalogCommand({ stdout, stderr }));
  program.addCommand(createSelectionCommand({ stdout, stderr }));
  program.addCommand(createTestCommand({ stdout, stderr, setExitCode: requestExitCode }));
  program.addCommand(createSuiteCommand({ stdout }));
  program.addCommand(createRunCommand({ stdout, stderr, setExitCode: requestExitCode }));
  program.addCommand(createCompareCommand({ stdout, stderr, setExitCode: requestExitCode }));
  program.addCommand(createGateCommand({ stdout, stderr, setExitCode: requestExitCode }));
  program.addCommand(createBaselineCommand({ stdout, stderr, setExitCode: requestExitCode }));
  program.addCommand(createTargetCommand({ stdout, stderr, setExitCode: requestExitCode }));
  program.addCommand(createScopeCommand({ stdout, stderr, setExitCode: requestExitCode }));
  program.addCommand(
    createInvestigationCommand({ stdout, stderr, setExitCode: requestExitCode })
  );
  program.addCommand(createRecoverCommand({ stdout, stderr, setExitCode: requestExitCode }));
  program.addCommand(createActionCommand({ stdout: stdoutLine, stderr: stderrLine, setExitCode: requestExitCode }));
  program.addCommand(createSchemaCommand({ stdout }));

  states.set(program, state);
  return program;
}

export async function runCli(argv: readonly string[] = process.argv, io: CliIo = {}): Promise<number> {
  const program = createCli(io);
  const state = states.get(program);
  if (state === undefined) throw new Error("CLI state was not initialized");
  program.exitOverride();
  if (argv.length <= 2) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync([...argv], { from: "node" });
    return state.requestedExitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof AwError) {
      state.stderr.write(`${formatCliError(error)}\n`);
      return exitCodeFor(error);
    }
    state.stderr.write("Error [INTERNAL]: An unexpected internal error occurred. Please report this issue.\n");
    return 1;
  }
}

/** The one line the CLI prints for an error. */
export function formatCliError(error: AwError): string {
  const code = sanitizeTerminal(error.code).replace(/[\r\n]+/g, " ");
  const message = sanitizeTerminal(error.message).replace(/[\r\n]+/g, " ").trim();
  const text = message || "The command could not be completed.";
  // Real-data and target setup errors say what happened and what to do; the code comes last (AUG-366).
  return plainErrorCode(error.code) ? `Error: ${text} (${code})` : `Error [${code}]: ${text}`;
}

function plainErrorCode(code: string): boolean {
  return isRealDataErrorCode(code) || /^(TARGET|STATEMENT|SCOPE|SUITE_SCOPE)_/u.test(code);
}
