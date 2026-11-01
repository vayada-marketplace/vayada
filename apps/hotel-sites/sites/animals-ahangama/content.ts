import type { HotelSite } from "../types";
import { brandFont, photos } from "./assets";

// Copy from Timo's design ("Homepage" artboard, VAY-2422).
export const animalsAhangama: HotelSite = {
  slug: "animals-ahangama",
  name: "Animals Ahangama",
  locale: "en",
  url: "https://animals-ahangama.site.vayada.com",
  // Placeholder photos and copy until the hotel's own arrive.
  indexable: false,
  // The hotel's live booking page. Its address still carries the "test-only" slug from the owner
  // tests (VAY-2058); the old address keeps redirecting after a rename.
  bookingUrl: "https://test-only-animals-ahangama.next-booking.vayada.com",
  fontClassName: brandFont.variable,
  colors: {
    background: "#FFFFFF",
    ink: "#2E2B28",
    text: "#4E4843",
    muted: "#5E5853",
    accent: "#8A2B1E",
    tint: "#FCE5D8",
    footer: "#34302D",
  },
  seo: {
    title: "Animals Ahangama · A place to land",
    description:
      "A place to land in Ahangama, Sri Lanka. Stay awhile. Eat well. Feel at home. Rooms by the pool, a restaurant and bar, a short walk to the beach.",
    image: { src: photos.hero, alt: "Pool and lounge terrace at Animals Ahangama" },
  },
  address: { locality: "Ahangama", country: "Sri Lanka", countryCode: "LK" },
  nav: [
    { label: "Stay", href: "#stay" },
    { label: "Eat & Drink", href: "#eat" },
    { label: "About", href: "#about" },
    { label: "Contact", href: "#contact" },
  ],
  hero: {
    image: { src: photos.hero, alt: "Pool and lounge terrace at Animals Ahangama" },
    headline: "A place to land.",
    subline: "Stay awhile. Eat well. Feel at home.",
    cta: "Book your stay",
  },
  intro: {
    eyebrow: "Animals Ahangama",
    headline: "We are all animals.",
    tagline: "All different. All alike. All welcome.",
    text: "Animals is your den away from home — a place to arrive as you are, find your own rhythm and feel completely at ease.",
  },
  footer: {
    headline: "Come stay awhile.",
    cta: "Book your stay",
    instagramUrl: null,
    contactUrl: null,
  },
};
