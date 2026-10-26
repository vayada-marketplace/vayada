import { parseFlexibleCancellationTerms } from "@vayada/domain-pms";
import { describe, expect, it } from "vitest";

import { parseUpsertBookingDesignRequest } from "./bookingDesign.js";
import { parseBookingGuestPolicyChoices } from "./bookingGuestPolicy.js";
import {
  DEFAULT_GUEST_TERMS,
  FIRST_RUN_BEDS,
  FIRST_RUN_BOOKING_DESIGN,
  FIRST_RUN_CANCELLATION_TERMS,
  FIRST_RUN_GUEST_TERMS,
  FIRST_RUN_MINIMUM_STAY_NIGHTS,
  FIRST_RUN_OPERATING_SCHEDULE,
  FIRST_RUN_BED_CHOICES,
  FIRST_RUN_FREE_CANCELLATION_DAYS,
  firstRunBeds,
  firstRunCancellationTerms,
  firstRunGuestPolicy,
  firstRunRoomLabels,
  isFirstRunBedChoice,
  isFirstRunFreeCancellationDays,
} from "./index.js";

// Every default must pass the same parser the real write path uses, or the first run would fail.
describe("first-run defaults (VAY-2247)", () => {
  it("Classic is a valid booking design choice", () => {
    expect(FIRST_RUN_BOOKING_DESIGN.fontPairing).toBe("grand-classic");
    expect(
      parseUpsertBookingDesignRequest({ expectedRevision: 0, ...FIRST_RUN_BOOKING_DESIGN }),
    ).not.toBeNull();
  });

  it("guest rules are valid in every guest language and welcome children from 12 as adults", () => {
    for (const language of ["en", "de", "fr", "es", "id", "nl"] as const) {
      const policy = firstRunGuestPolicy(language);
      expect(parseBookingGuestPolicyChoices(policy)).toEqual(policy);
    }
    expect(firstRunGuestPolicy("de")).toMatchObject({
      defaultGuestLanguage: "de",
      childrenEnabled: true,
      adultAgeThreshold: 12,
      checkInTime: "15:00",
      checkOutTime: "11:00",
    });
  });

  it("cancellation is free until 3 days before arrival, then the full stay", () => {
    expect(parseFlexibleCancellationTerms(FIRST_RUN_CANCELLATION_TERMS)).toEqual({
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 3,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    });
  });

  it("the calendar is open all year with a one-night minimum and one double bed per room", () => {
    expect(FIRST_RUN_OPERATING_SCHEDULE).toEqual({ mode: "year_round", periods: [] });
    expect(FIRST_RUN_MINIMUM_STAY_NIGHTS).toBe(1);
    expect(FIRST_RUN_BEDS).toEqual([{ type: "double", quantity: 1 }]);
  });

  it("offers free cancellation until 1, 3, 7 or 14 days, each a valid refundable policy (1.12b)", () => {
    expect(FIRST_RUN_FREE_CANCELLATION_DAYS).toEqual([1, 3, 7, 14]);
    for (const days of FIRST_RUN_FREE_CANCELLATION_DAYS) {
      expect(parseFlexibleCancellationTerms(firstRunCancellationTerms(days))).toEqual({
        ...FIRST_RUN_CANCELLATION_TERMS,
        freeCancellationDeadlineDays: days,
      });
    }
    expect(firstRunCancellationTerms()).toEqual(FIRST_RUN_CANCELLATION_TERMS);
    expect(isFirstRunFreeCancellationDays(7)).toBe(true);
    for (const other of [0, 2, 30, "3", null])
      expect(isFirstRunFreeCancellationDays(other)).toBe(false);
  });

  it("offers a double, queen, king or single bed per room, or two twin beds (1.12b)", () => {
    expect(FIRST_RUN_BED_CHOICES).toEqual(["double", "queen", "king", "twin", "single"]);
    expect(firstRunBeds()).toEqual(FIRST_RUN_BEDS);
    expect(firstRunBeds("king")).toEqual([{ type: "king", quantity: 1 }]);
    expect(firstRunBeds("twin")).toEqual([{ type: "twin", quantity: 2 }]);
    expect(isFirstRunBedChoice("queen")).toBe(true);
    for (const other of ["bunk_bed", "sofa_bed", "Double", 1])
      expect(isFirstRunBedChoice(other)).toBe(false);
  });

  it("uses the shared guest terms text", () => {
    expect(FIRST_RUN_GUEST_TERMS).toBe(DEFAULT_GUEST_TERMS);
  });

  it("names rooms Room 1–N and continues the numbering for the next room type", () => {
    expect(firstRunRoomLabels(3)).toEqual(["Room 1", "Room 2", "Room 3"]);
    expect(firstRunRoomLabels(2, 9)).toEqual(["Room 9", "Room 10"]);
    expect(() => firstRunRoomLabels(0)).toThrow(RangeError);
    expect(() => firstRunRoomLabels(2, 0)).toThrow(RangeError);
  });
});
