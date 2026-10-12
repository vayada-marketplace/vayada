import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiErrorResponse } from "@/services/api/client";
import { firstPricingInput } from "./FirstPricingSetup";
import {
  forgetKeptNewRoomPrices,
  keepNewRoomPrices,
  readKeptNewRoomPrices,
} from "./keptNewRoomPrices";
import { english, PricingError } from "./pricingAmounts";
import { pricingSaveError } from "./savePricing";

const created = "61000000-0000-4000-8000-0000000000bb";
const input = firstPricingInput(
  "property",
  { roomTypeId: created, name: "Suite", capacity: { total: 2, adults: 2, children: 2 } },
  "61000000-0000-4000-8000-0000000000dd",
  {
    mode: "flat",
    occupancy: [],
    included: { adults: "", adjustments: [] },
    methods: ["pay_at_property"],
    room: created,
    currency: "EUR",
    base: "120",
    adultAge: "12",
    childPrice: "0",
    countChildren: "yes",
    minimum: "1",
    maximum: "",
    cancellation: "non_refundable",
    freeDays: "",
    payment: "full",
  },
);
const prices = { room: { ...input.configuration, revision: 4 }, terms: [input.terms] };
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const kept = (error: unknown) => {
  keepNewRoomPrices(prices, error);
  return readKeptNewRoomPrices(created.toUpperCase())!;
};

it("keeps a created room's unsaved prices for its Prices tab, with why they were not saved (VAY-2147)", () => {
  const finance = kept(
    new ApiErrorResponse(403, { code: "denied", reason: "payments_disabled" } as never),
  );
  expect(finance).toMatchObject({ room: prices.room, terms: prices.terms, outcomeUnknown: false });
  expect(pricingSaveError(finance.error, english)).toBe(
    english("pricing.editor.financePaymentsDisabled"),
  );
  // The tab opens on freshly read prices, so a conflict only says someone saved at the same time.
  expect(pricingSaveError(kept(new ApiErrorResponse(409, { code: "stale" })).error, english)).toBe(
    "Someone else saved prices at the same time.",
  );
  expect(
    pricingSaveError(kept(new PricingError("pricing.newRoom.errorChanged")).error, english),
  ).toBe("Someone else saved prices at the same time.");
});

it("marks a save that broke off without an answer, which may have published after all", () => {
  const network = kept(new TypeError("Failed to fetch"));
  expect(network.outcomeUnknown).toBe(true);
  expect(pricingSaveError(network.error, english)).toBe("Failed to fetch");
  expect(kept(new ApiErrorResponse(503, { code: "unavailable" })).outcomeUnknown).toBe(true);
  expect(pricingSaveError(kept(new Error("")).error, english)).toBe(
    english("pricing.editor.errorSaveFailed"),
  );
});

it("reads only recent prices for exactly this room, and forgets them", () => {
  vi.useFakeTimers();
  keepNewRoomPrices(prices, new TypeError("Failed to fetch"));
  expect(readKeptNewRoomPrices("61000000-0000-4000-8000-0000000000cc")).toBeNull();
  vi.advanceTimersByTime(61 * 60 * 1000);
  expect(readKeptNewRoomPrices(created)).toBeNull();
  vi.useRealTimers();
  const key = Array.from(store.keys())[0]!;
  const saved = JSON.parse(store.get(key)!);
  for (const changed of [
    {
      ...saved,
      savedAt: Date.now(),
      prices: { ...saved.prices, room: { ...saved.prices.room, roomTypeId: "other" } },
    },
    {
      ...saved,
      savedAt: Date.now(),
      prices: { ...saved.prices, terms: [{ ...saved.prices.terms[0], roomTypeId: "other" }] },
    },
    {
      ...saved,
      savedAt: Date.now(),
      prices: { ...saved.prices, terms: [{ ...saved.prices.terms[0], offerId: "unknown" }] },
    },
  ]) {
    store.set(key, JSON.stringify(changed));
    expect(readKeptNewRoomPrices(created)).toBeNull();
  }
  store.set(key, "{");
  expect(readKeptNewRoomPrices(created)).toBeNull();
  keepNewRoomPrices(prices, new TypeError("Failed to fetch"));
  forgetKeptNewRoomPrices(created);
  expect(readKeptNewRoomPrices(created)).toBeNull();
});

it("works without storage: nothing is kept and nothing throws", () => {
  vi.stubGlobal("sessionStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  });
  expect(() => keepNewRoomPrices(prices, new Error("x"))).not.toThrow();
  expect(readKeptNewRoomPrices(created)).toBeNull();
  expect(() => forgetKeptNewRoomPrices(created)).not.toThrow();
});
