import { expect, it } from "vitest";
import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import {
  cancellationLine,
  cancellationSummary,
  checkoutCopy,
  hotelCountryName,
} from "./checkoutTerms";
import { hotelToday } from "./roomChoices";

type Cancellation = PublicBookingQuote["rooms"][number]["cancellation"];
const free = (days: number) =>
  ({
    kind: "flexible",
    terms: { flexibleCancellationType: "free", freeCancellationDeadlineDays: days },
  }) as unknown as Cancellation;
const partial = (tiers: { minDaysBeforeCheckIn: number; refundPercent: number }[]) =>
  ({
    kind: "flexible",
    terms: { flexibleCancellationType: "partial_refund", partialRefundTiers: tiers },
  }) as unknown as Cancellation;

it("never promises free cancellation once its deadline has passed (VAY-2347)", () => {
  // Booked on 25 Oct for the next night: free until 3 days before arrival ended on 23 Oct.
  expect(cancellationLine(free(3), { checkIn: "2026-10-26", today: "2026-10-25" })).toBe(
    "Cancellation: free cancellation ended on Fri, 23 Oct 2026. If you cancel or don’t arrive, we charge the full amount.",
  );
  // The deadline day itself still counts, as on the server.
  expect(cancellationLine(free(3), { checkIn: "2026-10-28", today: "2026-10-25" })).toBe(
    "Cancellation: free until the end of Sun, 25 Oct 2026, local hotel time. After that, or if you don’t arrive, we charge the full amount.",
  );
  expect(cancellationLine(free(0), { checkIn: "2026-10-25", today: "2026-10-25" })).toBe(
    "Cancellation: free until the end of Sun, 25 Oct 2026, local hotel time. After that, or if you don’t arrive, we charge the full amount.",
  );
  expect(
    cancellationLine({ kind: "non_refundable" }, { checkIn: "2026-10-26", today: "2026-10-25" }),
  ).toBe(checkoutCopy.nonRefundable);
});

it("dates the partial refunds still open and says when the last one ended", () => {
  const tiers = partial([
    { minDaysBeforeCheckIn: 7, refundPercent: 50 },
    { minDaysBeforeCheckIn: 30, refundPercent: 100 },
    { minDaysBeforeCheckIn: 1, refundPercent: 0 },
  ]);
  expect(cancellationLine(tiers, { checkIn: "2026-12-10", today: "2026-10-25" })).toBe(
    "Cancellation: 100% back if you cancel by the end of Tue, 10 Nov 2026; 50% back if you cancel from Wed, 11 Nov 2026 to the end of Thu, 3 Dec 2026, local hotel time. After that, or if you don’t arrive, we keep the full amount.",
  );
  expect(cancellationLine(tiers, { checkIn: "2026-11-10", today: "2026-10-25" })).toBe(
    "Cancellation: 50% back if you cancel by the end of Tue, 3 Nov 2026, local hotel time. After that, or if you don’t arrive, we keep the full amount.",
  );
  expect(cancellationLine(tiers, { checkIn: "2026-10-26", today: "2026-10-25" })).toBe(
    "Cancellation: refunds ended on Mon, 19 Oct 2026. If you cancel or don’t arrive, we keep the full amount.",
  );
  expect(
    cancellationLine(partial([{ minDaysBeforeCheckIn: 3, refundPercent: 0 }]), {
      checkIn: "2026-11-10",
      today: "2026-10-25",
    }),
  ).toBe(checkoutCopy.noRefund);
});

it("names each step's days when a refund rises again with less notice", () => {
  // The server picks the step with the most notice the guest still meets: 20 days before arrival
  // that is the 0% step, so the 50% step must not read as "by" a later date.
  const tiers = partial([
    { minDaysBeforeCheckIn: 30, refundPercent: 100 },
    { minDaysBeforeCheckIn: 14, refundPercent: 0 },
    { minDaysBeforeCheckIn: 7, refundPercent: 50 },
  ]);
  expect(cancellationLine(tiers, { checkIn: "2026-12-10", today: "2026-10-25" })).toBe(
    "Cancellation: 100% back if you cancel by the end of Tue, 10 Nov 2026; no refund if you cancel from Wed, 11 Nov 2026 to the end of Thu, 26 Nov 2026; 50% back if you cancel from Fri, 27 Nov 2026 to the end of Thu, 3 Dec 2026, local hotel time. After that, or if you don’t arrive, we keep the full amount.",
  );
});

it("names the rooms in the payment step's box only when their terms differ", () => {
  const stay = { checkIn: "2026-11-10", today: "2026-10-25" };
  expect(
    cancellationSummary(
      [
        { name: "Double", cancellation: free(3) },
        { name: "Double", cancellation: free(3) },
      ],
      stay,
    ),
  ).toEqual([
    "Free until the end of Sat, 7 Nov 2026, local hotel time. After that, or if you don’t arrive, we charge the full amount.",
  ]);
  expect(
    cancellationSummary(
      [
        { name: "Double", cancellation: free(3) },
        { name: "Suite", cancellation: { kind: "non_refundable" } },
      ],
      stay,
    ),
  ).toEqual([
    "Double: Free until the end of Sat, 7 Nov 2026, local hotel time. After that, or if you don’t arrive, we charge the full amount.",
    "Suite: Non-refundable. If you cancel, change or don’t arrive, we charge the full amount.",
  ]);
});

it("judges the deadline on the hotel's calendar day, not the guest's", () => {
  // 19:00 UTC on 25 Oct is already 26 Oct in Sri Lanka, so a deadline of 25 Oct has passed there.
  const today = hotelToday("Asia/Colombo", new Date("2026-10-25T19:00:00Z"));
  expect(today).toBe("2026-10-26");
  // Without a zone it is UTC, as on the server, not the device's zone.
  expect(hotelToday(undefined, new Date("2026-10-25T23:30:00Z"))).toBe("2026-10-25");
  expect(cancellationLine(free(3), { checkIn: "2026-10-28", today })).toContain(
    "free cancellation ended on Sun, 25 Oct 2026",
  );
});

it("names times as local hotel time with the hotel's country, never a zone name", () => {
  expect(hotelCountryName("LK")).toBe("Sri Lanka");
  expect(hotelCountryName("de", "de")).toBe("Deutschland");
  // Anything that isn't an ISO code is shown as it came.
  expect(hotelCountryName("Switzerland")).toBe("Switzerland");
  for (const none of ["", "  ", null, undefined]) expect(hotelCountryName(none)).toBeNull();
  expect(checkoutCopy.allTimesLocal(hotelCountryName("LK"))).toBe(
    "All times are local hotel time (Sri Lanka).",
  );
  expect(checkoutCopy.allTimesLocal(null)).toBe("All times are local hotel time.");
});
