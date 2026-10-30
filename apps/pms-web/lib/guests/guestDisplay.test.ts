import { describe, expect, it } from "vitest";
import {
  formatStayDates,
  guestActivity,
  guestInitials,
  propertyColor,
  stayNights,
  stayStatus,
} from "./guestDisplay";

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key} ${JSON.stringify(params)}` : key;

describe("guest display (VAY-2420)", () => {
  it("shows initials from both names", () => {
    expect(guestInitials("timo", "Schreyer")).toBe("TS");
    expect(guestInitials(" ", "")).toBe("?");
  });

  it("writes a stay's dates with the year once and counts its nights", () => {
    expect(formatStayDates("2026-10-29", "2026-11-01", "en-US")).toMatch(
      /^Oct 29\s–\sNov 1, 2026$/,
    );
    expect(formatStayDates("2026-12-30", "2027-01-02", "en-US")).toMatch(/2026.*2027/);
    expect(stayNights("2026-10-29", "2026-11-01")).toBe(3);
  });

  it("says whether the guest arrives today, later or stayed before", () => {
    expect(guestActivity("2026-10-29", "2026-10-29", "en-US", t)).toBe("guests.arrivingToday");
    expect(guestActivity("2026-11-03", "2026-10-29", "en-US", t)).toBe(
      'guests.arrivingOn {"date":"Nov 3"}',
    );
    expect(guestActivity("2026-08-02", "2026-10-29", "en-US", t)).toBe(
      'guests.lastStay {"date":"Aug 2, 2026"}',
    );
    expect(guestActivity(null, "2026-10-29", "en-US", t)).toBeNull();
  });

  it("labels each booking status and keeps one colour per property", () => {
    expect(stayStatus("confirmed").labelKey).toBe("bookings.statusConfirmed");
    expect(stayStatus("canceled").labelKey).toBe("bookings.statusCancelled");
    expect(stayStatus("unknown").labelKey).toBeNull();
    expect(propertyColor("a")).toBe(propertyColor("a"));
  });
});
