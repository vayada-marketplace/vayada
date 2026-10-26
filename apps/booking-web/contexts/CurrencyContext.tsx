"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { useHotel, useSlug } from "@/contexts/HotelContext";
import { bookingWebPublic } from "@/services/api/client";

export type RateAttribution = { label: string; url: string };

interface CurrencyContextValue {
  selectedCurrency: string;
  setSelectedCurrency: (currency: string) => void;
  /** The hotel currency plus each display currency that has a rate. */
  availableCurrencies: string[];
  rates: Record<string, number>;
  attribution: RateAttribution | null;
  loading: boolean;
  convertPrice: (amount: number, fromCurrency: string) => number;
  /** "≈ US$671" in the guest's display currency, or null when nothing is converted. */
  approximate: (amount: number, fromCurrency: string) => string | null;
  /** The amount in its own (charged) currency, then the approximation in brackets. */
  formatPrice: (amount: number, fromCurrency: string) => string;
}

const CurrencyContext = createContext<CurrencyContextValue>({
  selectedCurrency: "EUR",
  setSelectedCurrency: () => {},
  availableCurrencies: ["EUR"],
  rates: {},
  attribution: null,
  loading: true,
  convertPrice: (amount) => amount,
  approximate: () => null,
  formatPrice: (amount) => String(amount),
});

const STORAGE_KEY_PREFIX = "vayada-selected-currency";

function getStorageKey(slug: string) {
  return `${STORAGE_KEY_PREFIX}-${slug}`;
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const { hotel } = useHotel();
  const { slug } = useSlug();
  const baseCurrency = hotel?.currency || "EUR";
  // With the selector switched off in Design Studio, guests only ever see the hotel currency.
  const displayKey =
    hotel?.headerSettings?.showCurrencySelector === false
      ? ""
      : (hotel?.displayCurrencies ?? []).join(",");

  // Always start with the hotel's base currency so SSR and the first client
  // render agree. The effect below replaces it with the persisted choice once
  // we're definitively on the client and the slug has been resolved.
  const [chosenCurrency, setChosenCurrency] = useState<string>(baseCurrency);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [attribution, setAttribution] = useState<RateAttribution | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!hotel || !slug) return;
    const stored = localStorage.getItem(getStorageKey(slug));
    setChosenCurrency(stored || hotel.currency);
  }, [hotel, slug]);

  // Rates only for this hotel's display currencies; a hotel with one currency asks for none.
  useEffect(() => {
    setRates({});
    setAttribution(null);
    if (!slug || !displayKey.split(",").some((code) => code && code !== baseCurrency)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    bookingWebPublic
      .get<{ base: string; rates: Record<string, unknown>; attribution?: RateAttribution }>(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/exchange-rates`,
      )
      .then((data) => {
        if (cancelled || data.base !== baseCurrency) return;
        setRates(
          Object.fromEntries(
            Object.entries(data.rates ?? {}).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0,
            ),
          ),
        );
        setAttribution(data.attribution?.url?.startsWith("https://") ? data.attribution : null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, baseCurrency, displayKey]);

  const availableCurrencies = useMemo(
    () =>
      Array.from(
        new Set([
          baseCurrency,
          ...displayKey.split(",").filter((code) => code !== baseCurrency && rates[code] > 0),
        ]),
      ),
    [baseCurrency, displayKey, rates],
  );
  // A saved choice the hotel no longer offers, or one without a rate, falls back to the
  // hotel currency, so an amount is never labelled with a currency it was not converted to.
  const selectedCurrency = availableCurrencies.includes(chosenCurrency)
    ? chosenCurrency
    : baseCurrency;

  const setSelectedCurrency = useCallback(
    (currency: string) => {
      setChosenCurrency(currency);
      if (typeof window !== "undefined" && slug) {
        localStorage.setItem(getStorageKey(slug), currency);
      }
    },
    [slug],
  );

  const convertPrice = useCallback(
    (amount: number, fromCurrency: string): number => {
      if (fromCurrency === selectedCurrency) return amount;
      // fromCurrency -> baseCurrency -> selectedCurrency
      let amountInBase = amount;
      if (fromCurrency !== baseCurrency) {
        const fromRate = rates[fromCurrency];
        if (!fromRate) return amount;
        amountInBase = amount / fromRate;
      }
      if (selectedCurrency === baseCurrency) return amountInBase;
      const toRate = rates[selectedCurrency];
      if (!toRate) return amount;
      return amountInBase * toRate;
    },
    [selectedCurrency, baseCurrency, rates],
  );

  // The display currency is only ever an approximation: null when it is the amount's own
  // currency or no rate converts it. Whole units, so it never looks like a charged amount.
  const approximate = useCallback(
    (amount: number, fromCurrency: string): string | null => {
      if (fromCurrency === selectedCurrency) return null;
      if (fromCurrency !== baseCurrency && !rates[fromCurrency]) return null;
      const converted = convertPrice(amount, fromCurrency);
      // Nothing to approximate for zero ("Due now" at the property) or less than one unit.
      if (Math.abs(converted) < 0.5) return null;
      return `≈ ${new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: selectedCurrency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(converted)}`;
    },
    [convertPrice, selectedCurrency, baseCurrency, rates],
  );

  // A booking amount always shows what is charged, in its own currency, then any approximation.
  const formatPrice = useCallback(
    (amount: number, fromCurrency: string): string => {
      const exact = new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: fromCurrency,
        minimumFractionDigits: 0,
      }).format(amount);
      const approx = approximate(amount, fromCurrency);
      return approx ? `${exact} (${approx})` : exact;
    },
    [approximate],
  );

  return (
    <CurrencyContext.Provider
      value={{
        selectedCurrency,
        setSelectedCurrency,
        availableCurrencies,
        rates,
        attribution,
        loading,
        convertPrice,
        approximate,
        formatPrice,
      }}
    >
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency() {
  return useContext(CurrencyContext);
}
