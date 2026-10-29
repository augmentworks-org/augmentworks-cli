import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { runSourceCli } from "../util/cli-process.js";
import { listenLoopback, type ListeningServer } from "../util/http-server.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOKEN = "aw_connector_test_access_token_usage";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fixturesUrl = resolve(projectRoot, "contracts/aw-billing-v1.fixtures.json");

type FixtureFile = {
  fixtures: Record<string, { status?: number; response: unknown }>;
};

const fixtures = JSON.parse(await readFile(fixturesUrl, "utf8")) as FixtureFile;

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) => Promise<boolean> | boolean;

const temporaryDirectories: string[] = [];
const servers: ListeningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function emptyCwd(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-cli-usage-"));
  temporaryDirectories.push(directory);
  return directory;
}

function send(response: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extra
  });
  response.end(body);
}

function identity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: "user_test",
    email: "developer@example.com",
    workspace_id: WORKSPACE,
    workspace_name: "Test Workspace",
    connector_id: "connector_test",
    connector_name: "Refunds Staging",
    scopes: ["connector:identity", "connector:run"],
    ...overrides
  };
}

async function startMock(handler: Handler): Promise<{ server: ListeningServer; paths: string[] }> {
  const paths: string[] = [];
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    paths.push(`${request.method ?? "GET"} ${url.pathname}`);
    void Promise.resolve(handler(request, response, url)).then((handled) => {
      if (!handled && !response.writableEnded) {
        send(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
      }
    });
  });
  const server = await listenLoopback(httpServer);
  servers.push(server);
  return { server, paths };
}

function usageEnv(apiOrigin: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AUGMENTWORKS_API_URL: apiOrigin,
    AUGMENTWORKS_TOKEN: TOKEN,
    CI: "1",
    NO_COLOR: "1",
    ...extra
  };
}

describe("augmentworks usage CLI", () => {
  it("retrieves usage without a config directory and prints the 190-available fixture", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity({ workspace_name: "Acme\u001b[31m東京" }));
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/usage") {
        send(response, 200, fixtures.fixtures["partially_consumed_trial"]?.response);
        return true;
      }
      return false;
    });

    const result = await runSourceCli(["usage"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Available credits: 190");
    expect(result.stdout).toContain("Acme");
    expect(result.stdout).toContain("東京");
    expect(result.stdout).not.toContain("\u001b[31m");
    // The mock server's random port can contain "180" (e.g. :51806), so check
    // the output without the API origin line.
    expect(result.stdout.replace(server.baseUrl, "")).not.toContain("180");
    expect(result.stdout).toContain("server snapshot");
    expect(result.stdout).toContain("read-only");
    expect(result.stdout).not.toContain(TOKEN);
    expect(paths.some((path) => path.startsWith("POST "))).toBe(false);
    expect(paths).not.toContain("POST /v1/relay/runs");
    expect(paths.filter((path) => path === "GET /v1/billing/usage")).toHaveLength(1);
  });

  it("writes one JSON object on stdout for --json success", async () => {
    const cwd = await emptyCwd();
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, fixtures.fixtures["active_reservation"]?.response);
        return true;
      }
      return false;
    });

    const result = await runSourceCli(["usage", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { availableUnits: number; reservedUnits: number; consumedUnits: number };
    expect(parsed.availableUnits).toBe(190);
    expect(parsed.reservedUnits).toBe(7);
    expect(parsed.consumedUnits).toBe(3);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(TOKEN);
  });

  it("rejects a usage snapshot for a different workspace", async () => {
    const cwd = await emptyCwd();
    const mismatched = {
      ...(fixtures.fixtures["eligible_trial"]?.response as Record<string, unknown>),
      workspaceId: OTHER_WORKSPACE
    };
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, mismatched);
        return true;
      }
      return false;
    });

    const result = await runSourceCli(["usage", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(EXIT.AUTH);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; code: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("WORKSPACE_MISMATCH");
  });

  it("surfaces revoked membership as an authorization failure, not a zero balance", async () => {
    const cwd = await emptyCwd();
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 403, fixtures.fixtures["error_unauthorized"]?.response);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(EXIT.AUTH);
    const parsed = JSON.parse(result.stdout) as { code: string; safe_message: string };
    expect(parsed.code).toBe("CLOUD_AUTH_REJECTED");
    expect(parsed.safe_message.toLowerCase()).not.toContain("available credits: 0");
    expect(result.stdout).not.toMatch(/"availableUnits":\s*0/u);
  });

  it("surfaces the wrong connector scope without inventing a balance", async () => {
    const cwd = await emptyCwd();
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity({ scopes: ["connector:run"] }));
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 403, fixtures.fixtures["error_insufficient_scope"]?.response);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(EXIT.AUTH);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "SCOPE_DENIED" });
  });

  it("directs a missing billing profile to first-party recovery without creating an account", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 409, {
          schemaVersion: "aw-billing/1",
          error: {
            code: "billing_unprovisioned",
            message: "This workspace has no billing account.",
            retryable: false
          }
        });
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(EXIT.BILLING);
    expect(result.stderr).toContain("BILLING_UNPROVISIONED");
    expect(`${result.stderr}${result.stdout}`).toMatch(/\/portal/u);
    expect(result.stderr.toLowerCase()).toContain("profile");
    expect(result.stderr).toContain("did not");
    expect(paths.some((path) => path.includes("grant") || path.includes("checkout"))).toBe(false);
  });

  it("treats a capabilities document without usage_v1 as unsupported, not a zero balance", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, {
          schemaVersion: "aw-billing/1",
          asOf: "2026-09-06T17:00:00.000Z",
          capabilities: ["quote_v1"]
        });
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(EXIT.BILLING);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "USAGE_UNSUPPORTED", ok: false });
    expect(paths).not.toContain("GET /v1/billing/usage");
    expect(result.stdout).not.toMatch(/"availableUnits":\s*0/u);
  });

  it("fails closed when usage_v1 is absent instead of showing a zero balance", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(EXIT.BILLING);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "USAGE_UNSUPPORTED", ok: false });
    expect(paths).not.toContain("GET /v1/billing/usage");
    expect(result.stdout).not.toMatch(/"availableUnits":\s*0/u);
  });

  it("rejects a malformed usage payload", async () => {
    const cwd = await emptyCwd();
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        send(response, 200, fixtures.fixtures["malformed_data"]?.response);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(EXIT.RELAY);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "INVALID_CLOUD_RESPONSE" });
  });

  it("rejects oversized billing responses before parsing them", async () => {
    const cwd = await emptyCwd();
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(300 * 1024)
        });
        response.end("x");
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(EXIT.RELAY);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "RELAY_ENVELOPE_TOO_LARGE" });
  });

  it("rejects unexpected redirects and does not follow them", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        response.writeHead(302, { location: "https://evil.example/steal" });
        response.end();
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).not.toBe(0);
    expect(paths.join("\n")).not.toContain("evil.example");
    expect(JSON.parse(result.stdout).ok).toBe(false);
  });

  it("retries a retryable billing failure once", async () => {
    const cwd = await emptyCwd();
    let usageCalls = 0;
    const { server } = await startMock((request, response, url) => {
      if (url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (url.pathname === "/v1/billing/usage") {
        usageCalls += 1;
        if (usageCalls === 1) {
          send(response, 503, fixtures.fixtures["error_service_unavailable"]?.response);
          return true;
        }
        send(response, 200, fixtures.fixtures["eligible_trial"]?.response);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage", "--json"], {
      cwd,
      env: usageEnv(server.baseUrl)
    });
    expect(result.exitCode).toBe(0);
    expect(usageCalls).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ availableUnits: 200, ok: true });
  });

  it("fails WORKSPACE_MISMATCH before usage after /auth/me", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/usage") {
        send(response, 200, fixtures.fixtures["eligible_trial"]?.response);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage"], {
      cwd,
      env: usageEnv(server.baseUrl, {
        AUGMENTWORKS_API_KEY: "",
        AUGMENTWORKS_WORKSPACE_ID: OTHER_WORKSPACE
      })
    });
    expect(result.exitCode).toBe(EXIT.AUTH);
    expect(result.stderr).toContain("WORKSPACE_MISMATCH");
    expect(result.stderr).toContain(OTHER_WORKSPACE);
    expect(result.stderr).toContain(WORKSPACE);
    expect(paths).toEqual(["GET /api/v1/cli/auth/me"]);
  });

  it("fails WORKSPACE_CONFIG_CONFLICT before /auth/me when flag and env differ", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock(() => false);
    const result = await runSourceCli(["usage", "--workspace", WORKSPACE], {
      cwd,
      env: usageEnv(server.baseUrl, {
        AUGMENTWORKS_API_KEY: "",
        AUGMENTWORKS_WORKSPACE_ID: OTHER_WORKSPACE
      })
    });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stderr).toContain("WORKSPACE_CONFIG_CONFLICT");
    expect(paths).toEqual([]);
  });

  it("succeeds when --workspace matches /auth/me and prints name plus UUID", async () => {
    const cwd = await emptyCwd();
    const { server, paths } = await startMock((request, response, url) => {
      if (request.method === "GET" && url.pathname === "/api/v1/cli/auth/me") {
        send(response, 200, identity());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/capabilities") {
        send(response, 200, fixtures.fixtures["absent_capability"]?.response);
        return true;
      }
      if (request.method === "GET" && url.pathname === "/v1/billing/usage") {
        send(response, 200, fixtures.fixtures["partially_consumed_trial"]?.response);
        return true;
      }
      return false;
    });
    const result = await runSourceCli(["usage", "--workspace", WORKSPACE], {
      cwd,
      env: usageEnv(server.baseUrl, { AUGMENTWORKS_API_KEY: "" })
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Test Workspace (${WORKSPACE})`);
    expect(paths).toContain("GET /api/v1/cli/auth/me");
    expect(paths).toContain("GET /v1/billing/usage");
  });
});
