import { expect, it } from "vitest";
import { matchesChannexCreationReceipt as matches } from "./channexCreationReceiptGate.js";
import { sanitizeChannexCreationResponse as sanitize } from "../integrations/channexCreationReceipt.js";

it("accepts exact direct/relationship identity and rejects partial, warning or conflicting evidence", () => {
  const expected = {
    externalPropertyId: "p",
    externalRoomTypeId: "room",
    externalRatePlanId: "rate",
  };
  for (const data of [
    { type: "rate_plan", id: "rate", attributes: { property_id: "p", room_type_id: "room" } },
    {
      type: "rate_plan",
      id: "rate",
      relationships: { property: { data: { id: "p" } }, room_type: { data: { id: "room" } } },
    },
  ]) {
    const evidence = sanitize({ httpStatus: 201, body: JSON.stringify({ data }) }).identityEvidence;
    const row = {
      outcome: "complete_json",
      http_status: 201,
      has_warnings: false,
      identity_evidence: evidence,
    };
    expect(matches(row, expected)).toBe(true);
    for (const change of [
      { http_status: 200 },
      { has_warnings: true },
      { outcome: "body_interrupted" },
      { identity_evidence: {} },
      { identity_evidence: null },
    ])
      expect(matches({ ...row, ...change }, expected)).toBe(false);
    expect(matches(row, { ...expected, externalRatePlanId: "other" })).toBe(false);
    expect(
      matches(
        { ...row, identity_evidence: { ...evidence, rateId: { kind: "invalid" } } },
        expected,
      ),
    ).toBe(false);
  }
});
