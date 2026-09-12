import { afterEach, expect, it, vi } from "vitest";
import { loadMarketplacePublicHotel, parseMarketplacePublicHotel } from "./marketplacePublicHotel";
const propertyId = "e1943000-0000-4000-8000-000000000003";
const hotel = {
  propertyId,
  revisionId: "e1943000-0000-4000-8000-000000000005",
  displayName: "Approved hotel",
  propertyType: "hotel",
  shortDescription: "Approved description",
  locality: null,
  media: [{ mediaType: "logo", url: "https://cdn.example.test/logo.webp", altText: null }],
};
afterEach(() => vi.unstubAllGlobals());
it("loads anonymously without caching", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(hotel)));
  vi.stubGlobal("fetch", fetch);
  expect(await loadMarketplacePublicHotel(propertyId)).toEqual(hotel);
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining(`/api/marketplace/hotels/${propertyId}`),
    expect.objectContaining({ cache: "no-store", credentials: "omit" }),
  );
});
it("distinguishes no public profile from a provider failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 })),
  );
  expect(await loadMarketplacePublicHotel(propertyId)).toBeNull();
  await expect(loadMarketplacePublicHotel(propertyId)).rejects.toThrow("temporarily unavailable");
});
it("rejects mismatched properties and unsafe media", () => {
  expect(() =>
    parseMarketplacePublicHotel({ ...hotel, propertyId: hotel.revisionId }, propertyId),
  ).toThrow();
  for (const url of [
    "javascript:alert(1)",
    "http://example.test/image",
    "https://user:secret@example.test/image",
  ]) {
    expect(() =>
      parseMarketplacePublicHotel({ ...hotel, media: [{ ...hotel.media[0], url }] }, propertyId),
    ).toThrow();
  }
});

it("treats malformed addresses as unavailable without a request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(await loadMarketplacePublicHotel("not-a-uuid")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["deadline", "caller"])("terminates stalled requests on %s cancellation", async (source) => {
  vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
    const signal = options.signal!;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })));
  const controller = new AbortController();
  const pending = loadMarketplacePublicHotel(propertyId, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: source === "caller" ? "AbortError" : "TimeoutError" });
  if (source === "caller") controller.abort();
  await rejected;
}, 15_000);
