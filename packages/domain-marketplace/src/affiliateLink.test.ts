import { describe, expect, it } from "vitest";

import {
  buildMarketplaceAffiliateSharePath,
  parseMarketplaceAffiliateLink,
} from "./affiliateLink.js";

const token = "va_0123456789abcdefghij-_";

describe("marketplace affiliate link contract", () => {
  it("builds one default share path without a platform tag", () => {
    expect(buildMarketplaceAffiliateSharePath(token)).toEqual({
      ok: true,
      publicToken: token,
      campaignLabel: null,
      path: `/r/${token}`,
    });
  });

  it("adds an optional reporting label without changing the public token", () => {
    expect(buildMarketplaceAffiliateSharePath(token, "instagram.reel-1")).toEqual({
      ok: true,
      publicToken: token,
      campaignLabel: "instagram.reel-1",
      path: `/r/${token}?campaign=instagram.reel-1`,
    });
  });

  it.each([
    undefined,
    null,
    "",
    "va_short",
    "VA_0123456789abcdefghij-_",
    "va_0123456789abcdefghij+/",
    `va_${"a".repeat(23)}`,
  ])("rejects malformed public tokens: %s", (value) => {
    expect(parseMarketplaceAffiliateLink(value)).toEqual({
      ok: false,
      code: "invalid_affiliate_link",
      field: "publicToken",
    });
  });

  it.each([
    "",
    " label",
    "label ",
    ".label",
    "label-",
    "a/b",
    "a?b",
    "a&b",
    "a b",
    "a".repeat(65),
    7,
  ])("rejects unsafe or unbounded campaign labels: %s", (label) => {
    expect(parseMarketplaceAffiliateLink(token, label)).toEqual({
      ok: false,
      code: "invalid_affiliate_link",
      field: "campaignLabel",
    });
  });

  it.each(["a", "TikTok", "newsletter_2026", "post-4", "story.2"])(
    "preserves valid campaign label %s exactly",
    (label) => {
      expect(parseMarketplaceAffiliateLink(token, label)).toEqual({
        ok: true,
        publicToken: token,
        campaignLabel: label,
      });
    },
  );

  it("accepts the exact 64-character campaign-label boundary", () => {
    const label = `a${"-".repeat(62)}z`;
    expect(parseMarketplaceAffiliateLink(token, label)).toMatchObject({
      ok: true,
      campaignLabel: label,
    });
  });
});
