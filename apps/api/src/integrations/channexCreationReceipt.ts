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

/** Headers have already arrived. The dispatcher must separately bound fetch itself. */
export async function readChannexCreationResponse(response: Response) {
  const metadata = {
    httpStatus: response.status,
    providerRequestId: response.headers.get("x-request-id"),
  };
  const empty = sanitizeChannexCreationResponse({ ...metadata, body: "" });
  const interrupted = { ...empty, outcome: "body_interrupted" as const };
  if (response.bodyUsed || response.body?.locked) return interrupted;
  if (!response.body) return empty;
  const reader = response.body.getReader();
  const expiresAt = performance.now() + 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = Symbol("expired");
  const deadline = new Promise<typeof expired>((resolve) => {
    timer = setTimeout(() => resolve(expired), 5000);
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  const consume = async () => {
    while (true) {
      if (performance.now() >= expiresAt) return interrupted;
      const chunk = await reader.read();
      if (performance.now() >= expiresAt) return interrupted;
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65536) return { ...empty, outcome: "body_limit" as const };
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return sanitizeChannexCreationResponse({ ...metadata, body });
  };
  try {
    const result = await Promise.race([consume(), deadline]);
    return result === expired ? interrupted : result;
  } catch {
    return interrupted;
  } finally {
    clearTimeout(timer);
    // Cancellation is best-effort: a stalled source must not extend the deadline.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
