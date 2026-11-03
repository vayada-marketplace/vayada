import { beforeEach, describe, expect, it, vi } from "vitest";

const steps = vi.hoisted(() => ({
  currency: vi.fn(),
  payments: vi.fn(),
  pricing: vi.fn(),
  calendar: vi.fn(),
  guestRules: vi.fn(),
}));
vi.mock("./hotelFirstRunSteps.js", async (original) => ({
  ...(await original<typeof import("./hotelFirstRunSteps.js")>()),
  runFirstRunCurrency: steps.currency,
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
import { firstRunIdempotencyKey, type HotelFirstRunActor } from "./hotelFirstRunSteps.js";

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
/** All the four-step setup sends (VAY-2451). */
const request = { guestPayment: "pay_at_property" as const };
const facts: HotelFirstRunWriteFacts = {
  propertyId,
  firstRunRoomTypeIds: [roomTypeId],
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
    ...options.plan,
  };
  const ports = {
    plans,
    facts: {
      read: vi.fn(async () => options.facts ?? facts),
      readSetupProgress: vi.fn(async () => ({ guestPayment: true })),
    },
    lock: {
      withPropertyLock: async (_id: string, work: () => Promise<unknown>) =>
        options.busy ? "busy" : work(),
    },
    activation,
    roomRead: {
      listRoomTypeFacts: vi.fn(async () => [
        { roomTypeId, facts: { occupancy: { maxGuests: 3, maxAdults: 3, maxChildren: 2 } } },
      ]),
    },
  } as unknown as HotelFirstRunPorts;
  return { first: createHotelFirstRunService(ports), plans, activation };
}

beforeEach(() => {
  for (const step of Object.values(steps))
    step.mockReset().mockResolvedValue({ ok: true, wrote: true });
});

describe("hotel first run (VAY-2247, VAY-2451)", () => {
  it("runs the steps in order and reports which ones wrote", async () => {
    steps.payments.mockResolvedValue({ ok: true, wrote: false });
    const result = await service().first.run(actor, request);
    expect(result).toEqual({
      ok: true,
      state: expect.anything(),
      ran: ["currency", "pricing", "calendar", "guest_rules", "plan"],
    });
    expect(steps.currency).toHaveBeenCalledWith(expect.anything(), actor, "DE");
    // The setup's room type gets the placeholder price, sized to its own guests.
    expect(steps.pricing).toHaveBeenCalledTimes(1);
    expect(steps.pricing).toHaveBeenCalledWith(expect.anything(), actor, {
      roomTypeId,
      capacity: { total: 3, adults: 3, children: 2 },
      currency: "EUR",
      freeCancellationDays: 3,
    });
    expect(steps.calendar).toHaveBeenCalled();
    expect(steps.guestRules).toHaveBeenCalledWith(expect.anything(), actor, {
      language: "de",
      hasCity: true,
      localityPublic: false,
    });
  });

  it("stops at the first step that fails, so nothing runs on top of it", async () => {
    steps.pricing.mockResolvedValue({ ok: false, code: "first_run_pricing_stale" });
    const result = await service().first.run(actor, request);
    expect(result).toMatchObject({
      ok: false,
      code: "first_run_pricing_stale",
      step: "pricing",
      ran: ["currency", "payments"],
    });
    expect(steps.calendar).not.toHaveBeenCalled();
    expect(steps.guestRules).not.toHaveBeenCalled();
  });

  it("makes the hotel live once every step is saved, and only then (1.5)", async () => {
    const done = service();
    expect(await done.first.run(actor, request)).toMatchObject({ ok: true });
    expect(done.activation.activateWhenComplete).toHaveBeenCalledWith(actor);

    steps.calendar.mockResolvedValue({ ok: false, code: "first_run_calendar_failed" });
    const stopped = service();
    await stopped.first.run(actor, request);
    expect(stopped.activation.activateWhenComplete).not.toHaveBeenCalled();
  });

  it("reports a hotel it could not make live", async () => {
    const result = await service({
      activation: { ok: false, code: "first_run_profile_incomplete" },
    }).first.run(actor, request);
    expect(result).toMatchObject({
      ok: false,
      code: "first_run_profile_incomplete",
      step: null,
      ran: ["currency", "payments", "pricing", "calendar", "guest_rules", "plan"],
    });
  });

  it("refuses a second run for the same hotel while one is running", async () => {
    expect(await service({ busy: true }).first.run(actor, request)).toMatchObject({
      ok: false,
      code: "first_run_in_progress",
    });
    expect(steps.currency).not.toHaveBeenCalled();
  });

  it("finishes without a room: no price, no calendar, and the hotel still goes live", async () => {
    const done = service({ facts: { ...facts, firstRunRoomTypeIds: [], roomTypes: [] } });
    const result = await done.first.run(actor, request);
    expect(result).toMatchObject({
      ok: true,
      ran: ["currency", "payments", "guest_rules", "plan"],
    });
    expect(steps.pricing).not.toHaveBeenCalled();
    expect(steps.calendar).not.toHaveBeenCalled();
    expect(done.plans.selectCommissionPlan).toHaveBeenCalled();
    expect(done.activation.activateWhenComplete).toHaveBeenCalledWith(actor);
  });

  it("leaves the owner's own room types to them", async () => {
    await service({ facts: { ...facts, firstRunRoomTypeIds: [] } }).first.run(actor, request);
    expect(steps.pricing).not.toHaveBeenCalled();
  });
});

describe("first run plan step: Commission (VAY-2247, VAY-2451)", () => {
  const ports = (plan: object = {}) =>
    ({
      plans: {
        getPlanStatus: vi.fn(async () => ({ plan: null })),
        selectCommissionPlan: vi.fn(async () => ({ ok: true, status: "created", value: {} })),
        ...plan,
      },
    }) as unknown as HotelFirstRunPlanPorts;
  const commissionCommand = (port: HotelFirstRunPlanPorts) =>
    (port.plans.selectCommissionPlan as ReturnType<typeof vi.fn>).mock.calls[0]![0];

  it("selects Commission with the same command key as before", async () => {
    const commission = ports();
    expect(await runFirstRunPlan(commission, actor)).toEqual({ ok: true, wrote: true });
    expect(commissionCommand(commission)).toMatchObject({
      propertyId,
      idempotencyKey: firstRunIdempotencyKey(propertyId, "plan", "commission"),
    });
  });

  it("waits for Stripe while a Fixed Fee checkout the 7-step setup started is open", async () => {
    const checkout = ports({
      getPlanStatus: vi.fn(async () => ({ plan: null, checkoutPending: true })),
    });
    expect(await runFirstRunPlan(checkout, actor)).toEqual({ ok: true, wrote: false });
    expect(checkout.plans.selectCommissionPlan).not.toHaveBeenCalled();
  });

  it("keeps a plan the hotel already has", async () => {
    const existing = ports({ getPlanStatus: vi.fn(async () => ({ plan: "fixed" })) });
    expect(await runFirstRunPlan(existing, actor)).toEqual({ ok: true, wrote: false });
    expect(existing.plans.selectCommissionPlan).not.toHaveBeenCalled();
  });

  it("reports a finance refusal", async () => {
    const refused = ports({
      selectCommissionPlan: vi.fn(async () => ({
        ok: false,
        code: "plan_change_blocked",
        statusCode: 409,
      })),
    });
    expect(await runFirstRunPlan(refused, actor)).toMatchObject({
      ok: false,
      code: "first_run_plan_plan_change_blocked",
    });
  });
});
