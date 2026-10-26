import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/settings", () => ({ pmsSettingsService: { getHotelDetails: vi.fn() } }));

import { formatPaymentDeadline, knownTimeZone } from "./awaitingPayment";

describe("payment deadline in hotel time (VAY-2348)", () => {
  it("shows the deadline on the hotel's clock", () => {
    // 13:30 UTC is 15:30 in Vienna and 19:00 in Colombo.
    expect(formatPaymentDeadline("2026-08-13T13:30:00.000Z", "en-GB", "Europe/Vienna")).toBe(
      "Thu 13 Aug, 15:30",
    );
    expect(formatPaymentDeadline("2026-08-13T13:30:00.000Z", "en-GB", "Asia/Colombo")).toContain(
      "19:00",
    );
  });

  it("falls back to the browser's clock for an unknown zone, and keeps a bad date as it is", () => {
    // Browser time: any machine's zone gives some time in mid-August.
    expect(formatPaymentDeadline("2026-08-13T13:30:00.000Z", "en-GB", "Not/AZone")).toMatch(
      /1[234] Aug, \d\d:\d\d/,
    );
    expect(formatPaymentDeadline("soon", "en-GB", "Europe/Vienna")).toBe("soon");
  });

  it("only labels a time as hotel time when the hotel's zone is known", () => {
    expect(knownTimeZone("Asia/Colombo")).toBe("Asia/Colombo");
    expect(knownTimeZone("Not/AZone")).toBeNull();
    expect(knownTimeZone("")).toBeNull();
    expect(knownTimeZone(undefined)).toBeNull();
  });
});
