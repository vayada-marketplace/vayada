import { expect, it, vi } from "vitest";
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
  let desired: "room_only" | "breakfast" = "breakfast";
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
