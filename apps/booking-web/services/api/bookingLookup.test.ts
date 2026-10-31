import { afterEach, describe, expect, it, vi } from "vitest";
import { bookingService } from "./booking";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("bookingService.lookup (VAY-2220)", () => {
  it("asks the API straight from the browser, without cookies, so its limit counts this guest", async () => {
    const fetch = vi.fn(async () => Response.json({ bookingReference: "VAY-1" }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NEXT_PUBLIC_BOOKING_WEB_API_URL", "https://next-api.example.test/");
    await bookingService.lookup("hotel alpenrose", "VAY-1", "guest@example.test");
    vi.stubEnv("NEXT_PUBLIC_BOOKING_WEB_API_URL", "");
    await bookingService.lookup("hotel-alpenrose", "VAY-1", "guest@example.test");

    const [[direct, init], [sameOrigin]] = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(direct).toBe(
      "https://next-api.example.test/api/booking-web/hotels/hotel%20alpenrose/bookings/lookup",
    );
    // Without a configured API address (browser specs, plain local dev) it stays same-origin.
    expect(sameOrigin).toBe("/api/booking-web/hotels/hotel-alpenrose/bookings/lookup");
    expect(init).toMatchObject({
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(init.body as string)).toEqual({
      bookingReference: "VAY-1",
      guestEmail: "guest@example.test",
    });
  });

  it("keeps the API's too-many-tries answer for the Find my booking message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            statusCode: 429,
            error: "Too Many Requests",
            message: "Too many booking lookup attempts. Please try again later.",
          },
          { status: 429 },
        ),
      ),
    );
    vi.stubEnv("NEXT_PUBLIC_BOOKING_WEB_API_URL", "https://next-api.example.test");
    await expect(
      bookingService.lookup("hotel-alpenrose", "VAY-1", "guest@example.test"),
    ).rejects.toMatchObject({ status: 429 });
  });
});
