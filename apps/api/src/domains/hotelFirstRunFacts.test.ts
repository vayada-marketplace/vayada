import { describe, expect, it } from "vitest";

import {
  createHotelFirstRunFactsReader,
  type HotelFirstRunFactsPorts,
} from "./hotelFirstRunFacts.js";
import type { HotelFirstRunActor } from "./hotelFirstRunSteps.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const roomTypeId = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";
const actor = {
  organizationId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d",
  propertyId,
  userId: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
} as HotelFirstRunActor;

type Hotel = {
  set?: boolean;
  codes?: string[] | null;
  unlabelled?: number;
  plan?: { plan: "commission" | "fixed" | null; checkoutPending: boolean };
};

function ports(hotel: Hotel = {}): HotelFirstRunFactsPorts {
  const set = hotel.set ?? false;
  const unit = (n: number, verified: boolean) => ({
    roomUnitId: `u-${n}`,
    lifecycle: "active",
    operationalLabelStatus: verified ? "verified" : "unverified",
  });
  return {
    profile: {
      getPropertyProfile: async () => ({
        propertyId,
        profileRevision: 4,
        profile: {
          location: {
            countryCode: "DE",
            timezone: "Europe/Berlin",
            city: "Munich",
            localityPublic: set,
          },
        },
      }),
    },
    language: { read: async () => "de" },
    pricingRead: {
      getPropertyPricingCurrency: async () =>
        set ? { currency: "EUR", pricingCurrencyRevision: 2 } : null,
    },
    roomRead: {
      listRoomTypeFacts: async () => (set ? [{ roomTypeId, roomFactsRevision: 1 }] : []),
      // The first run made one room type here: the second draft has none, which ends the list.
      getDraftRoomTypeBinding: async (_propertyId: string, draftRoomId: string) =>
        set && draftRoomId === "first-run-room-1" ? { roomTypeId } : null,
      getRoomTypeCapacity: async () => ({ roomUnitsRevision: 9, activeUnitCount: 3 }),
      listPhysicalRoomUnitIdentities: async () =>
        [1, 2, 3].map((n) => unit(n, n > (hotel.unlabelled ?? 0))),
    },
    paymentRead: {
      getPaymentReadiness: async () =>
        set
          ? {
              pricingCurrency: { matchesCurrent: true },
              methods: [{ method: "pay_at_property", selected: true }],
            }
          : null,
    },
    pricing: { read: async () => (set ? { rooms: [{ roomTypeId, offers: [{}] }] } : null) },
    calendarRead: {
      getCurrentOperatingCalendarConfiguration: async () =>
        set ? { sourceStatus: "current" } : null,
    },
    guestRules: { read: async () => (set ? { revision: "r", choices: {} } : null) },
    terms: { read: async () => ({ termsText: set ? "Terms." : null }) },
    designRead: { getCurrentDesign: async () => (set ? { revision: 1 } : null) },
    plans: {
      getPlanStatus: async () =>
        hotel.plan ?? { plan: set ? "commission" : null, checkoutPending: false },
    },
    readiness: {
      getBookingReadiness: async () =>
        hotel.codes === null
          ? { outcome: "provider_failure" }
          : {
              outcome: "evaluated",
              groups: [
                {
                  steps: [
                    { entities: [{ blockers: (hotel.codes ?? []).map((code) => ({ code })) }] },
                  ],
                },
              ],
            },
    },
  } as unknown as HotelFirstRunFactsPorts;
}

const read = (hotel?: Hotel) => createHotelFirstRunFactsReader(ports(hotel)).read(actor);

describe("first-run facts reader (VAY-2247)", () => {
  it("reads a fresh hotel: a profile and nothing else", async () => {
    expect(await read()).toMatchObject({
      firstRunRoomTypeIds: [],
      language: "de",
      profile: {
        revision: 4,
        countryCode: "DE",
        timezone: "Europe/Berlin",
        city: "Munich",
        localityPublic: false,
      },
      currency: null,
      roomTypes: [],
      payments: { payAtPropertySelected: false, currencyMatches: false },
      pricing: { pricedRoomTypeIds: [], staleReasons: [] },
      calendar: { configured: false, stale: false, inventoryPrepared: false },
      guestRules: { rulesSaved: false, termsSaved: false, designSaved: false },
      plan: "none",
    });
  });

  it("reads a hotel after a complete first run", async () => {
    expect(await read({ set: true })).toMatchObject({
      firstRunRoomTypeIds: [roomTypeId],
      currency: { code: "EUR", revision: 2 },
      roomTypes: [
        {
          roomTypeId,
          roomFactsRevision: 1,
          roomUnitsRevision: 9,
          activeUnitCount: 3,
          unlabelledUnitIds: [],
        },
      ],
      payments: { payAtPropertySelected: true, currencyMatches: true },
      pricing: { pricedRoomTypeIds: [roomTypeId], staleReasons: [] },
      calendar: { configured: true, stale: false, inventoryPrepared: true },
      guestRules: { rulesSaved: true, termsSaved: true, designSaved: true },
      plan: "commission",
    });
  });

  it("takes stale prices and unprepared days from the publish readiness", async () => {
    const facts = await read({
      set: true,
      codes: [
        "pricing_rooms_changed",
        "inventory_launch_readiness_incomplete",
        "room_photo_required",
      ],
    });
    expect(facts.pricing.staleReasons).toEqual(["pricing_rooms_changed"]);
    expect(facts.calendar.inventoryPrepared).toBe(false);
  });

  it("counts days as not prepared when readiness can't be evaluated right now", async () => {
    expect((await read({ set: true, codes: null })).calendar.inventoryPrepared).toBe(false);
  });

  it("lists the rooms that still need a name", async () => {
    expect((await read({ set: true, unlabelled: 2 })).roomTypes[0]!.unlabelledUnitIds).toEqual([
      "u-1",
      "u-2",
    ]);
  });

  it("tells a pending Fixed Fee checkout apart from a hotel without a plan", async () => {
    expect((await read({ plan: { plan: null, checkoutPending: true } })).plan).toBe(
      "fixed_checkout_pending",
    );
    expect((await read({ plan: { plan: "fixed", checkoutPending: false } })).plan).toBe("fixed");
  });

  it("reads one thing at a time, never in parallel (incident 2026-10-21)", async () => {
    let inFlight = 0;
    let most = 0;
    const counted = ports({ set: true }) as unknown as Record<string, Record<string, unknown>>;
    for (const port of Object.values(counted)) {
      for (const [name, fn] of Object.entries(port)) {
        if (typeof fn !== "function") continue;
        port[name] = async (...args: unknown[]) => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          try {
            return await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
          } finally {
            inFlight -= 1;
          }
        };
      }
    }
    const reader = createHotelFirstRunFactsReader(counted as unknown as HotelFirstRunFactsPorts);
    expect((await reader.read(actor)).roomTypes).toHaveLength(1);
    await reader.readSetupProgress(actor);
    expect(most).toBe(1);
  });
});

describe("first-run setup progress for the checklist (VAY-2247 incident)", () => {
  const progress = (hotel?: Hotel, override: Partial<HotelFirstRunFactsPorts> = {}) =>
    createHotelFirstRunFactsReader({ ...ports(hotel), ...override }).readSetupProgress(actor);

  it("says neither is done on a fresh hotel", async () => {
    expect(await progress()).toEqual({ firstRoom: false, guestPayment: false });
  });

  it("says both are done after a complete first run, without the booking readiness", async () => {
    const readiness = {
      getBookingReadiness: async () => {
        throw new Error("the checklist must not evaluate the booking readiness");
      },
    } as unknown as HotelFirstRunFactsPorts["readiness"];
    expect(await progress({ set: true }, { readiness })).toEqual({
      firstRoom: true,
      guestPayment: true,
    });
  });

  it("keeps how guests pay open while the Fixed Fee checkout is pending", async () => {
    expect(await progress({ set: true, plan: { plan: null, checkoutPending: true } })).toEqual({
      firstRoom: true,
      guestPayment: false,
    });
  });
});
