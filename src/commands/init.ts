import { constants as fsConstants } from "node:fs";
import { access, link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

import { Command } from "commander";

import { AwError } from "../errors.js";
import {
  CUSTOMER_CLI_PLACEHOLDER,
  HOSTED_COMMAND_PIN,
  initNextSteps,
  NPM_PACKAGE,
  renderStarterOwnTarget
} from "../release.js";
import {
  DEFAULT_STARTER,
  loadStarterFiles,
  parseStarterId,
  STARTER_ASSESSMENT_RELATIVE_PATH,
  STARTER_CONNECTOR_RELATIVE_PATH,
  STARTER_ENV_EXAMPLE_RELATIVE_PATH,
  type StarterFile,
  type StarterId
} from "../onboarding/starters.js";

const ENV_TEMPLATE = `# Local target settings. Keep .env out of version control.
CHATBOT_BASE_URL=http://localhost:8000
CHATBOT_API_KEY=
`;

interface PlannedWrite {
  readonly path: string;
  readonly content: string;
}

export interface InitOptions {
  readonly config?: string;
  readonly cwd?: string;
  readonly force?: boolean;
  readonly agent?: boolean;
  readonly env?: boolean;
  readonly starter?: string;
}

export interface InitResult {
  readonly starter: StarterId;
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly preserved: readonly string[];
}

export interface InitCommandDependencies {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly cwd?: () => string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function displayPathFrom(root: string, path: string): string {
  const relativePath = relative(root, path);
  if (relativePath === "" || isAbsolute(relativePath) || relativePath.split(sep)[0] === "..") {
    return path;
  }
  return relativePath.split(sep).join("/");
}

function agentTemplate(configDisplayPath: string): string {
  return `# AugmentWorks agent setup

Use the pinned AugmentWorks CLI when working on this integration:

\`\`\`bash
npx --yes ${NPM_PACKAGE}@${HOSTED_COMMAND_PIN} doctor -c ${configDisplayPath}
\`\`\`

- Read \`${configDisplayPath}\`, \`${STARTER_ASSESSMENT_RELATIVE_PATH}\`, and \`${STARTER_ENV_EXAMPLE_RELATIVE_PATH}\`; never read, print, or commit \`.env\`.
- Keep target paths and request/response mappings declarative. Do not add executable mappings.
- Add only the prepare, send, observe, and cleanup hooks required by the selected pattern. The packaged starter is fictional. Hosted real-data tests need a target a workspace owner registered and verified and a test scope (\`augmentworks target add\`, \`target verify\`, \`scope create\`); never run those yourself. Without a scope, do not point hosted runs at production or upload production, customer, or regulated records. Do not set \`synthetic_only: true\` on a live or authorized document, grant \`suite:write\` to a machine key, or test a third party without authority. Response-only JSON chat must not add unused state hooks.
- Preview mappings with a JSON fixture before calling the target. Use \`probe\` to print the bounded plan, then \`probe --yes\` only after that review. Doctor and init never probe.
- Hosted catalog listing is \`catalog list\` / \`catalog show\`. Smoke/release selection and shards are server-compiled; catalog counts are not a quote. Keep this generated assessment format; do not invent a second file.
- Show the diff and ask before starting an assessment or changing external systems.
- Do not overwrite an edited assessment or reference file. Re-run init with --force only when replacing generated starters.
`;
}

function destinationForStarterFile(file: StarterFile, configDirectory: string, configPath: string): string {
  if (file.relativePath === STARTER_CONNECTOR_RELATIVE_PATH) return configPath;
  return resolve(configDirectory, file.relativePath);
}

function starterFileContent(file: StarterFile): string {
  if (file.relativePath !== "OWN-TARGET.md") return file.content;
  if (!file.content.includes(CUSTOMER_CLI_PLACEHOLDER)) {
    throw new AwError({
      code: "INIT_STARTER_MISSING",
      category: "config",
      message: "The packaged OWN-TARGET.md starter is missing the {{AW_CLI}} invocation placeholder."
    });
  }
  return renderStarterOwnTarget(file.content);
}

function planGeneratedWrites(
  starterFiles: readonly StarterFile[],
  configDirectory: string,
  configPath: string,
  agent: boolean
): PlannedWrite[] {
  const writes: PlannedWrite[] = starterFiles.map((file) => ({
    path: destinationForStarterFile(file, configDirectory, configPath),
    content: starterFileContent(file)
  }));
  if (agent) {
    writes.push({
      path: resolve(configDirectory, "augmentworks.agent.md"),
      content: agentTemplate(displayPathFrom(configDirectory, configPath))
    });
  }
  return writes;
}

function assertUniqueWritePaths(writes: readonly PlannedWrite[]): void {
  const seen = new Set<string>();
  for (const write of writes) {
    if (seen.has(write.path)) {
      throw new AwError({
        code: "INIT_CONFIG_PATH_COLLISION",
        category: "config",
        message: `Refusing to write the connector to ${write.path} because it collides with another generated starter file.`,
        details: { path: write.path }
      });
    }
    seen.add(write.path);
  }
}

async function atomicWrite(path: string, content: string, mode: number, overwrite: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    if (overwrite) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function ensureIgnored(gitignorePath: string): Promise<"created" | "updated" | "preserved"> {
  let current = "";
  let hadFile = true;
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hadFile = false;
  }
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  const additions: string[] = [];
  if (!(lines.includes(".env") || lines.includes("*.env") || lines.includes(".env*"))) {
    additions.push(".env");
  }
  if (
    !(
      lines.includes(".augmentworks") ||
      lines.includes(".augmentworks/") ||
      lines.includes("/.augmentworks") ||
      lines.includes("/.augmentworks/")
    )
  ) {
    additions.push(".augmentworks/");
  }
  if (additions.length === 0) return "preserved";
  const next = `${current}${current !== "" && !current.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`;
  const result = hadFile ? "updated" : "created";
  await atomicWrite(gitignorePath, next, 0o644, hadFile);
  return result;
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const starter = parseStarterId(options.starter);
  const configPath = resolve(cwd, options.config ?? STARTER_CONNECTOR_RELATIVE_PATH);
  const configDirectory = dirname(configPath);
  const envPath = resolve(configDirectory, ".env");
  const gitignorePath = resolve(configDirectory, ".gitignore");
  const force = options.force === true;
  const createEnvironment = options.env !== false;
  const starterFiles = await loadStarterFiles(starter);
  const writes = planGeneratedWrites(starterFiles, configDirectory, configPath, options.agent === true);
  assertUniqueWritePaths(writes);
  if (!force) {
    const collision = (await Promise.all(writes.map(async (write) => ({ path: write.path, exists: await exists(write.path) })))).find(
      (item) => item.exists
    );
    if (collision !== undefined) {
      throw new AwError({
        code: "INIT_FILE_EXISTS",
        category: "config",
        message: `Refusing to overwrite existing file ${collision.path}. Use --force to replace generated files.`,
        details: { path: collision.path }
      });
    }
  }

  const created: string[] = [];
  const updated: string[] = [];
  const preserved: string[] = [];
  for (const write of writes) {
    const alreadyExists = await exists(write.path);
    await atomicWrite(write.path, write.content, 0o644, alreadyExists && force);
    (alreadyExists ? updated : created).push(write.path);
  }

  if (createEnvironment) {
    if (await exists(envPath)) preserved.push(envPath);
    else {
      const example = starterFiles.find((file) => file.relativePath === STARTER_ENV_EXAMPLE_RELATIVE_PATH);
      await atomicWrite(envPath, example?.content ?? ENV_TEMPLATE, 0o600, false);
      created.push(envPath);
    }
    const ignoreResult = await ensureIgnored(gitignorePath);
    if (ignoreResult === "created") created.push(gitignorePath);
    else if (ignoreResult === "updated") updated.push(gitignorePath);
    else preserved.push(gitignorePath);
  }

  return { starter, created, updated, preserved };
}

export function createInitCommand(dependencies: InitCommandDependencies = {}): Command {
  return new Command("init")
    .description("Create a complete AugmentWorks connector, assessment, and starter references")
    .option("-c, --config <path>", "configuration path", STARTER_CONNECTOR_RELATIVE_PATH)
    .option(
      "--starter <name>",
      "response-quality / response-only (default JSON chat) or workflow / stateful (tool lifecycle)",
      DEFAULT_STARTER
    )
    .option("--agent", "also create repository-local coding-agent instructions")
    .option("--force", "replace generated files, but never replace an existing .env")
    .option("--no-env", "do not create a local .env or update .gitignore")
    .action(
      async (commandOptions: {
        config: string;
        starter?: string;
        agent?: boolean;
        force?: boolean;
        env: boolean;
      }) => {
        const cwd = dependencies.cwd?.() ?? process.cwd();
        const result = await runInit({
          config: commandOptions.config,
          cwd,
          force: commandOptions.force === true,
          agent: commandOptions.agent === true,
          env: commandOptions.env,
          ...(commandOptions.starter === undefined ? {} : { starter: commandOptions.starter })
        });
        const output = dependencies.stdout ?? process.stdout;
        output.write(`starter ${result.starter}\n`);
        for (const path of result.created) output.write(`created ${path}\n`);
        for (const path of result.updated) output.write(`updated ${path}\n`);
        for (const path of result.preserved) output.write(`preserved ${path}\n`);
        const configPath = resolve(cwd, commandOptions.config);
        const configDirectory = dirname(configPath);
        output.write(
          `${initNextSteps(
            displayPathFrom(cwd, configPath),
            displayPathFrom(cwd, resolve(configDirectory, STARTER_ASSESSMENT_RELATIVE_PATH))
          )}\n`
        );
      }
    );
}
