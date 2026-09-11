import {
  parsePricingConfiguration,
  pricingCurrencyScale,
  projectReplacementRoomNight,
  type RoomNightProjectionRequest,
  type RoomNightProjectionResult,
} from "@vayada/domain-pms";

type Projection = Extract<RoomNightProjectionResult, { kind: "projected" }>;
export type ChannexAdultNightPrices =
  | Extract<RoomNightProjectionResult, { kind: "unavailable" }>
  | Readonly<{ kind: "unavailable"; reason: "candidate_limit" }>
  | Readonly<{
      kind: "prepared";
      candidates: readonly Readonly<{
        occupancy: number;
        rate: string;
        projection: Projection;
      }>[];
    }>;

/** Internal candidates only: no provider mapping, child representation or write readiness.
 * Owner revisions must be trusted. Native channel adjustments are applied elsewhere.
 */
export function prepareChannexAdultNightPrices(
  configuration: unknown,
  request: Omit<RoomNightProjectionRequest, "guests">,
): ChannexAdultNightPrices {
  const config = parsePricingConfiguration(configuration);
  if (!config) return { kind: "unavailable", reason: "invalid_configuration" };
  const candidates: Array<{ occupancy: number; rate: string; projection: Projection }> = [];
  const capacity = config.capacity.adults;
  // Bound local work, not provider capability; never truncate the occupancy set.
  if (capacity > 100) return { kind: "unavailable", reason: "candidate_limit" };
  for (let occupancy = 1; occupancy <= capacity; occupancy++) {
    const projection = projectReplacementRoomNight(config, {
      ...request,
      guests: { adults: occupancy, childAgesAtCheckIn: [] },
    });
    if (projection.kind === "unavailable") return projection;
    // The calculator validates currency and returns canonical integer strings.
    const scale = pricingCurrencyScale(projection.currency)!;
    const digits = projection.night.totalMinor.padStart(scale + 1, "0");
    const rate = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
    candidates.push({ occupancy, rate, projection });
  }
  return { kind: "prepared", candidates };
}
