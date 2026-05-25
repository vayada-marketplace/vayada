export const CURRENCY_OPTIONS = [
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

export const CURRENCIES = CURRENCY_OPTIONS.map((c) => ({
  value: c.code,
  label: `${c.flag} ${c.name} (${c.code})`,
}));

export const PROPERTY_TYPES = [
  { value: "apart_hotel", label: "Apart Hotel" },
  { value: "apartment", label: "Apartment" },
  { value: "boat", label: "Boat" },
  { value: "camping", label: "Camping" },
  { value: "capsule_hotel", label: "Capsule Hotel" },
  { value: "chalet", label: "Chalet" },
  { value: "country_house", label: "Country House" },
  { value: "farm_stay", label: "Farm Stay" },
  { value: "guest_house", label: "Guest House" },
  { value: "holiday_home", label: "Holiday Home" },
  { value: "holiday_park", label: "Holiday Park" },
  { value: "homestay", label: "Homestay" },
  { value: "hostel", label: "Hostel" },
  { value: "hotel", label: "Hotel" },
  { value: "inn", label: "Inn" },
  { value: "lodge", label: "Lodge" },
  { value: "motel", label: "Motel" },
  { value: "resort", label: "Resort" },
  { value: "riad", label: "Riad" },
  { value: "ryokan", label: "Ryokan" },
  { value: "tent", label: "Tent" },
  { value: "villa", label: "Villa" },
];

export const TIMEZONE_OPTIONS = [
  "Pacific/Midway",
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Atlantic/Azores",
  "Europe/London",
  "Europe/Paris",
  "Europe/Istanbul",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Jakarta",
  "Asia/Makassar",
  "Asia/Jayapura",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
];

// Raw HTTP status reason-phrases (e.g. "Not Found", "Bad Gateway") leak
// through when the API returns FastAPI's default {"detail": "<phrase>"}.
// They tell the user nothing actionable, so swap them for the fallback.
const RAW_HTTP_PHRASES = new Set([
  "not found",
  "internal server error",
  "bad request",
  "forbidden",
  "unauthorized",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  "unprocessable entity",
  "conflict",
  "method not allowed",
  "request timeout",
]);

export function humanizeApiError(err: any, fallback: string): string {
  const msg = (err?.message || "").trim();
  if (!msg) return fallback;
  if (RAW_HTTP_PHRASES.has(msg.toLowerCase())) return fallback;
  return msg;
}
