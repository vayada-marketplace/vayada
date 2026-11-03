import { describe, expect, it, vi } from "vitest";

import {
  createHotelSetupChecklistService,
  type HotelGoLiveFactsRow,
} from "./hotelSetupChecklistService.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const actor = {
  organizationId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d",
  propertyId,
  userId: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
  requestId: "req-1",
  correlationId: null,
  requestedAt: "2026-10-20T09:00:00.000Z",
};

/** The first run's light setup-progress read, from the first-run steps that are done. */
function progress(done: readonly string[]) {
  return { guestPayment: done.includes("payments") && done.includes("plan") };
}

/** VAY-2451: a hotel that finished the four-step setup with its room, on the placeholder price. */
const GO_LIVE: HotelGoLiveFactsRow = {
  propertyDetails: true,
  bookingPublished: false,
  propertyPhotos: false,
  bookingRules: "default",
  onlineCardReady: false,
  roomTypes: [{ name: "Pool Villa", rooms: 2, maxGuests: 4, photos: 1, priced: true }],
  placeholderPrices: true,
  viewer: { hidden: false, dismissed: false },
};

function service(
  done: readonly string[],
  goLive: HotelGoLiveFactsRow | null = GO_LIVE,
  onlineCardsOffered = false,
) {
  const store = {
    acknowledge: vi.fn(async () => undefined),
    setViewer: vi.fn(async () => undefined),
  };
  return {
    store,
    checklist: createHotelSetupChecklistService({
      firstRun: { readSetupProgress: vi.fn(async () => progress(done)) },
      goLiveFacts: { read: vi.fn(async () => goLive) },
      store,
      onlineCardsOffered,
    }),
  };
}

const ALL = ["currency", "rooms", "payments", "pricing", "calendar", "guest_rules", "plan"];

describe("go-live checklist service (VAY-2247 wave 2, VAY-2451)", () => {
  it("reads the hotel and its setup progress one after the other, never in parallel (incident 2026-10-21)", async () => {
    let inFlight = 0;
    let most = 0;
    const timed = <T>(value: T) =>
      vi.fn(async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return value;
      });
    const checklist = createHotelSetupChecklistService({
      firstRun: { readSetupProgress: timed(progress(ALL)) },
      goLiveFacts: { read: timed(GO_LIVE) },
      store: { acknowledge: vi.fn(), setViewer: vi.fn() },
      onlineCardsOffered: false,
    });
    expect(await checklist.readGoLive(actor)).toMatchObject({ phase: "go_live" });
    expect(most).toBe(1);
  });

  it("is past setup once how guests pay and the plan are saved", async () => {
    expect(await service(ALL).checklist.readGoLive(actor)).toMatchObject({
      contractVersion: "hotel-setup-checklist.v2",
      phase: "go_live",
      setup: { done: 4, total: 4, next: null },
      canPublish: false,
      placeholderPrices: true,
      firstRoomType: { name: "Pool Villa" },
    });
    expect((await service(["currency"]).checklist.readGoLive(actor))?.setup).toEqual({
      done: 3,
      total: 4,
      next: "payments",
    });
  });

  it("says Later for online cards until they're offered", async () => {
    expect((await service(ALL).checklist.readGoLive(actor))?.later).toEqual([
      { id: "online_cards", state: "later" },
    ]);
    expect((await service(ALL, GO_LIVE, true).checklist.readGoLive(actor))?.later).toEqual([
      { id: "online_cards", state: "todo" },
    ]);
  });

  it("writes Looks good and the viewer's change, then answers with the go-live list", async () => {
    const { checklist, store } = service(ALL);
    expect(await checklist.acknowledge(actor, "guest_terms")).toMatchObject({
      contractVersion: "hotel-setup-checklist.v2",
    });
    expect(store.acknowledge).toHaveBeenCalledWith(actor, "guest_terms");
    expect(await checklist.setViewer(actor, { dismissed: true })).toMatchObject({
      contractVersion: "hotel-setup-checklist.v2",
    });
    expect(store.setViewer).toHaveBeenCalledWith(actor, { dismissed: true });
  });

  it("has no list for a hotel that isn't there", async () => {
    expect(await service(ALL, null).checklist.readGoLive(actor)).toBeNull();
  });
});
