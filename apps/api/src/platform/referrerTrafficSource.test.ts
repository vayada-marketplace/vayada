import { describe, expect, it } from "vitest";

import { referrerTrafficSource } from "./referrerTrafficSource.js";

describe("referrerTrafficSource", () => {
  it("keeps only the referring site", () => {
    expect(referrerTrafficSource("https://www.instagram.com/p/abc?x=1")).toBe("instagram");
    expect(referrerTrafficSource("https://vm.tiktok.com/x")).toBe("tiktok");
    expect(referrerTrafficSource("https://youtu.be/x")).toBe("youtube");
    expect(referrerTrafficSource("https://m.facebook.com/x")).toBe("facebook");
    expect(referrerTrafficSource("https://twitter.com/x")).toBe("x");
  });

  it("answers unknown for other sites, non-http schemes and junk", () => {
    expect(referrerTrafficSource("https://example.com/instagram.com")).toBe("unknown");
    expect(referrerTrafficSource("javascript:alert(1)")).toBe("unknown");
    expect(referrerTrafficSource("not a url")).toBe("unknown");
    expect(referrerTrafficSource(undefined)).toBe("unknown");
  });
});
