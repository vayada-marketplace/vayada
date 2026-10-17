/**
 * Application routes
 *
 * This is the marketing site (vayada.com). Sign-up and log-in live in Booking
 * Admin on its own host, so every route that belongs to the app is an absolute
 * URL into APP_BASE_URL. Pure marketing pages (home, product pages, legal) stay
 * relative — they are served by this site.
 */

/**
 * The authenticated app (login, signup) is Booking Admin, a separate deployment
 * on its own domain (VAY-2260: it replaced the Marketplace app). Configurable
 * per environment; defaults to the production host. In local dev set
 * NEXT_PUBLIC_APP_URL=https://admin.booking.localhost (portless) or
 * http://localhost:3003 (plain-port).
 */
export const APP_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL || "https://next-booking-admin.vayada.com";

const app = (path: string) => `${APP_BASE_URL}${path}`;

export const ROUTES = {
  // Marketing pages — served by this site (relative)
  HOME: "/",
  ABOUT: "/about",
  CONTACT: "/contact",
  PRICING: "/pricing",

  // Legal — served by this site (relative)
  PRIVACY: "/privacy",
  TERMS: "/terms",
  IMPRINT: "/imprint",

  // Auth — in Booking Admin
  LOGIN: app("/login"),
  SIGNUP: app("/signup"),
} as const;
