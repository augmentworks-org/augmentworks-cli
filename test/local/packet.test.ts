import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { SINGLE_TURN_CONVERSATION } from "../../src/config/conversation.js";
import type { ResolvedConfig } from "../../src/config/types.js";
import { canonicalJson, findingId, stableId } from "../../src/local/canonical.js";
import {
  assertLocalPacketCompatible,
  inspectLocalPacketCompatibility
} from "../../src/local/compatibility.js";
import {
  MAX_LOCAL_PACKET_BYTES,
  SUPPORT_REFUNDS_STARTER_REFERENCE,
  SUPPORT_REFUNDS_STARTER_SHA256,
  derivedPacketCommandCount,
  loadLocalPacket,
  parseLocalPacket
} from "../../src/local/packet.js";
import { isLocalAuthorizedPacket, type PacketManifest } from "../../src/local/types.js";
import { localAuthorizedPacketManifest } from "../real-data/helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "augmentworks-local-packet-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function starterManifest(): Promise<PacketManifest> {
  const manifest = (await loadLocalPacket({ reference: SUPPORT_REFUNDS_STARTER_REFERENCE })).manifest;
  if (isLocalAuthorizedPacket(manifest)) {
    throw new Error("bundled starter packet must remain aw-packet/0.1");
  }
  return manifest;
}

function compatibleConfig(packet: PacketManifest): ResolvedConfig {
  return {
    config: {
      version: 1,
      target: {
        name: "local-refunds",
        connector: "http",
        base_url: "http://127.0.0.1:8000",
        operations: {
          prepare: { method: "POST", path: "/prepare", idempotent: true },
          send: {
            method: "POST",
            path: "/send",
            response: { content: "$.answer", tool_events: "$.events" }
          },
          observe: { method: "POST", path: "/observe", idempotent: true },
          cleanup: { method: "POST", path: "/cleanup", idempotent: true }
        }
      },
      telemetry: {
        allow_tool_events: true,
        allow_observations: [
          ...new Set(packet.scenarios.flatMap((scenario) => scenario.observation_keys))
        ]
      }
    },
    configPath: "/tmp/augmentworks.yaml",
    configDirectory: "/tmp",
    configDigest: "a".repeat(64),
    baseUrl: new URL("http://127.0.0.1:8000"),
    authHeaders: {},
    secrets: [],
    capabilities: {
      level: "stateful",
      prepare: true,
      observation: true,
      cleanup: true,
      tool_events: true
    },
    conversation: SINGLE_TURN_CONVERSATION,
    warnings: []
  };
}

describe("local canonical data", () => {
  it("matches the hosted scorer's canonical numbers and stable identities", () => {
    expect(canonicalJson({ small: 1e-7, large: 1e21, negative_zero: -0 })).toBe(
      '{"large":1000000000000000000000,"negative_zero":0,"small":0.0000001}'
    );
    expect(
      stableId("attempt", "run-1", "support-refunds.eligible-refund-completes", "0")
    ).toBe("attempt_ed6808f62e5255de8f6e66d5d164949e");
    expect(
      findingId("run-1", "support-refunds.eligible-refund-completes", "failed")
    ).toBe("7c16d4f9-ee8a-5450-a73e-9d0418bb3298");
  });
});

describe("local packet loading", () => {
  it("loads the immutable Apache community starter by its bundled reference", async () => {
    const loaded = await loadLocalPacket({ reference: SUPPORT_REFUNDS_STARTER_REFERENCE });

    expect(loaded.source).toEqual({
      kind: "bundled",
      reference: SUPPORT_REFUNDS_STARTER_REFERENCE
    });
    expect(loaded.binding).toMatchObject({
      id: "support-refunds-starter",
      version: "0.1.0",
      sha256: SUPPORT_REFUNDS_STARTER_SHA256,
      name: "Community refund workflow starter"
    });
    expect(loaded.manifest.scenarios).toHaveLength(3);
    expect(
      loaded.manifest.scenarios.every((scenario) =>
        scenario.key.startsWith("support-refunds-starter.")
      )
    ).toBe(true);
    expect(loaded.derivedCommandCount).toBe(12);
    expect(derivedPacketCommandCount(loaded.manifest)).toBe(12);
  });

  it("loads a real local JSON file and resolves a directory to packet.json", async () => {
    const cwd = await temporaryDirectory();
    const packetDirectory = resolve(cwd, "packet-directory");
    await mkdir(packetDirectory);
    const packetPath = resolve(packetDirectory, "packet.json");
    await writeFile(packetPath, `${JSON.stringify(await starterManifest())}\n`, "utf8");

    const fromFile = await loadLocalPacket({ reference: packetPath, cwd });
    const fromDirectory = await loadLocalPacket({ reference: "packet-directory", cwd });

    expect(fromFile.source).toEqual({ kind: "file", path: packetPath });
    expect(fromDirectory.source).toEqual({ kind: "file", path: packetPath });
    expect(fromFile.binding.sha256).toBe(SUPPORT_REFUNDS_STARTER_SHA256);
    expect(fromDirectory.binding).toEqual(fromFile.binding);
  });

  it("never downloads or imports a local-mode packet", async () => {
    for (const reference of [
      "https://example.com/packet.json",
      "file:///tmp/packet.json",
      "npm:@example/packet",
      "node:fs",
      "@example/packet"
    ]) {
      await expect(loadLocalPacket({ reference })).rejects.toMatchObject({
        code: "LOCAL_PACKET_REFERENCE_UNSUPPORTED"
      });
    }
    await expect(loadLocalPacket({ reference: "not-bundled@1.0.0" })).rejects.toMatchObject({
      code: "LOCAL_PACKET_NOT_BUNDLED"
    });
  });

  it("rejects missing, malformed, invalid-UTF-8, and oversized packet files", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(resolve(cwd, "malformed.json"), "{", "utf8");
    await writeFile(resolve(cwd, "invalid-utf8.json"), Buffer.from([0xff, 0xfe]));
    await writeFile(
      resolve(cwd, "oversized.json"),
      Buffer.alloc(MAX_LOCAL_PACKET_BYTES + 1, 0x20)
    );

    await expect(loadLocalPacket({ reference: "missing.json", cwd })).rejects.toMatchObject({
      code: "LOCAL_PACKET_NOT_FOUND"
    });
    await expect(loadLocalPacket({ reference: "malformed.json", cwd })).rejects.toMatchObject({
      code: "LOCAL_PACKET_JSON_INVALID"
    });
    await expect(loadLocalPacket({ reference: "invalid-utf8.json", cwd })).rejects.toMatchObject({
      code: "LOCAL_PACKET_JSON_INVALID"
    });
    await expect(loadLocalPacket({ reference: "oversized.json", cwd })).rejects.toMatchObject({
      code: "LOCAL_PACKET_TOO_LARGE"
    });
  });

  it("rejects leaf symlinks and duplicate JSON object keys", async () => {
    const cwd = await temporaryDirectory();
    const packetPath = resolve(cwd, "packet.json");
    const symlinkPath = resolve(cwd, "packet-link.json");
    const realDirectory = resolve(cwd, "real-directory");
    const directorySymlink = resolve(cwd, "directory-link");
    await mkdir(realDirectory);
    await writeFile(packetPath, `${JSON.stringify(await starterManifest())}\n`, "utf8");
    await writeFile(
      resolve(realDirectory, "packet.json"),
      `${JSON.stringify(await starterManifest())}\n`,
      "utf8"
    );
    await symlink(packetPath, symlinkPath);
    await symlink(realDirectory, directorySymlink);
    await writeFile(
      resolve(cwd, "duplicate.json"),
      '{"schema_version":"aw-packet/0.1","nested":{"key":1,"key":2}}',
      "utf8"
    );

    await expect(loadLocalPacket({ reference: symlinkPath, cwd })).rejects.toMatchObject({
      code: "LOCAL_PACKET_FILE_INVALID"
    });
    await expect(
      loadLocalPacket({ reference: resolve(directorySymlink, "packet.json"), cwd })
    ).rejects.toMatchObject({ code: "LOCAL_PACKET_FILE_INVALID" });
    await expect(loadLocalPacket({ reference: "duplicate.json", cwd })).rejects.toMatchObject({
      code: "LOCAL_PACKET_JSON_INVALID"
    });
  });

  it("rejects hybrid and llm_rubric packets before any local scoring", async () => {
    expect(() =>
      parseLocalPacket({
        schema_version: "aw-packet/0.2",
        evaluation_mode: "hybrid",
        packet_id: "response-quality",
        scenarios: []
      })
    ).toThrowError(/hosted LLM judging/u);

    const hybridMode = structuredClone(await starterManifest()) as PacketManifest & {
      evaluation_mode?: string;
    };
    hybridMode.evaluation_mode = "hybrid";
    expect(() => parseLocalPacket(hybridMode)).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_LOCAL_GRADER" })
    );

    const rubric = structuredClone(await starterManifest());
    Object.assign(rubric.scenarios[0]!, {
      criteria: [{ kind: "llm_rubric", id: "tone" }]
    });
    expect(() => parseLocalPacket(rubric)).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_LOCAL_GRADER" })
    );
  });
});

describe("local packet validation", () => {
  it("rejects unknown fields at every typed packet layer", async () => {
    const root = structuredClone(await starterManifest()) as PacketManifest & { extra?: boolean };
    root.extra = true;
    expect(() => parseLocalPacket(root)).toThrowError(/Unrecognized key/u);

    const nested = structuredClone(await starterManifest());
    Object.assign(nested.scenarios[0]!.turns[0]!, { extra: true });
    expect(() => parseLocalPacket(nested)).toThrowError(/Unrecognized key/u);
  });

  it("enforces namespaced and unique scenario, assertion, and observation keys", async () => {
    const namespace = structuredClone(await starterManifest());
    namespace.scenarios[0]!.key = "another-packet.eligible";
    expect(() => parseLocalPacket(namespace)).toThrowError(/namespaced/u);

    const emptyNamespaceSuffix = structuredClone(await starterManifest());
    emptyNamespaceSuffix.scenarios[0]!.key = `${emptyNamespaceSuffix.packet_id}.`;
    expect(() => parseLocalPacket(emptyNamespaceSuffix)).toThrowError(/namespaced/u);

    const scenarios = structuredClone(await starterManifest());
    scenarios.scenarios[1]!.key = scenarios.scenarios[0]!.key;
    expect(() => parseLocalPacket(scenarios)).toThrowError(/unique/u);

    const assertions = structuredClone(await starterManifest());
    assertions.scenarios[0]!.assertions[1]!.key =
      assertions.scenarios[0]!.assertions[0]!.key;
    expect(() => parseLocalPacket(assertions)).toThrowError(/unique/u);

    const observations = structuredClone(await starterManifest());
    observations.scenarios[0]!.observation_keys.push("order.status");
    expect(() => parseLocalPacket(observations)).toThrowError(/unique/u);
  });

  it("cross-checks assertion turn and observation references", async () => {
    const turn = structuredClone(await starterManifest());
    const assistantAssertion = turn.scenarios[0]!.assertions[0]!;
    if (assistantAssertion.kind !== "assistant_contains") throw new Error("unexpected starter packet");
    assistantAssertion.turn_index = 1;
    expect(() => parseLocalPacket(turn)).toThrowError(/turn_index/u);

    const observation = structuredClone(await starterManifest());
    const observationAssertion = observation.scenarios[0]!.assertions.find(
      (assertion) => assertion.kind === "observation_equals"
    );
    if (observationAssertion?.kind !== "observation_equals") {
      throw new Error("unexpected starter packet");
    }
    observationAssertion.observation_key = "order.missing";
    expect(() => parseLocalPacket(observation)).toThrowError(/declared observation_key/u);
  });

  it("rejects empty assistant text assertions", async () => {
    for (const kind of ["assistant_contains", "assistant_not_contains"] as const) {
      const packet = structuredClone(await starterManifest());
      packet.scenarios[0]!.assertions[0] = {
        kind,
        key: `non-empty-${kind}`,
        description: "Assistant text assertion values must not be empty.",
        value: ""
      };
      expect(() => parseLocalPacket(packet)).toThrowError(/Too small/u);
    }
  });

  it("rejects vacuous pass thresholds and zero-call tool assertions", async () => {
    const threshold = structuredClone(await starterManifest());
    threshold.scenarios[0]!.pass_threshold = 0;
    expect(() => parseLocalPacket(threshold)).toThrowError(/>0/u);

    for (const field of ["min_calls", "max_calls"] as const) {
      const calls = structuredClone(await starterManifest());
      const toolAssertion = calls.scenarios[0]!.assertions.find(
        (assertion) => assertion.kind === "tool_called"
      );
      if (toolAssertion?.kind !== "tool_called") throw new Error("unexpected starter packet");
      toolAssertion[field] = 0;
      expect(() => parseLocalPacket(calls)).toThrowError(/>=1/u);
    }
  });

  it("cross-checks declared capabilities against packet contents", async () => {
    const multiTurn = structuredClone(await starterManifest());
    multiTurn.scenarios[0]!.turns.push({ content: "A second synthetic turn." });
    expect(() => parseLocalPacket(multiTurn)).toThrowError(/multi-turn/u);

    const observation = structuredClone(await starterManifest());
    observation.required_capabilities.observation = false;
    expect(() => parseLocalPacket(observation)).toThrowError(/observations/u);

    const events = structuredClone(await starterManifest());
    events.required_capabilities.tool_events = false;
    expect(() => parseLocalPacket(events)).toThrowError(/event assertions/u);

    const cleanup = structuredClone(await starterManifest());
    cleanup.required_capabilities.cleanup = false;
    expect(() => parseLocalPacket(cleanup)).toThrowError(/fixtures require/u);
  });

  it("preserves absent assertion values and enforces repetition and derived-operation limits", async () => {
    const absent = structuredClone(await starterManifest());
    const toolResult = absent.scenarios[0]!.assertions.find(
      (assertion) => assertion.kind === "tool_result"
    );
    if (toolResult?.kind !== "tool_result") throw new Error("unexpected starter packet");
    delete toolResult.output_contains;
    const parsed = parseLocalPacket(absent);
    const parsedToolResult = parsed.scenarios[0]!.assertions.find(
      (assertion) => assertion.kind === "tool_result"
    );
    expect(parsedToolResult).not.toHaveProperty("output_contains");

    const repetitions = structuredClone(await starterManifest());
    repetitions.scenarios[0]!.repetitions = 21;
    expect(() => parseLocalPacket(repetitions)).toThrowError(/<=20/u);

    const commands = structuredClone(await starterManifest());
    commands.scenarios[0]!.turns = Array.from({ length: 20 }, (_, index) => ({
      content: `Synthetic turn ${String(index)}`
    }));
    commands.scenarios[0]!.repetitions = 5;
    commands.required_capabilities.multi_turn = true;
    expect(() => parseLocalPacket(commands)).toThrowError(/operations/u);
  });
});

describe("local packet compatibility", () => {
  it("passes only when required lifecycle capabilities and every observation are local", async () => {
    const packet = await starterManifest();
    const config = compatibleConfig(packet);

    expect(inspectLocalPacketCompatibility(packet, config)).toEqual({
      ok: true,
      issues: [],
      requiredObservationKeys: ["order.refunded_amount", "order.status"]
    });
    expect(() => assertLocalPacketCompatible(packet, config)).not.toThrow();
  });

  it("reports all missing capabilities and observation allowlist entries before target work", async () => {
    const packet = await starterManifest();
    const config = compatibleConfig(packet);
    config.capabilities.prepare = false;
    config.capabilities.observation = false;
    config.capabilities.cleanup = false;
    config.capabilities.tool_events = false;
    config.config.telemetry = { allow_tool_events: false, allow_observations: [] };

    const report = inspectLocalPacketCompatibility(packet, config);
    expect(report.ok).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual([
      "PREPARE_REQUIRED",
      "OBSERVATION_REQUIRED",
      "CLEANUP_REQUIRED",
      "TOOL_EVENTS_REQUIRED",
      "OBSERVATION_NOT_ALLOWED",
      "OBSERVATION_NOT_ALLOWED"
    ]);
    expect(() => assertLocalPacketCompatible(packet, config)).toThrowError(
      /6 compatibility issues found/u
    );
  });

  it("requires explicit_session_v1 before a multi-turn local packet is admitted", async () => {
    const packet = structuredClone(await starterManifest());
    packet.required_capabilities.multi_turn = true;
    const config = compatibleConfig(packet);
    const report = inspectLocalPacketCompatibility(packet, config);
    expect(report.issues.map(({ code }) => code)).toContain("MULTI_TURN_REQUIRED");
    expect(() => assertLocalPacketCompatible(packet, config)).toThrowError(/explicit_session_v1/u);
  });
});

describe("hosted suite files in local mode", () => {
  it("rejects an aw-suite/1 file as a local packet", async () => {
    await expect(
      loadLocalPacket({
        reference: resolve(fileURLToPath(new URL("../..", import.meta.url)), "examples/customer-suites/faq-non-commerce.yaml")
      })
    ).rejects.toMatchObject({ code: "HOSTED_SUITE_UNSUPPORTED_LOCAL" });
  });

  it("rejects a live informational packet instead of executing it locally", async () => {
    await expect(
      loadLocalPacket({
        reference: resolve(
          fileURLToPath(new URL("../..", import.meta.url)),
          "test/fixtures/customer-suites/live-informational.packet.json"
        )
      })
    ).rejects.toMatchObject({ code: "LIVE_PACKET_UNSUPPORTED_LOCAL" });
  });
});

describe("aw-packet/local-authorized-1", () => {
  it("loads a customer-declared local authorized packet from disk", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "packet.json");
    const manifest = localAuthorizedPacketManifest();
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    const loaded = await loadLocalPacket({ reference: path });
    expect(isLocalAuthorizedPacket(loaded.manifest)).toBe(true);
    if (!isLocalAuthorizedPacket(loaded.manifest)) {
      throw new Error("expected local-authorized packet");
    }
    expect(loaded.manifest.execution_scope.authority.verification).toBe("customer_declared_local");
    expect(loaded.manifest.synthetic_only).toBe(false);
    expect(parseLocalPacket(manifest).schema_version).toBe("aw-packet/local-authorized-1");
  });

  it("rejects a hosted aw-packet/authorized-1 document", () => {
    expect(() =>
      parseLocalPacket({
        schema_version: "aw-packet/authorized-1",
        packet_id: "hosted"
      })
    ).toThrowError(/aw-packet\/authorized-1/);
  });
});
