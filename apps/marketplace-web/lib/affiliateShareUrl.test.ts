import { VAYADA_API_BASE_URL } from "@vayada/marketplace-shared/api/client";
import { afterEach, expect, it, vi } from "vitest";

import { affiliateShareUrl } from "./affiliateShareUrl";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("builds share links on the configured affiliate origin", () => {
  vi.stubEnv("NEXT_PUBLIC_AFFILIATE_LINK_ORIGIN", "https://affiliate.vayada.com");
  expect(affiliateShareUrl("/r/va_abcdefghijklmnopqrstuv?campaign=instagram.reel-1")).toBe(
    "https://affiliate.vayada.com/r/va_abcdefghijklmnopqrstuv?campaign=instagram.reel-1",
  );
});

it("keeps the API host when no affiliate origin is configured", () => {
  vi.stubEnv("NEXT_PUBLIC_AFFILIATE_LINK_ORIGIN", "");
  expect(affiliateShareUrl("/r/va_abcdefghijklmnopqrstuv")).toBe(
    new URL("/r/va_abcdefghijklmnopqrstuv", VAYADA_API_BASE_URL).toString(),
  );
});
