import { pricingObject, type RoomNightProjectionRequest } from "@vayada/domain-pms";
import { prepareChannexAdultNightPrices } from "./channexNightlyPrices.js";

/** One date's stored restriction values only, not OTA semantics, rate/room identity
 * ownership, delivery acknowledgement or activation permission. The caller must
 * supply a bounded authenticated GET port and recheck current authority afterward.
 * https://docs.channex.io/api-v.1-documentation/ari
 */
export async function verifyChannexNightRestrictions(
  configuration: unknown,
  request: Omit<RoomNightProjectionRequest, "guests">,
  identity: Readonly<{ externalPropertyId: string; externalRatePlanId: string }>,
  get: (method: "GET", path: string) => Promise<unknown>,
) {
  const scope = { ...identity };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    ![scope.externalPropertyId, scope.externalRatePlanId].every(
      (id) => typeof id === "string" && uuid.test(id),
    )
  )
    throw new Error("restriction_scope_unavailable");
  const prepared = prepareChannexAdultNightPrices(configuration, request);
  if (prepared.kind !== "prepared") throw new Error(prepared.reason);
  const { projection, restrictionCandidate } = prepared.candidates[0];
  const expected = { ...restrictionCandidate };
  const date = projection.night.date;
  await readRestrictions(scope, date, expected, get);
  return {
    kind: "observed" as const,
    ...scope,
    propertyId: projection.propertyId,
    roomTypeId: projection.roomTypeId,
    offerId: projection.offerId,
    publicationRevision: projection.revision,
    restrictionOfferId: projection.night.restrictionOfferId,
    date,
    restrictions: expected,
  };
}

/** A stored restriction observation only. The owning service must load the
 * immutable request and fence authority/history; this is never completion proof. */
export async function verifyChannexStagedNightRestrictions(
  persistedRequest: unknown,
  get: (method: "GET", path: string) => Promise<unknown>,
) {
  if (
    !pricingObject(persistedRequest) ||
    !Array.isArray(persistedRequest.values) ||
    persistedRequest.values.length !== 1
  )
    throw new Error("staged_restriction_request_unavailable");
  const value = persistedRequest.values[0];
  if (!pricingObject(value)) throw new Error("staged_restriction_request_unavailable");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const { property_id, rate_plan_id, date } = value;
  if (
    typeof property_id !== "string" ||
    !uuid.test(property_id) ||
    typeof rate_plan_id !== "string" ||
    !uuid.test(rate_plan_id) ||
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new Error("staged_restriction_request_unavailable");
  const expected = {
    min_stay_arrival: value.min_stay_arrival,
    min_stay_through: value.min_stay_through,
    max_stay: value.max_stay,
    closed_to_arrival: value.closed_to_arrival,
    closed_to_departure: value.closed_to_departure,
    stop_sell: value.stop_sell,
  };
  if (
    ![expected.min_stay_arrival, expected.min_stay_through].every(
      (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0,
    ) ||
    typeof expected.max_stay !== "number" ||
    !Number.isSafeInteger(expected.max_stay) ||
    expected.max_stay < 0 ||
    typeof expected.closed_to_arrival !== "boolean" ||
    typeof expected.closed_to_departure !== "boolean" ||
    expected.stop_sell !== true
  )
    throw new Error("staged_restriction_request_unavailable");
  const scope = { externalPropertyId: property_id, externalRatePlanId: rate_plan_id };
  await readRestrictions(scope, date, expected, get);
  return { kind: "restrictions_observed" as const, ...scope, date, restrictions: expected };
}

async function readRestrictions(
  scope: { externalPropertyId: string; externalRatePlanId: string },
  date: string,
  expected: Record<string, unknown>,
  get: (method: "GET", path: string) => Promise<unknown>,
) {
  const query = new URLSearchParams({
    "filter[property_id]": scope.externalPropertyId,
    "filter[date]": date,
    "filter[restrictions]": Object.keys(expected).join(","),
  });
  const response = await get("GET", `/api/v1/restrictions?${query}`);
  if (
    !pricingObject(response) ||
    Object.hasOwn(response, "errors") ||
    Object.hasOwn(response, "warnings") ||
    !pricingObject(response.data)
  )
    throw new Error("restriction_readback_unavailable");
  if (
    response.meta !== undefined &&
    (!pricingObject(response.meta) ||
      (response.meta.warnings !== undefined &&
        (!Array.isArray(response.meta.warnings) || response.meta.warnings.length !== 0)))
  )
    throw new Error("restriction_readback_unavailable");
  const rates = response.data;
  const dates = Object.hasOwn(rates, scope.externalRatePlanId)
    ? rates[scope.externalRatePlanId]
    : null;
  const actual = pricingObject(dates) && Object.hasOwn(dates, date) ? dates[date] : null;
  if (
    !pricingObject(actual) ||
    Object.entries(expected).some(
      ([key, value]) => !Object.hasOwn(actual, key) || actual[key] !== value,
    )
  )
    throw new Error("restriction_readback_mismatch");
}
