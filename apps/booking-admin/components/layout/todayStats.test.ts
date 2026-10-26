import { expect, it } from "vitest";
import en from "../../messages/en.json";
import { todayStatsMetrics } from "./todayStats";

const t = (key: string, params: Record<string, string | number> = {}) =>
  Object.entries(params).reduce(
    (message, [name, value]) => message.replace(`{${name}}`, String(value)),
    (en as Record<string, string>)[key] ?? key,
  );

it("reads like the ticket: revenue, bookings, page views (VAY-2203)", () => {
  expect(
    todayStatsMetrics({ revenue: 240, bookings: 2, pageViews: 18, currency: "EUR" }, t, "en"),
  ).toEqual(["€240 revenue", "2 bookings", "18 page views"]);
  expect(
    todayStatsMetrics({ revenue: 0, bookings: 0, pageViews: 0, currency: "EUR" }, t, "en"),
  ).toEqual(["€0 revenue", "0 bookings", "0 page views"]);
  expect(
    todayStatsMetrics({ revenue: 90, bookings: 1, pageViews: 1, currency: "EUR" }, t, "en"),
  ).toEqual(["€90 revenue", "1 booking", "1 page view"]);
});

it("shortens large amounts in the property currency", () => {
  // Intl keeps the code and the amount together with a no-break space.
  expect(
    todayStatsMetrics(
      { revenue: 1_200_000, bookings: 14, pageViews: 1204, currency: "IDR" },
      t,
      "en",
    ),
  ).toEqual(["IDR\u00a01.2M revenue", "14 bookings", "1,204 page views"]);
  expect(
    todayStatsMetrics({ revenue: 9_999, bookings: 3, pageViews: 0, currency: "EUR" }, t, "en")[0],
  ).toBe("€9,999 revenue");
});
