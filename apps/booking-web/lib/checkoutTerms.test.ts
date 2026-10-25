import { expect, it } from "vitest";
import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import { cancellationLine, checkoutCopy, hotelCountryName } from "./checkoutTerms";
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
    "Cancellation: 100% back if you cancel by the end of Tue, 10 Nov 2026; 50% back if you cancel by the end of Thu, 3 Dec 2026, local hotel time. After that, or if you don’t arrive, we keep the full amount.",
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

it("judges the deadline on the hotel's calendar day, not the guest's", () => {
  // 19:00 UTC on 25 Oct is already 26 Oct in Sri Lanka, so a deadline of 25 Oct has passed there.
  const today = hotelToday("Asia/Colombo", new Date("2026-10-25T19:00:00Z"));
  expect(today).toBe("2026-10-26");
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
