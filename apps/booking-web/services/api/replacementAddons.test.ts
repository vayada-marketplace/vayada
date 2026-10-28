import { afterEach, expect, it, vi } from "vitest";
import { getReplacementAddons } from "./replacementAddons";
const addon = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Breakfast",
  currency: "EUR",
  pricingModel: "per_guest_night",
  maxQuantity: 1,
  maxGuests: null,
};
const response = (addons: unknown = [addon], version = "public-pricing-addons.v1") =>
  new Response(JSON.stringify({ version, addons }));
afterEach(() => vi.unstubAllGlobals());
it("loads an unpriced catalogue with tenant encoding and no caching", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(response([{ ...addon, private: "ignored", price: 42 }]));
  vi.stubGlobal("fetch", fetcher);
  // An API from before VAY-2391 sends no schedule: a per-night extra is every night.
  expect(await getReplacementAddons("a/b")).toEqual([
    {
      ...addon,
      leadTimeHours: null,
      bookableFrom: null,
      scheduleMode: "daily",
      bookableWeekdays: [1, 2, 3, 4, 5, 6, 7],
    },
  ]);
  expect(fetcher).toHaveBeenCalledWith("/api/booking-web/hotels/a%2Fb/pricing-addons", {
    signal: undefined,
    cache: "no-store",
  });
});
it("rejects unsupported, duplicate and malformed catalogue entries", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  for (const change of [
    { id: "legacy" },
    { name: " " },
    { currency: "FAKE" },
    { pricingModel: "unknown" },
    { maxQuantity: 0 },
    { maxQuantity: 100 },
    { maxQuantity: 1.5 },
    { maxGuests: "2" },
    { maxGuests: 0 },
    { leadTimeHours: 0 },
    { leadTimeHours: "24" },
    { leadTimeHours: 12.5 },
    { bookableFrom: "tomorrow" },
    { bookableFrom: 20261020 },
  ]) {
    fetcher.mockResolvedValueOnce(response([{ ...addon, ...change }]));
    await expect(getReplacementAddons("hotel")).rejects.toThrow("verified");
  }
  for (const bad of [
    response([], "old"),
    response([addon, addon]),
    response(null),
    response(Array(100).fill(addon)),
  ]) {
    fetcher.mockResolvedValueOnce(bad);
    await expect(getReplacementAddons("hotel")).rejects.toThrow("verified");
  }
});
it("keeps an add-on's lead time and first bookable check-in date (VAY-2232)", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockResolvedValueOnce(
    response([{ ...addon, leadTimeHours: 24, bookableFrom: "2026-10-20" }]),
  );
  expect(await getReplacementAddons("hotel")).toMatchObject([
    { leadTimeHours: 24, bookableFrom: "2026-10-20" },
  ]);
  // A known lead time without a date: the hotel's time zone is unknown, so it can't be added.
  fetcher.mockResolvedValueOnce(response([{ ...addon, leadTimeHours: 48, bookableFrom: null }]));
  expect(await getReplacementAddons("hotel")).toMatchObject([
    { leadTimeHours: 48, bookableFrom: null },
  ]);
});
it("keeps when each extra happens and the weekdays a guest can pick (VAY-2391)", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockResolvedValueOnce(
    response([
      { ...addon, pricingModel: "per_stay", scheduleMode: "guest_pick", bookableWeekdays: [5, 6] },
    ]),
  );
  expect(await getReplacementAddons("hotel")).toMatchObject([
    { scheduleMode: "guest_pick", bookableWeekdays: [5, 6] },
  ]);
  // A schedule the page doesn't know leaves out that extra only, not the whole list.
  for (const change of [
    { scheduleMode: "weekly" },
    { scheduleMode: "arrival" },
    { pricingModel: "per_stay", scheduleMode: "daily" },
    { bookableWeekdays: [] },
    { bookableWeekdays: [0] },
    { bookableWeekdays: [3, 1] },
    { bookableWeekdays: [1, 1] },
  ]) {
    const other = { ...addon, id: "22222222-2222-4222-8222-222222222222" };
    fetcher.mockResolvedValueOnce(response([{ ...addon, ...change }, other]));
    expect((await getReplacementAddons("hotel")).map((extra) => extra.id)).toEqual([other.id]);
  }
  // Without the fields, a one-off extra asks the guest for a day, on any weekday.
  fetcher.mockResolvedValueOnce(response([{ ...addon, pricingModel: "per_stay" }]));
  expect(await getReplacementAddons("hotel")).toMatchObject([
    { scheduleMode: "guest_pick", bookableWeekdays: [1, 2, 3, 4, 5, 6, 7] },
  ]);
});
it("preserves all supported pricing-model semantics without inferring people or dates", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  for (const pricingModel of ["per_stay", "per_night", "per_guest", "per_guest_night"]) {
    fetcher.mockResolvedValueOnce(response([{ ...addon, pricingModel }]));
    expect((await getReplacementAddons("hotel"))[0].pricingModel).toBe(pricingModel);
  }
});
it("rejects superseded results even when transport ignores cancellation", async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      controller.abort();
      return response();
    }),
  );
  await expect(getReplacementAddons("hotel", controller.signal)).rejects.toThrow();
});

it("accepts more than 99 distinct configured extras without adding prices or selection defaults", async () => {
  const addons = Array.from({ length: 100 }, (_, index) => ({
    ...addon,
    id: `11111111-1111-4111-8111-${index.toString(16).padStart(12, "0")}`,
  }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(addons)));
  expect(await getReplacementAddons("hotel")).toEqual(
    addons.map((extra) => ({
      ...extra,
      leadTimeHours: null,
      bookableFrom: null,
      scheduleMode: "daily",
      bookableWeekdays: [1, 2, 3, 4, 5, 6, 7],
    })),
  );
});
