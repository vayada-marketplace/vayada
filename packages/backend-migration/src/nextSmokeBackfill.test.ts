import { describe, expect, it } from "vitest";

import {
  affiliateResourceIdForEmail,
  DEFAULT_NEXT_SMOKE_MODULE_IDS,
  NEXT_SMOKE_AFFILIATE_EMAIL,
  NEXT_SMOKE_AFFILIATE_RESOURCE_ID,
  NEXT_SMOKE_BOOKING_HOTEL_ID,
  NEXT_SMOKE_CONFIRM,
  normalizeModuleIds,
} from "./nextSmokeBackfill.js";

describe("next smoke backfill helpers", () => {
  it("pins the VAY-874/VAY-877 smoke defaults and apply guard", () => {
    expect(NEXT_SMOKE_CONFIRM).toBe("next-smoke-backfill:vay-874-vay-877");
    expect(NEXT_SMOKE_BOOKING_HOTEL_ID).toBe("43303cea-963c-445a-9522-a05145fe0918");
    expect(NEXT_SMOKE_AFFILIATE_EMAIL).toBe("flamur.maliqi2811@gmail.com");
    expect(NEXT_SMOKE_AFFILIATE_RESOURCE_ID).toBe("affiliate-smoke-flamur-maliqi2811");
    expect(DEFAULT_NEXT_SMOKE_MODULE_IDS).toEqual(["affiliates"]);
  });

  it("normalizes smoke affiliate resource IDs and module IDs", () => {
    expect(affiliateResourceIdForEmail(" Flamur.Maliqi2811+Smoke@Gmail.com ")).toBe(
      "affiliate-smoke-flamur-maliqi2811-smoke",
    );
    expect(normalizeModuleIds([])).toEqual(["affiliates"]);
    expect(normalizeModuleIds(["affiliates", "stripe", "affiliates"])).toEqual([
      "affiliates",
      "stripe",
    ]);
    expect(() => normalizeModuleIds(["bad module"])).toThrow(/Invalid module id/);
  });
});
