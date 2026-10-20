import { describe, expect, it, vi } from "vitest";

import {
  createHotelSetupChecklistService,
  type HotelSetupChecklistFactsRow,
} from "./hotelSetupChecklistService.js";
import type { HotelFirstRunState } from "./hotelFirstRunState.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const actor = {
  organizationId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d",
  propertyId,
  userId: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
  requestId: "req-1",
  correlationId: null,
  requestedAt: "2026-10-20T09:00:00.000Z",
};

function state(done: readonly string[]): HotelFirstRunState {
  return {
    contractVersion: "hotel-first-run.v1",
    propertyId,
    steps: ["currency", "rooms", "payments", "pricing", "calendar", "guest_rules", "plan"].map(
      (id) => ({ id, state: done.includes(id) ? "done" : "todo", reasons: [] }),
    ),
    nextStep: null,
  } as unknown as HotelFirstRunState;
}

const LIVE: HotelSetupChecklistFactsRow = {
  hotelBasics: true,
  bookingPublished: true,
  photos: false,
  style: false,
  calendar: "default",
  guestTerms: "default",
  onlineCardReady: false,
  viewer: { hidden: false, dismissed: false },
};

function service(
  done: readonly string[],
  facts: HotelSetupChecklistFactsRow | null = LIVE,
  onlineCardsOffered = false,
) {
  const store = {
    acknowledge: vi.fn(async () => undefined),
    setViewer: vi.fn(async () => undefined),
  };
  return {
    store,
    checklist: createHotelSetupChecklistService({
      firstRun: { read: vi.fn(async () => state(done)) },
      facts: { read: vi.fn(async () => facts) },
      store,
      onlineCardsOffered,
    }),
  };
}

const ALL = ["currency", "rooms", "payments", "pricing", "calendar", "guest_rules", "plan"];

describe("hotel setup checklist service (VAY-2247 wave 2)", () => {
  it("shows a hotel that went live through the first run with 4 of 9 done", async () => {
    expect(await service(ALL).checklist.read(actor)).toMatchObject({
      phase: "live",
      done: 4,
      total: 9,
    });
  });

  it("follows the setup screens before the page is published", async () => {
    const unpublished = { ...LIVE, bookingPublished: false };
    expect((await service(["currency"], unpublished).checklist.read(actor))?.setup).toEqual({
      done: 2,
      total: 5,
      next: "first_room",
    });
    expect(
      (await service(["currency", "rooms", "pricing"], unpublished).checklist.read(actor))?.setup
        .next,
    ).toBe("guest_payment");
    expect((await service(ALL, unpublished).checklist.read(actor))?.setup.next).toBe("go_live");
  });

  it("says Later for online cards until they're offered", async () => {
    const later = await service(ALL).checklist.read(actor);
    expect(later?.items.find((item) => item.id === "online_cards")?.state).toBe("later");
    const offered = await service(ALL, LIVE, true).checklist.read(actor);
    expect(offered?.items.find((item) => item.id === "online_cards")?.state).toBe("todo");
  });

  it("writes Looks good and the viewer's change, then answers with the checklist", async () => {
    const { checklist, store } = service(ALL);
    expect(await checklist.acknowledge(actor, "calendar")).toMatchObject({ phase: "live" });
    expect(store.acknowledge).toHaveBeenCalledWith(actor, "calendar");
    await checklist.setViewer(actor, { hidden: true });
    expect(store.setViewer).toHaveBeenCalledWith(actor, { hidden: true });
  });

  it("has no checklist for a hotel that isn't there", async () => {
    expect(await service(ALL, null).checklist.read(actor)).toBeNull();
  });
});
