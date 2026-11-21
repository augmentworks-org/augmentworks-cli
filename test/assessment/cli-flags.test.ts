import { describe, expect, it } from "vitest";

import { createTestCommand, hostedExitCode } from "../../src/commands/test.js";
import { EXIT, exitCodeFor, AwError } from "../../src/errors.js";
import type { RunStatusResponse } from "../../src/cloud/protocol.js";
import { runSourceCli } from "../util/cli-process.js";
import { HOSTED_ASSESSMENT_OPTION_HELP } from "../../src/version.js";

function runStatus(overrides: Partial<RunStatusResponse> = {}): RunStatusResponse {
  return {
    protocol_version: "aw-relay/0.2",
    run_id: "run-1",
    status: "completed",
    credit_state: "consumed",
    outcome: "passed",
    ...overrides
  };
}

describe("assessment CLI flags", () => {
  it("documents --assessment and --packet on test and doctor help", async () => {
    const testHelp = await runSourceCli(["test", "--help"], { cwd: process.cwd() });
    const doctorHelp = await runSourceCli(["doctor", "--help"], { cwd: process.cwd() });

    expect(testHelp.exitCode).toBe(0);
    expect(testHelp.stdout).toContain("--packet");
    expect(testHelp.stdout).toContain("--assessment");
    expect(testHelp.stdout).toContain("--profile");
    expect(testHelp.stdout).toContain("--suite");
    expect(testHelp.stdout).toContain("--investigation");
    expect(testHelp.stdout).toContain("--manifest");
    expect(testHelp.stdout).toContain("--local");
    expect(testHelp.stdout).toContain("--workspace");
    expect(testHelp.stdout).toContain(HOSTED_ASSESSMENT_OPTION_HELP);
    expect(testHelp.stdout).not.toMatch(/source 0\.3\.3/u);
    expect(testHelp.stdout).not.toMatch(/published 0\.3\.2 uses aw-relay\/0\.2/u);
    expect(doctorHelp.exitCode).toBe(0);
    expect(doctorHelp.stdout).toContain("--assessment");
    expect(doctorHelp.stdout).toContain("--profile");
  });

  it("rejects --assessment with --local and --packet together", async () => {
    const command = createTestCommand({
      stdout: { write: () => true },
      stderr: { write: () => true }
    }).exitOverride();

    await expect(
      command.parseAsync(
        ["node", "augmentworks", "--assessment", "file.yaml", "--local", "--packet", "x@1.0.0"],
        { from: "node" }
      )
    ).rejects.toMatchObject({ code: "ASSESSMENT_LOCAL_UNSUPPORTED" });

    const packetConflict = createTestCommand({
      stdout: { write: () => true },
      stderr: { write: () => true }
    }).exitOverride();
    await expect(
      packetConflict.parseAsync(
        ["node", "augmentworks", "--assessment", "file.yaml", "--packet", "support-refunds@0.1.0"],
        { from: "node" }
      )
    ).rejects.toMatchObject({ code: "ASSESSMENT_PACKET_CONFLICT" });
  });

  it("maps pending hybrid grading to exit 11 and judging errors to 12", () => {
    expect(hostedExitCode(runStatus({ evaluation_status: "pending" }))).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(hostedExitCode(runStatus({ evaluation_status: "partial" }))).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(hostedExitCode(runStatus({ evaluation_status: "error" }))).toBe(EXIT.EVALUATION_ERROR);
    expect(hostedExitCode(runStatus({ evaluation_status: "error", outcome: "failed" }))).toBe(
      EXIT.ASSESSMENT_FAILED
    );
    expect(hostedExitCode(runStatus({ evaluation_status: "error", outcome: null }))).toBe(
      EXIT.EVALUATION_ERROR
    );
    expect(hostedExitCode(runStatus({ evaluation_status: "complete", outcome: "failed" }))).toBe(
      EXIT.ASSESSMENT_FAILED
    );
    expect(hostedExitCode(runStatus({ evaluation_status: "complete", outcome: "passed" }))).toBe(EXIT.OK);
    expect(hostedExitCode(runStatus({ status: "cancelled" }))).toBe(EXIT.INTERRUPTED);
    expect(hostedExitCode(runStatus())).toBe(EXIT.OK);
    expect(hostedExitCode(runStatus({ outcome: null }))).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(hostedExitCode(runStatus({ evaluation_status: "complete", outcome: null }))).toBe(
      EXIT.EVALUATION_INCOMPLETE
    );
    expect(
      hostedExitCode({
        ...runStatus(),
        evaluation_status: "unsupported"
      } as unknown as RunStatusResponse)
    ).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(
      exitCodeFor(
        new AwError({
          code: "EVALUATION_INCOMPLETE",
          category: "relay",
          message: "pending"
        })
      )
    ).toBe(EXIT.EVALUATION_INCOMPLETE);
    expect(
      exitCodeFor(
        new AwError({
          code: "EVALUATION_ERROR",
          category: "relay",
          message: "error"
        })
      )
    ).toBe(EXIT.EVALUATION_ERROR);
  });
});
