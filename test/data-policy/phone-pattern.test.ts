import { describe, expect, it } from "vitest";

import { PHONE_PATTERN_SOURCE, maskString } from "../../src/data-policy/detectors.js";
import { PLACEHOLDERS } from "../../src/data-policy/types.js";

/**
 * Shared with the server (src/lib/data-policy/contract.test.ts in
 * augmentworks): the same source and the same vectors (AUG-400).
 */
const SHARED_PHONE_PATTERN_SOURCE = String.raw`(?<![\w+]|\w[.\-])(?!\d{4}[.\-]\d{1,2}[.\-]\d{1,2}(?!\d)|\d{1,2}[.\-]\d{1,2}[.\-]\d{4}(?!\d))\+?\(?\d(?:[ .\-()\u00A0]{0,2}\d){9,14}(?!\w)`;

const PHONE_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ["Call +1 555 0197 4242 today.", "Call <phone> today."],
  ["(555) 019-7424", "<phone>"],
  ["555.019.7424 or 5550197424", "<phone> or <phone>"],
  ["+44 20 7946 0958", "<phone>"],
  ["+44 (0)20 7946 0958", "<phone>"],
  ["+33 1 23 45 67 89", "<phone>"],
  ["+81-3-1234-5678", "<phone>"],
  ["+91 98765 43210", "<phone>"],
  ["2026-10-18", "2026-10-18"],
  ["Due 2026-10-18 12:00 UTC", "Due 2026-10-18 12:00 UTC"],
  ["2026-10-18T12:00:00Z", "2026-10-18T12:00:00Z"],
  ["18.10.2026 and 10-18-2026", "18.10.2026 and 10-18-2026"],
  ["Weekday support hours are 9:00-17:00 UTC.", "Weekday support hours are 9:00-17:00 UTC."],
  ["123e4567-e89b-12d3-a456-426614174000", "123e4567-e89b-12d3-a456-426614174000"],
  ["call_0123456789", "call_0123456789"],
  ["555-0197", "555-0197"],
  ["Internal price for SKU-14 is $48.", "Internal price for SKU-14 is $48."],
  ["12345678901234567890", "12345678901234567890"]
];

describe("international phone pattern (AUG-400)", () => {
  it("uses the source shared with the server", () => {
    expect(PHONE_PATTERN_SOURCE).toBe(SHARED_PHONE_PATTERN_SOURCE);
  });

  it.each(PHONE_VECTORS)("masks only phone numbers in %j", (input, expected) => {
    const masked = maskString(input, "content", [], new Set(["phone"])).text.replaceAll(
      PLACEHOLDERS.phone,
      "<phone>"
    );
    expect(masked).toBe(expected);
  });
});
