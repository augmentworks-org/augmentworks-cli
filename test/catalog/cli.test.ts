import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT } from "../../src/errors.js";
import { runSourceCli } from "../util/cli-process.js";
import { listenLoopback, type ListeningServer } from "../util/http-server.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtures = JSON.parse(
  await readFile(resolve(projectRoot, "contracts/aw-coverage-catalog-v1.fixtures.json"), "utf8")
) as {
  fixtures: Record<
    string,
    { status?: number; headers?: Record<string, string>; response: unknown }
  >;
};

const temporaryDirectories: string[] = [];
const servers: ListeningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function send(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  if (status === 304) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

async function startCatalogServer(
  handler: (request: IncomingMessage, url: URL, response: ServerResponse) => void
): Promise<ListeningServer> {
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    handler(request, url, response);
  });
  const server = await listenLoopback(httpServer);
  servers.push(server);
  return server;
}

describe("catalog CLI", () => {
  it("lists packets, profiles, and cases without login", async () => {
    const current = fixtures.fixtures["coverage_current"];
    const server = await startCatalogServer((request, url, response) => {
      expect(request.headers.authorization).toBeUndefined();
      if (url.pathname === "/v1/catalog/coverage") {
        send(response, 200, current?.response, current?.headers);
        return;
      }
      const missing = "<!DOCTYPE html><html><body>404: This page could not be found.</body></html>";
      response.writeHead(404, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(missing)
      });
      response.end(missing);
    });
    const state = await mkdtemp(join(tmpdir(), "aw-catalog-"));
    temporaryDirectories.push(state);
    const result = await runSourceCli(["catalog", "list", "--json"], {
      cwd: projectRoot,
      env: {
        AUGMENTWORKS_API_URL: server.baseUrl,
        AUGMENTWORKS_STATE_DIR: state,
        AUGMENTWORKS_API_KEY: "",
        AUGMENTWORKS_TOKEN: ""
      }
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      catalogVersion: string;
      createsBillableRun: boolean;
      staticCountsAreInformative: boolean;
      packets: unknown[];
      cases: { caseId: string }[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.createsBillableRun).toBe(false);
    expect(payload.staticCountsAreInformative).toBe(true);
    expect(payload.packets.length).toBeGreaterThan(0);
    expect(payload.cases.some((entry) => entry.caseId.includes("R01"))).toBe(true);
  });

  it("shows case prerequisites and fails closed on a stale catalogVersion", async () => {
    const current = fixtures.fixtures["coverage_current"];
    const stale = fixtures.fixtures["coverage_stale"];
    const server = await startCatalogServer((_request, url, response) => {
      if (url.searchParams.get("catalogVersion") === "0.0.1") {
        send(response, 409, stale?.response);
        return;
      }
      send(response, 200, current?.response, current?.headers);
    });
    const state = await mkdtemp(join(tmpdir(), "aw-catalog-"));
    temporaryDirectories.push(state);
    const env = {
      AUGMENTWORKS_API_URL: server.baseUrl,
      AUGMENTWORKS_STATE_DIR: state,
      AUGMENTWORKS_API_KEY: "",
      AUGMENTWORKS_TOKEN: ""
    };
    const shown = await runSourceCli(["catalog", "show", "response-quality/0.1.0/R01"], {
      cwd: projectRoot,
      env
    });
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("Behavior:");
    expect(shown.stdout).toContain("Session:");
    expect(shown.stdout).toContain("Required criteria:");

    const staleRun = await runSourceCli(["catalog", "list", "--catalog-version", "0.0.1"], {
      cwd: projectRoot,
      env
    });
    expect(staleRun.exitCode).toBe(EXIT.CONFIG);
    expect(staleRun.stderr).toContain("CATALOG_STALE");
    expect(staleRun.stderr).toContain("Do not quote from the old checksum");
  });

  it("reuses a fresh catalog cache without a second fetch", async () => {
    const current = fixtures.fixtures["coverage_current"];
    let hits = 0;
    const server = await startCatalogServer((_request, url, response) => {
      if (url.pathname !== "/v1/catalog/coverage") {
        send(response, 404, { error: { code: "not_found", message: "missing" } });
        return;
      }
      hits += 1;
      send(response, 200, current?.response, current?.headers);
    });
    const state = await mkdtemp(join(tmpdir(), "aw-catalog-"));
    temporaryDirectories.push(state);
    const env = {
      AUGMENTWORKS_API_URL: server.baseUrl,
      AUGMENTWORKS_STATE_DIR: state,
      AUGMENTWORKS_API_KEY: "",
      AUGMENTWORKS_TOKEN: ""
    };
    const first = await runSourceCli(["catalog", "list", "--json"], { cwd: projectRoot, env });
    expect(first.exitCode).toBe(0);
    const second = await runSourceCli(["catalog", "list", "--json"], { cwd: projectRoot, env });
    expect(second.exitCode).toBe(0);
    expect(hits).toBe(1);
  });

  it("revalidates with If-None-Match after max-age and keeps the cached document", async () => {
    const current = fixtures.fixtures["coverage_current"];
    let hits = 0;
    const server = await startCatalogServer((request, url, response) => {
      if (url.pathname !== "/v1/catalog/coverage") {
        send(response, 404, { error: { code: "not_found", message: "missing" } });
        return;
      }
      hits += 1;
      if (request.headers["if-none-match"]) {
        send(response, 304, null, current?.headers ?? {});
        return;
      }
      send(response, 200, current?.response, current?.headers);
    });
    const state = await mkdtemp(join(tmpdir(), "aw-catalog-"));
    temporaryDirectories.push(state);
    const env = {
      AUGMENTWORKS_API_URL: server.baseUrl,
      AUGMENTWORKS_STATE_DIR: state,
      AUGMENTWORKS_API_KEY: "",
      AUGMENTWORKS_TOKEN: ""
    };
    const first = await runSourceCli(["catalog", "list", "--json"], { cwd: projectRoot, env });
    expect(first.exitCode).toBe(0);
    const cachePath = join(state, "catalog", "coverage-v1.json");
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as { fetchedAtMs: number };
    cached.fetchedAtMs = Date.now() - 301_000;
    await writeFile(cachePath, `${JSON.stringify(cached)}\n`, "utf8");
    const second = await runSourceCli(["catalog", "list", "--json"], { cwd: projectRoot, env });
    expect(second.exitCode).toBe(0);
    expect(hits).toBe(2);
    const payload = JSON.parse(second.stdout) as { catalogChecksum: string };
    expect(payload.catalogChecksum).toBe(
      (current?.response as { catalogChecksum: string } | undefined)?.catalogChecksum
    );
  });
});
