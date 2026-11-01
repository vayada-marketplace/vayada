import type { HotelSite } from "../types";
import { brandFont, galleryPhotos, photos } from "./assets";

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
  // No roomTypeId yet: the booking page lists "Room 1–11", and the hotel hasn't said which are
  // Tiger, Leopard and Giraffe, so "View rooms" opens the whole list.
  rooms: {
    heading: "Stay with us.",
    detailsHeading: "Our rooms",
    items: [
      {
        id: "tiger",
        name: "Tiger",
        image: { src: photos.tiger, alt: "Tiger room interior" },
        summary: "Larger rooms · Indoor bathrooms",
        description:
          "Set beside the pool and chill-out area, Tiger offers our larger rooms, all with indoor bathrooms.",
        features: [
          "King-size bed",
          "Indoor bathroom",
          "Pool and chill-out area outside your door",
          "Air conditioning",
        ],
      },
      {
        id: "leopard",
        name: "Leopard",
        image: { src: photos.leopard, alt: "Leopard room interior" },
        summary: "Poolside · Open-air bathrooms",
        description:
          "Sharing the same poolside setting as Tiger, Leopard offers more compact rooms with open-air bathrooms.",
        features: [
          "Queen-size or single bed",
          "Open-air bathroom",
          "Pool and chill-out area outside your door",
          "Air conditioning",
        ],
      },
      {
        id: "giraffe",
        name: "Giraffe",
        image: { src: photos.giraffe, alt: "Giraffe room interior" },
        summary: "Separate house · Ten metres away",
        description:
          "Just ten metres away in a separate house, Giraffe offers simple, peaceful rooms with a little more independence.",
        features: [
          "Separate house",
          "Veranda seating",
          "A simple, good-value stay",
          "Air conditioning",
        ],
      },
      {
        id: "elephant",
        name: "Elephant",
        image: { src: photos.elephant, alt: "Elephant villa interior" },
        summary: "Coming soon · Two-bed villa",
        description:
          "A private two-bedroom villa with its own pool, kitchen and generous lounge space — made for families, friends and longer stays.",
        features: ["Two bedrooms", "Private pool", "Kitchen", "Sofa and lounge area"],
        comingSoon: true,
      },
    ],
  },
  gallery: {
    eyebrow: "Beyond your room",
    headline: ["Places to eat, work, swim, meet —", "or simply do very little."],
    // PLACEHOLDER COPY: only slide 01 is final; the bracketed lines wait for the client's text.
    slides: [
      {
        label: "Pool",
        title: "Sloth mode activated.",
        text: "Cool water, warm sun and nowhere else you need to be.",
        image: { src: galleryPhotos.pool, alt: "Pool" },
      },
      {
        label: "Cowork",
        title: "[Cowork headline]",
        text: "[Cowork subtitle]",
        image: { src: galleryPhotos.cowork, alt: "Cowork" },
      },
      {
        label: "Play",
        title: "[Play headline]",
        text: "[Play subtitle]",
        image: { src: galleryPhotos.play, alt: "Play" },
      },
      {
        label: "Lounge",
        title: "[Lounge headline]",
        text: "[Lounge subtitle]",
        image: { src: galleryPhotos.lounge, alt: "Lounge" },
      },
      {
        label: "Restaurant",
        title: "[Restaurant headline]",
        text: "[Restaurant subtitle]",
        image: { src: galleryPhotos.restaurant, alt: "Restaurant" },
      },
      {
        label: "Bar",
        title: "[Bar headline]",
        text: "[Bar subtitle]",
        image: { src: galleryPhotos.bar, alt: "Bar" },
      },
      {
        label: "Slow moments",
        title: "[Slow moments headline]",
        text: "[Slow moments subtitle]",
        image: { src: galleryPhotos.slowMoments, alt: "Slow moments" },
      },
      {
        label: "Evenings",
        title: "[Evenings headline]",
        text: "[Evenings subtitle]",
        image: { src: galleryPhotos.evenings, alt: "Evenings" },
      },
    ],
  },
  // Off until the hotel's real Google / Booking.com reviews are in. The design's three are mock-ups.
  reviews: null,
  eat: {
    eyebrow: "Eat & Drink",
    headline: ["Eat, drink &", "stay awhile."],
    text: "Good food, fresh cocktails and easy conversation. From sun down to late, this is where the night slows down.",
    image: { src: photos.restaurant, alt: "Restaurant terrace in the evening" },
    menusUrl: null,
    tableUrl: null,
  },
  location: {
    eyebrow: "Ahangama, Sri Lanka",
    headline: "Close to everything.",
    text: "Ahangama is where the south slows down. Surf in the mornings, swim at the beach, explore local cafés and shops, and watch the sun drop in the evening. We're a short walk to the beach and close to everything.",
    image: { src: photos.beach, alt: "Palm-lined beach in Ahangama at dusk" },
    exploreUrl: null,
  },
  footer: {
    headline: "Come stay awhile.",
    cta: "Book your stay",
    instagramUrl: null,
    contactUrl: null,
  },
};
