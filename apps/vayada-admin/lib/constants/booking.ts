export const COLOR_PRESETS = [
  { name: "Indigo", primary: "#4F46E5", accent: "#F5F5F4" },
  { name: "Emerald", primary: "#059669", accent: "#F0FDF4" },
  { name: "Amber", primary: "#D97706", accent: "#FFFBEB" },
  { name: "Rose", primary: "#E11D48", accent: "#FFF1F2" },
  { name: "Slate", primary: "#475569", accent: "#F8FAFC" },
];

// Rendered with the self-hosted files of @vayada/fonts/brand, as on the guest booking site.
export const FONT_PAIRINGS = [
  {
    id: "high-end-serif",
    name: "High-end Serif",
    fonts: "Playfair Display + Source Sans 3",
    preview: "Elegant & Timeless",
  },
  {
    id: "modern-minimalist",
    name: "Modern Minimalist",
    fonts: "Inter + Inter",
    preview: "Clean & Contemporary",
  },
  {
    id: "grand-classic",
    name: "Grand Classic",
    fonts: "Lora + Source Sans 3",
    preview: "Stately & Readable",
  },
  {
    id: "italiana-serif",
    name: "Italiana Serif",
    fonts: "Italiana + Source Sans 3",
    preview: "Refined & Airy",
  },
] as const;

export const CURRENCY_OPTIONS = [
  { code: "EUR", label: "EUR - Euro" },
  { code: "USD", label: "USD - US Dollar" },
  { code: "GBP", label: "GBP - British Pound" },
  { code: "CHF", label: "CHF - Swiss Franc" },
  { code: "SEK", label: "SEK - Swedish Krona" },
  { code: "NOK", label: "NOK - Norwegian Krone" },
  { code: "DKK", label: "DKK - Danish Krone" },
  { code: "PLN", label: "PLN - Polish Zloty" },
  { code: "CZK", label: "CZK - Czech Koruna" },
  { code: "HUF", label: "HUF - Hungarian Forint" },
  { code: "RON", label: "RON - Romanian Leu" },
  { code: "BGN", label: "BGN - Bulgarian Lev" },
  { code: "HRK", label: "HRK - Croatian Kuna" },
  { code: "TRY", label: "TRY - Turkish Lira" },
  { code: "RUB", label: "RUB - Russian Ruble" },
  { code: "JPY", label: "JPY - Japanese Yen" },
  { code: "CNY", label: "CNY - Chinese Yuan" },
  { code: "AUD", label: "AUD - Australian Dollar" },
  { code: "CAD", label: "CAD - Canadian Dollar" },
  { code: "SGD", label: "SGD - Singapore Dollar" },
  { code: "AED", label: "AED - UAE Dirham" },
  { code: "THB", label: "THB - Thai Baht" },
  { code: "IDR", label: "IDR - Indonesian Rupiah" },
  { code: "INR", label: "INR - Indian Rupee" },
  { code: "BRL", label: "BRL - Brazilian Real" },
  { code: "MXN", label: "MXN - Mexican Peso" },
  { code: "HKD", label: "HKD - Hong Kong Dollar" },
];
