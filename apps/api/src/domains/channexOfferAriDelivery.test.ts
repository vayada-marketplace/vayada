import { describe, expect, it } from "vitest";
import {
  CHANNEX_OFFER_ARI_DELIVERY_ENTRY_LIMIT,
  collapseChannexOfferAriValues,
} from "./channexOfferAriDelivery.js";
import {
  channexOfferAriValueSha256,
  type ChannexOfferAriValue,
} from "./channexOfferDesiredAri.js";

const identity = { property_id: "p", rate_plan_id: "r" };
const priced = (date: string, rate = "100.00", stop_sell = false): ChannexOfferAriValue => ({
  ...identity,
  date,
  rates: [
    { occupancy: 1, rate },
    { occupancy: 2, rate: "120.00" },
  ],
  min_stay_arrival: 1,
  min_stay_through: 1,
  max_stay: 0,
  closed_to_arrival: false,
  closed_to_departure: false,
  stop_sell,
});
const closed = (date: string): ChannexOfferAriValue => ({ ...identity, date, stop_sell: true });
const item = (value: ChannexOfferAriValue, isPriced: boolean) => ({
  date: value.date,
  priced: isPriced,
  value,
  valueSha256: channexOfferAriValueSha256(value),
});

describe("ongoing offer ARI range collapsing (VAY-2108 D3)", () => {
  it("merges consecutive equal nights and splits on any change, gap or price shape", () => {
    const entries = collapseChannexOfferAriValues([
      item(priced("2026-11-01"), true),
      item(priced("2026-11-02"), true),
      item(priced("2026-11-03", "150.00"), true),
      item(priced("2026-11-04", "150.00"), true),
      // A gap: the 5th is unchanged and absent from the input.
      item(priced("2026-11-06", "150.00"), true),
      item(closed("2026-11-07"), false),
      item(closed("2026-11-08"), false),
      item(priced("2026-11-09", "150.00", true), true),
    ]);
    expect(entries.map((entry) => [entry.date_from, entry.date_to, "rates" in entry])).toEqual([
      ["2026-11-01", "2026-11-02", true],
      ["2026-11-03", "2026-11-04", true],
      ["2026-11-06", "2026-11-06", true],
      ["2026-11-07", "2026-11-08", false],
      ["2026-11-09", "2026-11-09", true],
    ]);
    // The entry carries the value without its date, nothing else.
    expect(entries[0]).toEqual({
      ...identity,
      rates: [
        { occupancy: 1, rate: "100.00" },
        { occupancy: 2, rate: "120.00" },
      ],
      min_stay_arrival: 1,
      min_stay_through: 1,
      max_stay: 0,
      closed_to_arrival: false,
      closed_to_departure: false,
      stop_sell: false,
      date_from: "2026-11-01",
      date_to: "2026-11-02",
    });
    expect(entries[3]).toEqual({
      ...identity,
      stop_sell: true,
      date_from: "2026-11-07",
      date_to: "2026-11-08",
    });
  });
  it("keeps an unpriced closed night apart from a priced closed night", () => {
    const entries = collapseChannexOfferAriValues([
      item(priced("2026-11-01", "100.00", true), true),
      item(closed("2026-11-02"), false),
    ]);
    expect(entries).toHaveLength(2);
  });
  it("collapses a whole horizon of equal nights into one entry", () => {
    const values = [];
    let date = "2026-11-01";
    for (let i = 0; i < 500; i++) {
      values.push(item(priced(date), true));
      const next = new Date(`${date}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      date = next.toISOString().slice(0, 10);
    }
    const entries = collapseChannexOfferAriValues(values);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ date_from: "2026-11-01", date_to: "2028-03-14" });
    expect(CHANNEX_OFFER_ARI_DELIVERY_ENTRY_LIMIT).toBe(100);
  });
  it("returns nothing for no changes", () => {
    expect(collapseChannexOfferAriValues([])).toEqual([]);
  });
});
