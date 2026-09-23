import { describe, expect, it, vi } from "vitest";
import {
  verifyChannexAriTaskFinish as verify,
  verifyChannexAvailabilityTaskFinish,
} from "./channexAriTaskReadback.js";
const taskId = "5ff7d7b6-f455-4309-a19d-383442c09c50";
const externalPropertyId = "8f4c1e47-3de1-4150-8bde-ad031a013842";
const request = () => ({
  values: [
    {
      date_from: "2026-09-14",
      date_to: "2026-09-14",
      property_id: externalPropertyId,
      rate_plan_id: "55ed3514-378a-4467-ae77-164c1a6bd02e",
      stop_sell: true,
    },
  ],
});
const expected = () => ({ taskId, externalPropertyId, request: request() });
// Allow-listed projection of the observed sandbox task; no identity/IP/contact data.
const response = () => ({
  data: {
    type: "task",
    id: taskId,
    attributes: {
      id: taskId,
      task: "Property.UpdateRestrictions",
      success: true,
      errors: [],
      payload: request(),
      received_at: "2026-09-13T04:25:17.522333",
      executed_at: "2026-09-13T04:25:17.650180",
      finished_at: "2026-09-13T04:25:17.675389",
    },
  },
});

describe("original ARI task finish observation", () => {
  it("matches the original payload and returns only scoped finish metadata", async () => {
    const get = vi.fn(async () => ({ ...response(), private_metadata: "discard" }));
    expect(await verify(expected(), get)).toEqual({
      kind: "task_finish_observed",
      taskId,
      externalPropertyId,
      receivedAt: "2026-09-13T04:25:17.522333",
      executedAt: "2026-09-13T04:25:17.650180",
      finishedAt: "2026-09-13T04:25:17.675389",
    });
    expect(get).toHaveBeenCalledExactlyOnceWith("GET", `/api/v1/tasks/${taskId}`);
  });
  it.each([
    { taskId: "../other" },
    { externalPropertyId: "bad" },
    { request: {} },
    { request: { values: [] } },
    { request: { values: [{ property_id: taskId }] } },
  ])("rejects invalid expected scope before IO", async (change) => {
    const get = vi.fn();
    await expect(verify({ ...expected(), ...change }, get)).rejects.toThrow(
      "ari_task_scope_unavailable",
    );
    expect(get).not.toHaveBeenCalled();
  });
  it.each([
    "id",
    "task",
    "success",
    "errors",
    "payload",
    "received_at",
    "executed_at",
    "finished_at",
  ])("requires explicit %s", async (key) => {
    const body = response();
    delete (body.data.attributes as Record<string, unknown>)[key];
    await expect(verify(expected(), async () => body)).rejects.toThrow(
      "ari_task_observation_unavailable",
    );
  });
  it.each([
    { id: externalPropertyId },
    { task: "Property.UpdateAvailability" },
    { success: false },
    { success: "true" },
    { errors: null },
    { errors: ["partial failure"] },
    { finished_at: null },
    { finished_at: "pending" },
    { finished_at: "2026-02-30T00:00:00.000000" },
    { finished_at: "2026-09-13T24:00:00.000000" },
    { finished_at: "2026-09-13T04:25:17.650179" },
    { received_at: "2026-09-13T04:25:17.675390" },
    { executed_at: "2026-09-13T04:25:17.675390" },
    { payload: { values: [] } },
  ])("rejects mismatched, failed, pending or invalid task details", async (change) => {
    const body = response();
    Object.assign(body.data.attributes, change);
    await expect(verify(expected(), async () => body)).rejects.toThrow(
      "ari_task_observation_unavailable",
    );
  });
  it.each([
    {},
    { data: [] },
    { errors: {} },
    { warnings: [] },
    { meta: { warnings: ["partial"] } },
    { meta: null },
  ])("rejects ambiguous envelopes", async (change) => {
    await expect(
      verify(expected(), async () =>
        Object.keys(change).length ? { ...response(), ...change } : {},
      ),
    ).rejects.toThrow("ari_task_observation_unavailable");
  });
  it.each([{ id: externalPropertyId }, { type: "other" }])(
    "requires matching outer identity",
    async (change) => {
      const body = response();
      Object.assign(body.data, change);
      await expect(verify(expected(), async () => body)).rejects.toThrow(
        "ari_task_observation_unavailable",
      );
    },
  );
  it("rejects another rate's payload even on the same property", async () => {
    const body = response();
    body.data.attributes.payload.values[0]!.rate_plan_id = taskId;
    await expect(verify(expected(), async () => body)).rejects.toThrow(
      "ari_task_observation_unavailable",
    );
  });
  it("holds the live multioccupancy task when a submitted stay rule is omitted", async () => {
    const sent = {
      values: [
        {
          property_id: externalPropertyId,
          rate_plan_id: "dbe5d426-8403-4573-9254-c13f96e9c180",
          date: "2026-10-15",
          rates: [
            { occupancy: 1, rate: "100.00" },
            { occupancy: 2, rate: "130.00" },
            { occupancy: 3, rate: "155.00" },
          ],
          min_stay_arrival: 1,
          min_stay_through: 1,
          max_stay: 0,
          closed_to_arrival: false,
          closed_to_departure: false,
          stop_sell: true,
        },
      ],
    };
    const body = response();
    const observed = structuredClone(sent);
    delete (observed.values[0] as Record<string, unknown>).min_stay_through;
    Object.assign(body.data.attributes, { payload: observed });
    // Success/timestamps and correct prices do not prove the omitted field executed.
    await expect(
      verify({ taskId, externalPropertyId, request: sent }, async () => body),
    ).rejects.toThrow("ari_task_observation_unavailable");
    Object.assign(body.data.attributes, { payload: sent });
    await expect(
      verify({ taskId, externalPropertyId, request: sent }, async () => body),
    ).resolves.toMatchObject({ kind: "task_finish_observed" });
  });
  it("snapshots the original request before IO", async () => {
    const input = expected();
    const result = await verify(input, async () => {
      input.request.values[0]!.stop_sell = false;
      return response();
    });
    expect(result.kind).toBe("task_finish_observed");
  });
  it("compares differing fraction lengths at microsecond precision", async () => {
    const body = response();
    Object.assign(body.data.attributes, {
      received_at: "2026-09-13T04:25:17",
      executed_at: "2026-09-13T04:25:17.1",
      finished_at: "2026-09-13T04:25:17.100001",
    });
    expect((await verify(expected(), async () => body)).kind).toBe("task_finish_observed");
  });
  it("accepts Channex tasks that record execution just before receipt", async () => {
    const body = response();
    Object.assign(body.data.attributes, {
      received_at: "2026-09-23T11:43:56.357239",
      executed_at: "2026-09-23T11:43:56.354371",
      finished_at: "2026-09-23T11:43:56.398595",
    });
    expect((await verify(expected(), async () => body)).kind).toBe("task_finish_observed");
  });
});

describe("availability task finish observation", () => {
  const availabilityRequest = {
    values: [
      {
        property_id: externalPropertyId,
        room_type_id: "55ed3514-378a-4467-ae77-164c1a6bd02e",
        date_from: "2026-09-14",
        date_to: "2026-09-14",
        availability: 2,
      },
    ],
  };
  const expectedAvailability = { taskId, externalPropertyId, request: availabilityRequest };
  it("requires the availability task type and exact original payload", async () => {
    const body = response();
    Object.assign(body.data.attributes, {
      task: "Property.UpdateAvailability",
      payload: availabilityRequest,
    });
    await expect(
      verifyChannexAvailabilityTaskFinish(expectedAvailability, async () => body),
    ).resolves.toMatchObject({ kind: "task_finish_observed", taskId, externalPropertyId });
  });
  it("rejects a restrictions task for an availability request", async () => {
    const body = response();
    body.data.attributes.payload =
      availabilityRequest as unknown as typeof body.data.attributes.payload;
    await expect(
      verifyChannexAvailabilityTaskFinish(expectedAvailability, async () => body),
    ).rejects.toThrow("ari_task_observation_unavailable");
  });
});
