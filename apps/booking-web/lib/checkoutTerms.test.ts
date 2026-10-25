import { expect, it } from "vitest";
import { hotelCountryName, refundSteps } from "./checkoutTerms";
import { hotelToday } from "./roomChoices";

it("names the hotel's country for local hotel time, never a zone name", () => {
  expect(hotelCountryName("LK")).toBe("Sri Lanka");
  expect(hotelCountryName("de", "de")).toBe("Deutschland");
  // Anything that isn't an ISO code is shown as it came.
  expect(hotelCountryName("Switzerland")).toBe("Switzerland");
  for (const none of ["", "  ", null, undefined]) expect(hotelCountryName(none)).toBeNull();
});

it("judges today on the hotel's calendar day, UTC without a zone, never the device's", () => {
  // 19:00 UTC on 25 Oct is already 26 Oct in Sri Lanka.
  expect(hotelToday("Asia/Colombo", new Date("2026-10-25T19:00:00Z"))).toBe("2026-10-26");
  expect(hotelToday(undefined, new Date("2026-10-25T23:30:00Z"))).toBe("2026-10-25");
});

it("dates each refund step's days, most notice first (VAY-2347)", () => {
  expect(
    refundSteps(
      [
        { minDaysBeforeCheckIn: 7, refundPercent: 50 },
        { minDaysBeforeCheckIn: 30, refundPercent: 100 },
      ],
      { checkIn: "2026-11-10", today: "2026-10-25" },
    ),
  ).toEqual([
    {
      minDaysBeforeCheckIn: 30,
      refundPercent: 100,
      percent: 100,
      from: null,
      until: "2026-10-11",
      passed: true,
    },
    {
      minDaysBeforeCheckIn: 7,
      refundPercent: 50,
      percent: 50,
      from: "2026-10-12",
      until: "2026-11-03",
      passed: false,
    },
  ]);
});
