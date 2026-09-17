import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("enables replacement acceptance only for configured slugs", async () => {
  vi.stubEnv("NEXT_PUBLIC_REPLACEMENT_PRICING_ACCEPTANCE_ALLOWED_SLUGS", "test-hotel, other-hotel");
  const { replacementPricingAcceptanceEnabled } = await import("./replacementPricingAcceptance");

  expect(replacementPricingAcceptanceEnabled("test-hotel")).toBe(true);
  expect(replacementPricingAcceptanceEnabled("other-hotel")).toBe(true);
  expect(replacementPricingAcceptanceEnabled("unlisted-hotel")).toBe(false);
});

it("fails closed when the slug allowlist is absent", async () => {
  const { replacementPricingAcceptanceEnabled } = await import("./replacementPricingAcceptance");
  expect(replacementPricingAcceptanceEnabled("test-hotel")).toBe(false);
});
