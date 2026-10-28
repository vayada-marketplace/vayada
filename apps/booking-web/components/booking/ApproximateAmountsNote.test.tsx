/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import { CurrencyProvider } from "@/contexts/CurrencyContext";
import ApproximateAmountsNote from "./ApproximateAmountsNote";

// A hotel priced in LKR and shown to guests in US dollars first (VAY-2390).
const hotel = {
  currency: "LKR",
  displayCurrencies: ["LKR", "USD"],
  displayDefaultCurrency: "USD",
  headerSettings: { showCurrencySelector: true },
};
const get = vi.fn();
vi.mock("@/contexts/HotelContext", () => ({
  useHotel: () => ({ hotel }),
  useSlug: () => ({ slug: "note-test" }),
}));
vi.mock("@/services/api/client", () => ({
  bookingWebPublic: { get: (path: string) => get(path) },
}));

async function renderNote(stored: string | null) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => stored, setItem: vi.fn() });
  get.mockResolvedValue({ base: "LKR", rates: { USD: 0.0033 } });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale: "en",
        messages: en,
        children: createElement(
          CurrencyProvider,
          null,
          createElement(ApproximateAmountsNote, { currency: "LKR" }),
        ),
      }),
    ),
  );
  return { text: container.textContent, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  get.mockReset();
  vi.unstubAllGlobals();
});

it("explains ≈ amounts for a currency worth far less than the guest's (VAY-2390)", async () => {
  const { text, unmount } = await renderNote(null);
  expect(text).toBe("We charge in LKR. Amounts marked ≈ are approximate conversions.");
  unmount();
});

it("says nothing while the guest sees the hotel's own currency", async () => {
  const { text, unmount } = await renderNote("LKR");
  expect(text).toBe("");
  unmount();
});
