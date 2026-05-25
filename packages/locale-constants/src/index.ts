export interface CurrencyOption {
  code: string;
  name: string;
  flag: string;
}

export const CURRENCY_OPTIONS: CurrencyOption[] = [
  { code: "AED", name: "UAE Dirham", flag: "🇦🇪" },
  { code: "AUD", name: "Australian Dollar", flag: "🇦🇺" },
  { code: "BGN", name: "Bulgarian Lev", flag: "🇧🇬" },
  { code: "BRL", name: "Brazilian Real", flag: "🇧🇷" },
  { code: "CAD", name: "Canadian Dollar", flag: "🇨🇦" },
  { code: "CHF", name: "Swiss Franc", flag: "🇨🇭" },
  { code: "CNY", name: "Chinese Yuan", flag: "🇨🇳" },
  { code: "CZK", name: "Czech Koruna", flag: "🇨🇿" },
  { code: "DKK", name: "Danish Krone", flag: "🇩🇰" },
  { code: "EUR", name: "Euro", flag: "🇪🇺" },
  { code: "GBP", name: "British Pound", flag: "🇬🇧" },
  { code: "HKD", name: "Hong Kong Dollar", flag: "🇭🇰" },
  { code: "HRK", name: "Croatian Kuna", flag: "🇭🇷" },
  { code: "HUF", name: "Hungarian Forint", flag: "🇭🇺" },
  { code: "IDR", name: "Indonesian Rupiah", flag: "🇮🇩" },
  { code: "INR", name: "Indian Rupee", flag: "🇮🇳" },
  { code: "JPY", name: "Japanese Yen", flag: "🇯🇵" },
  { code: "KRW", name: "South Korean Won", flag: "🇰🇷" },
  { code: "MXN", name: "Mexican Peso", flag: "🇲🇽" },
  { code: "MYR", name: "Malaysian Ringgit", flag: "🇲🇾" },
  { code: "NOK", name: "Norwegian Krone", flag: "🇳🇴" },
  { code: "NZD", name: "New Zealand Dollar", flag: "🇳🇿" },
  { code: "PHP", name: "Philippine Peso", flag: "🇵🇭" },
  { code: "PLN", name: "Polish Zloty", flag: "🇵🇱" },
  { code: "RON", name: "Romanian Leu", flag: "🇷🇴" },
  { code: "RUB", name: "Russian Ruble", flag: "🇷🇺" },
  { code: "SEK", name: "Swedish Krona", flag: "🇸🇪" },
  { code: "SGD", name: "Singapore Dollar", flag: "🇸🇬" },
  { code: "THB", name: "Thai Baht", flag: "🇹🇭" },
  { code: "TRY", name: "Turkish Lira", flag: "🇹🇷" },
  { code: "USD", name: "US Dollar", flag: "🇺🇸" },
  { code: "VND", name: "Vietnamese Dong", flag: "🇻🇳" },
];

export const POPULAR_CURRENCY_CODES = [
  "USD",
  "EUR",
  "GBP",
  "AUD",
  "SGD",
  "CHF",
  "CAD",
  "THB",
  "JPY",
];
