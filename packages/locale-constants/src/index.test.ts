import { describe, expect, it } from "vitest";

import {
  CURRENCY_OPTIONS,
  defaultCurrencyForCountry,
  paymentMethodLabel,
  paymentMethodLabelKey,
} from "./index";

describe("paymentMethodLabel", () => {
  it.each([
    ["pay_at_property", "Pay at Property"],
    ["credit_card", "Credit Card"],
    ["card", "Card"],
    ["bank_transfer", "Bank Transfer"],
    ["cash", "Cash"],
    ["manual_card", "Manual Card"],
    ["paypal", "PayPal"],
    ["xendit", "Xendit"],
    ["other", "Other"],
  ])("maps %s to %s", (method, label) => {
    expect(paymentMethodLabel(method)).toBe(label);
  });

  it("fails closed for unknown values", () => {
    expect(paymentMethodLabel("future_wallet")).toBe("Other");
    expect(paymentMethodLabelKey("future_wallet")).toBe("other");
  });
});

describe("defaultCurrencyForCountry (VAY-2247)", () => {
  it.each([
    ["DE", "EUR"],
    ["hr", "EUR"],
    ["BG", "EUR"],
    ["CH", "CHF"],
    ["GB", "GBP"],
    ["US", "USD"],
    ["ID", "IDR"],
    ["LK", "LKR"],
    [" th ", "THB"],
  ])("starts a hotel in %s with %s", (country, currency) => {
    expect(defaultCurrencyForCountry(country)).toBe(currency);
  });

  it("falls back to EUR for countries without their own supported currency, or no country", () => {
    expect(defaultCurrencyForCountry("KE")).toBe("EUR");
    expect(defaultCurrencyForCountry("")).toBe("EUR");
    expect(defaultCurrencyForCountry(null)).toBe("EUR");
  });

  it("only ever answers with a supported currency", () => {
    const supported = new Set(CURRENCY_OPTIONS.map(({ code }) => code));
    for (const country of [
      "AE",
      "AU",
      "BR",
      "CA",
      "CN",
      "CZ",
      "DK",
      "HK",
      "HU",
      "IN",
      "JP",
      "KR",
      "MX",
      "MY",
      "NO",
      "NZ",
      "PH",
      "PL",
      "RO",
      "RU",
      "SE",
      "SG",
      "TR",
      "VN",
      "FR",
      "XK",
    ]) {
      expect(supported.has(defaultCurrencyForCountry(country))).toBe(true);
    }
  });
});
