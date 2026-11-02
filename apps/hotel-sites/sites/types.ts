import type { StaticImageData } from "next/image";

export type SiteImage = { src: StaticImageData; alt: string };

export type SiteRoom = {
  /** The in-page anchor of its details row (the card links to it). */
  id: string;
  name: string;
  image: SiteImage;
  /** The card's one-liner. */
  summary: string;
  description: string;
  features: string[];
  /** Not bookable yet: no "View rooms" button. */
  comingSoon?: boolean;
  /** The booking page's room type, once the hotel has said which it is. Its "View rooms" then
   * opens that room (booking page `?room=`); until then, the booking page's room list. */
  roomTypeId?: string;
};

/** A real guest review, quoted from Google or Booking.com with the guest's first name. */
export type SiteReview = {
  /** Stars out of five (a Booking.com score out of ten needs converting). */
  rating: 1 | 2 | 3 | 4 | 5;
  text: string;
  author: string;
  origin: string;
  source: "Google" | "Booking.com";
};

export type SiteSlide = { label: string; title: string; text: string; image: SiteImage };

/** Two-line headings keep the design's line break. */
type Lines = string[];

/** One hotel's website: everything the template shows, in the hotel's words. */
export type HotelSite = {
  slug: string;
  name: string;
  locale: string;
  /** Where the site is published: canonical URL, Open Graph and structured data. */
  url: string;
  /** Off while the site still holds placeholder photos or copy: search engines stay away. */
  indexable: boolean;
  /** The hotel's booking page on vayada; every "Book your stay" opens it. */
  bookingUrl: string;
  /** The brand font's CSS variable class, from next/font (see the site's assets.ts). */
  fontClassName: string;
  colors: {
    background: string;
    ink: string;
    text: string;
    muted: string;
    accent: string;
    tint: string;
    footer: string;
  };
  /** The hero photo doubles as the link preview image. */
  seo: { title: string; description: string };
  address: { locality: string; country: string; countryCode: string };
  nav: { label: string; href: string }[];
  hero: { image: SiteImage; headline: string; subline: string; cta: string };
  intro: { eyebrow: string; headline: string; tagline: string; text: string };
  /** `detailsHeading` names the details rows for screen readers; it isn't shown. */
  rooms: { heading: string; detailsHeading: string; items: SiteRoom[] };
  gallery: {
    eyebrow: string;
    headline: Lines;
    slides: [SiteSlide, ...SiteSlide[]];
  };
  /** Off (null) until the hotel's real reviews are in: never shown with invented ones. */
  reviews: { heading: string; items: SiteReview[]; moreUrl: string | null } | null;
  eat: {
    eyebrow: string;
    headline: Lines;
    text: string;
    image: SiteImage;
    /** Shown only once the hotel has given them. */
    menusUrl: string | null;
    tableUrl: string | null;
  };
  location: {
    eyebrow: string;
    headline: string;
    text: string;
    image: SiteImage;
    exploreUrl: string | null;
  };
  footer: {
    headline: string;
    cta: string;
    /** Shown only once the hotel has given them. */
    instagramUrl: string | null;
    contactUrl: string | null;
  };
};
