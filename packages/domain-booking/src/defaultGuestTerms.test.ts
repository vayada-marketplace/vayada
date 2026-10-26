import { describe, expect, it } from "vitest";

import { DEFAULT_GUEST_TERMS } from "./index.js";

describe("DEFAULT_GUEST_TERMS", () => {
  it("is exported from the package and fits the guest terms limit (20,000 characters)", () => {
    expect(
      DEFAULT_GUEST_TERMS.startsWith(
        "These Terms & Conditions apply to stays booked on our booking page.",
      ),
    ).toBe(true);
    expect(DEFAULT_GUEST_TERMS.length).toBeGreaterThan(500);
    expect(DEFAULT_GUEST_TERMS.length).toBeLessThanOrEqual(20_000);
  });
});
