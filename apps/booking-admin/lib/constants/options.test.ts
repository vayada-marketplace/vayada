import { describe, expect, it } from "vitest";
import { CURRENCY_OPTIONS } from "./options";

describe("booking-admin locale options", () => {
  it("includes Sri Lankan Rupee for Booking Engine additional currencies", () => {
    expect(CURRENCY_OPTIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LKR",
          name: "Sri Lankan Rupee",
        }),
      ]),
    );
  });
});
