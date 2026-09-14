import { describe, expect, it, vi } from "vitest";
import { verifyChannexAriTaskFinish as verify } from "./channexAriTaskReadback.js";
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
    { executed_at: "2026-09-13T04:25:17.522332" },
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
});
