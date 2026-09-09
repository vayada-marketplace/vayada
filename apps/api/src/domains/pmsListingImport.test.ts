import { describe, expect, it, vi } from "vitest";
import {
  createApifyListingImporter,
  normalizeListingOutput,
  parseListingSource,
} from "./pmsListingImport.js";

const url = "https://www.airbnb.com/rooms/12345";
const listing = { url, title: "Garden suite", description: "A quiet room", personCapacity: 3 };

describe("listing URL validation", () => {
  it.each([
    "http://www.airbnb.com/rooms/12345",
    "https://airbnb.com.evil.test/rooms/12345",
    "https://airbnb.com@evil.test/rooms/12345",
    "https://user:pass@airbnb.com/rooms/12345",
    "https://127.0.0.1/rooms/12345",
    "https://airbnb.com:8443/rooms/12345",
    "https://airbnb.com/s/city",
    "https://booking.com/searchresults.html",
    "https://airbnb.com/rooms/%31",
    "https://airbnb.com/rooms/1\\evil",
    null,
  ])("rejects unsupported input %s", (input) => expect(parseListingSource(input)).toBeNull());
  it("canonicalizes direct listing links without forwarding tracking parameters", () => {
    expect(parseListingSource("https://airbnb.com/rooms/12345/?secret=discard#fragment")).toEqual({
      provider: "airbnb",
      url,
    });
    expect(
      parseListingSource("https://booking.com/hotel/de/example.en-gb.html?sid=discard"),
    ).toEqual({ provider: "booking", url: "https://www.booking.com/hotel/de/example.en-gb.html" });
  });
});

describe("provider normalization", () => {
  it("returns only supported facts and strips host, media and rate data", () => {
    expect(
      normalizeListingOutput(parseListingSource(url)!, [
        {
          ...listing,
          host: { email: "private@example.test" },
          price: 120,
          images: ["https://example.test/photo"],
        },
      ]),
    ).toMatchObject({
      ok: true,
      rooms: [{ name: "Garden suite", description: "A quiet room", maxGuests: 3 }],
    });
    const result = normalizeListingOutput(parseListingSource(url)!, [
      { ...listing, personCapacity: "3", description: null },
    ]);
    expect(result.ok && result.rooms).toEqual([{ name: "Garden suite" }]);
  });
  it.each([
    [],
    {},
    [{ ...listing, url: "https://www.airbnb.com/rooms/999" }],
    [listing, listing],
    [{ url }],
  ])("rejects empty, malformed or unrelated output", (payload) => {
    expect(normalizeListingOutput(parseListingSource(url)!, payload)).toMatchObject({
      ok: false,
      code: "no_room_details",
    });
  });
  it("deduplicates Booking room offers without using hotel description or offer occupancy", () => {
    const source = parseListingSource("https://www.booking.com/hotel/de/example.html")!;
    const result = normalizeListingOutput(source, [
      {
        url: source.url,
        description: "Hotel description",
        rooms: [
          { roomType: "Suite", persons: 2 },
          { roomType: "Suite", persons: 3 },
          { roomType: "Double", persons: 1 },
        ],
      },
    ]);
    expect(result.ok && result.rooms).toEqual([{ name: "Suite" }, { name: "Double" }]);
  });
});

describe("Apify transport", () => {
  it("requires dates before calling Booking and forwards only validated dates", async () => {
    const booking = "https://www.booking.com/hotel/de/example.html";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify([{ url: booking, rooms: [{ roomType: "Suite" }] }])),
      );
    const importer = createApifyListingImporter({ token: "test-token", fetch: fetcher });
    expect(await importer(booking)).toMatchObject({ code: "stay_dates_required" });
    for (const dates of [
      "checkin=2027-02-30&checkout=2027-03-02",
      "checkin=2027-03-02&checkout=2027-03-01",
      "checkin=2027-03-01",
      "checkin=2027-03-01&checkin=2027-03-02&checkout=2027-03-03",
    ])
      expect(await importer(booking + "?" + dates)).toMatchObject({ code: "unsupported_url" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await importer(booking + "?checkin=2027-03-01&checkout=2027-03-03&sid=discard"),
    ).toMatchObject({ ok: true, rooms: [{ name: "Suite" }] });
    const [endpoint, init] = fetcher.mock.calls[0]!;
    expect(String(endpoint)).toContain("voyager~booking-scraper");
    expect(JSON.parse(String(init?.body))).toEqual({
      startUrls: [{ url: booking }],
      maxItems: 1,
      checkIn: "2027-03-01",
      checkOut: "2027-03-03",
    });
  });
  it("does not call the provider for invalid URLs or missing configuration", async () => {
    const fetcher = vi.fn();
    const importer = createApifyListingImporter({ fetch: fetcher });
    expect(await importer("https://evil.test")).toMatchObject({ code: "unsupported_url" });
    expect(await importer(url)).toMatchObject({ code: "not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses one fixed actor call, a header token, a canonical URL, and provider timeout", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify([listing])));
    const result = await createApifyListingImporter({ token: "test-token", fetch: fetcher })(
      url + "?tracking=discard",
    );
    expect(result).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledOnce();
    const [endpoint, init] = fetcher.mock.calls[0]!;
    expect(String(endpoint)).toBe(
      "https://api.apify.com/v2/actors/tri_angle~airbnb-rooms-urls-scraper/run-sync-get-dataset-items?timeout=60&maxItems=1&maxTotalChargeUsd=0.05&restartOnError=false&format=json",
    );
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { Authorization: "Bearer test-token" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({ startUrls: [{ url }] });
  });
  it.each([401, 403, 408, 429, 500])("sanitizes HTTP %s without retrying", async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("sensitive provider details", { status }));
    const result = await createApifyListingImporter({ token: "test-token", fetch: fetcher })(url);
    expect(result).toMatchObject({
      ok: false,
      code: status === 408 ? "timeout" : "provider_failed",
    });
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["invalid json", "x".repeat(2_000_001)])(
    "rejects invalid or oversized data",
    async (body) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      expect(
        await createApifyListingImporter({ token: "test-token", fetch: fetcher })(url),
      ).toMatchObject({ ok: false });
    },
  );
  it("does not leak network error messages", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret-token"));
    const result = await createApifyListingImporter({ token: "test-token", fetch: fetcher })(url);
    expect(result).toMatchObject({ ok: false, code: "provider_failed" });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});
