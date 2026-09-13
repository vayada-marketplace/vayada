import { expect, it } from "vitest";
import {
  parseStoredPricingQuote,
  storedPricingQuoteStatus,
  type StoredPricingQuote,
} from "./storedPricingQuote.js";
import { replacementStayKey } from "./replacementPricingEvidence.js";
const roomTypeId = "00000000-0000-4000-8000-000000000001",
  revision = "00000000-0000-4000-8000-000000000002";
function fixture() {
  const stay = {
    propertyId: "hotel",
    checkIn: "2026-10-01",
    checkOut: "2026-10-03",
    currency: "EUR",
    rooms: [
      {
        selectionId: "one",
        roomTypeId,
        offerId: "flex",
        guests: { adults: 2, childAgesAtCheckIn: [8] },
      },
    ],
    addons: [],
    promoCode: null,
  };
  return {
    version: "stored-pricing-quote.v1",
    quoteId: "quote-1",
    evaluatorVersion: "booking.1",
    paymentMethod: "card",
    stay,
    evidence: {
      version: "pricing.v2",
      requestKey: replacementStayKey(stay),
      currency: "EUR",
      revisions: {
        pms: "p1",
        terms: "t1",
        promotions: "pr1",
        addons: "a1",
        charges: "c1",
        finance: "f1",
        fx: "x1",
      },
      issuedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:15:00.000Z",
      lines: [
        { id: "r", selectionId: "one", kind: "room", amountMinor: "30000" },
        { id: "m", selectionId: "one", kind: "meal", amountMinor: "6000" },
      ],
      totalMinor: "36000",
      dueNowMinor: "10800",
      dueLaterMinor: "25200",
      terms: [
        {
          roomTypeId,
          offerId: "flex",
          revision,
          cancellation: { kind: "non_refundable" },
          payment: { kind: "deposit", basisPoints: 3000, balanceDaysBeforeArrival: 7 },
        },
      ],
      fx: [],
      paymentCapabilityEvidenceId: "finance",
      mandatoryChargeEvidenceId: "charges",
    },
    rooms: [
      {
        selectionId: "one",
        configurationRevision: 2,
        termsRevisions: { flex: revision },
        mealPlan: "breakfast",
        nights: ["2026-10-01", "2026-10-02"].map((date) => ({
          date,
          roomMinor: "15000",
          mealMinor: "3000",
          totalMinor: "18000",
          sources: [{ offerId: "flex", kind: "base" }],
        })),
      },
    ],
  } satisfies StoredPricingQuote;
}
const expected = { evaluatorVersion: "booking.1", paymentMethod: "card" };
it("round-trips detached historical evidence and separately rejects expired fresh acceptance", () => {
  const input = fixture(),
    q = parseStoredPricingQuote(JSON.parse(JSON.stringify(input)))!;
  expect(q).toEqual(input);
  input.rooms[0].nights[0].roomMinor = "1";
  expect(q.rooms[0].nights[0].roomMinor).toBe("15000");
  const status = (now: string) =>
    storedPricingQuoteStatus(q, q.stay, q.evidence.revisions, expected, new Date(now));
  expect(status(q.evidence.issuedAt)).toBe("current");
  expect(status(q.evidence.expiresAt)).toBe("stale");
  expect(status("2030-01-01T00:00:00.000Z")).toBe("stale");
  expect(parseStoredPricingQuote(q)).toEqual(q);
  for (const key of Object.keys(q.evidence.revisions))
    expect(
      storedPricingQuoteStatus(
        q,
        q.stay,
        { ...q.evidence.revisions, [key]: "changed" },
        expected,
        new Date(q.evidence.issuedAt),
      ),
    ).toBe("stale");
  for (const change of [{ evaluatorVersion: "booking.2" }, { paymentMethod: "bank" }])
    expect(
      storedPricingQuoteStatus(
        q,
        q.stay,
        q.evidence.revisions,
        { ...expected, ...change },
        new Date(q.evidence.issuedAt),
      ),
    ).toBe("stale");
});
it.each(["JPY", "KWD"])(
  "preserves exact minor strings above JS safe integers for %s",
  (currency) => {
    const q = fixture();
    q.stay.currency = currency;
    q.evidence.currency = currency;
    q.evidence.requestKey = replacementStayKey(q.stay);
    q.rooms[0].nights.forEach((n) => {
      n.roomMinor = "9007199254740993";
      n.mealMinor = "0";
      n.totalMinor = n.roomMinor;
    });
    q.evidence.lines[0].amountMinor = "18014398509481986";
    q.evidence.lines[1].amountMinor = "0";
    q.evidence.totalMinor = "18014398509481986";
    q.evidence.dueNowMinor = "5404319552844596";
    q.evidence.dueLaterMinor = "12610078956637390";
    expect(parseStoredPricingQuote(q)?.evidence.totalMinor).toBe("18014398509481986");
  },
);
it("rejects corrupt stored JSON without throwing or silently repairing it", () => {
  // JSON input deliberately loses static types to exercise the storage boundary.
  const changes = [
    ["version", "unknown"],
    ["evidence", null],
    ["rooms.0.nights", []],
    ["rooms.0.nights.1", fixture().rooms[0].nights[0]],
    ["rooms.0.selectionId", "foreign"],
    ["rooms.0.termsRevisions.flex", "other"],
    ["rooms.0.nights.0.sources", []],
    ["rooms.0.nights.0.sources.0.offerId", "other"],
    ["rooms.0.nights.0.totalMinor", "18001"],
    ["rooms.0.mealPlan", ""],
    ["rooms.0.mealPlan", "unknown"],
    ["rooms.0.mealPlan", "room_only"],
    ["evidence.lines.0.amountMinor", 30000],
    ["evidence.lines.0.kind", ["room"]],
    ["evidence.lines.0.amountMinor", "1000000000000000000"],
    ["evidence.dueLaterMinor", "25201"],
    ["evidence.lines", [null]],
    ["evidence.terms", [null]],
    ["evidence.fx", [null]],
    ["evidence.requestKey", "0".repeat(64)],
    ["evidence.issuedAt", "yesterday"],
    ["evidence.revisions.charges", undefined],
    ["evidence.terms.0.payment", null],
  ] as const;
  for (const [path, value] of changes) {
    const q = JSON.parse(JSON.stringify(fixture())),
      keys = path.split("."),
      last = keys.pop()!;
    const target = keys.reduce((object, key) => object[key], q);
    target[last] = value;
    expect(parseStoredPricingQuote(q), path).toBeNull();
  }
});
it("requires complete evidence for both allocated rooms even when they share an offer", () => {
  const q = fixture();
  q.stay.rooms.push({
    ...q.stay.rooms[0],
    selectionId: "two",
    guests: { adults: 1, childAgesAtCheckIn: [] },
  });
  q.rooms.push({ ...structuredClone(q.rooms[0]), selectionId: "two" });
  q.evidence.lines.push(
    ...q.evidence.lines.map((l) => ({ ...l, id: l.id + "2", selectionId: "two" })),
  );
  q.evidence.requestKey = replacementStayKey(q.stay);
  q.evidence.totalMinor = "72000";
  q.evidence.dueNowMinor = "21600";
  q.evidence.dueLaterMinor = "50400";
  expect(parseStoredPricingQuote(q)).not.toBeNull();
  q.rooms[1].nights[0].roomMinor = "16000";
  q.rooms[1].nights[0].mealMinor = "2000";
  expect(parseStoredPricingQuote(q)).toBeNull();
});
