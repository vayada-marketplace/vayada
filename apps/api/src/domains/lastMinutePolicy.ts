import { pricingKeys, pricingObject } from "@vayada/domain-pms";
export type LastMinuteTier = {
  daysBeforeMin: number;
  daysBeforeMax: number | null;
  discountPercent: number;
};
export type RoomLastMinutePolicy = { enabled: boolean; tiers: LastMinuteTier[] };
export function lastMinuteBasisPoints(value: unknown): number | null {
  if (typeof value !== "number" || !/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(String(value)))
    return null;
  const [whole, fraction = ""] = String(value).split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return bps <= 10000 ? bps : null;
}
export function parseLastMinuteTiers(value: unknown): LastMinuteTier[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const tiers: LastMinuteTier[] = [];
  for (const t of value) {
    if (
      !pricingObject(t) ||
      !pricingKeys(t, ["daysBeforeMin", "daysBeforeMax", "discountPercent"]) ||
      !Number.isSafeInteger(t.daysBeforeMin) ||
      Number(t.daysBeforeMin) < 0 ||
      !(
        t.daysBeforeMax === null ||
        (Number.isSafeInteger(t.daysBeforeMax) &&
          Number(t.daysBeforeMax) >= Number(t.daysBeforeMin))
      ) ||
      lastMinuteBasisPoints(t.discountPercent) === null
    )
      return null;
    tiers.push({
      daysBeforeMin: t.daysBeforeMin as number,
      daysBeforeMax: t.daysBeforeMax as number | null,
      discountPercent: t.discountPercent as number,
    });
  }
  tiers.sort((a, b) => a.daysBeforeMin - b.daysBeforeMin);
  if (tiers.some((t, i) => i > 0 && t.daysBeforeMin <= (tiers[i - 1].daysBeforeMax ?? Infinity)))
    return null;
  return tiers;
}
/** Explicit inherit is represented by enabled=true and an empty tier table. */
export function parseRoomLastMinutePolicy(value: unknown): RoomLastMinutePolicy | null {
  if (
    !pricingObject(value) ||
    !pricingKeys(value, ["enabled", "tiers"]) ||
    typeof value.enabled !== "boolean"
  )
    return null;
  const tiers = parseLastMinuteTiers(value.tiers);
  return tiers ? { enabled: value.enabled, tiers } : null;
}
