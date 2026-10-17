import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadCustomerSuiteFile } from "../../src/suite/load.js";
import { previewCustomerSuite } from "../../src/suite/preview.js";
import { preflightCustomerSuite } from "../../src/suite/preflight.js";
import {
  AuthorizedNativeSuiteSourceSchema,
  nativeSuiteContentHash,
  nativeSuiteSource,
  parseNativeSuiteCreateDocument
} from "../../src/suite/native.js";
import { suitePacketBinding } from "../../src/suite/admit.js";
import { hostedSuiteUnsupportedLocalError } from "../../src/suite/errors.js";
import { loadLocalPacket } from "../../src/local/packet.js";
import { ExecutionScopeSchema } from "../../src/real-data/documents.js";
import realDataFixtures from "../../contracts/aw-real-data-1.fixtures.json" with { type: "json" };

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const authorizedFixture = resolve(projectRoot, "test/fixtures/customer-suites/authorized.yaml");
const contractSuite = realDataFixtures.fixtures.customer_suite_v3.document;
/** The sealed scope the server returns for the fixture's scope_id 6666… revision 1. */
const sealedScope = ExecutionScopeSchema.parse({
  ...contractSuite.executionScope,
  scopeId: "66666666-6666-4666-8666-666666666666",
  revision: 1
});

describe("authorized aw-suite/3 customer suites", () => {
  it("loads, previews, and maps to aw-customer-suite/3 without mutating v1 native hashes", async () => {
    const loaded = await loadCustomerSuiteFile(authorizedFixture);
    expect(loaded.document.schemaVersion).toBe("aw-suite/3");
    expect(loaded.document).not.toHaveProperty("syntheticOnly");
    expect(loaded.document).not.toHaveProperty("liveTarget");
    const preview = previewCustomerSuite(loaded);
    expect(preview.syntheticOnly).toBe(false);
    expect(preview.packet).toEqual({ key: "aw-customer-suite", version: "3.0.0" });
    expect(preview.executionScope?.scopeId).toBe("66666666-6666-4666-8666-666666666666");
    expect(suitePacketBinding(loaded)).toEqual({ key: "aw-customer-suite", version: "3.0.0" });
    const source = nativeSuiteSource(loaded, sealedScope);
    expect(source).toMatchObject({
      schemaVersion: "aw-customer-suite/3",
      suiteId: "authorized.records.fixture",
      executionScope: sealedScope
    });
    expect(source).not.toHaveProperty("syntheticOnly");
    expect(source).not.toHaveProperty("packetOverlay");
    expect(AuthorizedNativeSuiteSourceSchema.safeParse(source).success).toBe(true);
    expect(nativeSuiteContentHash(parseNativeSuiteCreateDocument(source))).toBe(nativeSuiteContentHash(source));
  });

  it("uploads the sealed scope in the shape aw-real-data/1 fixes (AUG-357)", async () => {
    expect(contractSuite).not.toHaveProperty("packetOverlay");
    expect(AuthorizedNativeSuiteSourceSchema.safeParse(contractSuite).success).toBe(true);
    const loaded = await loadCustomerSuiteFile(authorizedFixture);
    expect(Object.keys(nativeSuiteSource(loaded, sealedScope)).sort()).toEqual(
      Object.keys(contractSuite).sort()
    );
  });

  it("refuses to upload without the sealed scope the suite names", async () => {
    const loaded = await loadCustomerSuiteFile(authorizedFixture);
    expect(() => nativeSuiteSource(loaded)).toThrow(expect.objectContaining({ code: "SUITE_HOSTED_INCOMPATIBLE" }));
    expect(() => nativeSuiteSource(loaded, { ...sealedScope, revision: 2 })).toThrow(
      expect.objectContaining({ code: "SUITE_HOSTED_INCOMPATIBLE" })
    );
  });

  it("preflights as authorized overlay without contacting a target", async () => {
    const loaded = await loadCustomerSuiteFile(authorizedFixture);
    const preflight = await preflightCustomerSuite(loaded);
    expect(preflight.overlay).toBe("aw-packet/authorized-1");
    expect(preflight.syntheticOnly).toBe(false);
    expect(preflight.localPreview.executesTarget).toBe(false);
  });

  it("rejects hosted authorized packets in local mode", async () => {
    await expect(loadLocalPacket({ reference: authorizedFixture })).rejects.toMatchObject({
      code: "HOSTED_SUITE_UNSUPPORTED_LOCAL"
    });
    expect(hostedSuiteUnsupportedLocalError("x.yaml").message).not.toMatch(/syntheticOnly/);
  });
});
