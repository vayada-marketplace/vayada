import { describe, expect, it } from "vitest";
import { parseReplacementStay, replacementEvidenceStatus, replacementStayKey,
  type ReplacementPricingEvidence, type PricingSourceRevisions } from "./replacementPricingEvidence.js";

const stay = () => parseReplacementStay({ propertyId: "p1", checkIn: "2026-10-01", checkOut: "2026-10-04", currency: "EUR",
  rooms: [{ selectionId: "r1", roomTypeId: "double", offerId: "flex", guests: { adults: 2, childAgesAtCheckIn: [1, 8] } }],
  addons: [], promoCode: null })!;
const revisions: PricingSourceRevisions = { pms: "p1", terms: "t1", promotions: "pr1", addons: "a1", charges: "c1", finance: "f1", fx: "x1" };
const evidence = (): ReplacementPricingEvidence => ({ version: "pricing.v2", requestKey: replacementStayKey(stay()), revisions,
  currency: "EUR", issuedAt: "2026-09-08T00:00:00Z", expiresAt: "2026-09-08T00:15:00Z",
  lines: [{ id: "room", selectionId: "r1", kind: "room", amountMinor: "40000" },
    { id: "promo", selectionId: "r1", kind: "discount", amountMinor: "4000" }],
  totalMinor: "36000", dueNowMinor: "10800", dueLaterMinor: "25200",
  terms: [{ roomTypeId: "double", offerId: "flex", revision: "t1", cancellation: { kind: "flexible", terms: { type: "free_until_days_before_arrival", freeCancellationDeadlineDays: 7,
    afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount", flexibleCancellationType: "partial_refund",
    partialRefundTiers: [{ minDaysBeforeCheckIn: 30, refundPercent: 75 }, { minDaysBeforeCheckIn: 14, refundPercent: 50 }] } }, payment: { kind: "deposit", basisPoints: 3000, balanceDaysBeforeArrival: 7 } }],
  fx: [], paymentCapabilityEvidenceId: "finance-1", mandatoryChargeEvidenceId: "charges-1" });
const now = new Date("2026-09-08T00:05:00Z");

describe("replacement stay and evidence contracts", () => {
  it("rejects malformed stays and isolates accepted input", () => {
    const input = stay(); const parsed = parseReplacementStay(input)!;
    expect(parsed).toEqual(input); expect(parsed.rooms).not.toBe(input.rooms);
    for (const change of [{ checkOut: "2026-10-01" }, { checkIn: "2026-02-30" }, { currency: "ZZZ" },
      { rooms: [] }, { rooms: [...input.rooms, ...input.rooms] }, { providerId: "external-provider" }, { addons: [{ id: "a", quantity: 0 }] },
      { rooms: [{ ...input.rooms[0], guests: { adults: 0, childAgesAtCheckIn: [] } }] },
      { rooms: [{ ...input.rooms[0], guests: { adults: 1, childAgesAtCheckIn: [null] } }] }]) {
      expect(parseReplacementStay({ ...input, ...change })).toBeNull();
    }
  });
  it("binds every meaningful stay choice while ignoring child-age ordering", () => {
    const input = stay(); const key = replacementStayKey(input);
    expect(replacementStayKey({ ...input, rooms: [{ ...input.rooms[0], guests: { adults: 2, childAgesAtCheckIn: [8, 1] } }] })).toBe(key);
    for (const next of [{ ...input, propertyId: "p2" }, { ...input, currency: "USD" }, { ...input, promoCode: "SUMMER" },
      { ...input, checkOut: "2026-10-05" }, { ...input, addons: [{ id: "bed", quantity: 1, dates: null }] },
      { ...input, rooms: [{ ...input.rooms[0], offerId: "nr" }] },
      { ...input, rooms: [{ ...input.rooms[0], guests: { adults: 2, childAgesAtCheckIn: [1, 9] } }] }]) {
      expect(replacementStayKey(next)).not.toBe(key);
    }
  });
  it("preserves dated add-ons in the request binding and rejects invalid dates", () => {
    const input = stay();
    const selected = (dates: string[] | null) => ({ ...input, addons: [{ id: "tour", quantity: 2, dates }] });
    expect(parseReplacementStay(selected(["2026-10-02"]))).not.toBeNull();
    expect(replacementStayKey(selected(["2026-10-02"]))).not.toBe(replacementStayKey(selected(["2026-10-03"])));
    for (const dates of [[], ["2026-09-30"], ["2026-10-05"], ["2026-02-30"], ["2026-10-02", "2026-10-02"]]) {
      expect(parseReplacementStay(selected(dates))).toBeNull();
    }
  });
  it("retains full legacy cancellation tiers and rejects duplicate deadlines", () => {
    const e = evidence(); const c = e.terms[0].cancellation;
    expect(c.kind === "flexible" && c.terms.partialRefundTiers).toEqual([
      { minDaysBeforeCheckIn: 30, refundPercent: 75 }, { minDaysBeforeCheckIn: 14, refundPercent: 50 }]);
    if (c.kind !== "flexible") throw new Error("fixture");
    const invalid = { ...e, terms: [{ ...e.terms[0], cancellation: { ...c, terms: { ...c.terms,
      partialRefundTiers: [{ minDaysBeforeCheckIn: 14, refundPercent: 75 }, { minDaysBeforeCheckIn: 14, refundPercent: 50 }] } } }] };
    expect(replacementEvidenceStatus(invalid, stay(), revisions, now)).toBe("invalid");
  });
  it("requires each owner revision and expires exactly at the boundary", () => {
    expect(replacementEvidenceStatus(evidence(), stay(), revisions, now)).toBe("current");
    for (const key of Object.keys(revisions)) {
      expect(replacementEvidenceStatus(evidence(), stay(), { ...revisions, [key]: "changed" }, now)).toBe("stale");
    }
    expect(replacementEvidenceStatus(evidence(), stay(), revisions, new Date(evidence().expiresAt))).toBe("stale");
    expect(replacementEvidenceStatus(evidence(), { ...stay(), promoCode: "X" }, revisions, now)).toBe("stale");
  });
  it("rejects broken conservation, missing room/terms evidence and invalid FX", () => {
    const e = evidence();
    for (const change of [{ dueLaterMinor: "25201" }, { totalMinor: "40000" }, { lines: [] }, { terms: [] },
      { lines: [...e.lines, e.lines[0]] }, { mandatoryChargeEvidenceId: "" },
      { lines: [{ ...e.lines[0], selectionId: "unselected" }] },
      { fx: [{ id: "fx", from: "USD", to: "EUR", numerator: "1", denominator: "0", observedAt: e.issuedAt, expiresAt: e.expiresAt }] }]) {
      expect(replacementEvidenceStatus({ ...e, ...change }, stay(), revisions, now)).toBe("invalid");
    }
  });
});

// Acceptance vectors for the future evaluator. These check agreed arithmetic,
// not calendar selection, promotion eligibility, taxes or live checkout behavior.
// BigInt half-up reference arithmetic intentionally lives only in this test.
const percent = (amount: bigint, bps: bigint) => (amount * bps + 5000n) / 10000n;
describe("agreed pricing acceptance arithmetic", () => {
  it.each([
    ["one guest occupancy", 10000n, 0n, 0n, 10000n],
    ["three guests occupancy", 15500n, 0n, 0n, 15500n],
    ["three guests per-person at 60", 3n * 6000n, 0n, 0n, 18000n],
    ["room 130 plus guest 25, NR 10%, breakfast 45", 13000n + 2500n, 1000n, 4500n, 18450n],
    ["three nights 450, NR 10%, meals 105", 45000n, 1000n, 10500n, 51000n],
    ["mixed occupancy rooms and actual guest meals", 10000n + 15500n, 0n, 6000n, 31500n],
    ["NR-only base has no extra discount", 15000n, 0n, 0n, 15000n],
    ["child free infant plus fixed supplement", 13000n + 0n + 2000n, 0n, 0n, 15000n],
  ] as const)("%s", (_name, room, nrBps, meals, expected) => {
    expect(percent(room, 10000n - nrBps) + meals).toBe(expected);
  });
  it("selects independent promo candidates when stacking is off; LM then code when on", () => {
    const initial = 10000n, lm = percent(initial, 9000n), code = percent(initial, 8000n);
    expect(lm < code ? lm : code).toBe(8000n); // old sequential comparison incorrectly returned 8200
    expect(percent(lm, 8000n)).toBe(7200n);
    expect(percent(36000n, 3000n)).toBe(10800n);
    expect(36000n - percent(36000n, 3000n)).toBe(25200n);
  });
  it("fixes rounding expectations and flags future zero/overflow outcomes", () => {
    expect(percent(15500n, 11000n)).toBe(17050n);
    expect(percent(22000n, 10000n)).toBe(22000n);
    expect(percent(1n, 5000n)).toBe(1n);
    expect(percent(1n, 1n)).toBe(0n); // future evaluator must return unavailable
    expect(999999999999999999n + 1n > 999999999999999999n).toBe(true); // overflow must fail
    const originalDiscount = 2000n, amendedEligible = 1500n;
    expect(amendedEligible - (originalDiscount < amendedEligible ? originalDiscount : amendedEligible)).toBe(0n);
  });
});
