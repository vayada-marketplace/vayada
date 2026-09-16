import { expect, it, vi } from "vitest";
import { verifyChannexMealReadback, type ChannexMeal } from "./channexMealSync.js";
import { createChannexManagementProvider } from "./channexManagement.js";
import type { ChannexManagementJob } from "../jobs/pmsChannexManagementWorker.js";

const job: ChannexManagementJob = {
  jobId: "job",
  propertyId: "property",
  correlationId: null,
  attemptNumber: 1,
  maxAttempts: 5,
  input: { commandId: "command", idempotencyKey: "key", operationType: "provision" },
};

function fixture(
  options: {
    channel?: string;
    wrongRoom?: boolean;
    reject?: number;
    stale?: boolean;
    timeout?: boolean;
  } = {},
) {
  let current = "room_only";
  let desired: ChannexMeal["mealType"] = "breakfast";
  const writes: unknown[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/channels"))
      return Response.json({
        data: options.channel
          ? [
              {
                attributes: {
                  channel: options.channel,
                  rate_plans: [{ rate_plan_id: "external-rate" }],
                },
              },
            ]
          : [],
      });
    expect(path).toBe("/api/v1/rate_plans/external-rate");
    if (init?.method === "PUT") {
      if (options.reject)
        return Response.json({ errors: "meal rejected" }, { status: options.reject });
      writes.push(JSON.parse(String(init.body)));
      if (!options.stale) current = JSON.parse(String(init.body)).rate_plan.meal_type;
      if (options.timeout) {
        options.timeout = false;
        throw new DOMException("timeout", "TimeoutError");
      }
    }
    return Response.json({
      data: {
        id: "external-rate",
        attributes: { meal_type: current },
        relationships: {
          property: { data: { id: "external-property" } },
          room_type: { data: { id: options.wrongRoom ? "unrelated" : "external-room" } },
        },
      },
    });
  });
  const provider = createChannexManagementProvider({
    apiBaseUrl: "https://staging.channex.io",
    apiKey: "test-key",
    fetch: fetcher,
    plans: {
      plan: async () => ({
        externalPropertyId: "external-property",
        requests: [],
        meals: [
          {
            ratePlanId: "plan",
            channel: "direct",
            externalRatePlanId: "external-rate",
            externalRoomTypeId: "external-room",
            mealType: desired,
          },
        ],
      }),
    },
  });
  return {
    provider,
    fetcher,
    writes,
    setMeal(value: typeof desired) {
      desired = value;
    },
  };
}

it("updates only the mapped meal, reads it back, and converges across repeated jobs and removal", async () => {
  const f = fixture();
  expect(await f.provider.execute(job)).toMatchObject({ ok: true });
  expect(await f.provider.execute(job)).toMatchObject({ ok: true });
  expect(f.writes).toEqual([{ rate_plan: { meal_type: "breakfast" } }]);
  f.setMeal("room_only");
  expect(await f.provider.execute({ ...job, attemptNumber: 2 })).toMatchObject({ ok: true });
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1]).toEqual({ rate_plan: { meal_type: "room_only" } });
});

it("retries an ambiguous successful PUT without duplicating plans or restoring an older meal", async () => {
  const f = fixture({ timeout: true });
  expect(await f.provider.execute(job)).toMatchObject({ ok: false, code: "timeout" });
  f.setMeal("room_only");
  expect(await f.provider.execute({ ...job, attemptNumber: 2 })).toMatchObject({ ok: true });
  expect(f.writes).toEqual([
    { rate_plan: { meal_type: "breakfast" } },
    { rate_plan: { meal_type: "room_only" } },
  ]);
});

it.each(["BookingCom", "Airbnb", "UnknownOTA"])(
  "exposes unsupported %s meal delivery without changing provider state",
  async (channel) => {
    const f = fixture({ channel });
    expect(await f.provider.execute(job)).toMatchObject({
      ok: false,
      code: "invalid_state",
      message: expect.stringContaining("meal synchronization is unsupported"),
    });
    expect(f.writes).toEqual([]);
  },
);

it.each([
  [{ wrongRoom: true }, "invalid_state"],
  [{ stale: true }, "invalid_state"],
  [{ reject: 422 }, "invalid_payload"],
  [{ reject: 503 }, "provider_unavailable"],
])("keeps scope, readback, and provider failures visible: %j", async (options, code) => {
  expect(await fixture(options).provider.execute(job)).toMatchObject({ ok: false, code });
});

it("does not fail unchanged connected meal terms during unrelated saves", async () => {
  const f = fixture({ channel: "BookingCom" });
  f.setMeal("room_only");
  expect(await f.provider.execute(job)).toMatchObject({ ok: true });
  expect(f.writes).toEqual([]);
});

it.each(["room_only", "breakfast", "half_board", "full_board", "all_inclusive"] as const)(
  "reconciles and verifies replacement %s without changing price or creating rates",
  async (mealType) => {
    const f = fixture();
    f.setMeal(mealType);
    expect(await f.provider.execute(job)).toMatchObject({ ok: true });
    expect(await f.provider.execute(job)).toMatchObject({ ok: true });
    expect(f.writes).toEqual(
      mealType === "room_only" ? [] : [{ rate_plan: { meal_type: mealType } }],
    );
  },
);

const expectedMeal: ChannexMeal = {
  externalRatePlanId: "rate",
  externalRoomTypeId: "room",
  mealType: "half_board",
};
function providerMeal(mealType: unknown = "half_board") {
  return {
    data: {
      id: "rate",
      attributes: { meal_type: mealType },
      relationships: {
        property: { data: { id: "property" } },
        room_type: { data: { id: "room" } },
      },
    },
  };
}
it.each(["room_only", "breakfast", "half_board", "full_board", "all_inclusive"] as const)(
  "returns exact %s metadata evidence through GET only",
  async (mealType) => {
    const request = vi.fn(async () => providerMeal(mealType));
    expect(
      await verifyChannexMealReadback("property", { ...expectedMeal, mealType }, request),
    ).toEqual({
      ...expectedMeal,
      mealType,
      externalPropertyId: "property",
    });
    expect(request.mock.calls).toEqual([["GET", "/api/v1/rate_plans/rate"]]);
  },
);
it.each([null, undefined, "none", "breakfast", "bed_and_breakfast", "unknown"])(
  "does not treat %s as half-board proof",
  async (value) => {
    await expect(
      verifyChannexMealReadback("property", expectedMeal, async () => {
        const response = providerMeal();
        response.data.attributes.meal_type = value;
        return response;
      }),
    ).rejects.toThrow("readback did not match");
  },
);
it.each(["property", "room", "rate", "conflictingProperty", "conflictingRoom"])(
  "rejects %s identity mismatches",
  async (field) => {
    const response = providerMeal();
    if (field === "property") response.data.relationships.property.data.id = "other";
    if (field === "room") response.data.relationships.room_type.data.id = "other";
    if (field === "rate") response.data.id = "other";
    if (field === "conflictingProperty")
      Object.assign(response.data.attributes, { property_id: "other" });
    if (field === "conflictingRoom")
      Object.assign(response.data.attributes, { room_type_id: "other" });
    await expect(
      verifyChannexMealReadback("property", expectedMeal, async () => response),
    ).rejects.toThrow("identity mismatch");
  },
);
it("rejects unknown canonical inclusions before provider IO and retains caller identity across IO", async () => {
  const request = vi.fn(async () => providerMeal());
  await expect(
    verifyChannexMealReadback(
      "property",
      { ...expectedMeal, mealType: "none" } as unknown as ChannexMeal,
      request,
    ),
  ).rejects.toThrow("Invalid Channex meal");
  expect(request).not.toHaveBeenCalled();
  const meal = { ...expectedMeal };
  expect(
    await verifyChannexMealReadback("property", meal, async () => {
      meal.externalRatePlanId = "changed";
      return providerMeal();
    }),
  ).toEqual({ ...expectedMeal, externalPropertyId: "property" });
});

it("accepts exact attribute-only identity but rejects missing and blank identity before proof", async () => {
  const response = {
    data: {
      id: "rate",
      attributes: {
        property_id: "property",
        room_type_id: "room",
        meal_type: "half_board",
      },
    },
  };
  expect(await verifyChannexMealReadback("property", expectedMeal, async () => response)).toEqual({
    ...expectedMeal,
    externalPropertyId: "property",
  });
  const request = vi.fn(async () => response);
  await expect(verifyChannexMealReadback(" ", expectedMeal, request)).rejects.toThrow(
    "Invalid Channex meal",
  );
  await expect(
    verifyChannexMealReadback("property", { ...expectedMeal, externalRoomTypeId: "" }, request),
  ).rejects.toThrow("Invalid Channex meal");
  expect(request).not.toHaveBeenCalled();
  await expect(
    verifyChannexMealReadback("property", expectedMeal, async () => ({
      data: {
        id: "rate",
        attributes: { meal_type: "half_board" },
      },
    })),
  ).rejects.toThrow("identity mismatch");
});
