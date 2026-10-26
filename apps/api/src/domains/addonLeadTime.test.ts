import { describe, expect, it } from "vitest";
import {
  addonLeadTimeAllows,
  addonLeadTimeEarliestArrival,
  readAddonLeadTime,
} from "./addonLeadTime.js";
import { propertyLocalInstant } from "./pricingManualPaymentLead.js";

const colombo = { timeZone: "Asia/Colombo", checkInTime: "14:00" } as const;
const hour = 3_600_000;

describe("add-on lead time (VAY-2232)", () => {
  it("reads the structured value, then the old free text", () => {
    expect(readAddonLeadTime({ leadTimeHours: 24 })).toEqual({ hours: 24, legacy: null });
    expect(readAddonLeadTime({ leadTimeHours: null })).toEqual({ hours: null, legacy: null });
    // A structured value wins over text an older editor wrote next to it.
    expect(readAddonLeadTime({ leadTimeHours: 12, leadTime: "3 days" })).toEqual({
      hours: 12,
      legacy: null,
    });
    expect(readAddonLeadTime({ leadTime: "10h" })).toEqual({ hours: null, legacy: "10h" });
    expect(readAddonLeadTime({ leadTime: "  " })).toEqual({ hours: null, legacy: null });
    expect(readAddonLeadTime({ leadTime: null })).toEqual({ hours: null, legacy: null });
    expect(readAddonLeadTime({})).toEqual({ hours: null, legacy: null });
    for (const invalid of [10, 0, "24", 36, 24.5, true])
      expect(readAddonLeadTime({ leadTimeHours: invalid })).toBeNull();
    expect(readAddonLeadTime({ leadTime: 12 })).toBeNull();
  });

  it("allows the add-on from exactly its notice before the hotel's check-in time", () => {
    const checkIn = propertyLocalInstant("2026-10-20", "14:00", "Asia/Colombo")!.getTime();
    const allows = (now: number) =>
      addonLeadTimeAllows({ hours: 24, checkIn: "2026-10-20", place: colombo, now: new Date(now) });
    expect(allows(checkIn - 24 * hour)).toBe(true);
    expect(allows(checkIn - 24 * hour + 60_000)).toBe(false);
    // Without a check-in time the arrival day starts at 00:00.
    const midnight = propertyLocalInstant("2026-10-20", "00:00", "Asia/Colombo")!.getTime();
    const place = { timeZone: "Asia/Colombo", checkInTime: null };
    expect(
      addonLeadTimeAllows({
        hours: 12,
        checkIn: "2026-10-20",
        place,
        now: new Date(midnight - 12 * hour),
      }),
    ).toBe(true);
    expect(
      addonLeadTimeAllows({
        hours: 12,
        checkIn: "2026-10-20",
        place,
        now: new Date(midnight - 12 * hour + 60_000),
      }),
    ).toBe(false);
    expect(
      addonLeadTimeAllows({
        hours: 12,
        checkIn: "2026-10-20",
        place: { timeZone: "Not/AZone", checkInTime: null },
        now: new Date("2026-10-01T00:00:00Z"),
      }),
    ).toBe(false);
  });

  it("names the first arrival date a guest can add the add-on for", () => {
    // 15:30 in Colombo on 2026-10-17; check-in is at 14:00.
    const now = new Date("2026-10-17T10:00:00Z");
    const earliest = (hours: 12 | 24 | 48 | 72 | 168) =>
      addonLeadTimeEarliestArrival({ hours, place: colombo, now });
    expect(earliest(12)).toBe("2026-10-18");
    expect(earliest(24)).toBe("2026-10-19");
    expect(earliest(48)).toBe("2026-10-20");
    expect(earliest(72)).toBe("2026-10-21");
    expect(earliest(168)).toBe("2026-10-25");
    expect(
      addonLeadTimeEarliestArrival({
        hours: 24,
        place: { timeZone: "Not/AZone", checkInTime: null },
        now,
      }),
    ).toBeNull();
  });
});
