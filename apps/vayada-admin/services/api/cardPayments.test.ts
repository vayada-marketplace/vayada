import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./client", () => ({ apiClient: { get: mocks.get } }));

import {
  hotelCardPaymentsService,
  hotelCardPaymentsView,
  type HotelCardPaymentsState,
} from "./cardPayments";

const propertyId = "11111111-1111-4111-8111-111111111111";
const state = (change: Partial<HotelCardPaymentsState> = {}): HotelCardPaymentsState => ({
  propertyId,
  providerAccount: { ready: true, cardCapabilityRevision: 3 },
  propertyReadinessRevision: 7,
  paymentSettings: { paymentsOn: true, cardChosen: true, currencyEligible: true },
  evidence: null,
  cardReady: true,
  ...change,
});

describe("hotel card payments (VAY-2205, read only since VAY-2442)", () => {
  beforeEach(() => mocks.get.mockReset());

  it("is on whenever Finance says card is ready, with no Vayada approval", () => {
    expect(hotelCardPaymentsView(state())).toMatchObject({
      on: true,
      linked: true,
      accountReady: true,
      hotelChoseCard: true,
    });
    expect(hotelCardPaymentsView(state({ cardReady: false })).on).toBe(false);
    expect(
      hotelCardPaymentsView(
        state({ cardReady: false, providerAccount: { ready: false, cardCapabilityRevision: 1 } }),
      ),
    ).toMatchObject({ on: false, linked: true, accountReady: false });
    expect(hotelCardPaymentsView(state({ cardReady: false, providerAccount: null }))).toMatchObject(
      { linked: false, accountReady: false },
    );
    for (const paymentSettings of [
      { paymentsOn: true, cardChosen: false, currencyEligible: true },
      { paymentsOn: false, cardChosen: true, currencyEligible: true },
      { paymentsOn: true, cardChosen: true, currencyEligible: false },
      null,
    ])
      expect(hotelCardPaymentsView(state({ paymentSettings })).hotelChoseCard).toBe(false);
    expect(
      hotelCardPaymentsView(
        state({ paymentSettings: { paymentsOn: true, cardChosen: true, currencyEligible: false } }),
      ).currencyEligible,
    ).toBe(false);
    expect(hotelCardPaymentsView(state({ prices: "save_needed" })).pricesSaveNeeded).toBe(true);
    expect(hotelCardPaymentsView(state({ prices: "current" })).pricesSaveNeeded).toBe(false);
  });

  it("reads the hotel's card state and offers no way to turn card on or off", async () => {
    mocks.get.mockResolvedValue(state());
    await expect(hotelCardPaymentsService.read(propertyId)).resolves.toEqual(state());
    expect(mocks.get).toHaveBeenCalledWith(
      `/api/finance/platform/properties/${propertyId}/online-card-execution-evidence`,
    );
    expect(Object.keys(hotelCardPaymentsService)).toEqual(["read"]);
  });
});
