import Fastify from "fastify";
import { buildApp } from "./app.js";
import type { RequestContext } from "@vayada/backend-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerChannexOfferPreviewRoutes } from "./routes/channexOfferPreview.js";
import { PricingStorageError } from "./domains/replacementPricingSnapshot.js";
const id = "61000000-0000-4000-8000-000000000001",
  draftId = "61000000-0000-4000-8000-000000000002";
const resource = { product: "pms", resourceType: "pms_property", resourceId: id };
const context = {
  actor: { internalUserId: id },
  selectedOrganization: { organizationId: id, kind: "hotel_group" },
  membership: { permissions: ["pms.rooms_rates.read", "pms.operations.read"] },
  linkedResources: [{ ...resource, relationship: "owner", status: "active" }],
  entitlements: [{ product: "pms", key: "property-management", status: "active", resource }],
} as RequestContext;
const snapshot = {
  currency: "EUR",
  ownerReferences: { finance: "evidence", charges: draftId },
  rooms: [
    {
      version: "pricing.v2",
      propertyId: id,
      roomTypeId: id,
      revision: 1,
      currency: "EUR",
      capacity: { total: 2, adults: 2, children: 0 },
      children: {
        adultFromAge: 12,
        bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
      },
      offers: [
        {
          id: "flex",
          termsRevision: draftId,
          meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
          price: {
            kind: "independent",
            calendar: {
              base: { mode: "flat", amountMinor: "10000" },
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
              maxStayNights: null,
              closedToArrival: false,
              closedToDeparture: false,
              stopSell: false,
            },
            seasons: [],
            dates: [],
          },
        },
      ],
    },
  ],
};
const sources = { room: "room", terms: "terms", finance: "finance" };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const params = { roomTypeId: id, offerId: "flex", publicationRevision: "1", primaryOccupancy: "2" };
async function fixture(auth: RequestContext | null = context) {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization === "Bearer valid") request.authContext = auth;
  });
  const read = vi
    .fn()
    .mockResolvedValue({ ...structuredClone(snapshot), revision: 1, sources, stale: false });
  await app.register(registerChannexOfferPreviewRoutes, { prefix: "/api/pms", read });
  return {
    read,
    inject: (
      query = new URLSearchParams(params).toString(),
      token = "Bearer valid",
      propertyId = id,
    ) =>
      app.inject({
        url: `/api/pms/properties/${propertyId}/channex/offer-preview?${query}`,
        headers: { authorization: token },
      }),
  };
}
describe("channel offer preview HTTP boundary", () => {
  it("registers only with a supplied preview runtime", async () => {
    const disabled = buildApp({ logger: false }),
      enabled = buildApp({ logger: false, channexOfferPreview: { read: vi.fn() } });
    apps.push(disabled, enabled);
    const url = `/api/pms/properties/${id}/channex/offer-preview`;
    expect((await disabled.inject({ url })).statusCode).toBe(404);
    expect((await enabled.inject({ url })).statusCode).toBe(401);
  });
  it("returns only the exact configuration and explicit primary, with no readiness claim", async () => {
    const f = await fixture(),
      response = await f.inject();
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(f.read).toHaveBeenCalledExactlyOnceWith(context, id);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      propertyId: id,
      roomTypeId: id,
      offerId: "flex",
      publicationRevision: 1,
      primaryOccupancy: 2,
      canProvision: false,
      canSend: false,
      kind: "preview",
      configuration: {
        sell_mode: "per_person",
        rate_mode: "manual",
        parent_rate_plan_id: null,
        inherit_rate: false,
        currency: "EUR",
        meal_type: "room_only",
        options: [
          { occupancy: 1, is_primary: false },
          { occupancy: 2, is_primary: true },
        ],
        stop_sell: Array(7).fill(true),
      },
    });
    const changed = await f.inject(
      new URLSearchParams({ ...params, primaryOccupancy: "1" }).toString(),
    );
    expect(changed.json().configuration.options).toEqual([
      { occupancy: 1, is_primary: true },
      { occupancy: 2, is_primary: false },
    ]);
  });
  it("rejects missing/invalid auth before reading or parsing selection", async () => {
    const f = await fixture();
    for (const token of ["", "Bearer invalid"]) {
      const r = await f.inject("bad=selection", token);
      expect(r.statusCode).toBe(401);
      expect(r.headers["cache-control"]).toBe("no-store");
    }
    expect(f.read).not.toHaveBeenCalled();
  });
  it("enforces both permissions, entitlement and exact owner/operator property access", async () => {
    for (const patch of [
      { membership: { permissions: ["pms.rooms_rates.read"] } },
      { membership: { permissions: ["pms.operations.read"] } },
      { entitlements: [] },
      { entitlements: [{ ...context.entitlements[0], status: "suspended" }] },
      {
        entitlements: [
          { ...context.entitlements[0], resource: { ...resource, resourceId: draftId } },
        ],
      },
      { linkedResources: [] },
      { linkedResources: [{ ...context.linkedResources[0], resourceId: draftId }] },
      { linkedResources: [{ ...context.linkedResources[0], status: "inactive" }] },
      { linkedResources: [{ ...context.linkedResources[0], relationship: "front_desk" }] },
      { selectedOrganization: { ...context.selectedOrganization, kind: "creator" } },
    ]) {
      const f = await fixture({ ...context, ...patch } as RequestContext);
      expect((await f.inject()).statusCode).toBe(403);
      expect(f.read).not.toHaveBeenCalled();
    }
    const operator = await fixture({
      ...context,
      linkedResources: [{ ...context.linkedResources[0], relationship: "operator" }],
    });
    expect((await operator.inject()).statusCode).toBe(200);
  });
  it("rejects missing, unknown, duplicate, fractional and noncanonical selections before reading", async () => {
    const f = await fixture(),
      valid = new URLSearchParams(params).toString();
    for (const key of Object.keys(params)) {
      const q = new URLSearchParams(params);
      q.delete(key);
      expect((await f.inject(q.toString())).statusCode).toBe(400);
      expect((await f.inject(`${valid}&${key}=1`)).statusCode).toBe(400);
    }
    const invalidSelections: Record<string, string>[] = [
      { actorUserId: id },
      { roomTypeId: "bad" },
      { roomTypeId: "AAAAAAAA-0000-4000-8000-000000000001" },
      { offerId: "" },
      { offerId: " flex" },
      { offerId: "x".repeat(201) },
      ...["0", "-1", "1.5", "01", "1e1", "+1", " 1", "2147483648"].map((publicationRevision) => ({
        publicationRevision,
      })),
      ...["0", "-1", "1.5", "01", "1e1", "101"].map((primaryOccupancy) => ({ primaryOccupancy })),
    ];
    for (const patch of invalidSelections) {
      expect(
        (await f.inject(new URLSearchParams({ ...params, ...patch }).toString())).statusCode,
      ).toBe(400);
    }
    expect((await f.inject(valid, "Bearer valid", "invalid")).statusCode).toBe(400);
    expect(f.read).not.toHaveBeenCalled();
  });
  it("returns missing and refresh-required states without falling back to another selection", async () => {
    const f = await fixture();
    for (const patch of [{ roomTypeId: draftId }, { offerId: "other" }])
      expect(
        (await f.inject(new URLSearchParams({ ...params, ...patch }).toString())).statusCode,
      ).toBe(404);
    expect(
      (await f.inject(new URLSearchParams({ ...params, primaryOccupancy: "3" }).toString()))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await f.inject(new URLSearchParams({ ...params, publicationRevision: "2" }).toString())
      ).json(),
    ).toEqual({ code: "refresh_required" });
    f.read.mockResolvedValue({ ...snapshot, revision: 1, sources, stale: true });
    expect((await f.inject()).statusCode).toBe(409);
    f.read.mockResolvedValue(null);
    expect((await f.inject()).statusCode).toBe(404);
    const maximum = {
      ...snapshot,
      rooms: snapshot.rooms.map((room) => ({ ...room, revision: 2147483647 })),
      revision: 2147483647,
      sources,
      stale: false,
    };
    f.read.mockResolvedValue(maximum);
    expect(
      (
        await f.inject(
          new URLSearchParams({ ...params, publicationRevision: "2147483647" }).toString(),
        )
      ).statusCode,
    ).toBe(200);
  });
  it("allows only bounded unsupported states and at most 100 occupancy options", async () => {
    const f = await fixture();
    for (const [adults, children, reason] of [
      [2, 1, "child_representation_unavailable"],
      [101, 0, "candidate_limit"],
    ] as const) {
      const room = structuredClone(snapshot.rooms[0]);
      room.capacity = { adults, children, total: adults + children };
      f.read.mockResolvedValue({ ...snapshot, rooms: [room], revision: 1, sources, stale: false });
      const r = await f.inject();
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        kind: "unsupported",
        reason,
        canProvision: false,
        canSend: false,
      });
      expect(r.json()).not.toHaveProperty("configuration");
    }
    const room = structuredClone(snapshot.rooms[0]);
    room.capacity = { total: 100, adults: 100, children: 0 };
    f.read.mockResolvedValue({ ...snapshot, rooms: [room], revision: 1, sources, stale: false });
    const r = await f.inject();
    expect(r.statusCode).toBe(200);
    expect(r.json().configuration.options).toHaveLength(100);
    expect(Buffer.byteLength(r.body)).toBeLessThan(6000);
  });
  it("sanitizes invalid stored evidence and failures and preserves transaction authorization denial", async () => {
    const f = await fixture();
    for (const patch of [
      { rooms: [null] },
      { revision: 0 },
      { stale: undefined },
      { currency: "XYZ" },
      { rooms: [{ ...snapshot.rooms[0], propertyId: draftId }] },
    ]) {
      f.read.mockResolvedValue({ ...snapshot, revision: 1, stale: false, sources, ...patch });
      const r = await f.inject();
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ code: "pricing_unavailable" });
    }
    for (const [error, status, code] of [
      [new Error("secret provider credential"), 503, "pricing_unavailable"],
      [new PricingStorageError("invalid"), 503, "pricing_unavailable"],
      [new PricingStorageError("denied"), 403, "forbidden"],
      [new PricingStorageError("stale"), 409, "refresh_required"],
    ] as const) {
      f.read.mockRejectedValue(error);
      const r = await f.inject();
      expect(r.statusCode).toBe(status);
      expect(r.json()).toEqual({ code });
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });
});
