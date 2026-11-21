import type { HotelSite } from "../types";
import { brandFont, galleryPhotos, photos } from "./assets";

// Copy from Timo's design ("Homepage" artboard, VAY-2422); gallery texts, contact details, photos
// and which booking-page rooms are Tiger, Leopard and Giraffe from the hotel (VAY-2465).
export const animalsAhangama: HotelSite = {
  slug: "animals-ahangama",
  name: "Animals Ahangama",
  locale: "en",
  url: "https://animals-ahangama.site.vayada.com",
  // Kept from search engines until the go-live call (VAY-2465).
  indexable: false,
  // The hotel's live booking page, renamed from test-only-animals-ahangama (VAY-2465); the old
  // address redirects here.
  bookingUrl: "https://animals-ahangama.next-booking.vayada.com",
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
    image: { src: photos.hero, alt: "The pool and sun loungers at Animals Ahangama" },
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
  // The booking page lists each room on its own, "Room 1" to "Room 11". The hotel (Timo, 20 Nov
  // 2026): Rooms 1–4 are Tiger, 5–7 Leopard, 8–11 Giraffe. The ids are those rooms' room types.
  rooms: {
    heading: "Stay with us.",
    detailsHeading: "Our rooms",
    items: [
      {
        id: "tiger",
        name: "Tiger",
        image: {
          src: photos.tiger,
          alt: "A Tiger room: low double bed, built-in shelves, bathrobes",
        },
        summary: "Larger rooms · Indoor bathrooms",
        description:
          "Set beside the pool and chill-out area, Tiger offers our larger rooms, all with indoor bathrooms.",
        features: [
          "King-size bed",
          "Indoor bathroom",
          "Pool and chill-out area outside your door",
          "Air conditioning",
        ],
        roomTypeIds: [
          "70af6ad4-555d-43be-b387-9f6b46845199", // Room 1
          "e12e0edc-1c7b-433b-885f-0da712764752", // Room 2
          "221eb9aa-513a-4a03-9a61-07fe2c9ef0f9", // Room 3
          "9615d95d-fac0-4613-b267-a0c5f49ada82", // Room 4
        ],
      },
      {
        id: "leopard",
        name: "Leopard",
        image: {
          src: photos.leopard,
          alt: "A Leopard room: low double bed by the glass door to its open-air bathroom",
        },
        summary: "Poolside · Open-air bathrooms",
        description:
          "Sharing the same poolside setting as Tiger, Leopard offers more compact rooms with open-air bathrooms.",
        features: [
          "Queen-size or single bed",
          "Open-air bathroom",
          "Pool and chill-out area outside your door",
          "Air conditioning",
        ],
        roomTypeIds: [
          "3a14bd50-2093-4ebc-a1c4-8d66aea0f4a5", // Room 5
          "450b6655-4dbf-4315-95b4-cc969f1fdf89", // Room 6
          "94f11f83-452e-42f6-96fc-d9a45575ddfc", // Room 7
        ],
      },
      {
        id: "giraffe",
        name: "Giraffe",
        image: { src: photos.giraffe, alt: "A Giraffe room: four-poster bed with a mosquito net" },
        summary: "Separate house · Ten metres away",
        description:
          "Just ten metres away in a separate house, Giraffe offers simple, peaceful rooms with a little more independence.",
        features: [
          "Separate house",
          "Veranda seating",
          "A simple, good-value stay",
          "Air conditioning",
        ],
        roomTypeIds: [
          "bf7edd9f-455d-4cfc-8815-c7362f2b7b9c", // Room 8
          "561c58c5-c5bf-4643-b54b-4f2545cfb9fc", // Room 9
          "829389f4-9683-402a-b77a-b1d3cc9b8edd", // Room 10
          "e530c80d-25e1-41e2-a3ba-48e32d8c0a45", // Room 11
        ],
      },
      {
        id: "elephant",
        name: "Elephant",
        image: {
          src: photos.elephant,
          alt: "A rendering of the Elephant villa: its own pool, lounge and kitchen",
        },
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
    // Slide texts from the hotel (Timo, 2026-11-16).
    slides: [
      {
        label: "Pool",
        title: "Sloth mode activated.",
        text: "Cool water, warm sun and nowhere else you need to be.",
        image: { src: galleryPhotos.pool, alt: "A guest resting in the pool among palms" },
      },
      {
        label: "Cowork",
        title: "Work with a view",
        text: "Quiet desks, good Wi-Fi and palm trees outside the window.",
        image: { src: galleryPhotos.cowork, alt: "Typing on a laptop at a table" },
      },
      {
        label: "Play",
        title: "Room to play",
        text: "Games, good company and nowhere you need to be.",
        image: { src: galleryPhotos.play, alt: "A glass chess set and a fruit plate" },
      },
      {
        label: "Lounge",
        title: "Lounge around",
        text: "Deep cushions, cold drinks and the sound of the jungle.",
        image: { src: galleryPhotos.lounge, alt: "Cushioned chairs on the veranda" },
      },
      {
        label: "Restaurant",
        title: "Fresh from our kitchen",
        text: "Island flavours and café classics, served all day.",
        image: { src: galleryPhotos.restaurant, alt: "A pan over the flame in the kitchen" },
      },
      {
        label: "Bar",
        title: "Sundowners at the bar",
        text: "Cocktails, cold beer and the best seat for golden hour.",
        image: { src: galleryPhotos.bar, alt: "The bar counter and its rattan stools" },
      },
      {
        label: "Slow moments",
        title: "Slow moments",
        text: "Long breakfasts, lazy afternoons, no alarm clocks.",
        image: { src: galleryPhotos.slowMoments, alt: "A coffee and a magazine on the bed" },
      },
      {
        label: "Evenings",
        title: "Evenings at Animals",
        text: "Warm lights, good music and stories from the day.",
        image: { src: galleryPhotos.evenings, alt: "Guests at dinner under string lights" },
      },
    ],
  },
  // Off until the hotel's real Google / Booking.com reviews are in. The design's three are mock-ups.
  reviews: null,
  eat: {
    eyebrow: "Eat & Drink",
    headline: ["Eat, drink &", "stay awhile."],
    text: "Good food, fresh cocktails and easy conversation. From sun down to late, this is where the night slows down.",
    image: { src: photos.eat, alt: "Guests laughing over cocktails among the plants" },
    menusUrl: null,
    tableUrl: null,
  },
  location: {
    eyebrow: "Ahangama, Sri Lanka",
    headline: "Close to everything.",
    text: "Ahangama is where the south slows down. Surf in the mornings, swim at the beach, explore local cafés and shops, and watch the sun drop in the evening. We're a short walk to the beach and close to everything.",
    image: { src: photos.location, alt: "Palm trees and string lights over the garden" },
    exploreUrl: null,
  },
  footer: {
    headline: "Come stay awhile.",
    cta: "Book your stay",
    phone: "+94 74 028 5070",
    whatsappUrl: "https://wa.me/94740285070",
    email: "animalsahangama@gmail.com",
    instagramUrl: "https://www.instagram.com/animalsahangama/",
  },
};
