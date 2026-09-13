import { expect, it } from "vitest";
import { parseStoredReplacementEvidence } from "./storedReplacementEvidence.js";
const fixture = () => ({
  version: "pricing.v2",
  requestKey: "a".repeat(64),
  currency: "KWD",
  revisions: {
    pms: "p",
    terms: "t",
    promotions: "pr",
    addons: "a",
    charges: "c",
    finance: "f",
    fx: "x",
  },
  issuedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-09-01T00:15:00.000Z",
  lines: [{ id: "room", selectionId: "one", kind: "room", amountMinor: "9007199254740993" }],
  totalMinor: "9007199254740993",
  dueNowMinor: "9007199254740993",
  dueLaterMinor: "0",
  terms: [
    {
      roomTypeId: "00000000-0000-4000-8000-000000000001",
      offerId: "flex",
      revision: "00000000-0000-4000-8000-000000000002",
      cancellation: { kind: "non_refundable" },
      payment: { kind: "full" },
    },
  ],
  fx: [],
  paymentCapabilityEvidenceId: "finance",
  mandatoryChargeEvidenceId: "charges",
});
it("decodes exact money and complete policy/revision fields without monetary Number conversion", () => {
  expect(parseStoredReplacementEvidence(JSON.parse(JSON.stringify(fixture())))).toEqual(fixture());
});
it("rejects malformed nested fields, unknown versions and unsafe monetary encodings", () => {
  for (const change of [
    { version: "pricing.v1" },
    { unexpected: true },
    { currency: "ZZZ" },
    { revisions: {} },
    { terms: [null] },
    { fx: [null] },
    { lines: [null] },
    { lines: new Array(1) },
    { issuedAt: "yesterday" },
    ...[9007199254740992, "1.1", "01", "-1", "1000000000000000000"].map((totalMinor) => ({
      totalMinor,
    })),
  ]) {
    expect(parseStoredReplacementEvidence({ ...fixture(), ...change })).toBeNull();
  }
});
