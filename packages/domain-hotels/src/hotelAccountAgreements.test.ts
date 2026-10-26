import { describe, expect, it } from "vitest";

import {
  CURRENT_HOTEL_ACCOUNT_AGREEMENTS,
  isCurrentHotelAccountAgreements,
} from "./hotelAccountAgreements.js";

describe("hotel account agreements (VAY-2246)", () => {
  it("are the terms and the DPA of 24 October 2026", () => {
    expect(CURRENT_HOTEL_ACCOUNT_AGREEMENTS).toEqual({
      termsVersion: "2026-10-24",
      dpaVersion: "2026-10-24",
    });
    expect(Object.isFrozen(CURRENT_HOTEL_ACCOUNT_AGREEMENTS)).toBe(true);
  });

  it("accept only exactly the current versions", () => {
    expect(isCurrentHotelAccountAgreements({ ...CURRENT_HOTEL_ACCOUNT_AGREEMENTS })).toBe(true);
    for (const value of [
      null,
      "2026-10-24",
      [],
      {},
      { termsVersion: "2026-10-20", dpaVersion: "2026-10-24" },
      { termsVersion: "2026-10-24", dpaVersion: "2026-10-23" },
      { termsVersion: "2026-10-24" },
      { ...CURRENT_HOTEL_ACCOUNT_AGREEMENTS, extra: true },
    ])
      expect(isCurrentHotelAccountAgreements(value)).toBe(false);
  });
});
