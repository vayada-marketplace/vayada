import { describe, expect, it } from "vitest";

import {
  BOOKING_WEB_EVENT_LIMITS,
  createBookingWebEventRateLimit,
} from "./bookingWebEventRateLimit.js";

const START = Date.UTC(2026, 9, 15, 12, 0, 0);
const small = { address: 3, session: 2, hotel: 5, all: 8 };

describe("Booking Web funnel event rate limit (VAY-2214)", () => {
  it("uses the agreed per-minute limits by default", () => {
    expect(BOOKING_WEB_EVENT_LIMITS).toEqual({
      address: 60,
      session: 30,
      hotel: 300,
      all: 1_500,
    });
  });

  it("limits each address, session and hotel per minute, and only counts accepted events", () => {
    const limit = createBookingWebEventRateLimit({ now: () => START + 15_000, limits: small });
    const event = (address: string, sessionId: string, hotelSlug = "hotel-a") => ({
      address,
      sessionId,
      hotelSlug,
    });

    expect(limit(event("203.0.113.1", "s1")).allowed).toBe(true);
    expect(limit(event("203.0.113.1", "s1")).allowed).toBe(true);
    // A third event of this session is refused and uses up nothing else.
    expect(limit(event("203.0.113.1", "s1"))).toEqual({
      allowed: false,
      scope: "session",
      retryAfterSeconds: 45,
      firstInWindow: true,
    });
    expect(limit(event("203.0.113.1", "s2")).allowed).toBe(true);
    expect(limit(event("203.0.113.1", "s3"))).toMatchObject({
      allowed: false,
      scope: "address",
      firstInWindow: true,
    });
    expect(limit(event("203.0.113.1", "s4"))).toMatchObject({
      scope: "address",
      firstInWindow: false,
    });
    expect(limit(event("203.0.113.2", "s5")).allowed).toBe(true);
    expect(limit(event("203.0.113.3", "s6")).allowed).toBe(true);
    expect(limit(event("203.0.113.4", "s7"))).toMatchObject({ allowed: false, scope: "hotel" });
    // Hotel slugs count case-insensitively.
    expect(limit(event("203.0.113.4", "s7", "HOTEL-A"))).toMatchObject({ scope: "hotel" });
    expect(limit(event("203.0.113.4", "s7", "hotel-b")).allowed).toBe(true);
  });

  it("caps all events, then starts a fresh window each minute", () => {
    let at = START;
    const limit = createBookingWebEventRateLimit({ now: () => at, limits: small });
    for (let i = 0; i < 8; i += 1)
      expect(limit({ address: `198.51.100.${i}`, sessionId: `s${i}`, hotelSlug: `h${i}` })).toEqual(
        { allowed: true },
      );
    expect(limit({ address: "198.51.100.99", sessionId: "s99", hotelSlug: "h99" })).toMatchObject({
      allowed: false,
      scope: "all",
      retryAfterSeconds: 60,
    });
    at = START + 60_000;
    expect(limit({ address: "198.51.100.99", sessionId: "s99", hotelSlug: "h99" })).toEqual({
      allowed: true,
    });
  });

  it("counts IPv6 addresses per /64 and IPv4-mapped addresses as IPv4", () => {
    const limit = createBookingWebEventRateLimit({ now: () => START, limits: small });
    for (const [i, address] of [
      "2001:db8:1:2::1",
      "2001:db8:1:2:ffff::9",
      "2001:0db8:0001:0002:0000:0000:0000:0042",
    ].entries())
      expect(limit({ address, sessionId: `v6-${i}`, hotelSlug: `v6-${i}` }).allowed).toBe(true);
    expect(
      limit({ address: "2001:db8:1:2::77", sessionId: "v6-x", hotelSlug: "v6-x" }),
    ).toMatchObject({ allowed: false, scope: "address" });
    expect(
      limit({ address: "2001:db8:1:3::1", sessionId: "v6-y", hotelSlug: "v6-y" }).allowed,
    ).toBe(true);

    const mapped = createBookingWebEventRateLimit({ now: () => START, limits: small });
    for (const [i, address] of ["192.0.2.7", "::ffff:192.0.2.7", "::ffff:c000:0207"].entries())
      expect(mapped({ address, sessionId: `m${i}`, hotelSlug: `m${i}` }).allowed).toBe(true);
    expect(mapped({ address: "192.0.2.7", sessionId: "m9", hotelSlug: "m9" })).toMatchObject({
      scope: "address",
    });
  });
});
