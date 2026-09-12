import { describe, expect, it } from "vitest";
import { sanitizeChannexCreationResponse as sanitize } from "./channexCreationReceipt.js";

const project = (data: unknown, extra = {}) =>
  sanitize({
    httpStatus: 201,
    providerRequestId: "request-1",
    body: JSON.stringify({ data, ...extra }),
  });
describe("Channex creation receipt projection", () => {
  it("retains exact contradictory identities but excludes unrelated response content", () => {
    const result = project(
      {
        type: "rate_plan",
        id: "rate",
        attributes: {
          id: "different",
          property_id: " property ",
          room_type_id: "room",
          secret: "omit-me",
        },
        relationships: {
          property: { data: { id: "other-property" } },
          room_type: { data: { id: "other-room" } },
        },
      },
      { debug: "omit-me", meta: { warnings: [{ message: "omit-me" }] } },
    );
    expect(result.identityEvidence).toMatchObject({
      rateId: { kind: "value", value: "rate" },
      attributeRateId: { kind: "value", value: "different" },
      propertyId: { kind: "value", value: " property " },
      relatedPropertyId: { kind: "value", value: "other-property" },
      relatedRoomId: { kind: "value", value: "other-room" },
    });
    expect(result.hasWarnings).toBe(true);
    expect(JSON.stringify(result)).not.toContain("omit-me");
    expect(result.providerRequestId).toBe("request-1");
  });
  it("keeps missing fields distinct from invalid containers and relationship-only identities", () => {
    expect(
      project({ id: "r", relationships: { property: { data: { id: "p" } } } }).identityEvidence,
    ).toMatchObject({
      attributes: { kind: "missing" },
      propertyId: { kind: "missing" },
      relatedPropertyId: { kind: "value", value: "p" },
    });
    expect(
      project({ attributes: [], relationships: { property: null } }).identityEvidence,
    ).toMatchObject({
      attributes: { kind: "invalid" },
      propertyId: { kind: "invalid" },
      propertyRelationship: { kind: "invalid" },
    });
    expect(project(null).identityEvidence).toMatchObject({
      data: { kind: "invalid" },
      rateId: { kind: "invalid" },
    });
  });
  it("bounds UTF-8 identity bytes without truncation or coercion", () => {
    expect(project({ id: "é".repeat(256) }).identityEvidence).toMatchObject({
      rateId: { kind: "value", value: "é".repeat(256) },
    });
    for (const id of ["é".repeat(257), 1, null, "", "bad\nvalue"])
      expect(project({ id }).identityEvidence).toMatchObject({ rateId: { kind: "invalid" } });
  });
  it("marks unpaired Unicode surrogates invalid for PostgreSQL JSONB", () => {
    for (const id of ["\ud800", "\udfff", "x\ud800y", "\ud800\ud800"])
      expect(project({ id }).identityEvidence).toMatchObject({ rateId: { kind: "invalid" } });
    expect(project({ id: "😀" }).identityEvidence).toMatchObject({
      rateId: { kind: "value", value: "😀" },
    });
  });
  it("caps text before parsing and keeps malformed text out of evidence", () => {
    expect(sanitize({ httpStatus: 502, body: "private error" })).toMatchObject({
      outcome: "invalid_json",
      identityEvidence: {},
      hasWarnings: true,
    });
    const body = JSON.stringify({ data: { id: "r" } });
    expect(sanitize({ httpStatus: 201, body: body.padEnd(65536) }).outcome).toBe("complete_json");
    expect(sanitize({ httpStatus: 201, body: body.padEnd(65537) }).outcome).toBe("body_limit");
    expect(sanitize({ httpStatus: 201, body: "é".repeat(32769) }).outcome).toBe("body_limit");
  });
  it("allowlists request IDs and never equates JSON parsing with HTTP success", () => {
    for (const providerRequestId of [
      "Bearer secret",
      "request\n",
      "https://host/?key=secret",
      "x".repeat(513),
      "é",
    ])
      expect(sanitize({ httpStatus: 500, body: "{}", providerRequestId })).toMatchObject({
        httpStatus: 500,
        outcome: "complete_json",
        providerRequestId: null,
      });
    expect(
      sanitize({ httpStatus: 201, body: "{}", providerRequestId: "x".repeat(512) })
        .providerRequestId,
    ).toHaveLength(512);
    expect(() => sanitize({ httpStatus: NaN, body: "{}" })).toThrow(
      "Invalid Channex receipt status",
    );
  });
  it("keeps warning and error payloads only as conservative markers", () => {
    expect(project({}, { meta: { warnings: [] } }).hasWarnings).toBe(false);
    for (const extra of [
      { meta: null },
      { meta: { warnings: null } },
      { meta: { warnings: [1] } },
      { warnings: [] },
      { errors: { secret: 1 } },
    ])
      expect(project({}, extra).hasWarnings).toBe(true);
  });
  it("fits the storage limit even when all retained strings require JSON escaping", () => {
    const id = '"'.repeat(512);
    const result = project({
      type: id,
      id,
      attributes: { id, property_id: id, room_type_id: id },
      relationships: { property: { data: { id } }, room_type: { data: { id } } },
    });
    expect(Buffer.byteLength(JSON.stringify(result.identityEvidence))).toBeLessThanOrEqual(8192);
  });
});
