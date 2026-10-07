import { afterEach, expect, it, vi } from "vitest";
import { bookingWebPublicApi } from "./bookingWebPublic";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("sends server-side arrival admission to the configured absolute API origin", async () => {
  vi.stubEnv("BOOKING_WEB_API_URL", "https://api.vayada.example");
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ status: "admitted", contextId: "context-id" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const input = { host: "hotel.next-booking.vayada.com", referenceToken: "vc_reference" };
  expect(await bookingWebPublicApi.admitAffiliateArrival(input, "internal-token")).toEqual({
    status: "admitted",
    contextId: "context-id",
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.vayada.example/api/booking-web/affiliate/arrivals",
    expect.objectContaining({
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Vayada-Affiliate-Arrival-Token": "internal-token",
      },
      body: JSON.stringify(input),
    }),
  );
});

it("resolves a host through the absolute API origin on the server", async () => {
  vi.stubEnv("BOOKING_WEB_API_URL", "https://api.vayada.example");
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ slug: "hotel-alpenrose" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  expect(
    (await bookingWebPublicApi.resolveHost("hotel-alpenrose.next-booking.vayada.com")).slug,
  ).toBe("hotel-alpenrose");
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.vayada.example/api/booking-web/hosts/hotel-alpenrose.next-booking.vayada.com",
    undefined,
  );
});
