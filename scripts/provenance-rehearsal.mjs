#!/usr/bin/env node

// Runs a real (non-dry-run) `npm publish <tarball> --provenance` against a throwaway local
// registry, so npm signs a Sigstore provenance bundle exactly as it would for npmjs.org, and
// checks that the bundle attached to the publish request names the tarball's digest.
// `npm publish --dry-run` stops before libnpmpublish, so it never exercises provenance signing.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const tarballPath = resolve(process.argv[2] ?? "");
const tarball = await readFile(tarballPath);
const tarballSha512 = createHash("sha512").update(tarball).digest("hex");

let published;
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    process.stdout.write(`[registry] ${request.method} ${request.url}\n`);
    if (request.method === "PUT") {
      published = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not_found"}');
  });
});
await new Promise((fulfill) => server.listen(0, "127.0.0.1", fulfill));
const registry = `http://127.0.0.1:${String(server.address().port)}/`;

const workDirectory = await mkdtemp(join(tmpdir(), "aw-provenance-rehearsal-"));
const userConfig = join(workDirectory, ".npmrc");
await writeFile(userConfig, `${registry.replace(/^http:/, "")}:_authToken=rehearsal-only\n`, "utf8");

const status = await new Promise((fulfill) => {
  const child = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["publish", tarballPath, "--provenance", "--registry", registry, "--loglevel", "notice"],
    {
      cwd: workDirectory,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: userConfig },
      stdio: "inherit",
      shell: process.platform === "win32"
    }
  );
  child.once("close", fulfill);
});
server.close();
await rm(workDirectory, { recursive: true, force: true });

if (status !== 0) throw new Error(`npm publish exited ${String(status)}`);
if (published === undefined) throw new Error("npm publish never sent a publish request");

const attachments = Object.entries(published._attachments ?? {});
const tgz = attachments.find(([name]) => name.endsWith(".tgz"));
const sigstore = attachments.find(([name]) => name.endsWith(".sigstore"));
if (tgz === undefined) throw new Error("publish request carried no tarball");
if (sigstore === undefined) throw new Error("publish request carried no provenance bundle");

const sentSha512 = createHash("sha512").update(Buffer.from(tgz[1].data, "base64")).digest("hex");
if (sentSha512 !== tarballSha512) throw new Error("published tarball bytes differ from the tested tarball");

const bundle = JSON.parse(sigstore[1].data);
const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
const subject = statement.subject?.[0];
if (subject?.digest?.sha512 !== tarballSha512) {
  throw new Error("provenance subject digest does not match the tested tarball");
}
const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
const tlog = bundle.verificationMaterial?.tlogEntries?.[0];

process.stdout.write(
  [
    "[rehearsal] provenance bundle attached to the publish request",
    `[rehearsal] attachment: ${sigstore[0]}`,
    `[rehearsal] predicateType: ${String(statement.predicateType)}`,
    `[rehearsal] subject: ${String(subject.name)} sha512=${tarballSha512.slice(0, 16)}...`,
    `[rehearsal] workflow: ${String(workflow?.repository)} ${String(workflow?.path)} @ ${String(workflow?.ref)}`,
    `[rehearsal] transparency log index: ${String(tlog?.logIndex)}`
  ].join("\n") + "\n"
);
