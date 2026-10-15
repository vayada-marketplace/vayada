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

it.each(["", "affiliate.vayada.com"])(
  "keeps the API host when the affiliate origin is unset or unusable (%j)",
  (origin) => {
    vi.stubEnv("NEXT_PUBLIC_AFFILIATE_LINK_ORIGIN", origin);
    expect(affiliateShareUrl("/r/va_abcdefghijklmnopqrstuv")).toBe(
      "https://api.localhost/r/va_abcdefghijklmnopqrstuv",
    );
  },
);
