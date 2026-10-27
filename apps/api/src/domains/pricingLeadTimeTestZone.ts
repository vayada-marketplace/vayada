import type { PoolClient } from "pg";

/**
 * VAY-2382: a property time zone in which the database clock reads about noon, with today's date
 * there. Lead-time rules (VAY-2145, VAY-2232) compare the arrival (a property-local date at the
 * hotel's check-in time) with the database clock, so a test that anchors its dates on "today"
 * meets the property's midnight three ways: the day can change between building the dates and
 * the read, an arrival at 00:00 is the notice away to the millisecond at the first instant of a
 * day, and in the last minute of a day no check-in time keeps "a week away at 23:59" true. The
 * product reads "now" from the database, so a test can't freeze it; choosing where the hotel is
 * from the clock keeps its midnight at least 11 hours away instead, without waiting. Whole-hour
 * Etc/GMT zones carry the IANA sign: Etc/GMT-5 is UTC+05:00.
 */
export async function pricingLeadTimeTestZone(
  client: Pick<PoolClient, "query">,
): Promise<{ timeZone: string; today: string; plusDays: (days: number) => string }> {
  const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
  // Noon in the zone falls in the current UTC hour: local time is 12:00 to 12:59.
  const offsetHours = 12 - now.getUTCHours();
  const timeZone =
    offsetHours === 0
      ? "Etc/GMT"
      : offsetHours > 0
        ? `Etc/GMT-${offsetHours}`
        : `Etc/GMT+${-offsetHours}`;
  const today = new Date(now.getTime() + offsetHours * 3_600_000).toISOString().slice(0, 10);
  const plusDays = (days: number) => {
    const date = new Date(`${today}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  return { timeZone, today, plusDays };
}
