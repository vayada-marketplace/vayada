import { createHash } from "node:crypto";
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
    const approval = {
      evidenceId: "22222222-2222-4222-8222-222222222222",
      acceptedAt: "2026-10-18T19:40:00.000Z",
      acceptedByUserId: "33333333-3333-4333-8333-333333333333",
    };
    expect(hotelCardPaymentsView(state({ evidence: approval, cardReady: true }))).toMatchObject({
      on: true,
      approval,
      canTurnOn: false,
    });
  });

  it("reads the hotel's card state", async () => {
    mocks.get.mockResolvedValue(state());
    await expect(hotelCardPaymentsService.read(propertyId)).resolves.toEqual(state());
    expect(mocks.get).toHaveBeenCalledWith(
      `/api/finance/platform/properties/${propertyId}/online-card-execution-evidence`,
    );
  });

  it("sends Vayada's approval for the revisions it was shown, as an attestation", async () => {
    mocks.post.mockResolvedValue({});
    await hotelCardPaymentsService.turnOn(state(), new Date("2026-10-18T19:40:05.000Z"));
    const [endpoint, body] = mocks.post.mock.calls[0]!;
    const executedAt = "2026-10-18T19:40:00.000Z";
    expect(endpoint).toBe(
      `/api/finance/platform/properties/${propertyId}/online-card-execution-evidence`,
    );
    expect(body).toEqual({
      commandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedCardCapabilityRevision: 3,
      expectedPropertyReadinessRevision: 7,
      evidenceFingerprintHash: createHash("sha256")
        .update(
          [
            "vayada-card-approval.v1",
            propertyId,
            "card-capability:3",
            "property-readiness:7",
            executedAt,
          ].join("\n"),
        )
        .digest("hex"),
      executedAt,
    });
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
