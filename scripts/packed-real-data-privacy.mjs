#!/usr/bin/env node

/**
 * Packed normal-invocation privacy fixture (AUG-188 remaining scope).
 *
 * Runs the installed CLI `test --local` against invented canaries. This is not a
 * fake PrivacyService unit test: the packed binary must use landed R06.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePackReport } from "./npm-pack-report.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_D = "44444444-4444-4444-8444-444444444444";
const UUID_E = "55555555-5555-4555-8555-555555555555";
const UUID_F = "66666666-6666-4666-8666-666666666666";
const FUTURE = "2099-12-31T23:59:59Z";
const CANARIES = {
  secret: "SYNTHETIC_CANARY_SECRET_do_not_leak",
  token: "SYNTHETIC_CANARY_TOKEN_do_not_leak",
  password: "nested-synthetic-password-value",
  apiKey: "sk-syntheticCanaryKey12",
  email: "canary.user@example.test",
  phone: "+1-555-010-1234"
};
const ANSWER = `Weekday support hours are 9 to 17. Contact ${CANARIES.email} at ${CANARIES.phone}. token=${CANARIES.token} api_key=${CANARIES.apiKey} password:${CANARIES.password}`;

class FixtureFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "FixtureFailure";
  }
}

function assert(condition, message) {
  if (!condition) throw new FixtureFailure(message);
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function omitHash(document, hashField) {
  const output = {};
  for (const [key, child] of Object.entries(document)) {
    if (key === hashField) continue;
    output[key] = child;
  }
  return output;
}

function seal(document, hashField) {
  return { ...document, [hashField]: sha256(canonicalize(omitHash(document, hashField))) };
}

function resolveNpmJsCli(binName) {
  const fileName = `${binName}-cli.js`;
  const fromLifecycle =
    typeof process.env.npm_execpath === "string" && process.env.npm_execpath.length > 0
      ? process.env.npm_execpath
      : undefined;
  const candidates = [];
  if (fromLifecycle !== undefined) {
    if (binName === "npm") candidates.push(fromLifecycle);
    candidates.push(join(dirname(fromLifecycle), fileName));
  }
  const prefix = dirname(process.execPath);
  candidates.push(
    join(prefix, "node_modules", "npm", "bin", fileName),
    join(prefix, "..", "lib", "node_modules", "npm", "bin", fileName)
  );
  return candidates.find((path) => existsSync(path));
}

function runJsCli(binName, args, options = {}) {
  const cli = resolveNpmJsCli(binName);
  const executable = cli === undefined ? (process.platform === "win32" ? `${binName}.cmd` : binName) : process.execPath;
  const argv = cli === undefined ? args : [cli, ...args];
  return spawnSync(executable, argv, {
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, ...options.env, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
    ...(cli === undefined && process.platform === "win32" ? { shell: true } : {})
  });
}

async function ensurePackedBin(temporaryRoot) {
  const provided = process.env.AUGMENTWORKS_PACKED_BIN?.trim();
  if (provided) {
    await access(provided, fsConstants.R_OK);
    return provided;
  }
  const packDirectory = join(temporaryRoot, "pack");
  const consumerDirectory = join(temporaryRoot, "install");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  const built = runJsCli("npm", ["run", "build"]);
  if (built.status !== 0) throw new FixtureFailure(`npm run build failed\n${built.stderr}`);
  const packed = runJsCli("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory]);
  if (packed.status !== 0) throw new FixtureFailure(`npm pack failed\n${packed.stderr}`);
  const report = parsePackReport(packed.stdout);
  const tarballPath = join(packDirectory, report.filename);
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "aw-packed-real-data-privacy", private: true, version: "0.0.0" }, null, 2)}\n`,
    "utf8"
  );
  const installed = runJsCli(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballPath],
    { cwd: consumerDirectory }
  );
  if (installed.status !== 0) throw new FixtureFailure(`npm install tarball failed\n${installed.stderr}`);
  return join(consumerDirectory, "node_modules", "@augmentworks", "cli", "dist", "index.js");
}

function canaryProfile() {
  return seal(
    {
      schemaVersion: "aw-redaction-profile/1",
      profileId: UUID_E,
      revision: 1,
      profileHash: "0".repeat(64),
      allowedContentFields: [],
      rules: [
        // Relay replies reach the profile as the ingress document { path, content: message }.
        { id: "mask-email-message", selector: "/content/content", action: "mask", detector: "email" },
        { id: "mask-phone-message", selector: "/content/content", action: "mask", detector: "phone" },
        {
          id: "mask-email-assistant",
          selector: "/attempts/*/turns/*/assistant_content",
          action: "mask",
          detector: "email"
        },
        {
          id: "mask-phone-assistant",
          selector: "/attempts/*/turns/*/assistant_content",
          action: "mask",
          detector: "phone"
        }
      ],
      maxDocumentBytes: 65_536,
      maxTextChars: 8_000
    },
    "profileHash"
  );
}

function canaryPolicy(profile, dataClass, contentHandling) {
  return seal(
    {
      schemaVersion: "aw-data-policy/1",
      policyId: UUID_D,
      revision: 1,
      policyHash: "0".repeat(64),
      dataClass,
      contentHandling,
      redactionProfileId: profile.profileId,
      redactionProfileHash: profile.profileHash,
      retentionDays: 30,
      externalSharing: "disabled",
      providerProcessing: "openai_standard"
    },
    "policyHash"
  );
}

function authorizedPacket(origin, policy, profile) {
  const boundary = seal(
    {
      // aw-target-boundary/1 as the contract defines it. A local scope carries only
      // its hash, which the CLI rebuilds from augmentworks.yaml (AUG-355).
      schemaVersion: "aw-target-boundary/1",
      targetId: UUID_A,
      revision: 1,
      boundaryHash: "0".repeat(64),
      transport: "direct_http",
      effectBoundary: "no_tools",
      assessedIdentity: new URL(origin).origin,
      endpoints: [{ method: "POST", path: "/chat" }]
    },
    "boundaryHash"
  );
  const scope = seal(
    {
      schemaVersion: "aw-local-execution-scope/1",
      scopeId: UUID_F,
      revision: 1,
      scopeHash: "0".repeat(64),
      targetId: boundary.targetId,
      targetRevision: boundary.revision,
      targetBoundaryHash: boundary.boundaryHash,
      environment: "development",
      dataOrigin: "constructed",
      effects: "informational",
      authority: {
        id: UUID_B,
        revision: 1,
        hash: sha256(canonicalize({ id: UUID_B, revision: 1 })),
        verification: "customer_declared_local"
      },
      dataPolicy: { id: policy.policyId, revision: policy.revision, hash: policy.policyHash },
      actionPolicy: null,
      budget: {
        maxMessages: 3,
        maxActions: 0,
        maxCommands: 8,
        maxRuntimeSeconds: 600,
        maxCredits: 0
      },
      expiresAt: FUTURE
    },
    "scopeHash"
  );
  return {
    schema_version: "aw-packet/local-authorized-1",
    packet_id: "packed-real-data-privacy",
    version: "1.0.0",
    name: "Packed real-data privacy canary",
    description: "Invented canaries only. No customer records.",
    domain: "records",
    synthetic_only: false,
    execution_scope: scope,
    data_policy: policy,
    redaction_profile: profile,
    required_capabilities: {
      multi_turn: false,
      observation: false,
      tool_events: false,
      cleanup: false
    },
    scenarios: [
      {
        key: "packed-real-data-privacy.hours",
        name: "Hours",
        category: "records",
        severity: "medium",
        description: "Ask weekday hours against the local target.",
        expected_behavior: "State weekday hours.",
        fixture: {},
        turns: [{ content: "What are your weekday support hours?" }],
        observation_keys: [],
        assertions: [
          {
            kind: "assistant_contains",
            key: "hours",
            description: "Mentions weekday hours.",
            value: "Weekday"
          }
        ],
        repetitions: 1,
        pass_threshold: 1
      }
    ]
  };
}

function connectorYaml() {
  return `version: 1
target:
  name: packed-real-data-privacy
  connector: http
  base_url: \${CHATBOT_BASE_URL}
  auth:
    bearer_env: CHATBOT_API_KEY
  operations:
    send:
      method: POST
      path: /chat
      request:
        message: $input.message.content
      response:
        content: $.answer
        finished: $.finished
`;
}

// Verbatim content handling keeps permitted customer content such as email and
// phone, as the server contract does (AUG-417). Credentials never leave.
const CONTACT_CANARIES = new Set(["email", "phone"]);

function expectNoCanaries(text, label, { keepContact = false } = {}) {
  for (const [name, canary] of Object.entries(CANARIES)) {
    if (keepContact && CONTACT_CANARIES.has(name)) continue;
    assert(!String(text).includes(canary), `${label} leaked ${name}`);
  }
}

function runPacked(packedBin, args, env, cwd, expectStatus) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [packedBin, ...args], {
      cwd,
      env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 60_000);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new FixtureFailure(`Could not run packed CLI: ${error.message}`));
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      if (status !== expectStatus) {
        reject(
          new FixtureFailure(
            `packed CLI ${args.join(" ")} exited ${String(status)}${signal ? ` signal=${signal}` : ""}, expected ${String(expectStatus)}\n${stdout.trim()}\n${stderr.trim()}`
          )
        );
        return;
      }
      resolveRun({ status, stdout, stderr });
    });
  });
}

async function writeProject(directory, origin, packet) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "augmentworks.yaml"), connectorYaml(), "utf8");
  await writeFile(
    join(directory, ".env"),
    `CHATBOT_BASE_URL=${origin}\nCHATBOT_API_KEY=pack-privacy-target-key\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  await writeFile(join(directory, "packet.json"), `${JSON.stringify(packet, null, 2)}\n`, "utf8");
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "aw-packed-real-data-privacy-"));
  let server;
  try {
    const packedBin = await ensurePackedBin(temporaryRoot);
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
        return;
      }
      if (request.method === "POST" && url.pathname === "/chat") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8");
        expectNoCanaries(body, "target request body");
        const payload = JSON.stringify({ answer: ANSWER, finished: true });
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        });
        response.end(payload);
        return;
      }
      const missing = "<!DOCTYPE html><html><body>404: This page could not be found.</body></html>";
      response.writeHead(404, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(missing)
      });
      response.end(missing);
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const isolatedHome = join(temporaryRoot, "home");
    await mkdir(isolatedHome, { recursive: true });
    const env = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      LOCALAPPDATA: join(isolatedHome, "AppData", "Local"),
      APPDATA: join(isolatedHome, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      XDG_STATE_HOME: join(isolatedHome, ".local", "state"),
      AUGMENTWORKS_STATE_DIR: join(isolatedHome, "aw-state"),
      AUGMENTWORKS_API_URL: "http://127.0.0.1:1",
      AUGMENTWORKS_TOKEN: "",
      AUGMENTWORKS_API_KEY: "",
      CHATBOT_BASE_URL: origin,
      CHATBOT_API_KEY: "pack-privacy-target-key",
      CI: "1",
      NO_COLOR: "1",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      ALL_PROXY: "",
      all_proxy: "",
      NO_PROXY: "*",
      no_proxy: "*"
    };

    const profile = canaryProfile();
    for (const [label, dataClass, contentHandling] of [
      ["minimized-business", "business", "minimized"],
      ["minimized-personal", "personal", "minimized"],
      ["verbatim-credentials", "public", "verbatim"]
    ]) {
      process.stdout.write(`[packed real-data privacy] ${label}\n`);
      const work = join(temporaryRoot, label);
      const policy = canaryPolicy(profile, dataClass, contentHandling);
      await writeProject(work, origin, authorizedPacket(origin, policy, profile));
      const output = join(work, "report");
      const run = await runPacked(
        packedBin,
        ["test", "--local", "--packet", "packet.json", "--output-dir", output, "--json"],
        env,
        work,
        0
      );
      const keepContact = contentHandling === "verbatim";
      expectNoCanaries(`${run.stdout}\n${run.stderr}`, `${label} cli output`, { keepContact });
      const report = JSON.parse(await readFile(join(output, "report.json"), "utf8"));
      expectNoCanaries(JSON.stringify(report), `${label} report.json`, { keepContact });
      assert(report.schema_version === "AW-LOCAL-RESULT-1", `${label} schema`);
      assert(report.provenance?.cloud_contacted === false, `${label} contacted cloud`);
      assert(report.provenance?.uploaded === false, `${label} uploaded`);
      if (contentHandling === "verbatim") {
        assert(JSON.stringify(report).includes("Weekday"), `${label} dropped weekday hours`);
        assert(JSON.stringify(report).includes(CANARIES.email), `${label} masked email`);
        assert(JSON.stringify(report).includes(CANARIES.phone), `${label} masked phone`);
      } else {
        assert(!JSON.stringify(report).includes(CANARIES.email), `${label} kept email`);
      }
    }

    process.stdout.write("[packed real-data privacy] missing data_policy\n");
    const missingDir = join(temporaryRoot, "missing-policy");
    const valid = authorizedPacket(origin, canaryPolicy(profile, "business", "minimized"), profile);
    const { data_policy: _omitted, ...withoutPolicy } = valid;
    await writeProject(missingDir, origin, withoutPolicy);
    const missing = await runPacked(
      packedBin,
      ["test", "--local", "--packet", "packet.json", "--output-dir", join(missingDir, "report"), "--json"],
      env,
      missingDir,
      2
    );
    const missingText = `${missing.stdout}\n${missing.stderr}`;
    assert(
      /LOCAL_PACKET_INVALID|UNSUPPORTED_DATA_POLICY/.test(missingText),
      `missing policy diagnostic was ${missingText}`
    );
    expectNoCanaries(missingText, "missing-policy cli output");
    assert(!existsSync(join(missingDir, "report", "report.json")), "missing policy wrote a raw report");

    process.stdout.write("[packed real-data privacy] stale policyHash\n");
    const staleDir = join(temporaryRoot, "stale-policy");
    const stalePacket = authorizedPacket(origin, canaryPolicy(profile, "business", "minimized"), profile);
    stalePacket.data_policy = { ...stalePacket.data_policy, policyHash: "f".repeat(64) };
    await writeProject(staleDir, origin, stalePacket);
    const stale = await runPacked(
      packedBin,
      ["test", "--local", "--packet", "packet.json", "--output-dir", join(staleDir, "report"), "--json"],
      env,
      staleDir,
      2
    );
    const staleText = `${stale.stdout}\n${stale.stderr}`;
    assert(
      /UNSUPPORTED_DATA_POLICY|DATA_POLICY_STALE|LOCAL_PACKET_INVALID/.test(staleText),
      `stale policy diagnostic was ${staleText}`
    );
    expectNoCanaries(staleText, "stale-policy cli output");
    assert(!existsSync(join(staleDir, "report", "report.json")), "stale policy wrote a raw report");

    process.stdout.write("[packed real-data privacy] missing redaction_profile\n");
    const missingProfileDir = join(temporaryRoot, "missing-profile");
    const { redaction_profile: _profileOmitted, ...withoutProfile } = authorizedPacket(
      origin,
      canaryPolicy(profile, "business", "minimized"),
      profile
    );
    await writeProject(missingProfileDir, origin, withoutProfile);
    const missingProfile = await runPacked(
      packedBin,
      [
        "test",
        "--local",
        "--packet",
        "packet.json",
        "--output-dir",
        join(missingProfileDir, "report"),
        "--json"
      ],
      env,
      missingProfileDir,
      2
    );
    const missingProfileText = `${missingProfile.stdout}\n${missingProfile.stderr}`;
    assert(
      /LOCAL_PACKET_INVALID|REDACTION_PROFILE_MISMATCH/.test(missingProfileText),
      `missing profile diagnostic was ${missingProfileText}`
    );
    assert(
      !existsSync(join(missingProfileDir, "report", "report.json")),
      "missing profile wrote a raw report"
    );

    process.stdout.write("[packed real-data privacy] passed\n");
  } finally {
    if (server !== undefined) {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    if (process.env.AUGMENTWORKS_KEEP_SMOKE_TMP === "1") {
      process.stdout.write(`[packed real-data privacy] retained ${temporaryRoot}\n`);
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[packed real-data privacy] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
