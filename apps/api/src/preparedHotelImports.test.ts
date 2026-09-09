import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@vayada/backend-auth";
import type { PropertyProfileResponse, PreparedHotelImport } from "@vayada/domain-hotels";
import { registerPreparedHotelImportRoutes } from "./routes/preparedHotelImports.js";
import type { PreparedImportSource } from "./domains/preparedHotelImportRepository.js";
import type { PmsRoomFactsRoutesOptions } from "./routes/pmsRoomFacts.js";
import { parseHotelAccountInviteCreateRequest } from "./routes/marketplaceAdmin.js";
const room = {
  id: "suite",
  name: "Suite",
  description: "",
  maxGuests: 2,
  maxAdults: 2,
  maxChildren: 0,
  bedType: "queen",
  bedQuantity: 1,
  bathroomType: "private" as const,
  sizeSquareMetres: null,
};
const data: PreparedHotelImport = {
  contractVersion: "prepared-hotel-import.v1",
  property: { displayName: "Prepared Hotel", city: "Munich" },
  rooms: [room],
};
const propertyId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture(
  overrides: {
    permissions?: string[];
    pms?: boolean;
    bound?: boolean;
    source?: boolean;
    stale?: boolean;
    auth?: (context: RequestContext) => RequestContext;
  } = {},
) {
  const source: PreparedImportSource = { sourceId, data, propertyId: null, results: {} };
  const profile = {
    propertyId,
    profileRevision: 1,
    profile: {
      displayName: "Existing Hotel",
      propertyType: "hotel",
      location: {
        streetAddress: "Street 1",
        postalCode: "10115",
        city: "Berlin",
        countryCode: "DE",
        timezone: "Europe/Berlin",
        latitude: null,
        longitude: null,
        localityPublic: false,
        geoPublic: false,
        mapDisplayMode: "hidden",
      },
      contacts: [
        { channelType: "email", value: "hotel@example.test", purpose: "guest", isPublic: false },
        { channelType: "phone", value: "+49301234567", purpose: "operations", isPublic: false },
      ],
    },
  } as PropertyProfileResponse;
  const find = vi.fn(async () => (overrides.source === false ? null : source));
  const apply = vi.fn(async (_scope, execute) => {
    const items = await execute(source);
    for (const item of items) if (item.status === "applied") source.results[item.itemId] = item;
    return items;
  });
  const update = vi.fn(async (input) => {
    if (overrides.stale) return null;
    profile.profile = input.profile;
    profile.profileRevision++;
    return profile;
  });
  const create = vi.fn(async (command) => ({
    ok: true,
    response: { roomType: { roomTypeId: "room-created" }, facts: command.facts },
  }));
  const bind = vi.fn(async () => (overrides.bound ? { roomTypeId: "room-existing" } : null));
  const list = vi.fn(async () => []);
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer test") return;
    request.authContext = {
      actor: { internalUserId: "actor", status: "active" },
      selectedOrganization: { organizationId: "org", kind: "hotel_group", status: "active" },
      membership: {
        status: "active",
        permissions: overrides.permissions ?? [
          "hotel_catalog.setup.manage",
          "marketplace.profile.manage",
          "pms.operations.manage",
        ],
      },
      linkedResources: [
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
          relationship: "owner",
          status: "active",
        },
        ...(overrides.pms === false
          ? []
          : [
              {
                product: "pms",
                resourceType: "pms_property",
                resourceId: propertyId,
                relationship: "owner",
                status: "active",
              },
            ]),
      ],
      entitlements:
        overrides.pms === false
          ? []
          : [
              {
                product: "pms",
                key: "property-management",
                status: "active",
                resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
              },
            ],
    } as RequestContext;
    if (overrides.auth) request.authContext = overrides.auth(request.authContext);
  });
  await app.register(registerPreparedHotelImportRoutes, {
    repository: { find, apply, close: async () => {} },
    profiles: { getPropertyProfile: async () => profile, updatePropertyProfile: update },
    rooms: {
      commandPort: { createRoomTypeFacts: create },
      bindingReadPort: { getDraftRoomTypeBinding: bind },
      factsReadPort: { listRoomTypeFacts: list },
    } as unknown as PmsRoomFactsRoutesOptions,
  });
  const post = (patch: PreparedHotelImport = data) =>
    app.inject({
      method: "POST",
      url: `/properties/${propertyId}/import`,
      headers: { authorization: "Bearer test" },
      payload: { sourceId, data: patch, expectedProfileRevision: 1 },
    });
  return { app, post, find, apply, update, create, bind, list, source, profile };
}
describe("prepared import routes", () => {
  it("preserves the published map when importing only a timezone", async () => {
    const f = await fixture();
    Object.assign(f.profile.profile.location, {
      latitude: 52.52,
      longitude: 13.405,
      geoPublic: true,
      mapDisplayMode: "exact",
    });
    const before = { ...f.profile.profile.location };
    const result = await f.post({ ...data, property: { timezone: "Europe/Paris" }, rooms: [] });
    expect(result.statusCode).toBe(200);
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.profile.profile.location).toEqual({ ...before, timezone: "Europe/Paris" });
  });
  it.each([
    "actor",
    "membership",
    "organization",
    "missing-entitlement",
    "inactive-entitlement",
    "staff-link",
    "profile-permission",
  ])("denies %s access before applying", async (failure) => {
    const f = await fixture({
      auth: (context) => {
        if (failure === "actor")
          return { ...context, actor: { ...context.actor, status: "suspended" } };
        if (failure === "membership")
          return { ...context, membership: { ...context.membership, status: "suspended" } };
        if (failure === "organization")
          return {
            ...context,
            selectedOrganization: { ...context.selectedOrganization, status: "suspended" },
          };
        if (failure === "missing-entitlement") return { ...context, entitlements: [] };
        if (failure === "inactive-entitlement")
          return {
            ...context,
            entitlements: context.entitlements.map((item) => ({ ...item, status: "suspended" })),
          };
        if (failure === "staff-link")
          return {
            ...context,
            linkedResources: context.linkedResources.map((item) => ({
              ...item,
              relationship: "front_desk",
            })),
          } as RequestContext;
        return {
          ...context,
          membership: {
            ...context.membership,
            permissions: ["hotel_catalog.setup.manage", "pms.operations.manage"],
          },
        };
      },
    });
    expect((await f.post()).statusCode).toBe(403);
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("denies missing setup permission before source lookup", async () => {
    const f = await fixture({ permissions: [] });
    expect(
      (await f.app.inject({ url: "/imports/prepared", headers: { authorization: "Bearer test" } }))
        .statusCode,
    ).toBe(403);
    expect(f.find).not.toHaveBeenCalled();
  });

  it("preview does not write", async () => {
    const f = await fixture();
    const r = await f.app.inject({
      url: `/properties/${propertyId}/import`,
      headers: { authorization: "Bearer test" },
    });
    expect(r.statusCode).toBe(200);
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
  it("requires authentication and linked property", async () => {
    const f = await fixture();
    expect((await f.app.inject({ url: `/properties/${propertyId}/import` })).statusCode).toBe(401);
    expect(
      (
        await f.app.inject({
          url: "/properties/other/import",
          headers: { authorization: "Bearer test" },
        })
      ).statusCode,
    ).toBe(403);
    expect(f.find).not.toHaveBeenCalled();
  });
  it("rejects room writes without PMS access", async () => {
    const f = await fixture({ pms: false });
    expect((await f.post()).statusCode).toBe(403);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("allows marketplace hotel fields without PMS access", async () => {
    const f = await fixture({ pms: false });
    expect(
      (await f.post({ ...data, rooms: [] }))
        .json()
        .items.every((item: { status: string }) => item.status === "applied"),
    ).toBe(true);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("supports incremental property selections and preserves applied fields", async () => {
    const f = await fixture();
    await f.post({ ...data, property: { displayName: "Prepared Hotel" }, rooms: [] });
    await f.post({ ...data, property: { city: "Munich" }, rooms: [] });
    await f.post({ ...data, property: { displayName: "Overwrite" }, rooms: [] });
    expect(f.update).toHaveBeenCalledTimes(2);
    expect(f.source.results["property:city"].status).toBe("applied");
  });
  it("returns partial failure for stale profile while creating room", async () => {
    const f = await fixture({ stale: true });
    const r = await f.post();
    expect(r.json().items).toContainEqual({
      itemId: "property:displayName",
      status: "failed",
      error: "profile_revision_conflict",
    });
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it("recovers existing room binding without overwriting edits", async () => {
    const f = await fixture({ bound: true });
    await f.post({ ...data, property: {} });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("corrected room facts get new command keys but same binding identity", async () => {
    const f = await fixture();
    f.create.mockResolvedValue({ ok: false, error: { code: "room_type_name_conflict" } } as never);
    await f.post({ ...data, property: {} });
    await f.post({ ...data, property: {}, rooms: [{ ...room, name: "Renamed Suite" }] });
    const [a, b] = f.create.mock.calls.map((c) => c[0]);
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    expect(a.draftRoomId).toBe(b.draftRoomId);
  });
  it("rejects fabricated source room IDs", async () => {
    const f = await fixture();
    expect((await f.post({ ...data, rooms: [{ ...room, id: "other" }] })).statusCode).toBe(404);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("validates unknown room facts before binding", async () => {
    const f = await fixture();
    expect((await f.post({ ...data, rooms: [{ ...room, maxGuests: null }] })).statusCode).toBe(422);
    expect(f.apply).not.toHaveBeenCalled();
  });
});
describe("invite preparation contract", () => {
  const invite = {
    identity: { email: "owner@example.test" },
    organization: { displayName: "Group" },
    property: { displayName: "Hotel" },
    selectedTracks: ["creator_marketplace"],
  };
  it("keeps old invitations valid", () =>
    expect(typeof parseHotelAccountInviteCreateRequest(invite)).toBe("object"));
  it("rejects rooms on marketplace-only invites", () =>
    expect(parseHotelAccountInviteCreateRequest({ ...invite, preparedData: data })).toBe(
      "rooms_require_hotel_operations",
    ));
  it("accepts prepared operations invites", () =>
    expect(
      typeof parseHotelAccountInviteCreateRequest({
        ...invite,
        selectedTracks: ["hotel_operations"],
        preparedData: data,
      }),
    ).toBe("object"));
});
