import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDoctor } from "../../src/commands/doctor.js";
import { createInitCommand, runInit } from "../../src/commands/init.js";
import { runSchema } from "../../src/commands/schema.js";
import {
  HOSTED_COMMAND_PIN,
  initNextSteps,
  LOCAL_DISTRIBUTION,
  PUBLISHED_PACKAGE_VERSION,
  SOURCE_PACKAGE_VERSION
} from "../../src/release.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "augmentworks-init-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("configuration commands", () => {
  it("initializes atomically and never replaces an existing .env", async () => {
    const directory = await temporaryDirectory();
    const initial = await runInit({ cwd: directory, agent: true });
    expect(initial.created).toEqual(expect.arrayContaining([
      resolve(directory, "augmentworks.yaml"),
      resolve(directory, "augmentworks.assessment.yaml"),
      resolve(directory, "references/faq.md"),
      resolve(directory, ".env"),
      resolve(directory, ".env.example"),
      resolve(directory, "augmentworks.agent.md")
    ]));
    expect(initial.starter).toBe("response-quality");
    expect(await readFile(resolve(directory, "augmentworks.assessment.yaml"), "utf8")).toContain(
      "response-quality"
    );
    expect(await readFile(resolve(directory, "references/faq.md"), "utf8")).toContain("30 days");
    if (process.platform !== "win32") {
      expect((await lstat(resolve(directory, ".env"))).mode & 0o077).toBe(0);
    }
    await writeFile(resolve(directory, ".env"), "CHATBOT_API_KEY=keep-me\n", { encoding: "utf8", mode: 0o600 });
    const forced = await runInit({ cwd: directory, agent: true, force: true });
    expect(forced.preserved).toContain(resolve(directory, ".env"));
    expect(await readFile(resolve(directory, ".env"), "utf8")).toBe("CHATBOT_API_KEY=keep-me\n");
    expect(await readFile(resolve(directory, ".gitignore"), "utf8")).toContain(".env\n");
    expect(await readFile(resolve(directory, ".gitignore"), "utf8")).toContain(
      ".augmentworks/\n"
    );
    const agent = await readFile(resolve(directory, "augmentworks.agent.md"), "utf8");
    expect(agent).toContain(`npx --yes @augmentworks/cli@${HOSTED_COMMAND_PIN} doctor -c augmentworks.yaml`);
    expect(agent).toContain("Add only the prepare, send, observe, and cleanup hooks required by the selected pattern.");
    expect(agent).toContain("The packaged starter is fictional.");
    expect(agent).toContain("Hosted real-data tests need a target a workspace owner registered and verified");
    expect(agent).not.toContain("release-disabled");
    expect(agent).not.toContain("Add only synthetic prepare, send, observe, and cleanup hooks");
    expect(agent).not.toContain("Preview mappings with a synthetic JSON fixture");
    if (LOCAL_DISTRIBUTION === "git") {
      expect(agent).not.toContain(`npx --yes @augmentworks/cli@${SOURCE_PACKAGE_VERSION}`);
    }
  });

  it("adds the local artifact directory even when .env is already ignored", async () => {
    const directory = await temporaryDirectory();
    await writeFile(resolve(directory, ".gitignore"), ".env\n", "utf8");
    await runInit({ cwd: directory });
    expect(await readFile(resolve(directory, ".gitignore"), "utf8")).toBe(
      ".env\n.augmentworks/\n"
    );
  });

  it("refuses to overwrite generated files without --force", async () => {
    const directory = await temporaryDirectory();
    await runInit({ cwd: directory });
    await expect(runInit({ cwd: directory })).rejects.toMatchObject({ code: "INIT_FILE_EXISTS" });
  });

  it("doctor validates locally and reports the capability", async () => {
    const directory = await temporaryDirectory();
    await runInit({ cwd: directory });
    const report = await runDoctor({
      cwd: directory,
      processEnv: {
        CHATBOT_BASE_URL: "http://localhost:8000",
        CHATBOT_API_KEY: "local-test-value"
      }
    });
    expect(report.ok).toBe(true);
    expect(report.offline).toBe(true);
    expect(report.resolvedConfig?.capabilities.level).toBe("chat-only");
    expect(report.assessment?.document.packets[0]?.key).toBe("response-quality");
    expect(report.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "OFFLINE_CHECK_COMPLETE",
        "MAPPING_PREVIEW_AVAILABLE",
        "ASSESSMENT_FILE_VALID",
        "ASSESSMENT_WIRE_BOUNDS",
        "ASSESSMENT_CAPABILITY_MATCH",
        "CONVERSATION_SINGLE_TURN"
      ])
    );
  });

  it("refuses to overwrite an edited assessment without --force", async () => {
    const directory = await temporaryDirectory();
    await runInit({ cwd: directory });
    await writeFile(resolve(directory, "augmentworks.assessment.yaml"), "# edited\n", "utf8");
    await expect(runInit({ cwd: directory })).rejects.toMatchObject({ code: "INIT_FILE_EXISTS" });
    expect(await readFile(resolve(directory, "augmentworks.assessment.yaml"), "utf8")).toBe("# edited\n");
  });

  it("writes matching workflow starter files", async () => {
    const directory = await temporaryDirectory();
    const result = await runInit({ cwd: directory, starter: "workflow" });
    expect(result.starter).toBe("workflow");
    expect(await readFile(resolve(directory, "augmentworks.yaml"), "utf8")).toContain("prepare:");
    expect(await readFile(resolve(directory, "augmentworks.assessment.yaml"), "utf8")).toContain(
      "support-refunds"
    );
    const report = await runDoctor({
      cwd: directory,
      processEnv: {
        CHATBOT_BASE_URL: "http://localhost:8000",
        CHATBOT_API_KEY: "local-test-value"
      }
    });
    expect(report.ok).toBe(true);
    expect(report.resolvedConfig?.capabilities.level).toBe("stateful");
    expect(report.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "OFFLINE_CHECK_COMPLETE",
        "MAPPING_PREVIEW_AVAILABLE",
        "ASSESSMENT_CAPABILITY_MATCH",
        "CONVERSATION_SINGLE_TURN"
      ])
    );
  });

  it("rejects an unknown starter", async () => {
    const directory = await temporaryDirectory();
    await expect(runInit({ cwd: directory, starter: "enterprise" })).rejects.toMatchObject({
      code: "INIT_STARTER_UNKNOWN"
    });
  });

  it("warns when doctor runs against a config-only directory", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      resolve(directory, "augmentworks.yaml"),
      `version: 1
target:
  name: chat
  connector: http
  base_url: \${CHATBOT_BASE_URL}
  operations:
    send:
      method: POST
      path: /chat
      request:
        message: $input.message.content
      response:
        content: $.answer
`,
      "utf8"
    );
    const report = await runDoctor({
      cwd: directory,
      processEnv: {
        CHATBOT_BASE_URL: "http://localhost:8000",
        CHATBOT_API_KEY: "local-test-value"
      }
    });
    expect(report.ok).toBe(true);
    expect(report.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["ASSESSMENT_FILE_ABSENT", "MAPPING_PREVIEW_AVAILABLE", "CONVERSATION_SINGLE_TURN"])
    );
  });

  it("writes the requested connector filename instead of augmentworks.yaml", async () => {
    const directory = await temporaryDirectory();
    const result = await runInit({ cwd: directory, config: "custom.yaml", env: false });
    expect(result.created).toContain(resolve(directory, "custom.yaml"));
    expect(result.created).toContain(resolve(directory, "augmentworks.assessment.yaml"));
    expect(result.created).toContain(resolve(directory, "references/faq.md"));
    expect(result.created).toContain(resolve(directory, ".env.example"));
    expect(result.created).not.toContain(resolve(directory, "augmentworks.yaml"));
    expect(result.created).not.toContain(resolve(directory, ".env"));
    expect(result.created).not.toContain(resolve(directory, ".gitignore"));
    await expect(access(resolve(directory, "augmentworks.yaml"), fsConstants.F_OK)).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(resolve(directory, ".env"), fsConstants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
    const report = await runDoctor({
      cwd: directory,
      config: "custom.yaml",
      processEnv: {
        CHATBOT_BASE_URL: "http://localhost:8000",
        CHATBOT_API_KEY: "local-test-value"
      }
    });
    expect(report.ok).toBe(true);
    expect(report.configPath).toBe(resolve(directory, "custom.yaml"));
  });

  it.each([
    { starter: "response-quality" as const, config: "nested/custom.yaml" },
    { starter: "workflow" as const, config: "nested/workflow.yaml" }
  ])("honors a nested $config path for the $starter starter", async ({ starter, config }) => {
    const directory = await temporaryDirectory();
    const result = await runInit({ cwd: directory, config, starter, env: false });
    const configPath = resolve(directory, config);
    const configDirectory = dirname(configPath);
    expect(result.starter).toBe(starter);
    expect(result.created).toContain(configPath);
    expect(result.created).toContain(resolve(configDirectory, "augmentworks.assessment.yaml"));
    expect(result.created).not.toContain(resolve(directory, "augmentworks.yaml"));
    expect(result.created).not.toContain(resolve(configDirectory, "augmentworks.yaml"));
    await expect(access(resolve(directory, "augmentworks.yaml"), fsConstants.F_OK)).rejects.toMatchObject({
      code: "ENOENT"
    });
    const report = await runDoctor({
      cwd: directory,
      config,
      processEnv: {
        CHATBOT_BASE_URL: "http://localhost:8000",
        CHATBOT_API_KEY: "local-test-value"
      }
    });
    expect(report.ok).toBe(true);
    expect(report.configPath).toBe(configPath);
  });

  it("honors an absolute config path for the workflow starter", async () => {
    const directory = await temporaryDirectory();
    const configPath = resolve(directory, "absolute", "connector.yaml");
    const result = await runInit({ cwd: directory, config: configPath, starter: "workflow", env: false });
    expect(result.created).toContain(configPath);
    expect(result.created).toContain(resolve(directory, "absolute", "augmentworks.assessment.yaml"));
    expect(result.created).toContain(resolve(directory, "absolute", "references/refund-policy.md"));
    expect(result.created).not.toContain(resolve(directory, "augmentworks.yaml"));
    const report = await runDoctor({
      cwd: directory,
      config: configPath,
      processEnv: {
        CHATBOT_BASE_URL: "http://localhost:8000",
        CHATBOT_API_KEY: "local-test-value"
      }
    });
    expect(report.ok).toBe(true);
    expect(report.resolvedConfig?.capabilities.level).toBe("stateful");
  });

  it("protects the requested file and does not replace a sibling default config", async () => {
    const directory = await temporaryDirectory();
    await writeFile(resolve(directory, "augmentworks.yaml"), "# keep-default\n", "utf8");
    const created = await runInit({ cwd: directory, config: "custom.yaml", env: false });
    expect(created.created).toContain(resolve(directory, "custom.yaml"));
    expect(await readFile(resolve(directory, "augmentworks.yaml"), "utf8")).toBe("# keep-default\n");

    await writeFile(resolve(directory, "custom.yaml"), "# keep-custom\n", "utf8");
    await expect(runInit({ cwd: directory, config: "custom.yaml", env: false })).rejects.toMatchObject({
      code: "INIT_FILE_EXISTS"
    });
    expect(await readFile(resolve(directory, "custom.yaml"), "utf8")).toBe("# keep-custom\n");
    expect(await readFile(resolve(directory, "augmentworks.yaml"), "utf8")).toBe("# keep-default\n");

    const forced = await runInit({ cwd: directory, config: "custom.yaml", env: false, force: true });
    expect(forced.updated).toContain(resolve(directory, "custom.yaml"));
    expect(forced.updated).not.toContain(resolve(directory, "augmentworks.yaml"));
    expect(await readFile(resolve(directory, "augmentworks.yaml"), "utf8")).toBe("# keep-default\n");
    expect(await readFile(resolve(directory, "custom.yaml"), "utf8")).toContain("version:");
  });

  it("mentions the selected config in agent instructions and next-step guidance", async () => {
    const directory = await temporaryDirectory();
    await runInit({ cwd: directory, config: "nested/custom.yaml", agent: true, env: false });
    const agent = await readFile(resolve(directory, "nested/augmentworks.agent.md"), "utf8");
    expect(agent).toContain(`npx --yes @augmentworks/cli@${HOSTED_COMMAND_PIN} doctor -c custom.yaml`);
    expect(agent).toContain("`custom.yaml`");
    expect(agent).not.toContain("doctor -c augmentworks.yaml");

    const chunks: string[] = [];
    const command = createInitCommand({
      cwd: () => directory,
      stdout: { write: (chunk) => {
        chunks.push(String(chunk));
        return true;
      } }
    });
    await command.parseAsync(["-c", "other.yaml", "--no-env"], { from: "user" });
    const output = chunks.join("");
    expect(output).toContain(resolve(directory, "other.yaml"));
    expect(output).toContain(initNextSteps("other.yaml"));
    expect(output).not.toContain("created augmentworks.yaml, augmentworks.assessment.yaml");
    if (LOCAL_DISTRIBUTION === "npm") {
      expect(output).not.toContain("node dist/index.js");
      expect(output).toContain(
        `npx --yes @augmentworks/cli@${PUBLISHED_PACKAGE_VERSION} probe -c other.yaml`
      );
    }
  });

  it("prints npm-distribution init next steps without node dist/index.js", async () => {
    const directory = await temporaryDirectory();
    const chunks: string[] = [];
    const command = createInitCommand({
      cwd: () => directory,
      stdout: {
        write: (chunk) => {
          chunks.push(String(chunk));
          return true;
        }
      }
    });
    await command.parseAsync(["--agent"], { from: "user" });
    const output = chunks.join("");
    const ownTarget = await readFile(resolve(directory, "OWN-TARGET.md"), "utf8");
    const agent = await readFile(resolve(directory, "augmentworks.agent.md"), "utf8");
    const pin = `npx --yes @augmentworks/cli@${PUBLISHED_PACKAGE_VERSION}`;

    expect(output).toContain(initNextSteps());
    expect(ownTarget).not.toContain("{{AW_CLI}}");
    expect(agent).toContain(`${pin} doctor -c augmentworks.yaml`);

    if (LOCAL_DISTRIBUTION === "npm") {
      expect(output).not.toContain("node dist/index.js");
      expect(output).toContain(
        `${pin} preview-mapping -c augmentworks.yaml --operation send --fixture ./fixtures/send-response.json`
      );
      expect(output).toContain(`${pin} probe -c augmentworks.yaml`);
      expect(output).toContain(`${pin} probe -c augmentworks.yaml --yes`);
      expect(ownTarget).not.toContain("node dist/index.js");
      expect(ownTarget).toContain(`${pin} preview-mapping`);
      expect(ownTarget).toContain(`${pin} probe -c augmentworks.yaml --yes`);
    } else {
      expect(output).toContain("node dist/index.js preview-mapping");
      expect(ownTarget).toContain("node dist/index.js preview-mapping");
    }
  });

  it("refuses a requested config path that collides with another generated starter file", async () => {
    const directory = await temporaryDirectory();
    await expect(runInit({ cwd: directory, config: "augmentworks.assessment.yaml", env: false })).rejects.toMatchObject({
      code: "INIT_CONFIG_PATH_COLLISION"
    });
  });

  it("prints a valid bundled schema", async () => {
    const schema = JSON.parse(await runSchema()) as Record<string, unknown>;
    expect(schema["$id"]).toBe("https://augmentworks.ai/schemas/v1/augmentworks.schema.json");
    expect(schema["additionalProperties"]).toBe(false);

    const packet = JSON.parse(await runSchema(false, "local-packet")) as Record<string, unknown>;
    const result = JSON.parse(await runSchema(true, "local-result")) as Record<string, unknown>;
    const suite = JSON.parse(await runSchema(false, "customer-suite")) as Record<string, unknown>;
    const investigation = JSON.parse(await runSchema(false, "investigation-export")) as Record<string, unknown>;
    expect(packet["$id"]).toBe("https://augmentworks.ai/schemas/v1/local-packet.schema.json");
    expect(result["$id"]).toBe("https://augmentworks.ai/schemas/v1/local-result.schema.json");
    expect(String(suite["$id"])).toBe(
      String(packet["$id"]).replace(/local-packet\.schema\.json$/u, "customer-suite.schema.json")
    );
    expect(String(investigation["$id"])).toBe(
      String(packet["$id"]).replace(/local-packet\.schema\.json$/u, "investigation-export.schema.json")
    );
  });
});
