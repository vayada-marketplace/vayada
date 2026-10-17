import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock("./targetClient", () => ({
  targetApiClient: {
    get: mocks.get,
    post: mocks.post,
    put: mocks.put,
  },
}));

import {
  hotelOperationsErrorMessage,
  hotelOperationsSetupApi,
  stableSetupCommandId,
} from "./hotelOperationsSetupClient";
import { ApiErrorResponse } from "./client";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hotel operations setup client", () => {
  it("keeps target validation details out of the host-facing setup error", () => {
    expect(
      hotelOperationsErrorMessage(
        new ApiErrorResponse(400, {
          code: "invalid_body",
          message: "Room type create bathroomType is invalid.",
        }),
        "The room type could not be saved.",
      ),
    ).toBe("The room type could not be saved.");
    expect(
      hotelOperationsErrorMessage(
        new ApiErrorResponse(422, {
          code: "unsupported_room_fact",
          category: "validation",
          detail: "Room type create bedType is invalid.",
        }),
        "The room type could not be saved.",
      ),
    ).toBe("The room type could not be saved.");
  });

  it("changes command keys when the authoritative payload changes", () => {
    expect(stableSetupCommandId("setup", "property-1", { rate: 100 })).not.toBe(
      stableSetupCommandId("setup", "property-1", { rate: 120 }),
    );
    expect(stableSetupCommandId("setup", "property-1", { a: 1, b: 2 })).toBe(
      stableSetupCommandId("setup", "property-1", { b: 2, a: 1 }),
    );
  });

  it("replays one Stripe link attempt but mints a new command for a deliberate retry", async () => {
    mocks.post.mockResolvedValue({ onboardingUrl: "https://connect.stripe.test/onboard" });
    const input = {
      email: "host@example.test",
      country: "DE",
      providerAccountId: "provider-account-1",
    };

    await hotelOperationsSetupApi.startStripeOnboarding("property-1", {
      ...input,
      linkAttemptId: "attempt-1",
    });
    await hotelOperationsSetupApi.startStripeOnboarding("property-1", {
      ...input,
      linkAttemptId: "attempt-1",
    });
    await hotelOperationsSetupApi.startStripeOnboarding("property-1", {
      ...input,
      linkAttemptId: "attempt-2",
    });

    const bodies = mocks.post.mock.calls.map((call) => call[1] as { commandId: string });
    expect(bodies[0]!.commandId).toBe(bodies[1]!.commandId);
    expect(bodies[2]!.commandId).not.toBe(bodies[0]!.commandId);
    expect(mocks.post).toHaveBeenNthCalledWith(
      1,
      "/api/finance/properties/property-1/provider-accounts/provider-account-1/onboarding-link",
      expect.objectContaining({ returnSurface: "booking_admin_setup" }),
    );
    expect(bodies[0]).not.toHaveProperty("propertyId");
    expect(bodies[0]).not.toHaveProperty("returnUrl");
  });

  it("reconciles only the exact property's stored Stripe account", async () => {
    mocks.post.mockResolvedValue({
      propertyId: "property / one",
      providerAccount: { ready: false },
    });
    const signal = new AbortController().signal;

    await hotelOperationsSetupApi.reconcileStripeProviderAccount(
      " property / one ",
      "stripe-flow:attempt:1",
      signal,
    );

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/finance/properties/property%20%2F%20one/provider-accounts/stripe/reconcile",
      {
        commandId: "stripe-flow:attempt:1",
        idempotencyKey: "stripe-flow:attempt:1",
      },
      { signal },
    );
    expect(mocks.post.mock.calls[0]?.[1]).not.toHaveProperty("providerAccountId");
  });

  it("reads and writes launch settings through the property-owned setup endpoint", async () => {
    mocks.get.mockResolvedValue({
      defaultCurrency: "EUR",
      supportedCurrencies: ["CHF", "GBP", 7],
      defaultLanguage: "de",
      supportedLanguages: ["en", "fr"],
      instagram: "https://instagram.com/alpenrose",
      facebook: "https://facebook.com/alpenrose",
      tiktok: "https://tiktok.com/@alpenrose",
      youtube: "https://youtube.com/@alpenrose",
    });
    mocks.put.mockResolvedValue({});

    await expect(
      hotelOperationsSetupApi.getPropertyLaunchSettings("property / one"),
    ).resolves.toEqual({
      defaultCurrency: "EUR",
      supportedCurrencies: ["CHF", "GBP"],
      defaultLanguage: "de",
      supportedLanguages: ["en", "fr"],
      instagram: "https://instagram.com/alpenrose",
      facebook: "https://facebook.com/alpenrose",
      tiktok: "https://tiktok.com/@alpenrose",
      youtube: "https://youtube.com/@alpenrose",
    });

    await hotelOperationsSetupApi.updatePropertyLaunchSettings("property / one", {
      defaultCurrency: "EUR",
      supportedCurrencies: ["CHF"],
      defaultLanguage: "de",
      supportedLanguages: ["en"],
      instagram: "https://instagram.com/alpenrose",
      facebook: "",
      tiktok: "https://tiktok.com/@alpenrose",
      youtube: "",
    });

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/hotel-setup/properties/property%20%2F%20one/launch-settings",
      undefined,
    );
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/hotel-setup/properties/property%20%2F%20one/launch-settings",
      {
        defaultCurrency: "EUR",
        supportedCurrencies: ["CHF"],
        defaultLanguage: "de",
        supportedLanguages: ["en"],
        instagram: "https://instagram.com/alpenrose",
        facebook: "",
        tiktok: "https://tiktok.com/@alpenrose",
        youtube: "",
      },
    );
  });

  it("uses the canonical Finance subscription routes for onboarding plan selection", async () => {
    mocks.get.mockResolvedValue({
      planStatus: { plan: "commission", status: "commission", amountMinor: 3_500 },
    });
    mocks.post
      .mockResolvedValueOnce({
        planStatus: { plan: "commission", status: "commission", amountMinor: 3_500 },
      })
      .mockResolvedValueOnce({
        checkout: {
          checkoutUrl: "https://checkout.stripe.test/fixed",
          amountMinor: 3_500,
          activeRoomCount: 2,
        },
      });

    await hotelOperationsSetupApi.getPlanStatus("property / one");
    await hotelOperationsSetupApi.selectCommissionPlan("property / one");
    await hotelOperationsSetupApi.startFixedPlanCheckout("property / one");

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/finance/properties/property%20%2F%20one/plan-status",
      undefined,
    );
    expect(mocks.post.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      "/api/finance/properties/property%20%2F%20one/select-commission",
      "/api/finance/properties/property%20%2F%20one/fixed-plan/checkout",
    ]);
  });

  it("advances plan command identity when the durable plan status changes", async () => {
    mocks.post.mockResolvedValue({
      planStatus: { plan: "commission", status: "commission", amountMinor: 3_500 },
    });

    await hotelOperationsSetupApi.selectCommissionPlan("property-1", "2026-08-11T10:00:00Z");
    await hotelOperationsSetupApi.selectCommissionPlan("property-1", "2026-08-11T11:00:00Z");

    const [first, second] = mocks.post.mock.calls.map(([, body]) => body as { commandId: string });
    expect(first.commandId).not.toBe(second.commandId);
  });
});
