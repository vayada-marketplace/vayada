import { describe, expect, it } from "vitest";
import { identifyAffiliateEvidenceReplay as identify } from "./affiliateEvidenceReplay.js";
import type { AffiliateBookingEvidenceObservation as Observation } from "./affiliateBookingEvidence.js";

const binding = {
  connectionId: "connection-1",
  organizationId: "org-1",
  propertyId: "property-1",
  externalPropertyId: "external-1",
  state: "active" as const,
};
const evidence = { ...binding, evidenceReference: "proof-1" };
const sample = (): Observation => ({
  contractVersion: "affiliate-booking-evidence.v1",
  sourceEventKey: "event-1",
  sourceRevision: "9",
  supersedesEventKey: null,
  sourceOccurredAt: "2026-09-15T10:00:00Z",
  retrievedAt: "2026-09-15T10:01:00Z",
  booking: { externalPropertyId: "external-1", reservationId: "r-1", reservationItemId: null },
  facts: {
    reservationStatus: "confirmed",
    bookingAmount: { amount: "240.00", currency: "EUR", basis: "gross_booking" },
  },
  provenance: {
    kind: "authenticated_source_read",
    evidenceReference: "proof-1",
    originActor: "source_system",
    causedByVayadaCommandId: null,
  },
});
const replay = (input: unknown) => identify(input, binding, evidence, "adapter-v1")!;

describe("affiliate source-fact replay identity", () => {
  it("pins version-1 encoding so future identity changes require explicit migration", () => {
    expect(replay(sample())).toEqual({
      deliveryKey: "465245ea0176df7cd33e529975f38523852188e284e7a6214d372661e859e863",
      factDigest: "770e5fa8f8a49543d8783b06f662bad5c5955f312acc4a59977327c6c1f6f60c",
    });
  });
  it("normalizes departure and cumulative refunds and isolates external property identity", () => {
    const first = sample();
    first.facts = {
      actualDepartureAt: "2026-09-15T10:00:00Z",
      refundTotal: { amount: "0.000000", currency: "EUR", basis: "accommodation" },
    };
    const second = structuredClone(first);
    second.facts.actualDepartureAt = "2026-09-15T10:00:00.000Z";
    second.facts.refundTotal!.amount = "0";
    expect(replay(second)).toEqual(replay(first));
    second.booking.externalPropertyId = "external-2";
    expect(identify(second, binding, evidence, "adapter-v1")).toBeNull();
    const scoped = identify(
      second,
      { ...binding, externalPropertyId: "external-2" },
      { ...evidence, externalPropertyId: "external-2" },
      "adapter-v1",
    )!;
    expect(scoped.deliveryKey).not.toBe(replay(first).deliveryKey);
    expect(scoped.factDigest).not.toBe(replay(first).factDigest);
  });
  it("recognizes repeated polls with new retrieval/provenance records", () => {
    const first = sample();
    const next = sample();
    next.retrievedAt = "2026-09-15T11:01:00Z";
    next.provenance.evidenceReference = "proof-2";
    next.provenance.originActor = "vayada_command";
    next.provenance.causedByVayadaCommandId = "command-1";
    expect(
      identify(next, binding, { ...evidence, evidenceReference: "proof-2" }, "adapter-v1"),
    ).toEqual(replay(first));
    expect(next.provenance.causedByVayadaCommandId).toBe("command-1");
  });
  it("canonicalizes object order, equivalent UTC and decimal spelling without mutation", () => {
    const first = sample();
    const next = sample();
    next.sourceOccurredAt = "2026-09-15T10:00:00.000Z";
    next.facts = {
      bookingAmount: { basis: "gross_booking", currency: "EUR", amount: "240" },
      reservationStatus: "confirmed",
    };
    expect(replay(first)).toEqual(replay(next));
    expect(first.facts.bookingAmount!.amount).toBe("240.00");
    expect(first.sourceOccurredAt).toBe("2026-09-15T10:00:00Z");
  });
  it("treats changes to facts, revision, occurrence, supersession or mapping as conflicts", () => {
    const first = replay(sample());
    for (const patch of [
      { facts: { reservationStatus: "cancelled" } },
      { sourceRevision: "10" },
      { sourceOccurredAt: null },
      { supersedesEventKey: "event-0" },
    ]) {
      const next = replay({ ...sample(), ...patch });
      expect(next.deliveryKey).toBe(first.deliveryKey);
      expect(next.factDigest).not.toBe(first.factDigest);
    }
    const changed = identify(sample(), binding, evidence, "adapter-v2")!;
    expect(changed.deliveryKey).toBe(first.deliveryKey);
    expect(changed.factDigest).not.toBe(first.factDigest);
  });
  it("keeps absent, null, empty and ordered candidate facts distinct", () => {
    const variants = [
      {},
      { bookingAmount: null },
      { referralCandidates: [] },
      {
        referralCandidates: [
          { reference: "a", method: "field" },
          { reference: "b", method: "field" },
        ],
      },
      {
        referralCandidates: [
          { reference: "b", method: "field" },
          { reference: "a", method: "field" },
        ],
      },
    ];
    expect(new Set(variants.map((facts) => replay({ ...sample(), facts }).factDigest)).size).toBe(
      5,
    );
  });
  it("isolates all source scope dimensions and uses unambiguous structured IDs", () => {
    const base = replay(sample());
    for (const key of ["organizationId", "connectionId", "propertyId"] as const) {
      const scoped = identify(
        sample(),
        { ...binding, [key]: "other" },
        { ...evidence, [key]: "other" },
        "adapter-v1",
      )!;
      expect(scoped.deliveryKey).not.toBe(base.deliveryKey);
      expect(scoped.factDigest).not.toBe(base.factDigest);
    }
    for (const booking of [
      { ...sample().booking, reservationId: "other" },
      { ...sample().booking, reservationItemId: "room-1" },
    ])
      expect(replay({ ...sample(), booking }).deliveryKey).not.toBe(base.deliveryKey);
    const a = {
      ...sample(),
      sourceEventKey: "b:c",
      booking: { ...sample().booking, reservationId: "a" },
    };
    const b = {
      ...sample(),
      sourceEventKey: "c",
      booking: { ...sample().booking, reservationId: "a:b" },
    };
    expect(replay(a).deliveryKey).not.toBe(replay(b).deliveryKey);
    expect(replay({ ...sample(), sourceEventKey: "event-2" }).deliveryKey).not.toBe(
      base.deliveryKey,
    );
  });
  it("fails closed for invalid input, unbound evidence and revoked connections", () => {
    expect(replay({ ...sample(), facts: { guestEmail: "guest@example.com" } })).toBeNull();
    expect(identify(sample(), binding, null, "adapter-v1")).toBeNull();
    expect(identify(sample(), { ...binding, state: "revoked" }, evidence, "adapter-v1")).toBeNull();
    expect(
      identify(sample(), binding, { ...evidence, propertyId: "other" }, "adapter-v1"),
    ).toBeNull();
    for (const version of ["", " adapter-v1", "x".repeat(257), "v\n1"])
      expect(identify(sample(), binding, evidence, version)).toBeNull();
  });
});
