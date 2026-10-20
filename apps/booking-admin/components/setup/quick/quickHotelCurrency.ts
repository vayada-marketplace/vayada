import {
  COUNTRY_OPTIONS,
  CURRENCY_OPTIONS,
  POPULAR_CURRENCY_CODES,
  defaultCurrencyForCountry,
} from "@vayada/locale-constants";

/** "€" for EUR; the code itself where a currency has no symbol of its own. */
export function currencySymbol(code: string): string {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: code,
        currencyDisplay: "narrowSymbol",
      })
        .formatToParts(0)
        .find((part) => part.type === "currency")?.value ?? code
    );
  } catch {
    return code;
  }
}

export type QuickHotelCurrency = Readonly<{
  code: string;
  symbol: string;
  label: string;
  note: string;
  /** False when the owner chose another currency than the country's. */
  fromCountry: boolean;
}>;

/**
 * VAY-2247: the hotel's currency, from its country (the same table the server's first run uses)
 * unless the owner chose another. Null until the country is known.
 */
export function quickHotelCurrency(countryCode: string, chosen: string): QuickHotelCurrency | null {
  if (!COUNTRY_OPTIONS.some((country) => country.code === countryCode)) return null;
  const fromCountry = defaultCurrencyForCountry(countryCode);
  const code = CURRENCY_OPTIONS.some((option) => option.code === chosen) ? chosen : fromCountry;
  const symbol = currencySymbol(code);
  const country =
    COUNTRY_OPTIONS.find((option) => option.code === countryCode)?.name ?? countryCode;
  return Object.freeze({
    code,
    symbol,
    label: symbol === code ? code : `${code} (${symbol})`,
    note: code === fromCountry ? `From ${country}` : "Chosen by you",
    fromCountry: code === fromCountry,
  });
}

/** The currencies to choose from: the popular ones first, then the rest by name. */
export function currencyChoices() {
  const popular: readonly string[] = POPULAR_CURRENCY_CODES;
  return [
    ...popular.flatMap((code) => CURRENCY_OPTIONS.filter((option) => option.code === code)),
    ...CURRENCY_OPTIONS.filter((option) => !popular.includes(option.code)).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  ];
}
