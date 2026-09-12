import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { RequestContext } from "@vayada/backend-auth";
import {
  registerAirbnbImportRoutes,
  type AirbnbImportRoutesOptions,
} from "./routes/airbnbImports.js";

const propertyId = "10090000-0000-4000-8000-000000000001";
const sourceId = "10090000-0000-4000-8000-000000000002";
const channelId = "10090000-0000-4000-8000-000000000003";
const state = "x".repeat(43);
const origin = "https://marketplace.example.test";
const binding = {
  environment: "staging" as const,
  groupId: sourceId,
  externalPropertyId: propertyId,
};
const data = { contractVersion: "prepared-hotel-import.v1" as const, property: {}, rooms: [] };
const path = `/properties/${propertyId}/airbnb-import`;
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture(denial = "") {
  const context = {
    actor: { internalUserId: "actor", status: denial === "actor" ? "suspended" : "active" },
    selectedOrganization: {
      organizationId: "org",
      kind: denial === "kind" ? "platform" : "hotel_group",
      status: denial === "org" ? "suspended" : "active",
    },
    membership: {
      roleKey: "operator",
      status: denial === "membership" ? "inactive" : "active",
      permissions:
        denial === "permission"
          ? []
          : denial === "pms_permission"
            ? ["hotel_catalog.setup.manage"]
            : ["hotel_catalog.setup.manage", "pms.operations.manage"],
    },
    linkedResources:
      denial === "unlinked"
        ? []
        : [
            {
              product: "hotel_catalog",
              resourceType: "property",
              resourceId: propertyId,
              relationship: "owner",
              status: "active",
            },
            {
              product: "pms",
              resourceType: "pms_property",
              resourceId: propertyId,
              relationship: denial === "front_desk" ? "front_desk" : "owner",
              status: denial === "inactive_link" ? "inactive" : "active",
            },
          ],
    entitlements:
      denial === "entitlement"
        ? []
        : [
            {
              product: "pms",
              key: "property-management",
              status: denial === "inactive_entitlement" ? "inactive" : "active",
              resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
            },
          ],
  } as RequestContext;
  const options: AirbnbImportRoutesOptions = {
    allowedOrigins: [origin],
    propertyAccessRepository: {
      findMembershipPropertyScope: vi.fn(async () =>
        denial === "missing_scope"
          ? null
          : {
              mode: denial === "invalid_scope" ? "invalid" : "assigned",
              roleKey: "operator",
              accessOrigin: "agency",
              assignedPropertyIds: denial === "excluded_assignment" ? [] : [propertyId],
            },
      ),
    },
    repository: {
      begin: vi.fn(async () => ({ sourceId, state })),
      pending: vi.fn(async () => ({ ...binding, sourceId })),
      complete: vi.fn(async () => sourceId),
      find: vi.fn(async () => ({ ...binding, sourceId, channelId, data })),
      close: async () => {},
    },
    resolveBinding: vi.fn(async () => binding),
    createLink: vi.fn(async () => "https://www.airbnb.com/oauth2/auth?synthetic=true"),
    readListings: vi.fn(async () => data),
  };
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (denial !== "auth") request.authContext = context;
  });
  await app.register(registerAirbnbImportRoutes, options);
  const post = (suffix: string, payload: Record<string, unknown>, requestOrigin = origin) =>
    app.inject({ method: "POST", url: path + suffix, headers: { origin: requestOrigin }, payload });
  return { app, options, post };
}

it("starts from server binding and completes only after provider verification", async () => {
  const f = await fixture();
  const start = await f.post("/start", {});
  expect(start.statusCode).toBe(200);
  expect(start.headers["cache-control"]).toBe("private, no-store");
  expect(f.options.createLink).toHaveBeenCalledWith(binding, { state, sourceId, propertyId });
  const complete = await f.post("/complete", { state, channelId });
  expect(complete.json()).toEqual({ sourceId });
  expect(f.options.readListings).toHaveBeenCalledWith({ ...binding, sourceId }, channelId);
  expect(f.options.repository.complete).toHaveBeenCalledWith(
    { actorUserId: "actor", organizationId: "org", propertyId },
    state,
    channelId,
    data,
  );
  expect((await f.app.inject({ url: path + `/sources/${sourceId}` })).json()).toEqual({
    sourceId,
    data,
  });
});
it.each([
  "auth",
  "actor",
  "org",
  "kind",
  "membership",
  "missing_scope",
  "invalid_scope",
  "excluded_assignment",
  "pms_permission",
  "inactive_link",
  "inactive_entitlement",
  "permission",
  "unlinked",
  "front_desk",
  "entitlement",
])("denies %s on start, completion and retrieval", async (denial) => {
  const f = await fixture(denial);
  for (const response of [
    await f.post("/start", {}),
    await f.post("/complete", { state, channelId }),
    await f.app.inject({ url: path + `/sources/${sourceId}` }),
  ])
    expect(response.statusCode).toBe(denial === "auth" ? 401 : 403);
  expect(f.options.resolveBinding).not.toHaveBeenCalled();
  expect(f.options.repository.pending).not.toHaveBeenCalled();
  expect(f.options.readListings).not.toHaveBeenCalled();
});
it("rejects missing/foreign Origin and client provider/redirect overrides", async () => {
  const f = await fixture();
  for (const value of ["", "https://unrelated.example"])
    expect((await f.post("/start", {}, value)).statusCode).toBe(403);
  expect((await f.post("/start", { groupId: sourceId, redirect: origin })).statusCode).toBe(400);
  expect((await f.post("/complete", { state, channelId, success: true })).statusCode).toBe(400);
  expect(f.options.repository.begin).not.toHaveBeenCalled();
  expect(f.options.readListings).not.toHaveBeenCalled();
});
it("rejects expired/replayed state and changed binding before provider reads", async () => {
  const f = await fixture();
  vi.mocked(f.options.repository.pending).mockResolvedValueOnce(null);
  expect((await f.post("/complete", { state, channelId })).statusCode).toBe(409);
  vi.mocked(f.options.resolveBinding).mockResolvedValue({ ...binding, groupId: channelId });
  expect((await f.post("/complete", { state, channelId })).statusCode).toBe(409);
  expect((await f.app.inject({ url: path + `/sources/${sourceId}` })).statusCode).toBe(409);
  expect(f.options.readListings).not.toHaveBeenCalled();
  expect(f.options.repository.complete).not.toHaveBeenCalled();
});
it("keeps provider failures retryable without exposing details", async () => {
  const f = await fixture();
  vi.mocked(f.options.readListings).mockRejectedValueOnce(new Error("private-provider-detail"));
  expect((await f.post("/complete", { state, channelId })).json()).toEqual({
    code: "airbnb_source_unavailable",
  });
  expect(f.options.repository.complete).not.toHaveBeenCalled();
  expect((await f.post("/complete", { state, channelId })).statusCode).toBe(200);
  vi.mocked(f.options.repository.complete).mockResolvedValueOnce(null);
  expect((await f.post("/complete", { state, channelId })).statusCode).toBe(409);
});

it("handles unavailable binding/source and malformed callbacks without starting work", async () => {
  const f = await fixture();
  vi.mocked(f.options.resolveBinding).mockResolvedValue(null);
  expect((await f.post("/start", {})).statusCode).toBe(409);
  expect(f.options.repository.begin).not.toHaveBeenCalled();
  expect((await f.post("/complete", { state: "bad", channelId })).statusCode).toBe(400);
  expect(f.options.repository.pending).not.toHaveBeenCalled();
  vi.mocked(f.options.repository.find).mockResolvedValue(null);
  expect((await f.app.inject({ url: path + `/sources/${sourceId}` })).statusCode).toBe(404);
});

it("revokes completion and source access when a property assignment is removed", async () => {
  const f = await fixture();
  expect((await f.post("/start", {})).statusCode).toBe(200);
  vi.mocked(f.options.propertyAccessRepository.findMembershipPropertyScope).mockResolvedValue({
    mode: "assigned",
    roleKey: "operator",
    accessOrigin: "agency",
    assignedPropertyIds: [],
  });
  expect((await f.post("/complete", { state, channelId })).statusCode).toBe(403);
  expect((await f.app.inject({ url: path + `/sources/${sourceId}` })).statusCode).toBe(403);
  expect(f.options.readListings).not.toHaveBeenCalled();
});

it.each(["changed", "disconnected", "unavailable"])(
  "rejects %s binding during listing read before persisting",
  async (outcome) => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.options.readListings).mockImplementationOnce(async () => {
      entered();
      await blocked;
      return data;
    });
    const response = f.post("/complete", { state, channelId }).then((result) => result);
    await started;
    if (outcome === "unavailable")
      vi.mocked(f.options.resolveBinding).mockRejectedValue(new Error("private-binding-error"));
    else
      vi.mocked(f.options.resolveBinding).mockResolvedValue(
        outcome === "disconnected" ? null : { ...binding, groupId: channelId },
      );
    release();
    const result = await response;
    expect(result.statusCode).toBe(outcome === "unavailable" ? 502 : 409);
    expect(result.json()).toEqual({
      code: outcome === "unavailable" ? "airbnb_source_unavailable" : "channex_binding_changed",
    });
    expect(f.options.repository.complete).not.toHaveBeenCalled();
  },
);
