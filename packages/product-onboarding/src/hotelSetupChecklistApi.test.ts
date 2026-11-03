import { buildHotelGoLiveChecklist } from "@vayada/domain-hotels";
import { describe, expect, it, vi } from "vitest";

import { createHotelSetupChecklistClient } from "./hotelSetupChecklistApi";

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";

function http(answer: unknown) {
  return {
    get: vi.fn(async () => answer),
    post: vi.fn(async () => answer),
    put: vi.fn(async () => answer),
  };
}

const GO_LIVE = buildHotelGoLiveChecklist({
  propertyId: PROPERTY,
  propertyDetails: true,
  setupFinished: true,
  roomTypes: [{ name: "Pool Villa", rooms: 2, maxGuests: 4, photos: 1, priced: true }],
  placeholderPrices: true,
  bookingRules: "default",
  propertyPhotos: false,
  bookingPublished: false,
  onlineCardReady: false,
  onlineCardsOffered: false,
  viewer: { hidden: false, dismissed: false },
});

describe("go-live checklist client (VAY-2451)", () => {
  it("reads the go-live list, or null while the API doesn't serve it (404)", async () => {
    const api = http(JSON.parse(JSON.stringify(GO_LIVE)));
    const client = createHotelSetupChecklistClient(api);
    expect(await client.loadGoLive(PROPERTY)).toEqual(GO_LIVE);
    expect(api.get).toHaveBeenCalledWith(`/api/hotel-setup/properties/${PROPERTY}/checklist/v2`, {
      cache: "no-store",
    });
    await client.looksGoodGoLive(PROPERTY, "guest_terms");
    expect(api.post).toHaveBeenCalledWith(
      `/api/hotel-setup/properties/${PROPERTY}/checklist/v2/acknowledgements`,
      { item: "guest_terms" },
    );
    const off = http(null);
    off.get.mockRejectedValueOnce(Object.assign(new Error("Not found"), { status: 404 }));
    expect(await createHotelSetupChecklistClient(off).loadGoLive(PROPERTY)).toBeNull();
    const down = http(null);
    down.get.mockRejectedValueOnce(Object.assign(new Error("Down"), { status: 503 }));
    await expect(createHotelSetupChecklistClient(down).loadGoLive(PROPERTY)).rejects.toThrow(
      "Down",
    );
  });

  it("changes the viewer's own state", async () => {
    const api = http(JSON.parse(JSON.stringify(GO_LIVE)));
    await createHotelSetupChecklistClient(api).setGoLiveViewer(PROPERTY, { dismissed: true });
    expect(api.put).toHaveBeenCalledWith(
      `/api/hotel-setup/properties/${PROPERTY}/checklist/v2/viewer`,
      { dismissed: true },
    );
  });

  it("refuses an answer it can't read or for another hotel", async () => {
    await expect(
      createHotelSetupChecklistClient(http({ nope: true })).loadGoLive(PROPERTY),
    ).rejects.toThrow(/invalid or belongs to another hotel/);
    const other = {
      ...JSON.parse(JSON.stringify(GO_LIVE)),
      propertyId: "0b1c2d3e-4f50-4617-8899-aabbccddeeff",
    };
    await expect(
      createHotelSetupChecklistClient(http(other)).loadGoLive(PROPERTY),
    ).rejects.toThrow();
  });
});
