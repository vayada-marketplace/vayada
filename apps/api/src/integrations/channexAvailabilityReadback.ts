import { pricingObject } from "@vayada/domain-pms";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Exact one-room, one-date provider observation. The caller owns persisted
 * request provenance, task completion, current PMS evidence and reconciliation. */
export async function verifyChannexRoomAvailability(
  persistedRequest: unknown,
  get: (method: "GET", path: string) => Promise<unknown>,
) {
  const expected = parseRequest(persistedRequest);
  const query = new URLSearchParams({
    "filter[property_id]": expected.externalPropertyId,
    "filter[date][gte]": expected.date,
    "filter[date][lte]": expected.date,
  });
  const data = availabilityData(await get("GET", `/api/v1/availability?${query}`));
  const dates = data[expected.externalRoomTypeId],
    actual = pricingObject(dates) ? dates[expected.date] : undefined,
    count = exactCount(actual);
  if (count === null || count !== expected.availableCount)
    // VAY-2108: the count Channex showed lets the caller recognise a night its cut-off closed.
    throw Object.assign(new Error("availability_readback_mismatch"), { observedCount: count });
  return { kind: "availability_observed" as const, ...expected };
}

/** VAY-2108: every room's count Channex shows for one date (null when unreadable). Read-only. */
export async function observeChannexAvailabilityDate(
  externalPropertyId: string,
  date: string,
  get: (method: "GET", path: string) => Promise<unknown>,
) {
  if (!uuid.test(externalPropertyId) || !validDate(date))
    throw new Error("availability_request_unavailable");
  const query = new URLSearchParams({
    "filter[property_id]": externalPropertyId,
    "filter[date][gte]": date,
    "filter[date][lte]": date,
  });
  const data = availabilityData(await get("GET", `/api/v1/availability?${query}`));
  return (externalRoomTypeId: string) => {
    const dates = Object.hasOwn(data, externalRoomTypeId) ? data[externalRoomTypeId] : undefined;
    return exactCount(pricingObject(dates) && Object.hasOwn(dates, date) ? dates[date] : undefined);
  };
}

function availabilityData(response: unknown) {
  if (
    !pricingObject(response) ||
    Object.hasOwn(response, "errors") ||
    Object.hasOwn(response, "warnings") ||
    !pricingObject(response.data) ||
    (response.meta !== undefined &&
      (!pricingObject(response.meta) ||
        (response.meta.warnings !== undefined &&
          (!Array.isArray(response.meta.warnings) || response.meta.warnings.length !== 0))))
  )
    throw new Error("availability_readback_unavailable");
  return response.data;
}

function parseRequest(value: unknown) {
  if (
    !pricingObject(value) ||
    !exactKeys(value, ["values"]) ||
    !Array.isArray(value.values) ||
    value.values.length !== 1
  )
    throw new Error("availability_request_unavailable");
  const item = value.values[0];
  if (
    !pricingObject(item) ||
    !exactKeys(item, ["availability", "date_from", "date_to", "property_id", "room_type_id"])
  )
    throw new Error("availability_request_unavailable");
  const { property_id, room_type_id, date_from, date_to, availability } = item;
  if (
    typeof property_id !== "string" ||
    !uuid.test(property_id) ||
    typeof room_type_id !== "string" ||
    !uuid.test(room_type_id) ||
    typeof date_from !== "string" ||
    date_from !== date_to ||
    !validDate(date_from) ||
    exactCount(availability) === null ||
    typeof availability !== "number"
  )
    throw new Error("availability_request_unavailable");
  return {
    externalPropertyId: property_id,
    externalRoomTypeId: room_type_id,
    date: date_from,
    availableCount: availability,
  };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function exactCount(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
