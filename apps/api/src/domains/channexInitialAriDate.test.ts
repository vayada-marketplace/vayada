import { describe, expect, it } from "vitest";
import { admitChannexInitialAriDate as admit } from "./channexInitialAriDate.js";

describe("initial ARI property-local date admission", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  it("includes today and the existing full-ARI boundary, excluding adjacent dates", () => {
    expect(admit("2026-01-01", "UTC", now)).toMatchObject({
      kind: "admitted",
      through: "2027-07-03",
    });
    expect(admit("2027-07-03", "UTC", now).kind).toBe("admitted");
    for (const date of ["2025-12-31", "2027-07-04"])
      expect(admit(date, "UTC", now).kind).toBe("unavailable");
  });
  it("uses the hotel's date on either side of UTC midnight", () => {
    const instant = new Date("2026-01-01T00:30:00Z");
    expect(admit("2025-12-31", "America/Los_Angeles", instant)).toMatchObject({
      kind: "admitted",
      propertyLocalDate: "2025-12-31",
    });
    expect(admit("2025-12-31", "Asia/Taipei", instant).kind).toBe("unavailable");
    expect(admit("2026-01-01", "Pacific/Kiritimati", new Date("2026-01-01T10:30:00Z")).kind).toBe(
      "unavailable",
    );
  });
  it("preserves calendar dates across daylight-saving transitions and leap day", () => {
    for (const instant of ["2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z"])
      expect(admit("2026-03-08", "America/New_York", new Date(instant))).toMatchObject({
        kind: "admitted",
        propertyLocalDate: "2026-03-08",
      });
    expect(admit("2028-02-29", "UTC", new Date("2028-02-28T12:00:00Z")).kind).toBe("admitted");
  });
  it("rejects missing or invalid timezone, dates and clock values without fallback", () => {
    for (const zone of [undefined, null, "", " UTC ", "invalid/zone"])
      expect(admit("2026-01-01", zone, now).kind).toBe("unavailable");
    for (const date of ["2026-02-30", "2027-02-29", "2026-1-1", "not-date"])
      expect(admit(date, "UTC", now).kind).toBe("unavailable");
    expect(admit("2026-01-01", "UTC", new Date(NaN)).kind).toBe("unavailable");
  });
});
