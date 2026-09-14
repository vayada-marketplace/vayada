import { describe, expect, it } from "vitest";
import {
  parseAffiliateBookingEvidence as parse,
  matchesAffiliateEvidenceBinding as matches,
  type AffiliateBookingEvidenceObservation,
} from "./affiliateBookingEvidence.js";

const observation = (): AffiliateBookingEvidenceObservation => ({
  contractVersion: "affiliate-booking-evidence.v1",
  sourceEventKey: "r17-revision-4",
  sourceRevision: "4",
  supersedesEventKey: null,
  sourceOccurredAt: "2026-09-08T10:00:00Z",
  retrievedAt: "2026-09-08T10:00:03.12Z",
  booking: { externalPropertyId: "hotel-7", reservationId: "r17", reservationItemId: null },
  facts: { reservationStatus: "confirmed", stayStatus: "unknown" },
  provenance: {
    kind: "authenticated_source_read",
    evidenceReference: "evidence-92",
    originActor: "unknown",
    causedByVayadaCommandId: null,
  },
});
const binding = {
  connectionId: "connection-1",
  organizationId: "org-1",
  propertyId: "property-1",
  externalPropertyId: "hotel-7",
  state: "active" as const,
};
const evidence = { ...binding, evidenceReference: "evidence-92" };

describe("affiliate evidence request", () => {
  it("preserves partial, cleared and unverified facts without inventing attribution", () => {
    const input = observation();
    input.facts = { actualDepartureAt: null, bookingAmount: null, referralCandidates: [] };
    const result = parse(input)!;
    expect(result).toEqual(input);
    expect(result.facts).not.toHaveProperty("stayStatus");
    input.facts.referralCandidates!.push({
      reference: "later",
      method: "source_reservation_field",
    });
    expect(result.facts.referralCandidates).toEqual([]);
    expect(parse({ ...observation(), facts: {} })?.facts).toEqual({});
  });
  it.each(["cancelled", "deleted", "unknown"])(
    "retains %s without inferring stay/refund effects",
    (reservationStatus) => {
      expect(parse({ ...observation(), facts: { reservationStatus } })?.facts).toEqual({
        reservationStatus,
      });
    },
  );
  it("preserves completion assertions and cumulative refunds without qualifying earnings", () => {
    const input = observation();
    input.facts = {
      stayStatus: "completed",
      actualDepartureAt: null,
      refundTotal: { amount: "30.00", currency: "EUR", basis: "accommodation" },
    };
    input.provenance.originActor = "vayada_command";
    input.provenance.causedByVayadaCommandId = "command-1";
    expect(parse(input)).toEqual(input);
  });
  it("rejects version, guest data and claimed internal scope at every object boundary", () => {
    for (const patch of [
      { contractVersion: "v2" },
      { organizationId: "other" },
      { guestEmail: "guest@example.com" },
      { booking: { ...observation().booking, propertyId: "other" } },
      { facts: { attributed: true } },
      { facts: { stayStatus: "paid" } },
      { facts: { reservationStatus: null } },
      { facts: { stayStatus: undefined } },
      { facts: { referralCandidates: [{ reference: "r", method: "field", creatorId: "c" }] } },
      { provenance: { ...observation().provenance, verified: true } },
    ])
      expect(parse({ ...observation(), ...patch })).toBeNull();
  });
  it("requires bounded opaque identities without trimming or coercion", () => {
    for (const sourceEventKey of ["", " ", " r", "r\n", "r\u200b", "x".repeat(257), 17, null])
      expect(parse({ ...observation(), sourceEventKey })).toBeNull();
    expect(parse({ ...observation(), sourceEventKey: "x".repeat(256) })).not.toBeNull();
    const input: Record<string, unknown> = observation();
    delete input.sourceRevision;
    expect(parse(input)).toBeNull();
    expect(parse({ ...observation(), facts: { referralCandidates: Array(1) } })).toBeNull();
    expect(
      parse({
        ...observation(),
        facts: { referralCandidates: Array(33).fill({ reference: "r", method: "field" }) },
      }),
    ).toBeNull();
  });
  it("rejects invalid dates, rollover, non-UTC timestamps and malformed monetary snapshots", () => {
    for (const sourceOccurredAt of [
      "2026-02-30T00:00:00Z",
      "2026-09-08T24:00:00Z",
      "2026-09-08",
      "2026-09-08T10:00:00+02:00",
    ])
      expect(parse({ ...observation(), sourceOccurredAt })).toBeNull();
    for (const scheduledArrival of ["2026-02-29", "2026-13-01", null])
      expect(parse({ ...observation(), facts: { scheduledArrival } })).toBeNull();
    expect(parse({ ...observation(), facts: { scheduledArrival: "2028-02-29" } })).not.toBeNull();
    for (const amount of ["-1", "1e3", "NaN", "00.1", "0.0000001", "1".repeat(19), 30])
      expect(
        parse({
          ...observation(),
          facts: { refundTotal: { amount, currency: "EUR", basis: "accommodation" } },
        }),
      ).toBeNull();
  });
  it("rejects accessors and prototype-backed fields without executing them", () => {
    const input = observation();
    Object.defineProperty(input, "facts", {
      get() {
        throw new Error("not JSON");
      },
    });
    expect(parse(input)).toBeNull();
    expect(parse(Object.create(observation()))).toBeNull();
    expect(parse({ ...observation(), facts: JSON.parse('{"__proto__":{}}') })).toBeNull();
    const candidates = [{}];
    Object.defineProperty(candidates, "0", {
      get() {
        throw new Error("not JSON");
      },
    });
    expect(parse({ ...observation(), facts: { referralCandidates: candidates } })).toBeNull();
  });
});

describe("trusted affiliate evidence binding", () => {
  it("matches only the active connection, internal and external property, and stored reference", () => {
    expect(matches(observation(), binding, evidence)).toBe(true);
    expect(matches(observation(), binding, null)).toBe(false);
    expect(matches(observation(), { ...binding, state: "revoked" }, evidence)).toBe(false);
    for (const key of [
      "connectionId",
      "organizationId",
      "propertyId",
      "externalPropertyId",
      "evidenceReference",
    ])
      expect(matches(observation(), binding, { ...evidence, [key]: "other" })).toBe(false);
    expect(
      matches(observation(), { ...binding, connectionId: "" }, { ...evidence, connectionId: "" }),
    ).toBe(false);
    const input = observation();
    input.booking.externalPropertyId = "other";
    expect(matches(input, binding, evidence)).toBe(false);
  });
});
