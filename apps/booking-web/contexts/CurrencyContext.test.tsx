/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CurrencyProvider, useCurrency } from "./CurrencyContext";
const hotel = {
  currency: "EUR",
  displayCurrencies: ["EUR", "USD", "JPY"],
  headerSettings: { showCurrencySelector: true },
};
const get = vi.fn();
vi.mock("@/contexts/HotelContext", () => ({
  useHotel: () => ({ hotel }),
  useSlug: () => ({ slug: "currency-test" }),
}));
vi.mock("@/services/api/client", () => ({
  bookingWebPublic: { get: (path: string) => get(path) },
}));
const rates = { base: "EUR", rates: { USD: 1.1, JPY: 160 } };

async function renderCurrency(stored: string | null = null) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => stored, setItem: vi.fn() });
  const container = document.createElement("div");
  const root = createRoot(container);
  const probe: { current?: ReturnType<typeof useCurrency> } = {};
  function Probe() {
    probe.current = useCurrency();
    return null;
  }
  await act(async () => root.render(createElement(CurrencyProvider, null, createElement(Probe))));
  return { currency: () => probe.current!, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  hotel.displayCurrencies = ["EUR", "USD", "JPY"];
  hotel.headerSettings.showCurrencySelector = true;
  get.mockReset();
  vi.unstubAllGlobals();
});

it("shows the charged amount with cents first and the conversion as approximate", async () => {
  get.mockResolvedValue(rates);
  const { currency, unmount } = await renderCurrency();
  expect(get).toHaveBeenCalledWith("/api/booking-web/hotels/currency-test/exchange-rates");
  expect(currency().availableCurrencies).toEqual(["EUR", "USD", "JPY"]);
  expect(currency().formatPrice(610.25, "EUR")).toBe("€610.25");
  expect(currency().formatPrice(600, "EUR")).toBe("€600");
  expect(currency().approximate(610.25, "EUR")).toBeNull();
  act(() => currency().setSelectedCurrency("USD"));
  expect(currency().formatPrice(610.25, "EUR")).toBe("€610.25 (≈ US$671)");
  expect(currency().approximate(610.25, "EUR")).toBe("≈ US$671");
  act(() => currency().setSelectedCurrency("JPY"));
  expect(currency().formatPrice(10.25, "EUR")).toBe("€10.25 (≈ JP¥1,640)");
  unmount();
});

it("converts another booking currency through the hotel currency, never a zero amount", async () => {
  get.mockResolvedValue(rates);
  const { currency, unmount } = await renderCurrency();
  expect(currency().formatPrice(110, "USD")).toBe("US$110 (≈ €100)");
  act(() => currency().setSelectedCurrency("USD"));
  expect(currency().formatPrice(0, "EUR")).toBe("€0");
  expect(currency().approximate(0.3, "EUR")).toBeNull();
  unmount();
});

it("never converts an amount in a currency without a rate", async () => {
  get.mockResolvedValue(rates);
  const { currency, unmount } = await renderCurrency("USD");
  expect(currency().selectedCurrency).toBe("USD");
  expect(currency().formatPrice(120, "GBP")).toBe("£120");
  expect(currency().approximate(120, "GBP")).toBeNull();
  expect(currency().formatPrice(110, "USD")).toBe("US$110");
  unmount();
});

it("ignores a saved currency the hotel no longer offers", async () => {
  get.mockResolvedValue(rates);
  hotel.displayCurrencies = ["EUR", "USD"];
  const { currency, unmount } = await renderCurrency("JPY");
  expect(currency().selectedCurrency).toBe("EUR");
  expect(currency().availableCurrencies).toEqual(["EUR", "USD"]);
  expect(currency().formatPrice(610.25, "EUR")).toBe("€610.25");
  unmount();
});

it("keeps the hotel currency and hides other currencies when rates are missing", async () => {
  get.mockRejectedValue(new Error("offline"));
  const { currency, unmount } = await renderCurrency("USD");
  expect(currency().selectedCurrency).toBe("EUR");
  expect(currency().availableCurrencies).toEqual(["EUR"]);
  expect(currency().formatPrice(610.25, "EUR")).toBe("€610.25");
  unmount();
});

it("asks for no rates when the hotel offers only its own currency", async () => {
  hotel.displayCurrencies = ["EUR"];
  const { currency, unmount } = await renderCurrency("USD");
  expect(get).not.toHaveBeenCalled();
  expect(currency().selectedCurrency).toBe("EUR");
  expect(currency().loading).toBe(false);
  unmount();
});

it("keeps the hotel currency when the hotel switched the selector off", async () => {
  hotel.headerSettings.showCurrencySelector = false;
  const { currency, unmount } = await renderCurrency("USD");
  expect(get).not.toHaveBeenCalled();
  expect(currency().selectedCurrency).toBe("EUR");
  expect(currency().availableCurrencies).toEqual(["EUR"]);
  unmount();
});
