import type { StaticImageData } from "next/image";

export type SiteImage = { src: StaticImageData; alt: string };

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
  seo: { title: string; description: string; image: SiteImage };
  address: { locality: string; country: string; countryCode: string };
  nav: { label: string; href: string }[];
  hero: { image: SiteImage; headline: string; subline: string; cta: string };
  intro: { eyebrow: string; headline: string; tagline: string; text: string };
  footer: {
    headline: string;
    cta: string;
    /** Shown only once the hotel has given them. */
    instagramUrl: string | null;
    contactUrl: string | null;
  };
};
