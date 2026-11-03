import { describe, expect, it } from "vitest";

import {
  firstRunIdempotencyKey,
  runFirstRunCurrency,
  runFirstRunPayments,
  type HotelFirstRunActor,
  type HotelFirstRunSetupPorts,
} from "./hotelFirstRunSteps.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const organizationId = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d";
const actor: HotelFirstRunActor = {
  organizationId,
  propertyId,
  userId: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
  requestId: "req-1",
  correlationId: null,
  requestedAt: "2026-10-20T09:00:00.000Z",
};
/** In-memory PMS + Finance behind the first-run ports; records every command it receives. */
function fakeHotel(start: { currency?: string; methods?: string[] } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const state = {
    currency: start.currency ? { currency: start.currency, pricingCurrencyRevision: 1 } : null,
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

describe("first run currency and payments steps (VAY-2247)", () => {
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
