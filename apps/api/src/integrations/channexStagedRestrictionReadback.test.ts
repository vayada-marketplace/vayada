import { describe, expect, it, vi } from "vitest";
import { verifyChannexStagedNightRestrictions as verify } from "./channexRestrictionReadback.js";

const property = "11111111-1111-4111-8111-111111111111";
const rate = "22222222-2222-4222-8222-222222222222";
const date = "2026-10-15";
const restrictions = {
  min_stay_arrival: 3,
  min_stay_through: 1,
  max_stay: 0,
  closed_to_arrival: false,
  closed_to_departure: true,
  stop_sell: true,
};
const request = () => ({
  values: [
    {
      property_id: property,
      rate_plan_id: rate,
      date,
      rates: [
        { occupancy: 1, rate: "100.00" },
        { occupancy: 2, rate: "130.00" },
      ],
      ...restrictions,
    },
  ],
});
const response = () => ({ data: { [rate]: { [date]: { ...restrictions } } } });

describe("exact staged restriction readback", () => {
  it("compares the closed persisted fields and scopes the documented GET", async () => {
    const get = vi.fn(async () => response());
    expect(await verify(request(), get)).toEqual({
      kind: "restrictions_observed",
      externalPropertyId: property,
      externalRatePlanId: rate,
      date,
      restrictions,
    });
    expect(get).toHaveBeenCalledOnce();
    const [method, path] = get.mock.calls[0] as unknown as [string, string];
    const url = new URL(path, "https://staging.channex.io");
    expect(method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/restrictions");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "filter[property_id]": property,
      "filter[date]": date,
      "filter[restrictions]": Object.keys(restrictions).join(","),
    });
  });
  it.each(Object.keys(restrictions))("rejects a missing or changed %s", async (key) => {
    const missing = response();
    delete (missing.data[rate]![date] as Record<string, unknown>)[key];
    await expect(verify(request(), async () => missing)).rejects.toThrow(
      "restriction_readback_mismatch",
    );
    const wrong = response();
    (wrong.data[rate]![date] as Record<string, unknown>)[key] = key === "stop_sell" ? false : null;
    await expect(verify(request(), async () => wrong)).rejects.toThrow(
      "restriction_readback_mismatch",
    );
  });
  it.each([
    {},
    { data: {} },
    { data: { [rate]: {} } },
    { data: { [property]: { [date]: restrictions } } },
  ])("rejects absent or different target data", async (body) => {
    await expect(verify(request(), async () => body)).rejects.toThrow(/restriction_readback/);
  });
  it.each([
    { errors: {} },
    { warnings: [] },
    { meta: null },
    { meta: { warnings: ["partial"] } },
    { meta: { warnings: null } },
  ])("rejects ambiguous response envelopes", async (extra) => {
    await expect(verify(request(), async () => ({ ...response(), ...extra }))).rejects.toThrow(
      "restriction_readback_unavailable",
    );
  });
  it.each([
    undefined,
    {},
    { values: [] },
    { values: [null] },
    { values: [request().values[0], request().values[0]] },
  ])("rejects unsupported request cardinality before IO", async (body) => {
    const get = vi.fn();
    await expect(verify(body, get)).rejects.toThrow("staged_restriction_request_unavailable");
    expect(get).not.toHaveBeenCalled();
  });
  it.each([
    { stop_sell: false },
    { stop_sell: 1 },
    { min_stay_arrival: 0 },
    { min_stay_through: 1.5 },
    { max_stay: -1 },
    { max_stay: "0" },
    { closed_to_arrival: null },
    { closed_to_departure: 0 },
    { property_id: "../" },
    { rate_plan_id: "" },
    { date: "2026-02-30" },
    { date: "2026-1-1" },
    { date: "2026-10-15T00:00:00Z" },
  ])("rejects malformed or open stored requests before IO", async (change) => {
    const get = vi.fn();
    await expect(verify({ values: [{ ...request().values[0], ...change }] }, get)).rejects.toThrow(
      "staged_restriction_request_unavailable",
    );
    expect(get).not.toHaveBeenCalled();
  });
  it.each(Object.keys(restrictions))("requires the stored %s field", async (key) => {
    const body = request();
    delete (body.values[0] as Record<string, unknown>)[key];
    await expect(verify(body, vi.fn())).rejects.toThrow("staged_restriction_request_unavailable");
  });
  it("snapshots scope and expected restrictions before IO", async () => {
    const body = request();
    const result = await verify(body, async () => {
      body.values[0]!.stop_sell = false;
      body.values[0]!.date = "2026-10-16";
      body.values[0]!.rate_plan_id = property;
      return response();
    });
    expect(result).toMatchObject({
      date,
      externalRatePlanId: rate,
      restrictions: { stop_sell: true },
    });
  });
  it("does not turn matching restrictions into price or completion proof", async () => {
    const result = await verify(request(), async () => ({
      data: { [rate]: { [date]: { ...restrictions, rate: "999.00" } } },
    }));
    expect(Object.keys(result).sort()).toEqual([
      "date",
      "externalPropertyId",
      "externalRatePlanId",
      "kind",
      "restrictions",
    ]);
  });
});
