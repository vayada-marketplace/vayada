import { createHmac, randomBytes } from "node:crypto";

import { sourcePrefix } from "./ipSourcePrefix.js";

/** "Find my booking" tries per address per minute. */
export const BOOKING_LOOKUP_LIMIT = 5;
const WINDOW_MS = 60_000;

export type BookingLookupRateLimit = (
  address: string,
) => { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * In-memory fixed-window counter for "Find my booking" (VAY-2222). It replaces the attempt rows
 * the API wrote to the append-only audit log, keyed by an unsalted hash of the address. Keys are
 * HMACs under a random per-process key, as in VAY-2214's event limit, so no address is kept as
 * such and nothing is stored or logged. IPv6 addresses count per /64. Only accepted tries use up
 * the bucket. next-api runs as one task, so the limit is global.
 */
export function createBookingLookupRateLimit(
  options: { now?: () => number; limit?: number } = {},
): BookingLookupRateLimit {
  const now = options.now ?? Date.now;
  const limit = options.limit ?? BOOKING_LOOKUP_LIMIT;
  const secret = randomBytes(32);
  const counts = new Map<string, number>();
  let window = Number.NaN;

  return (address) => {
    const at = now();
    const current = Math.floor(at / WINDOW_MS);
    if (current !== window) {
      window = current;
      counts.clear();
    }
    const key = createHmac("sha256", secret).update(sourcePrefix(address)).digest("base64url");
    const used = counts.get(key) ?? 0;
    if (used >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil(((current + 1) * WINDOW_MS - at) / 1_000));
      return { allowed: false, retryAfterSeconds };
    }
    counts.set(key, used + 1);
    return { allowed: true };
  };
}
