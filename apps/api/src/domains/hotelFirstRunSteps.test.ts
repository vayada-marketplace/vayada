import { describe, expect, it } from "vitest";

import {
  firstRunIdempotencyKey,
  runFirstRunCurrency,
  runFirstRunPayments,
  runFirstRunRooms,
  type HotelFirstRunActor,
  type HotelFirstRunSetupPorts,
} from "./hotelFirstRunSteps.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const organizationId = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d";
const roomTypeId = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";
const actor: HotelFirstRunActor = {
  organizationId,
  propertyId,
  userId: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
  requestId: "req-1",
  correlationId: null,
  requestedAt: "2026-10-20T09:00:00.000Z",
};
const room = { name: "Classic Double", numberOfRooms: 3, maxGuests: 2, pricePerNight: "145" };

type Unit = { roomUnitId: string; operationalLabel: string | null; verified: boolean };
const unitId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** In-memory PMS + Finance behind the first-run ports; records every command it receives. */
function fakeHotel(start: { currency?: string; ownRoomTypes?: number; methods?: string[] } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const state = {
    currency: start.currency ? { currency: start.currency, pricingCurrencyRevision: 1 } : null,
    boundRoomTypeId: null as string | null,
    ownRoomTypes: start.ownRoomTypes ?? 0,
    // A new room type starts at room-units revision 1 (the reconcile parser refuses 0).
    unitsRevision: 1,
    units: [] as Unit[],
    methods: start.methods ?? ([] as string[]),
    methodsRevision: start.methods ? 1 : 0,
    methodsCurrencyRevision: start.methods ? 1 : 0,
  };
  const record = (name: string, command: unknown) =>
    calls.push([name, command as Record<string, unknown>]);
  const ports = {
    pricingRead: {
      getPropertyPricingCurrency: async () =>
        state.currency
          ? { ...state.currency, propertyId, contractVersion: "x", createdAt: "", updatedAt: "" }
          : null,
    },
    currency: {
      upsertPropertyPricingCurrency: async (command: { currency: string }) => {
        record("currency", command);
        state.currency = { currency: command.currency, pricingCurrencyRevision: 1 };
        return { ok: true, response: {} };
      },
    },
    roomRead: {
      listRoomTypeFacts: async () =>
        Array.from({ length: state.ownRoomTypes + (state.boundRoomTypeId ? 1 : 0) }, () => ({})),
      // One first-run room type here; several are walked on the real database.
      getDraftRoomTypeBinding: async (_propertyId: string, draftRoomId: string) =>
        draftRoomId === "first-run-room-1" && state.boundRoomTypeId
          ? { roomTypeId: state.boundRoomTypeId }
          : null,
      getRoomTypeCapacity: async () => ({
        roomUnitsRevision: state.unitsRevision,
        activeUnitCount: state.units.length,
      }),
      listPhysicalRoomUnitIdentities: async () =>
        state.units.map((unit) => ({
          roomUnitId: unit.roomUnitId,
          lifecycle: "active",
          operationalLabel: unit.operationalLabel,
          operationalLabelStatus: unit.verified ? "verified" : "unverified",
        })),
    },
    roomFacts: {
      createRoomTypeFacts: async (command: unknown) => {
        record("room_type", command);
        state.boundRoomTypeId = roomTypeId;
        return { ok: true, response: { roomType: { roomTypeId } } };
      },
    },
    units: {
      reconcilePhysicalRoomUnits: async (command: {
        targetActiveUnitCount: number;
        expectedRevision: number;
      }) => {
        record("units", command);
        expect(command.expectedRevision).toBe(state.unitsRevision);
        state.units = Array.from({ length: command.targetActiveUnitCount }, (_, index) => ({
          roomUnitId: unitId(index + 1),
          operationalLabel: null,
          verified: false,
        }));
        state.unitsRevision += 1;
        return { ok: true, response: { capacity: { roomUnitsRevision: state.unitsRevision } } };
      },
    },
    labels: {
      setPhysicalRoomOperationalLabel: async (command: {
        roomUnitId: string;
        operationalLabel: string;
        expectedRevision: number;
      }) => {
        record("label", command);
        expect(command.expectedRevision).toBe(state.unitsRevision);
        const unit = state.units.find((current) => current.roomUnitId === command.roomUnitId)!;
        Object.assign(unit, { operationalLabel: command.operationalLabel, verified: true });
        state.unitsRevision += 1;
        return { ok: true, response: { roomUnitsRevision: state.unitsRevision } };
      },
    },
    paymentRead: {
      getPaymentReadiness: async () =>
        state.methodsRevision === 0
          ? null
          : {
              paymentMethodsRevision: state.methodsRevision,
              pricingCurrency: {
                current: state.currency
                  ? {
                      contractVersion: "x",
                      currency: state.currency.currency,
                      pricingCurrencyRevision: 1,
                    }
                  : null,
                committed: null,
                matchesCurrent: state.methodsCurrencyRevision === 1,
              },
              methods: ["pay_at_property", "bank_transfer"].map((method) => ({
                method,
                selected: state.methods.includes(method),
              })),
            },
    },
    payments: {
      replacePaymentMethods: async (command: { selectedMethods: string[] }) => {
        record("payments", command);
        state.methods = [...command.selectedMethods];
        state.methodsRevision += 1;
        state.methodsCurrencyRevision = 1;
        return { ok: true, response: {} };
      },
    },
  } as unknown as HotelFirstRunSetupPorts;
  return { ports, calls, state };
}

describe("first run steps 1–3 (VAY-2247)", () => {
  it("currency: starts a German hotel in EUR at revision 0, and leaves an existing currency alone", async () => {
    const hotel = fakeHotel();
    expect(await runFirstRunCurrency(hotel.ports, actor, "DE")).toEqual({ ok: true, wrote: true });
    expect(hotel.calls).toEqual([
      [
        "currency",
        expect.objectContaining({ currency: "EUR", expectedPricingCurrencyRevision: 0 }),
      ],
    ]);
    expect(await runFirstRunCurrency(hotel.ports, actor, "CH")).toEqual({ ok: true, wrote: false });
    expect(hotel.calls).toHaveLength(1);
  });

  it("rooms: creates the room type, its rooms and names them Room 1–3, chaining the units revision", async () => {
    const hotel = fakeHotel();
    expect(await runFirstRunRooms(hotel.ports, actor, [room])).toEqual({ ok: true, wrote: true });
    expect(hotel.calls.map(([name]) => name)).toEqual([
      "room_type",
      "units",
      "label",
      "label",
      "label",
    ]);
    expect(hotel.calls[0]![1]).toMatchObject({
      draftRoomId: "first-run-room-1",
      expectedRevision: 0,
      facts: { name: "Classic Double", beds: [{ type: "double", quantity: 1 }] },
    });
    expect(hotel.state.units.map((unit) => unit.operationalLabel)).toEqual([
      "Room 1",
      "Room 2",
      "Room 3",
    ]);
    // A second run finds everything in place and writes nothing.
    expect(await runFirstRunRooms(hotel.ports, actor, [room])).toEqual({ ok: true, wrote: false });
    expect(hotel.calls).toHaveLength(5);
  });

  it("rooms: resumes after a crash halfway through naming the rooms", async () => {
    const hotel = fakeHotel();
    hotel.state.boundRoomTypeId = roomTypeId;
    hotel.state.units = [
      { roomUnitId: unitId(1), operationalLabel: "Room 1", verified: true },
      { roomUnitId: unitId(2), operationalLabel: null, verified: false },
      { roomUnitId: unitId(3), operationalLabel: null, verified: false },
    ];
    hotel.state.unitsRevision = 3;
    expect(await runFirstRunRooms(hotel.ports, actor, [room])).toEqual({ ok: true, wrote: true });
    expect(hotel.calls.map(([name, command]) => [name, command["operationalLabel"]])).toEqual([
      ["label", "Room 2"],
      ["label", "Room 3"],
    ]);
  });

  it("rooms: leaves a hotel alone that already set up its own room types", async () => {
    const hotel = fakeHotel({ ownRoomTypes: 2 });
    expect(await runFirstRunRooms(hotel.ports, actor, [room])).toEqual({ ok: true, wrote: false });
    expect(hotel.calls).toEqual([]);
  });

  it("rooms: refuses an invalid room before writing anything", async () => {
    const hotel = fakeHotel();
    expect(
      await runFirstRunRooms(hotel.ports, actor, [{ ...room, numberOfRooms: 0 }]),
    ).toMatchObject({
      ok: false,
      code: "first_run_room_invalid",
    });
    expect(hotel.calls).toEqual([]);
  });

  it("payments: selects pay at the property, and keeps what the owner already chose", async () => {
    const fresh = fakeHotel({ currency: "EUR" });
    expect(await runFirstRunPayments(fresh.ports, actor)).toEqual({ ok: true, wrote: true });
    expect(fresh.calls).toEqual([
      [
        "payments",
        expect.objectContaining({
          selectedMethods: ["pay_at_property"],
          expectedPaymentMethodsRevision: 0,
          expectedPricingCurrencyRevision: 1,
        }),
      ],
    ]);
    expect(await runFirstRunPayments(fresh.ports, actor)).toEqual({ ok: true, wrote: false });

    const owner = fakeHotel({ currency: "EUR", methods: ["bank_transfer"] });
    await runFirstRunPayments(owner.ports, actor);
    // The payment command keeps its own canonical order.
    expect([...owner.state.methods].sort()).toEqual(["bank_transfer", "pay_at_property"]);
  });

  it("payments: needs a currency first", async () => {
    expect(await runFirstRunPayments(fakeHotel().ports, actor)).toMatchObject({
      ok: false,
      code: "first_run_payments_currency_missing",
    });
  });

  it("keys are stable per property, step and input, and short enough for every command", () => {
    const key = firstRunIdempotencyKey(propertyId, "currency", "EUR");
    expect(key).toBe(firstRunIdempotencyKey(propertyId, "currency", "EUR"));
    expect(key).not.toBe(firstRunIdempotencyKey(propertyId, "currency", "CHF"));
    expect(key).toMatch(/^first-run:v1:currency:[0-9a-f]{64}$/);
    expect(
      firstRunIdempotencyKey(propertyId, "room_label", ["unit", "Room 12"]).length,
    ).toBeLessThanOrEqual(200);
  });
});
