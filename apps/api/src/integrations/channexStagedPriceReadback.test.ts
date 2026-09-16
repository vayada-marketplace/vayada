import { describe, expect, it, vi } from "vitest";
import { planChannexOfferConfiguration } from "./channexOfferConfiguration.js";
import { verifyChannexStagedNightPrices as verify } from "./channexStagedPriceReadback.js";
const property = "8f4c1e47-3de1-4150-8bde-ad031a013842",
  roomId = "14187b2a-4d91-4d0e-b579-a00006740fba";
const ids = [
  "5d0a27ba-2fae-430f-aca9-43b1c8dffb67",
  "dbe5d426-8403-4573-9254-c13f96e9c180",
  "6fc58483-fd06-494b-9167-bee76ef8af4b",
];
const identity = {
  externalPropertyId: property,
  externalRoomTypeId: roomId,
  externalRatePlanId: ids[1],
};
function setup() {
  const room = {
    version: "pricing.v2",
    propertyId: property,
    roomTypeId: roomId,
    revision: 1,
    currency: "EUR",
    capacity: { total: 3, adults: 3, children: 0 },
    children: {
      adultFromAge: 18,
      bands: [{ fromAge: 0, throughAge: 17, nightlyMinor: "0", countsTowardCapacity: true }],
    },
    offers: [
      {
        id: "flex",
        termsRevision: "v1",
        meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
        price: {
          kind: "independent",
          calendar: {
            base: { mode: "occupancy", amountsMinor: ["10000", "13000", "15500"] },
            months: [],
            seasons: [],
            weekdays: [],
            dates: [],
          },
        },
        restrictions: {
          kind: "own",
          rules: {
            minArrivalNights: 1,
            maxStayNights: 14,
            closedToArrival: false,
            closedToDeparture: false,
            stopSell: true,
          },
          seasons: [],
          dates: [],
        },
      },
    ],
  };
  const plan = planChannexOfferConfiguration(room, "flex", 2);
  if (plan.kind !== "planned") throw Error(plan.reason);
  const metadata = {
    data: {
      id: ids[1],
      type: "rate_plan",
      attributes: {
        ...plan.configuration,
        property_id: property,
        room_type_id: roomId,
        inherit_stop_sell: false,
        auto_rate_settings: null,
        options: plan.configuration.options.map((o, i) => ({
          ...o,
          id: ids[i],
          inherit_rate: false,
          derived_option: o.is_primary ? null : { rate: [] },
        })),
      },
    },
  };
  const request = {
    values: [
      {
        property_id: property,
        rate_plan_id: ids[1],
        date: "2026-10-15",
        stop_sell: true,
        rates: ["100.00", "130.00", "155.00"].map((rate, i) => ({ occupancy: i + 1, rate })),
      },
    ],
  };
  const values: Record<string, unknown> = Object.fromEntries(
    ids.map((id, i) => [
      id,
      { "2026-10-15": { rate: request.values[0].rates[i].rate, stop_sell: true } },
    ]),
  );
  const get = vi.fn(async (_method: "GET", path: string): Promise<unknown> => {
    if (path.includes("/rate_plans/")) return structuredClone(metadata);
    const id = new URL(path, "https://staging.channex.io").searchParams.get(
      "filter[rate_plan_id]",
    )!;
    return { data: { [id]: values[id] } };
  });
  const run = (port = get) => verify(room, "flex", 2, identity, request, port);
  return { room, metadata, request, values, get, run };
}
describe("all staged occupancy prices", () => {
  it("reads every option ID and rechecks metadata, without multiplying totals", async () => {
    const f = setup();
    const result = await f.run();
    expect(result.prices).toEqual(
      ids.map((ratePlanId, i) => ({
        ratePlanId,
        occupancy: i + 1,
        rate: ["100.00", "130.00", "155.00"][i],
      })),
    );
    expect(f.get).toHaveBeenCalledTimes(5);
  });
  it.each(["missing", "wrong", "open", "numeric"])(
    "rejects a %s non-primary price without a partial result",
    async (kind) => {
      const f = setup();
      f.values[ids[2]] =
        kind === "missing"
          ? undefined
          : {
              "2026-10-15": {
                rate: kind === "wrong" ? "156.00" : kind === "numeric" ? 155 : "155.00",
                stop_sell: kind !== "open",
              },
            };
      await expect(f.run()).rejects.toThrow("staged_price_readback_unavailable");
    },
  );
  it.each(["duplicate_id", "missing_id", "primary_id", "missing_occupancy", "derived"])(
    "rejects %s metadata",
    async (kind) => {
      const f = setup(),
        o = f.metadata.data.attributes.options;
      if (kind === "duplicate_id") o[2].id = o[0].id;
      if (kind === "missing_id") Object.assign(o[0], { id: undefined });
      if (kind === "primary_id") [o[0].id, o[1].id] = [o[1].id, o[0].id];
      if (kind === "missing_occupancy") o.pop();
      if (kind === "derived")
        Object.assign(o[0], { derived_option: { rate: [["increase_by_percent", "10"]] } });
      await expect(f.run()).rejects.toThrow();
    },
  );
  it.each([{ warnings: [] }, { errors: {} }, { meta: { warnings: ["partial"] } }, { meta: null }])(
    "rejects otherwise-valid metadata with ambiguous envelope %j",
    async (patch) => {
      const f = setup();
      Object.assign(f.metadata, patch);
      await expect(f.run()).rejects.toThrow("staged_price_readback_unavailable");
      expect(f.get).toHaveBeenCalledOnce();
    },
  );
  it("snapshots caller inputs before the first GET", async () => {
    const f = setup();
    const result = await f.run(
      vi.fn(async (method, path) => {
        f.request.values[0].rates[0].rate = "999.00";
        f.room.currency = "USD";
        return f.get(method, path);
      }),
    );
    expect(result.prices[0].rate).toBe("100.00");
  });
  it("rejects option remapping during price reads", async () => {
    const f = setup();
    let calls = 0;
    await expect(
      f.run(
        vi.fn(async (method, path) => {
          const body = await f.get(method, path);
          if (++calls === 2) f.metadata.data.attributes.options[0].id = property;
          return body;
        }),
      ),
    ).rejects.toThrow();
  });
  it.each([
    {},
    { data: {} },
    { data: {}, errors: {} },
    { data: {}, meta: { warnings: ["partial"] } },
  ])("rejects ambiguous price envelopes", async (body) => {
    const f = setup();
    await expect(
      f.run(
        vi.fn(async (method, path) =>
          path.includes("/restrictions?") ? body : f.get(method, path),
        ),
      ),
    ).rejects.toThrow();
  });
  it.each(["scope", "duplicate", "zero", "date", "empty"])(
    "rejects invalid immutable %s before IO",
    async (kind) => {
      const f = setup(),
        v = f.request.values[0];
      if (kind === "scope") v.property_id = roomId;
      if (kind === "duplicate") v.rates.push(v.rates[0]);
      if (kind === "zero") v.rates[0].rate = "0.00";
      if (kind === "date") v.date = "2026-02-30";
      if (kind === "empty") v.rates = [];
      await expect(f.run()).rejects.toThrow();
      expect(f.get).not.toHaveBeenCalled();
    },
  );
});
