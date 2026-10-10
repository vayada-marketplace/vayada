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
  convertBetween: (amount: number, fromCurrency: string, toCurrency: string) => number;
  convertAndRound: (amount: number, fromCurrency: string) => number;
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
  convertBetween: (amount) => amount,
  convertAndRound: (amount) => Math.round(amount * 100) / 100,
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
        setAttribution(data.attribution ?? null);
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

  const convertBetween = useCallback(
    (amount: number, fromCurrency: string, toCurrency: string): number => {
      if (fromCurrency === toCurrency) return amount;
      let amountInBase = amount;
      if (fromCurrency !== baseCurrency) {
        const fromRate = rates[fromCurrency];
        if (!fromRate) return amount;
        amountInBase = amount / fromRate;
      }
      if (toCurrency === baseCurrency) return amountInBase;
      const toRate = rates[toCurrency];
      if (!toRate) return amount;
      return amountInBase * toRate;
    },
    [baseCurrency, rates],
  );

  // Preserve currency minor units so displayed line amounts retain quoted cents.
  const convertAndRound = useCallback(
    (amount: number, fromCurrency: string): number => {
      let canConvert = true;
      if (fromCurrency !== selectedCurrency) {
        if (fromCurrency !== baseCurrency && !rates[fromCurrency]) canConvert = false;
        if (selectedCurrency !== baseCurrency && !rates[selectedCurrency]) canConvert = false;
      }
      const converted = canConvert ? convertPrice(amount, fromCurrency) : amount;
      const currency = canConvert ? selectedCurrency : fromCurrency;
      const digits = new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits;
      const factor = 10 ** (digits ?? 2);
      return Math.round(converted * factor) / factor;
    },
    [convertPrice, selectedCurrency, baseCurrency, rates],
  );

  const formatPrice = useCallback(
    (amount: number, fromCurrency: string): string => {
      // Check if we can actually perform the conversion
      let canConvert = true;
      if (fromCurrency !== selectedCurrency) {
        if (fromCurrency !== baseCurrency && !rates[fromCurrency]) canConvert = false;
        if (selectedCurrency !== baseCurrency && !rates[selectedCurrency]) canConvert = false;
      }

      const displayCurrency = canConvert ? selectedCurrency : fromCurrency;
      const displayAmount = canConvert ? convertPrice(amount, fromCurrency) : amount;

      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: displayCurrency,
        minimumFractionDigits: 0,
      }).format(displayAmount);
    },
    [convertPrice, selectedCurrency, baseCurrency, rates],
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
        convertBetween,
        convertAndRound,
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
