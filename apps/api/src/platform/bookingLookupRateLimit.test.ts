import { describe, expect, it } from "vitest";

import { BOOKING_LOOKUP_LIMIT, createBookingLookupRateLimit } from "./bookingLookupRateLimit.js";

const START = Date.UTC(2026, 9, 16, 12, 0, 0);

describe("Find my booking rate limit (VAY-2222)", () => {
  it("admits five tries per address per minute, then a fresh window", () => {
    expect(BOOKING_LOOKUP_LIMIT).toBe(5);
    let at = START + 20_000;
    const limit = createBookingLookupRateLimit({ now: () => at });
    for (let attempt = 1; attempt <= 5; attempt += 1)
      expect(limit("203.0.113.1")).toEqual({ allowed: true });
    expect(limit("203.0.113.1")).toEqual({ allowed: false, retryAfterSeconds: 40 });
    // Other addresses have their own bucket.
    expect(limit("203.0.113.2")).toEqual({ allowed: true });
    at = START + 59_500;
    expect(limit("203.0.113.1")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    at = START + 60_000;
    expect(limit("203.0.113.1")).toEqual({ allowed: true });
  });

  it("counts IPv6 addresses per /64 and IPv4-mapped addresses as IPv4", () => {
    const limit = createBookingLookupRateLimit({ now: () => START, limit: 2 });
    expect(limit("2001:db8:1:2::1").allowed).toBe(true);
    expect(limit("2001:0db8:0001:0002:ffff::9").allowed).toBe(true);
    expect(limit("2001:db8:1:2::77").allowed).toBe(false);
    expect(limit("2001:db8:1:3::1").allowed).toBe(true);

    expect(limit("192.0.2.7").allowed).toBe(true);
    expect(limit("::ffff:c000:0207").allowed).toBe(true);
    expect(limit("::ffff:192.0.2.7").allowed).toBe(false);
  });
});
