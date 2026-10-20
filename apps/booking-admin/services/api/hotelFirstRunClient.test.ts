import { describe, expect, it, vi } from "vitest";

import { ApiErrorResponse } from "./client";
import {
  HOTEL_FIRST_RUN_STEPS,
  HotelFirstRunError,
  createHotelFirstRunClient,
  parseHotelFirstRunState,
  quickSetupStepForFirstRun,
  type HotelFirstRunStepState,
} from "./hotelFirstRunClient";

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";

function state(
  overrides: Partial<Record<(typeof HOTEL_FIRST_RUN_STEPS)[number], HotelFirstRunStepState>> = {},
  nextStep: string | null = "currency",
) {
  return {
    contractVersion: "hotel-first-run.v1",
    defaultsVersion: "hotel-first-run-defaults.v1",
    propertyId: PROPERTY,
    steps: HOTEL_FIRST_RUN_STEPS.map((id) => ({
      id,
      state: overrides[id] ?? "todo",
      blockers: [],
    })),
    nextStep,
  };
}
const ALL_DONE = Object.fromEntries(HOTEL_FIRST_RUN_STEPS.map((id) => [id, "done"])) as Record<
  (typeof HOTEL_FIRST_RUN_STEPS)[number],
  HotelFirstRunStepState
>;
const REQUEST = {
  room: { name: "Classic Double", numberOfRooms: 8, maxGuests: 2, pricePerNight: "145" },
  pricesIncludeMandatoryCharges: true,
  guestPayment: "pay_at_property",
  plan: "commission",
} as const;

describe("hotel first-run client (VAY-2247)", () => {
  it("reads the state for the property, uncached", async () => {
    const get = vi.fn(async () => state());
    const client = createHotelFirstRunClient({ get, post: vi.fn() } as never);
    expect((await client.read(PROPERTY)).nextStep).toBe("currency");
    expect(get).toHaveBeenCalledWith(
      `/api/hotel-setup/properties/${PROPERTY}/first-run`,
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("refuses a state for another property or with steps out of order", () => {
    expect(parseHotelFirstRunState(state(), PROPERTY)).not.toBeNull();
    expect(parseHotelFirstRunState({ ...state(), propertyId: "other" }, PROPERTY)).toBeNull();
    expect(
      parseHotelFirstRunState({ ...state(), steps: [...state().steps].reverse() }, PROPERTY),
    ).toBeNull();
    expect(parseHotelFirstRunState({ ...state(), nextStep: "publish" }, PROPERTY)).toBeNull();
  });

  it("runs the first run and passes the Stripe checkout on", async () => {
    const post = vi.fn(async () => ({
      state: state(ALL_DONE, null),
      ran: ["currency", "rooms", "nope"],
      checkout: { url: "https://checkout.stripe.com/c/pay/cs_test" },
    }));
    const client = createHotelFirstRunClient({ get: vi.fn(), post } as never);
    const result = await client.run(PROPERTY, REQUEST);
    expect(post).toHaveBeenCalledWith(`/api/hotel-setup/properties/${PROPERTY}/first-run`, REQUEST);
    expect(result.ran).toEqual(["currency", "rooms"]);
    expect(result.checkoutUrl).toBe("https://checkout.stripe.com/c/pay/cs_test");
  });

  it("turns a stopped step into an error with its code, step and state", async () => {
    const post = vi.fn(async () => {
      throw new ApiErrorResponse(422, {
        code: "mandatory_charges_declaration_required",
        step: "pricing",
        state: state({ currency: "done", rooms: "done", payments: "done" }, "pricing"),
      } as never);
    });
    const client = createHotelFirstRunClient({ get: vi.fn(), post } as never);
    const error = await client.run(PROPERTY, REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HotelFirstRunError);
    expect(error).toMatchObject({
      code: "mandatory_charges_declaration_required",
      step: "pricing",
      state: { nextStep: "pricing" },
    });
    const other = vi.fn(async () => {
      throw new ApiErrorResponse(500, { detail: "boom" } as never);
    });
    await expect(
      createHotelFirstRunClient({ get: vi.fn(), post: other } as never).run(PROPERTY, REQUEST),
    ).rejects.toBeInstanceOf(ApiErrorResponse);
  });

  it("resumes at the first screen that still needs an answer", () => {
    const parsed = (value: ReturnType<typeof state>) => parseHotelFirstRunState(value, PROPERTY)!;
    expect(quickSetupStepForFirstRun(parsed(state()))).toBe(3);
    expect(
      quickSetupStepForFirstRun(
        parsed(state({ currency: "done", rooms: "done", payments: "done" }, "pricing")),
      ),
    ).toBe(3);
    expect(quickSetupStepForFirstRun(parsed(state({ ...ALL_DONE, plan: "todo" }, "plan")))).toBe(4);
    expect(
      quickSetupStepForFirstRun(parsed(state({ ...ALL_DONE, plan: "awaiting_checkout" }, null))),
    ).toBe(4);
    expect(quickSetupStepForFirstRun(parsed(state(ALL_DONE, null)))).toBe(5);
  });
});
