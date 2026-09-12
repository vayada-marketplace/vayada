type Field = { kind: "missing" | "invalid" | "object" } | { kind: "value"; value: string };

/** Pure evidence projection. Caller must bound stream consumption and its deadline.
 * A complete JSON observation is neither accepted creation nor permission to send.
 */
export function sanitizeChannexCreationResponse(input: {
  httpStatus: number;
  providerRequestId?: string | null;
  body: string;
}) {
  if (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)
    throw new Error("Invalid Channex receipt status");
  if (typeof input.body !== "string") throw new Error("Invalid Channex receipt body");
  const requestId = input.providerRequestId;
  const base = {
    httpStatus: input.httpStatus,
    providerRequestId:
      typeof requestId === "string" &&
      requestId.length > 0 &&
      requestId.length <= 512 &&
      !/[^A-Za-z0-9._:-]/.test(requestId)
        ? requestId
        : null,
  };
  if (Buffer.byteLength(input.body, "utf8") > 65536)
    return { ...base, outcome: "body_limit" as const, identityEvidence: {}, hasWarnings: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return { ...base, outcome: "invalid_json" as const, identityEvidence: {}, hasWarnings: true };
  }
  const at = (...path: string[]): unknown => {
    let value = parsed;
    for (const key of path) {
      if (value === undefined) return undefined;
      if (!object(value)) return null;
      value = value[key];
    }
    return value;
  };
  const field = (...path: string[]): Field => {
    const value = at(...path);
    if (value === undefined) return { kind: "missing" };
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value, "utf8") > 512 ||
      /[\u0000-\u001f\u007f]/.test(value) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
    )
      return { kind: "invalid" };
    return { kind: "value", value };
  };
  const container = (...path: string[]): Field => {
    const value = at(...path);
    return { kind: value === undefined ? "missing" : object(value) ? "object" : "invalid" };
  };
  const meta = at("meta"),
    warnings = at("meta", "warnings");
  return {
    ...base,
    outcome: "complete_json" as const,
    identityEvidence: {
      data: container("data"),
      attributes: container("data", "attributes"),
      relationships: container("data", "relationships"),
      type: field("data", "type"),
      rateId: field("data", "id"),
      attributeRateId: field("data", "attributes", "id"),
      propertyId: field("data", "attributes", "property_id"),
      roomId: field("data", "attributes", "room_type_id"),
      propertyRelationship: container("data", "relationships", "property"),
      roomRelationship: container("data", "relationships", "room_type"),
      relatedPropertyId: field("data", "relationships", "property", "data", "id"),
      relatedRoomId: field("data", "relationships", "room_type", "data", "id"),
    },
    hasWarnings:
      (meta !== undefined && !object(meta)) ||
      (warnings !== undefined && (!Array.isArray(warnings) || warnings.length > 0)) ||
      at("warnings") !== undefined ||
      at("errors") !== undefined,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
