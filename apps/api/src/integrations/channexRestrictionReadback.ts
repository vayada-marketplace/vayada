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
  const query = new URLSearchParams({
    "filter[property_id]": scope.externalPropertyId,
    "filter[date]": date,
    "filter[restrictions]": Object.keys(expected).join(","),
  });
  const response = await get("GET", `/api/v1/restrictions?${query}`);
  if (
    !pricingObject(response) ||
    Object.hasOwn(response, "errors") ||
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
