// Every preset keeps white button text readable (WCAG AA), as the booking design requires
// (VAY-2318: Tropical Gold and Sunset Coral are darker than they were).
export const BOOKING_PAGE_COLOR_PRESETS = [
  { name: "Ocean Blue", primary: "#0077B6" },
  { name: "Tropical Gold", primary: "#A67D12" },
  { name: "Forest Green", primary: "#2D6A4F" },
  { name: "Sunset Coral", primary: "#E35734" },
  { name: "Royal Purple", primary: "#7B2D8E" },
  { name: "Charcoal", primary: "#2D3436" },
] as const;

// The Design Studio font pairings. Apps render them with the self-hosted files of
// @vayada/fonts/brand (BRAND_FONT_PAIRINGS), the same ones the guest booking site uses.
export const BOOKING_PAGE_FONT_PAIRINGS = [
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
    id: "imperial-serif",
    name: "Imperial Serif",
    fonts: "Cinzel + Source Sans 3",
    preview: "Monumental & Refined",
  },
  {
    id: "italiana-serif",
    name: "Italiana Serif",
    fonts: "Italiana + Source Sans 3",
    preview: "Refined & Airy",
  },
] as const;

export type ColorPreset = { name: string; primary: string; accent?: string };
export type FontPairing = {
  id: string;
  name: string;
  fonts: string;
  preview: string;
};
