import { createHmac, randomBytes } from "node:crypto";

import { sourcePrefix } from "./ipSourcePrefix.js";

/**
 * Per-minute limits for Booking Web's funnel events (VAY-2214). A guest's whole booking sends
 * about a dozen events; next-api runs as one task, so these are effectively global.
 */
export const BOOKING_WEB_EVENT_LIMITS = {
  address: 60,
  session: 30,
  hotel: 300,
  all: 1_500,
} as const;
export type BookingWebEventLimitScope = keyof typeof BOOKING_WEB_EVENT_LIMITS;
const WINDOW_MS = 60_000;

export type BookingWebEventRateLimit = (event: {
  address: string;
  sessionId: string;
  hotelSlug: string;
}) =>
  | { allowed: true }
  | {
      allowed: false;
      scope: BookingWebEventLimitScope;
      retryAfterSeconds: number;
      /** The first refusal of this scope in the window, so it is logged once a minute. */
      firstInWindow: boolean;
    };

/**
 * In-memory fixed-window counters. Keys are HMACs under a random per-process key, so no address
 * or session id is kept as such, and nothing is stored or logged. IPv6 addresses count per /64.
 * Only accepted events use up a bucket, so the overall limit also bounds each map's size.
 */
export function createBookingWebEventRateLimit(
  options: {
    now?: () => number;
    limits?: Record<BookingWebEventLimitScope, number>;
  } = {},
): BookingWebEventRateLimit {
  const now = options.now ?? Date.now;
  const limits = options.limits ?? BOOKING_WEB_EVENT_LIMITS;
  const secret = randomBytes(32);
  const counts = {
    address: new Map<string, number>(),
    session: new Map<string, number>(),
    hotel: new Map<string, number>(),
  };
  const refused = new Set<BookingWebEventLimitScope>();
  let window = Number.NaN;
  let all = 0;
  const hmac = (scope: string, value: string) =>
    createHmac("sha256", secret).update(scope).update("\0").update(value).digest("base64url");

  return (event) => {
    const at = now();
    const current = Math.floor(at / WINDOW_MS);
    if (current !== window) {
      window = current;
      all = 0;
      refused.clear();
      for (const map of Object.values(counts)) map.clear();
    }
    const refuse = (scope: BookingWebEventLimitScope) => {
      const firstInWindow = !refused.has(scope);
      refused.add(scope);
      const retryAfterSeconds = Math.max(1, Math.ceil(((current + 1) * WINDOW_MS - at) / 1_000));
      return { allowed: false as const, scope, retryAfterSeconds, firstInWindow };
    };

    if (all >= limits.all) return refuse("all");
    const keys = {
      address: hmac("address", sourcePrefix(event.address)),
      session: hmac("session", event.sessionId),
      hotel: hmac("hotel", event.hotelSlug.toLowerCase()),
    };
    for (const scope of ["address", "session", "hotel"] as const) {
      const used = counts[scope].get(keys[scope]) ?? 0;
      if (used >= limits[scope]) return refuse(scope);
    }
    all += 1;
    for (const scope of ["address", "session", "hotel"] as const)
      counts[scope].set(keys[scope], (counts[scope].get(keys[scope]) ?? 0) + 1);
    return { allowed: true };
  };
}
