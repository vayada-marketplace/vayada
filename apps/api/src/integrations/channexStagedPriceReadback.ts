import { isDeepStrictEqual } from "node:util";
import { pricingObject, pricingDate } from "@vayada/domain-pms";
import { verifyChannexOfferConfiguration } from "./channexOfferConfiguration.js";

/** All current guest totals for one immutable staged night; never upload execution
 * or activation proof. Caller owns request provenance, aggregate IO bounds and
 * before/after authority/history checks. All provider operations are read-only. */
export async function verifyChannexStagedNightPrices(
  room: unknown,
  offerId: string,
  primaryOccupancy: number,
  identity: { externalPropertyId: string; externalRoomTypeId: string; externalRatePlanId: string },
  persistedRequest: unknown,
  get: (method: "GET", path: string) => Promise<unknown>,
) {
  const unavailable = () => {
    throw new Error("staged_price_readback_unavailable");
  };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const scope = { ...identity },
    configuration = structuredClone(room),
    request = structuredClone(persistedRequest);
  if (
    ![scope.externalPropertyId, scope.externalRoomTypeId, scope.externalRatePlanId].every(
      (id) => typeof id === "string" && uuid.test(id),
    ) ||
    !pricingObject(request) ||
    !Array.isArray(request.values) ||
    request.values.length !== 1
  )
    return unavailable();
  const value = request.values[0];
  if (
    !pricingObject(value) ||
    value.property_id !== scope.externalPropertyId ||
    value.rate_plan_id !== scope.externalRatePlanId ||
    !pricingDate(value.date) ||
    value.date_from !== undefined ||
    value.date_to !== undefined ||
    value.days !== undefined ||
    value.rate !== undefined ||
    value.stop_sell !== true ||
    !Array.isArray(value.rates) ||
    value.rates.length < 1 ||
    value.rates.length > 100
  )
    return unavailable();
  const date = value.date,
    expected = new Map<number, string>();
  for (const rate of value.rates) {
    if (
      !pricingObject(rate) ||
      typeof rate.occupancy !== "number" ||
      !Number.isSafeInteger(rate.occupancy) ||
      rate.occupancy < 1 ||
      expected.has(rate.occupancy) ||
      typeof rate.rate !== "string" ||
      !/^(0|[1-9]\d*)(\.\d{1,3})?$/.test(rate.rate) ||
      !/[1-9]/.test(rate.rate)
    )
      return unavailable();
    expected.set(rate.occupancy, rate.rate);
  }
  async function optionIds() {
    let options: unknown;
    const observation = await verifyChannexOfferConfiguration(
      configuration,
      offerId,
      primaryOccupancy,
      scope,
      async (method, path) => {
        const response = cleanResponse(structuredClone(await get(method, path)));
        if (
          path === `/api/v1/rate_plans/${scope.externalRatePlanId}` &&
          pricingObject(response) &&
          pricingObject(response.data) &&
          pricingObject(response.data.attributes)
        )
          options = structuredClone(response.data.attributes.options);
        return response;
      },
    );
    if (observation.configuration.options.length !== expected.size || !Array.isArray(options))
      return unavailable();
    const ids = new Set<string>(),
      result: { occupancy: number; ratePlanId: string; rate: string }[] = [];
    for (const option of options) {
      if (
        !pricingObject(option) ||
        typeof option.occupancy !== "number" ||
        !expected.has(option.occupancy) ||
        typeof option.id !== "string" ||
        !uuid.test(option.id) ||
        ids.has(option.id) ||
        (option.is_primary === true) !== (option.id === scope.externalRatePlanId)
      )
        return unavailable();
      ids.add(option.id);
      result.push({
        occupancy: option.occupancy,
        ratePlanId: option.id,
        rate: expected.get(option.occupancy)!,
      });
    }
    return result.sort((a, b) => a.occupancy - b.occupancy);
  }
  const before = await optionIds();
  for (const option of before) {
    const query = new URLSearchParams({
      "filter[property_id]": scope.externalPropertyId,
      "filter[rate_plan_id]": option.ratePlanId,
      "filter[date]": date,
      "filter[restrictions]": "rate,stop_sell",
    });
    const response = cleanResponse(await get("GET", `/api/v1/restrictions?${query}`));
    if (!pricingObject(response.data)) return unavailable();
    const dates = response.data[option.ratePlanId],
      actual = pricingObject(dates) ? dates[date] : undefined;
    if (!pricingObject(actual) || actual.rate !== option.rate || actual.stop_sell !== true)
      return unavailable();
  }
  if (!isDeepStrictEqual(before, await optionIds())) return unavailable();
  return { kind: "prices_observed" as const, ...scope, date, prices: before };
}

function cleanResponse(response: unknown) {
  if (
    !pricingObject(response) ||
    Object.hasOwn(response, "errors") ||
    Object.hasOwn(response, "warnings") ||
    (response.meta !== undefined &&
      (!pricingObject(response.meta) ||
        (response.meta.warnings !== undefined && !isDeepStrictEqual(response.meta.warnings, []))))
  )
    throw new Error("staged_price_readback_unavailable");
  return response;
}
