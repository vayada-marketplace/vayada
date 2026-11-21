import { pricingObject } from "@vayada/domain-pms";

/** The most dates a Channex cut-off closes beyond its current date (`cut_off_days`, 0-30). */
export const CHANNEX_CUT_OFF_MAX_DAYS = 30;

// Channex moves a property's current date at 02:00 in the property's time zone.
const DATE_CHANGE_SECONDS = 2 * 3600;
const DAY_SECONDS = 24 * 3600;

export type ChannexPropertyCutOff = Readonly<{
  timeZone: string;
  /** Seconds after local midnight, or null when the property has no cut-off. */
  cutOffSeconds: number | null;
  cutOffDays: number;
}>;

/**
 * VAY-2108: a Channex property's cut-off (property settings `cut_off_time` and `cut_off_days`).
 * From the cut-off time on, Channex shows its current date (plus `cut_off_days` more) as 0 and
 * ignores availability updates for those dates, while the update's task still reports success
 * (https://help.channex.io/en/articles/8245601-property-cut-off-feature,
 * https://docs.channex.io/api-v.1-documentation/hotels-collection). The old system set Tiga's to
 * 16:30 and Aether's to 18:00, both for the same day only. Read-only.
 */
export async function readChannexPropertyCutOff(
  externalPropertyId: string,
  get: (method: "GET", path: string) => Promise<unknown>,
): Promise<ChannexPropertyCutOff> {
  const unavailable = (): never => {
    throw new Error("channex_cut_off_unavailable");
  };
  if (
    typeof externalPropertyId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(externalPropertyId)
  )
    unavailable();
  const response = await get("GET", `/api/v1/properties/${externalPropertyId}`);
  if (
    !pricingObject(response) ||
    Object.hasOwn(response, "errors") ||
    Object.hasOwn(response, "warnings") ||
    (response.meta !== undefined &&
      (!pricingObject(response.meta) ||
        (response.meta.warnings !== undefined &&
          (!Array.isArray(response.meta.warnings) || response.meta.warnings.length !== 0))))
  )
    return unavailable();
  const data = response.data;
  if (
    !pricingObject(data) ||
    data.type !== "property" ||
    data.id !== externalPropertyId ||
    !pricingObject(data.attributes)
  )
    return unavailable();
  const { id, timezone, settings } = data.attributes;
  if (
    (id !== undefined && id !== externalPropertyId) ||
    typeof timezone !== "string" ||
    !localClock(timezone, new Date(0)) ||
    !pricingObject(settings)
  )
    return unavailable();
  const time = settings.cut_off_time,
    days = settings.cut_off_days;
  const match =
    typeof time === "string" ? /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(time) : null;
  if (time !== null && time !== undefined && !match) return unavailable();
  if (
    days !== null &&
    days !== undefined &&
    !(
      typeof days === "number" &&
      Number.isSafeInteger(days) &&
      days >= 0 &&
      days <= CHANNEX_CUT_OFF_MAX_DAYS
    )
  )
    return unavailable();
  return {
    timeZone: timezone,
    cutOffSeconds: match
      ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0)
      : null,
    // Without a day count, a set cut-off still closes the current date.
    cutOffDays: typeof days === "number" ? days : 0,
  };
}

/**
 * VAY-2582: a Channex property's time zone, for the hotel profile save (one GET, 5 s at most). A hotel
 * connected to Channex keeps the same time zone as its Channex property, or its sync stops.
 */
export function createChannexPropertyTimeZoneRead(config: {
  apiBaseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}) {
  const request = config.fetch ?? fetch;
  return async (externalPropertyId: string): Promise<string> => {
    const property = await readChannexPropertyCutOff(externalPropertyId, async (_method, path) => {
      const response = await request(new URL(path, config.apiBaseUrl), {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: { "user-api-key": config.apiKey },
      });
      if (!response.ok) throw new Error("channex_time_zone_unavailable");
      return response.json();
    });
    return property.timeZone;
  };
}

/**
 * The Channex dates whose availability the cut-off closes at `now`, or null while it closes none.
 * The cut-off belongs to Channex's current date, which starts at 02:00: a 16:30 cut-off closes that
 * date from 16:30 until 02:00 the next morning, and a 00:00 cut-off from midnight until 02:00.
 */
export function channexCutOffClosedDates(cutOff: ChannexPropertyCutOff, now: Date) {
  if (cutOff.cutOffSeconds === null) return null;
  const local = localClock(cutOff.timeZone, now);
  if (!local) throw new Error("channex_cut_off_unavailable");
  const sinceDateChange = local.seconds - DATE_CHANGE_SECONDS;
  const currentDate = sinceDateChange < 0 ? addDays(local.date, -1) : local.date;
  const cutOffSinceDateChange =
    (cutOff.cutOffSeconds - DATE_CHANGE_SECONDS + DAY_SECONDS) % DAY_SECONDS;
  if ((sinceDateChange + DAY_SECONDS) % DAY_SECONDS < cutOffSinceDateChange) return null;
  return { from: currentDate, through: addDays(currentDate, cutOff.cutOffDays) };
}

export function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function localClock(timeZone: string, now: Date) {
  if (!timeZone || timeZone !== timeZone.trim() || !Number.isFinite(now.getTime())) return null;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        calendar: "iso8601",
        numberingSystem: "latn",
      })
        .formatToParts(now)
        .map(({ type, value }) => [type, value]),
    );
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
    };
  } catch {
    return null;
  }
}
