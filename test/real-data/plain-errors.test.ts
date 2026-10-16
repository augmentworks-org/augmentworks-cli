import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { formatCliError, runCli } from "../../src/cli.js";
import { AwError } from "../../src/errors.js";
import { assertScopeNotExpired } from "../../src/real-data/boundary.js";
import { assertCommandWithinBudget } from "../../src/real-data/budget.js";
import { assertHostedRealDataRelease } from "../../src/real-data/capabilities.js";
import { classifyRealDataFailure } from "../../src/real-data/classify.js";
import { realDataError, withoutRecoverySuffix } from "../../src/real-data/errors.js";
import { ownerLoginRequiredError } from "../../src/target/common.js";
import { ADVERTISED_DISABLED_CAPABILITIES } from "../real-data/helpers.js";

const EXPIRED = "2026-10-01T00:00:00Z";
const NOW = Date.parse("2026-10-16T19:00:00Z");
const temporary: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function caught(run: () => unknown): AwError {
  try {
    run();
  } catch (error) {
    if (error instanceof AwError) return error;
    throw error;
  }
  throw new Error("expected an AwError");
}

/** Each situation AUG-366 names, raised the way the CLI raises it. */
const CASES: ReadonlyArray<readonly [string, () => AwError]> = [
  [
    "target scope mismatch",
    () =>
      realDataError(
        "TARGET_SCOPE_MISMATCH",
        "target.base_url in augmentworks.yaml points at https://staging.example.com, but this scope's target is registered at https://bot.example.com. Set base_url to https://bot.example.com, or register https://staging.example.com as its own target. A loopback address is transport only and can't stand in for a registered public address."
      )
  ],
  ["scope expired", () => caught(() => assertScopeNotExpired(EXPIRED, NOW))],
  [
    "verification expired",
    () => caught(() => assertScopeNotExpired(EXPIRED, NOW, "This target's verification"))
  ],
  [
    "authority revoked",
    () => realDataError("TARGET_AUTHORITY_REVOKED", "This suite's test scope was revoked, so nothing was sent to your agent.")
  ],
  [
    "budget exhausted",
    () =>
      caught(() =>
        assertCommandWithinBudget(
          { kind: "send" } as Parameters<typeof assertCommandWithinBudget>[0],
          { maxMessages: 3, maxActions: 0, maxCommands: 60, maxRuntimeSeconds: 600, maxCredits: 6 },
          { messages: 3, actions: 0, commands: 3 },
          false
        )
      )
  ],
  [
    "no workspace statement",
    () =>
      realDataError(
        "TARGET_AUTHORITY_REQUIRED",
        "This workspace hasn't accepted the real-data statement, so it can't run real-data tests."
      )
  ],
  [
    "target not verified",
    () => realDataError("TARGET_AUTHORITY_REQUIRED", "This suite's target isn't verified yet, so it can't run real-data tests.")
  ],
  [
    "machine key used for setup (server)",
    () => realDataError("TARGET_AUTHORITY_REQUIRED", "Machine keys can't register targets or create scopes.")
  ],
  ["machine key used for setup (CLI)", () => ownerLoginRequiredError("Creating a test scope")],
  ["release unavailable", () => caught(() => assertHostedRealDataRelease(ADVERTISED_DISABLED_CAPABILITIES))],
  [
    "release unavailable, rate limited",
    () => realDataError("EXECUTION_RELEASE_UNAVAILABLE", "Too many real-data runs started in this workspace.")
  ]
];

describe("plain-language real-data errors (AUG-366)", () => {
  it.each(CASES)("%s", (_name, raise) => {
    const error = raise();
    const line = formatCliError(error);
    expect(line).toMatchSnapshot();
    // What happened, then what to do, with the code last.
    expect(line.endsWith(`(${error.code})`)).toBe(true);
    expect(line).toMatch(/`augmentworks [a-z]|Settings → Targets|run the same command again/u);
    expect(line).not.toMatch(/admitted|release-disabled|quote|authority document/iu);
    const classified = classifyRealDataFailure(error);
    if (classified !== undefined) {
      expect(classified.fix.length).toBeGreaterThan(0);
      expect(error.message.endsWith(classified.fix)).toBe(true);
    }
  });

  it("strips every advice variant to recover the server's words", () => {
    for (const [, raise] of CASES) {
      const error = raise();
      const fix = classifyRealDataFailure(error)?.fix;
      if (fix === undefined) continue;
      expect(withoutRecoverySuffix(error.message)).toBe(error.message.slice(0, -fix.length - 1));
    }
  });

  it("keeps the bracketed format for other errors", () => {
    expect(formatCliError(new AwError({ code: "SCHEMA_KIND_INVALID", category: "config", message: "Unknown kind." }))).toBe(
      "Error [SCHEMA_KIND_INVALID]: Unknown kind."
    );
  });

  it("prints a setup error with the code last", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aw-plain-errors-"));
    temporary.push(directory);
    const suite = join(directory, "refunds.suite.yaml");
    await writeFile(suite, "schema_version: aw-suite/3\nsuite_id: refunds\n", "utf8");
    vi.stubEnv("AUGMENTWORKS_API_KEY", "aw_api_test_key");
    const stderr: string[] = [];
    const code = await runCli(["node", "augmentworks", "scope", "create", "--target", "support", "--suite", suite], {
      stderr: { write: (chunk: string | Uint8Array) => stderr.push(String(chunk)) > 0 }
    });
    expect(code).not.toBe(0);
    expect(stderr.join("")).toBe(
      "Error: Creating a test scope needs a workspace owner's login, and machine keys can't do it. Unset AUGMENTWORKS_API_KEY and run `augmentworks login` as an owner. (TARGET_OWNER_LOGIN_REQUIRED)\n"
    );
  });
});
