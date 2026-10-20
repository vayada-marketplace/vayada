import { beforeEach, describe, expect, it, vi } from "vitest";

const steps = vi.hoisted(() => ({
  currency: vi.fn(),
  rooms: vi.fn(),
  payments: vi.fn(),
  pricing: vi.fn(),
  calendar: vi.fn(),
  guestRules: vi.fn(),
}));
vi.mock("./hotelFirstRunSteps.js", async (original) => ({
  ...(await original<typeof import("./hotelFirstRunSteps.js")>()),
  runFirstRunCurrency: steps.currency,
  runFirstRunRooms: steps.rooms,
  runFirstRunPayments: steps.payments,
}));
vi.mock("./hotelFirstRunPricing.js", async (original) => ({
  ...(await original<typeof import("./hotelFirstRunPricing.js")>()),
  runFirstRunPricing: steps.pricing,
}));
vi.mock("./hotelFirstRunCalendar.js", () => ({ runFirstRunCalendar: steps.calendar }));
vi.mock("./hotelFirstRunGuestRules.js", () => ({ runFirstRunGuestRules: steps.guestRules }));

import { runFirstRunPlan, type HotelFirstRunPlanPorts } from "./hotelFirstRunPlan.js";
import {
  createHotelFirstRunService,
  type HotelFirstRunPorts,
  type HotelFirstRunWriteFacts,
} from "./hotelFirstRunService.js";
import type { HotelFirstRunActor } from "./hotelFirstRunSteps.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const roomTypeId = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";
const actor: HotelFirstRunActor = {
  organizationId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d",
  propertyId,
  userId: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
  requestId: "req-1",
  correlationId: null,
  requestedAt: "2026-10-20T09:00:00.000Z",
};
const request = {
  room: { name: "Classic Double", numberOfRooms: 8, maxGuests: 2, pricePerNight: "145" },
  pricesIncludeMandatoryCharges: true,
  guestPayment: "pay_at_property" as const,
  plan: "commission" as const,
};
const facts: HotelFirstRunWriteFacts = {
  propertyId,
  firstRunRoomTypeId: roomTypeId,
  language: "de",
  profile: {
    revision: 2,
    countryCode: "DE",
    timezone: "Europe/Berlin",
    city: "Munich",
    localityPublic: false,
  },
  currency: { code: "EUR", revision: 1 },
  roomTypes: [
    {
      roomTypeId,
      roomFactsRevision: 1,
      roomUnitsRevision: 9,
      activeUnitCount: 8,
      unlabelledUnitIds: [],
    },
  ],
  payments: { payAtPropertySelected: true, currencyMatches: true },
  pricing: { pricedRoomTypeIds: [], staleReasons: [] },
  calendar: { configured: false, stale: false, inventoryPrepared: false },
  guestRules: { rulesSaved: false, termsSaved: false, designSaved: false },
  plan: "none",
};

function service(
  options: {
    busy?: boolean;
    facts?: HotelFirstRunWriteFacts;
    plan?: object;
    activation?: Awaited<ReturnType<HotelFirstRunPorts["activation"]["activateWhenComplete"]>>;
  } = {},
) {
  const activation = {
    activateWhenComplete: vi.fn(
      async () => options.activation ?? { ok: true as const, activated: true },
    ),
  };
  const plans = {
    getPlanStatus: vi.fn(async () => ({ plan: null })),
    selectCommissionPlan: vi.fn(async () => ({ ok: true, status: "created", value: {} })),
    createFixedPlanCheckout: vi.fn(async () => ({
      ok: true,
      status: "created",
      value: { checkoutUrl: "https://stripe.example/checkout" },
    })),
    ...options.plan,
  };
  const ports = {
    plans,
    facts: { read: vi.fn(async () => options.facts ?? facts) },
    lock: {
      withPropertyLock: async (_id: string, work: () => Promise<unknown>) =>
        options.busy ? "busy" : work(),
    },
    activation,
  } as unknown as HotelFirstRunPorts;
  return { first: createHotelFirstRunService(ports), plans, activation };
}

beforeEach(() => {
  for (const step of Object.values(steps))
    step.mockReset().mockResolvedValue({ ok: true, wrote: true });
});

describe("hotel first run (VAY-2247)", () => {
  it("runs the seven steps in order and reports which ones wrote", async () => {
    steps.payments.mockResolvedValue({ ok: true, wrote: false });
    const result = await service().first.run(actor, request, "owner@example.com");
    expect(result).toMatchObject({
      ok: true,
      ran: ["currency", "rooms", "pricing", "calendar", "guest_rules", "plan"],
      checkoutUrl: null,
    });
    expect(steps.currency).toHaveBeenCalledWith(expect.anything(), actor, "DE");
    expect(steps.pricing).toHaveBeenCalledWith(expect.anything(), actor, {
      roomTypeId,
      capacity: { total: 2, adults: 2, children: 1 },
      currency: "EUR",
      pricePerNight: "145",
      pricesIncludeMandatoryCharges: true,
    });
    expect(steps.guestRules).toHaveBeenCalledWith(expect.anything(), actor, {
      language: "de",
      hasCity: true,
      localityPublic: false,
    });
  });

  it("stops at the first step that fails, so nothing runs on top of it", async () => {
    steps.pricing.mockResolvedValue({ ok: false, code: "mandatory_charges_declaration_required" });
    const result = await service().first.run(actor, request, null);
    expect(result).toMatchObject({
      ok: false,
      code: "mandatory_charges_declaration_required",
      step: "pricing",
      ran: ["currency", "rooms", "payments"],
    });
    expect(steps.calendar).not.toHaveBeenCalled();
    expect(steps.guestRules).not.toHaveBeenCalled();
  });

  it("makes the hotel live once every step is saved, and only then (1.5)", async () => {
    const done = service();
    expect(await done.first.run(actor, request, null)).toMatchObject({ ok: true });
    expect(done.activation.activateWhenComplete).toHaveBeenCalledWith(actor);

    steps.calendar.mockResolvedValue({ ok: false, code: "first_run_calendar_failed" });
    const stopped = service();
    await stopped.first.run(actor, request, null);
    expect(stopped.activation.activateWhenComplete).not.toHaveBeenCalled();
  });

  it("reports a hotel it could not make live", async () => {
    const result = await service({
      activation: { ok: false, code: "first_run_profile_incomplete" },
    }).first.run(actor, request, null);
    expect(result).toMatchObject({
      ok: false,
      code: "first_run_profile_incomplete",
      step: null,
      ran: ["currency", "rooms", "payments", "pricing", "calendar", "guest_rules", "plan"],
    });
  });

  it("refuses a second run for the same hotel while one is running", async () => {
    expect(await service({ busy: true }).first.run(actor, request, null)).toMatchObject({
      ok: false,
      code: "first_run_in_progress",
    });
    expect(steps.currency).not.toHaveBeenCalled();
  });

  it("returns the Stripe checkout link for Fixed Fee", async () => {
    const fixed = service();
    const result = await fixed.first.run(
      actor,
      { ...request, plan: "fixed_fee" },
      "owner@example.com",
    );
    expect(result).toMatchObject({ ok: true, checkoutUrl: "https://stripe.example/checkout" });
    expect(fixed.plans.createFixedPlanCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        customerEmail: "owner@example.com",
        returnSurface: "booking-admin",
      }),
    );
  });

  it("doesn't price the owner's own rooms", async () => {
    await service({ facts: { ...facts, firstRunRoomTypeId: null } }).first.run(
      actor,
      request,
      null,
    );
    expect(steps.pricing).not.toHaveBeenCalled();
    expect(steps.calendar).toHaveBeenCalled();
  });

  it("refuses an invalid room before any step", async () => {
    const result = await service().first.run(
      actor,
      { ...request, room: { ...request.room, maxGuests: 0 } },
      null,
    );
    expect(result).toMatchObject({ ok: false, code: "first_run_room_invalid", step: "rooms" });
    expect(steps.currency).not.toHaveBeenCalled();
  });
});

describe("first run step 7: the plan (VAY-2247)", () => {
  const ports = (plan: object = {}) =>
    ({
      plans: {
        getPlanStatus: vi.fn(async () => ({ plan: null })),
        selectCommissionPlan: vi.fn(async () => ({ ok: true, status: "created", value: {} })),
        createFixedPlanCheckout: vi.fn(async () => ({
          ok: true,
          status: "created",
          value: { checkoutUrl: "https://stripe.example/c" },
        })),
        ...plan,
      },
    }) as unknown as HotelFirstRunPlanPorts;

  it("selects Commission with a stable command id and key", async () => {
    const commission = ports();
    expect(
      await runFirstRunPlan(commission, actor, { plan: "commission", customerEmail: null }),
    ).toEqual({ ok: true, wrote: true });
    const [command] = (commission.plans.selectCommissionPlan as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(command).toMatchObject({
      propertyId,
      idempotencyKey: expect.stringMatching(/^first-run:v1:plan:/),
    });
  });

  it("keeps a plan the hotel already has", async () => {
    const existing = ports({ getPlanStatus: vi.fn(async () => ({ plan: "fixed" })) });
    expect(
      await runFirstRunPlan(existing, actor, { plan: "commission", customerEmail: null }),
    ).toEqual({ ok: true, wrote: false });
    expect(existing.plans.selectCommissionPlan).not.toHaveBeenCalled();
  });

  it("needs the owner's email for the Stripe checkout and reports finance refusals", async () => {
    expect(
      await runFirstRunPlan(ports(), actor, { plan: "fixed_fee", customerEmail: null }),
    ).toMatchObject({
      ok: false,
      code: "first_run_plan_email_missing",
    });
    const refused = ports({
      createFixedPlanCheckout: vi.fn(async () => ({
        ok: false,
        code: "stripe_not_configured",
        statusCode: 503,
      })),
    });
    expect(
      await runFirstRunPlan(refused, actor, { plan: "fixed_fee", customerEmail: "o@example.com" }),
    ).toMatchObject({
      ok: false,
      code: "first_run_plan_stripe_not_configured",
    });
  });
});
