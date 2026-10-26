import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("./client", () => ({ apiClient: { get: mocks.get, post: mocks.post } }));

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
  cardReady: false,
  ...change,
});

describe("hotel card payments (VAY-2205)", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
  });

  it("turns on only a ready Stripe account, and shows the approval in force as on", () => {
    expect(hotelCardPaymentsView(state())).toMatchObject({
      on: false,
      linked: true,
      stripeReady: true,
      canTurnOn: true,
    });
    expect(
      hotelCardPaymentsView(
        state({ providerAccount: { ready: false, cardCapabilityRevision: 1 } }),
      ),
    ).toMatchObject({ stripeReady: false, canTurnOn: false });
    expect(hotelCardPaymentsView(state({ providerAccount: null }))).toMatchObject({
      linked: false,
      canTurnOn: false,
    });
    expect(hotelCardPaymentsView(state({ propertyReadinessRevision: null })).canTurnOn).toBe(false);
    // The hotel chooses card first: an approval given before would go out of date.
    for (const paymentSettings of [
      { paymentsOn: true, cardChosen: false, currencyEligible: true },
      { paymentsOn: false, cardChosen: true, currencyEligible: true },
      { paymentsOn: true, cardChosen: true, currencyEligible: false },
      null,
    ])
      expect(hotelCardPaymentsView(state({ paymentSettings }))).toMatchObject({
        hotelChoseCard: false,
        canTurnOn: false,
      });
    expect(
      hotelCardPaymentsView(
        state({ paymentSettings: { paymentsOn: true, cardChosen: true, currencyEligible: false } }),
      ).currencyEligible,
    ).toBe(false);
    const approval = {
      evidenceId: "22222222-2222-4222-8222-222222222222",
      acceptedAt: "2026-10-18T19:40:00.000Z",
      acceptedByUserId: "33333333-3333-4333-8333-333333333333",
      current: true,
    };
    expect(hotelCardPaymentsView(state({ evidence: approval, cardReady: true }))).toMatchObject({
      on: true,
      approvalOutOfDate: false,
      approval,
      canTurnOn: false,
    });
    // An approval given for an earlier Stripe account or Payment settings: not on, and only
    // off-then-on renews it.
    expect(
      hotelCardPaymentsView(state({ evidence: { ...approval, current: false }, cardReady: false })),
    ).toMatchObject({ on: false, approvalOutOfDate: true, canTurnOn: false });
    // A current approval while the hotel turned card off in its Payment settings: off, not out
    // of date.
    expect(
      hotelCardPaymentsView(
        state({
          evidence: approval,
          cardReady: false,
          paymentSettings: { paymentsOn: true, cardChosen: false, currencyEligible: true },
        }),
      ),
    ).toMatchObject({ on: false, approvalOutOfDate: false, hotelChoseCard: false });
    expect(hotelCardPaymentsView(state({ prices: "save_needed" })).pricesSaveNeeded).toBe(true);
    expect(hotelCardPaymentsView(state({ prices: "current" })).pricesSaveNeeded).toBe(false);
  });

  it("reads the hotel's card state", async () => {
    mocks.get.mockResolvedValue(state());
    await expect(hotelCardPaymentsService.read(propertyId)).resolves.toEqual(state());
    expect(mocks.get).toHaveBeenCalledWith(
      `/api/finance/platform/properties/${propertyId}/online-card-execution-evidence`,
    );
  });

  it("sends Vayada's approval for the revisions it was shown; the server records the time", async () => {
    mocks.post.mockResolvedValue({});
    await hotelCardPaymentsService.turnOn(state());
    expect(mocks.post).toHaveBeenCalledWith(
      `/api/finance/platform/properties/${propertyId}/online-card-execution-evidence`,
      {
        commandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
        expectedCardCapabilityRevision: 3,
        expectedPropertyReadinessRevision: 7,
      },
    );
    await expect(hotelCardPaymentsService.turnOn(state({ providerAccount: null }))).rejects.toThrow(
      "isn't ready",
    );
  });

  it("withdraws the approval in force to turn card off", async () => {
    mocks.post.mockResolvedValue({});
    await hotelCardPaymentsService.turnOff(propertyId, "22222222-2222-4222-8222-222222222222");
    expect(mocks.post).toHaveBeenCalledWith(
      `/api/finance/platform/properties/${propertyId}/online-card-execution-evidence/22222222-2222-4222-8222-222222222222/revoke`,
      {
        commandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    );
  });
});
