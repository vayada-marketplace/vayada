import { describe, expect, it, vi } from "vitest";
import { normalizeChannexAirbnbListings, readChannexAirbnbImport } from "./channexAirbnbImport.js";

const scope = {
  channelId: "10090000-0000-4000-8000-000000000001",
  groupId: "10090000-0000-4000-8000-000000000002",
  externalPropertyId: "10090000-0000-4000-8000-000000000003",
};
const channel = () => ({
  data: {
    id: scope.channelId,
    attributes: { channel: "Airbnb", properties: [scope.externalPropertyId] },
    relationships: { group: { data: { id: scope.groupId } } },
  },
});
const listings = (
  values: unknown[] = [{ id: "123", title: "Demo loft", occupancies: [1, 2] }],
) => ({ data: { listing_id_dictionary: { values } } });
const options = (fetcher: typeof fetch) => ({
  environment: "staging" as const,
  apiKey: "synthetic-key",
  fetcher,
});

describe("Airbnb listing source", () => {
  it("reads a scoped channel before listings, with no write requests", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(channel()))
      .mockResolvedValueOnce(Response.json(listings()));
    const result = await readChannexAirbnbImport(scope, options(fetcher));
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `https://staging.channex.io/api/v1/channels/${scope.channelId}`,
      `https://staging.channex.io/api/v1/channels/${scope.channelId}/action/listings`,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: { "user-api-key": "synthetic-key" },
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.body).toBeUndefined();
    }
    expect(result.property).toEqual({});
    expect(result.rooms[0]).toEqual({
      id: "abb_123",
      name: "Demo loft",
      description: "",
      maxGuests: 2,
      maxAdults: null,
      maxChildren: null,
      bedType: "",
      bedQuantity: null,
      bathroomType: "",
      sizeSquareMetres: null,
    });
  });

  it.each(["property", "group", "channel", "provider", "multi-property"])(
    "rejects a mismatched %s before listing access",
    async (kind) => {
      const data = channel();
      if (kind === "property") data.data.attributes.properties = [scope.groupId];
      if (kind === "group") data.data.relationships.group.data.id = scope.externalPropertyId;
      if (kind === "channel") data.data.id = scope.groupId;
      if (kind === "provider") data.data.attributes.channel = "BookingCom";
      if (kind === "multi-property") data.data.attributes.properties.push(scope.groupId);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(data));
      await expect(readChannexAirbnbImport(scope, options(fetcher))).rejects.toThrow(
        "does not match",
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects invalid scope before sending credentials", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      readChannexAirbnbImport({ ...scope, channelId: "../elsewhere" }, options(fetcher)),
    ).rejects.toThrow("Invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[], [2], [1, 3], [1, 1], [0, 1], ["1"], null].map((occupancies) => ({ occupancies })))(
    "leaves ambiguous capacity unknown: %j",
    ({ occupancies }) => {
      expect(
        normalizeChannexAirbnbListings(listings([{ id: "123", title: "Loft", occupancies }]))
          .rooms[0]?.maxGuests,
      ).toBeNull();
    },
  );
  it("supports empty accounts and an unordered complete occupancy sequence", () => {
    expect(normalizeChannexAirbnbListings(listings([])).rooms).toEqual([]);
    expect(
      normalizeChannexAirbnbListings(listings([{ id: "123", title: "Loft", occupancies: [2, 1] }]))
        .rooms[0]?.maxGuests,
    ).toBe(2);
  });
  it.each(
    [
      [
        { id: "1", title: "Loft" },
        { id: "1", title: "Other" },
      ],
      [{ id: "1", title: "" }],
      [{ id: "1", title: "x".repeat(201) }],
      [{ id: "../bad", title: "Loft" }],
      Array.from({ length: 51 }, (_, id) => ({ id: String(id), title: "Loft" })),
    ].map((items) => ({ items })),
  )("rejects invalid or duplicate listing data", ({ items }) => {
    expect(() => normalizeChannexAirbnbListings(listings(items))).toThrow("Invalid");
  });
  it.each(["http", "json", "oversize", "network"])(
    "does not expose provider payloads on %s failure",
    async (kind) => {
      const fetcher = vi.fn<typeof fetch>();
      if (kind === "network")
        fetcher.mockRejectedValue(new Error("synthetic-key private-provider-detail"));
      else
        fetcher.mockResolvedValue(
          new Response(kind === "oversize" ? "x".repeat(262_145) : "private-provider-detail", {
            status: kind === "http" ? 403 : 200,
          }),
        );
      await expect(readChannexAirbnbImport(scope, options(fetcher))).rejects.toThrow(
        /^Airbnb listing source could not be read$/,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
});
