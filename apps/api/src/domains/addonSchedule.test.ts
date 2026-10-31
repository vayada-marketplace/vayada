import { describe, expect, it } from "vitest";
import {
  addonLineDates,
  addonScheduledDates,
  defaultAddonScheduleMode,
  isoWeekday,
  parseBookableWeekdays,
  readAddonSchedule,
  resolveAddonScheduleMode,
} from "./addonSchedule.js";

const every = [1, 2, 3, 4, 5, 6, 7];

describe("add-on schedule (VAY-2391)", () => {
  it("defaults like the 0525 backfill: per-night every day, transport on arrival, else the guest picks", () => {
    expect(defaultAddonScheduleMode("per_night", "transport")).toBe("daily");
    expect(defaultAddonScheduleMode("per_guest_night", "dining")).toBe("daily");
    expect(defaultAddonScheduleMode("per_stay", " Transport ")).toBe("arrival");
    expect(defaultAddonScheduleMode("per_guest", "transport")).toBe("arrival");
    expect(defaultAddonScheduleMode("per_stay", "dining")).toBe("guest_pick");
    expect(defaultAddonScheduleMode("per_guest", null)).toBe("guest_pick");
  });

  it("keeps a per-night price and every day together", () => {
    const resolve = resolveAddonScheduleMode;
    expect(resolve({ pricingModel: "per_night", category: "dining", chosen: "daily" })).toBe(
      "daily",
    );
    expect(
      resolve({ pricingModel: "per_night", category: "dining", chosen: "arrival" }),
    ).toBeNull();
    expect(resolve({ pricingModel: "per_stay", category: "dining", chosen: "daily" })).toBeNull();
    expect(resolve({ pricingModel: "per_stay", category: "dining", chosen: "anytime" })).toBe(
      "anytime",
    );
    // Without a choice the saved mode stays while it fits the price; otherwise the default.
    expect(resolve({ pricingModel: "per_stay", category: "dining", saved: "departure" })).toBe(
      "departure",
    );
    expect(resolve({ pricingModel: "per_night", category: "dining", saved: "departure" })).toBe(
      "daily",
    );
    expect(resolve({ pricingModel: "per_stay", category: "transport", saved: "daily" })).toBe(
      "arrival",
    );
    expect(resolve({ pricingModel: "per_guest", category: "wellness", saved: "daily" })).toBe(
      "guest_pick",
    );
  });

  it("accepts one to seven distinct ISO weekdays, sorted", () => {
    expect(parseBookableWeekdays([7, 1, 5])).toEqual([1, 5, 7]);
    expect(parseBookableWeekdays(every)).toEqual(every);
    for (const invalid of [[], [0], [8], [1, 1], [1.5], ["1"], null, "1,2", [...every, 1]])
      expect(parseBookableWeekdays(invalid)).toBeNull();
  });

  it("reads a per-night price as every day, never a one-off one, and missing values as the defaults", () => {
    expect(readAddonSchedule("per_night", "guest_pick", [5])).toEqual({
      scheduleMode: "daily",
      bookableWeekdays: [5],
    });
    expect(readAddonSchedule("per_stay", "daily", every)?.scheduleMode).toBe("guest_pick");
    expect(readAddonSchedule("per_stay", "departure", every)?.scheduleMode).toBe("departure");
    expect(readAddonSchedule("per_stay", undefined, undefined)).toEqual({
      scheduleMode: "guest_pick",
      bookableWeekdays: every,
    });
    // The column allows a weekday twice; it means the same days.
    expect(readAddonSchedule("per_stay", "guest_pick", [6, 5, 6])?.bookableWeekdays).toEqual([
      5, 6,
    ]);
    expect(readAddonSchedule("per_stay", "weekly", every)).toBeNull();
    expect(readAddonSchedule("per_stay", "arrival", [0])).toBeNull();
  });

  it("dates a one-off add-on from the stay unless the guest has to pick", () => {
    const stay = { checkIn: "2026-11-03", checkOut: "2026-11-06" };
    expect(addonScheduledDates("arrival", stay)).toEqual(["2026-11-03"]);
    expect(addonScheduledDates("departure", stay)).toEqual(["2026-11-06"]);
    expect(addonScheduledDates("anytime", stay)).toEqual([]);
    expect(addonScheduledDates("guest_pick", stay)).toBeNull();
    // 2026-11-02 is a Monday, 2026-11-08 a Sunday.
    expect(["2026-11-02", "2026-11-06", "2026-11-08"].map(isoWeekday)).toEqual([1, 5, 7]);
  });

  it("dates a line by when it happens and refuses days its schedule doesn't allow (VAY-2409)", () => {
    // Tuesday 3 to Friday 6 November.
    const stay = { checkIn: "2026-11-03", checkOut: "2026-11-06" };
    const mode = (scheduleMode: Parameters<typeof addonLineDates>[0]["scheduleMode"]) => ({
      scheduleMode,
      bookableWeekdays: every,
    });
    const nights = ["2026-11-03", "2026-11-04", "2026-11-05"];
    expect(addonLineDates(mode("daily"), null, stay)).toEqual(nights);
    expect(addonLineDates(mode("daily"), [...nights].reverse(), stay)).toEqual(nights);
    expect(addonLineDates(mode("daily"), nights.slice(1), stay)).toBeNull();
    expect(addonLineDates(mode("arrival"), null, stay)).toEqual(["2026-11-03"]);
    expect(addonLineDates(mode("arrival"), ["2026-11-03"], stay)).toEqual(["2026-11-03"]);
    expect(addonLineDates(mode("arrival"), ["2026-11-04"], stay)).toBeNull();
    expect(addonLineDates(mode("departure"), ["2026-11-06"], stay)).toEqual(["2026-11-06"]);
    expect(addonLineDates(mode("anytime"), null, stay)).toEqual([]);
    expect(addonLineDates(mode("anytime"), ["2026-11-03"], stay)).toBeNull();
    // A guest picks one night, on a weekday it is offered; never none, two or the check-out day.
    const thursdays = { scheduleMode: "guest_pick" as const, bookableWeekdays: [4] };
    expect(addonLineDates(thursdays, ["2026-11-05"], stay)).toEqual(["2026-11-05"]);
    expect(addonLineDates(thursdays, ["2026-11-04"], stay)).toBeNull();
    expect(addonLineDates(thursdays, null, stay)).toBeNull();
    expect(addonLineDates(mode("guest_pick"), ["2026-11-04", "2026-11-05"], stay)).toBeNull();
    expect(addonLineDates(mode("guest_pick"), ["2026-11-06"], stay)).toBeNull();
  });
});
