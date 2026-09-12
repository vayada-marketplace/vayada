import { afterEach, expect, it, vi } from "vitest";
const { query, end } = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      query = query;
      end = end;
    },
  },
}));
import { createAirbnbImportRuntime, loadAirbnbImportConfig } from "./airbnbImportRuntime.js";
import { buildApp } from "./app.js";
const env = {
  AIRBNB_IMPORT_ENABLED: "true",
  CHANNEX_API_BASE_URL: "https://staging.channex.io",
  CHANNEX_API_KEY: "synthetic",
  AIRBNB_IMPORT_CALLBACK_ORIGIN: "https://marketplace.example.test",
};
afterEach(() => vi.clearAllMocks());
it("is disabled by default even without provider credentials", () => {
  expect(loadAirbnbImportConfig({})).toBeUndefined();
  expect(loadAirbnbImportConfig({ AIRBNB_IMPORT_ENABLED: "false" })).toBeUndefined();
});
it.each([
  { AIRBNB_IMPORT_ENABLED: "yes" },
  { CHANNEX_API_BASE_URL: "https://other.test" },
  { CHANNEX_API_KEY: "" },
  { AIRBNB_IMPORT_CALLBACK_ORIGIN: "http://marketplace.example.test" },
  { AIRBNB_IMPORT_CALLBACK_ORIGIN: "https://marketplace.example.test/path" },
  { AIRBNB_IMPORT_CALLBACK_ORIGIN: "https://user:pass@marketplace.example.test" },
])("rejects invalid enabled settings: %j", (override) => {
  expect(() => loadAirbnbImportConfig({ ...env, ...override })).toThrow();
});
it("requires the callback to be an explicitly allowed origin", () => {
  expect(() =>
    createAirbnbImportRuntime({
      config: loadAirbnbImportConfig(env)!,
      connectionString: "synthetic",
      allowedOrigins: [],
    }),
  ).toThrow("allowed authentication origin");
});
it("composes evidence lookup and provider link with the same binding", async () => {
  const id = "10090000-0000-4000-8000-000000000001";
  const groupId = "10090000-0000-4000-8000-000000000002";
  query.mockResolvedValue({
    rows: [
      {
        external_property_id: id,
        evidence: {
          contractVersion: "channex-property-creation.v1",
          environment: "staging",
          externalPropertyId: id,
          jobId: id,
        },
      },
    ],
  });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        data: {
          type: "property",
          id,
          relationships: { groups: { data: [{ type: "group", id: groupId }] } },
        },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: {
          type: "connection_link",
          attributes: { url: "https://www.airbnb.com/oauth2/auth?synthetic=true" },
        },
      }),
    );
  const runtime = createAirbnbImportRuntime({
    config: loadAirbnbImportConfig(env)!,
    connectionString: "synthetic",
    allowedOrigins: [env.AIRBNB_IMPORT_CALLBACK_ORIGIN],
    fetcher,
  });
  const binding = await runtime.routes.resolveBinding({
    propertyId: id,
    organizationId: id,
    actorUserId: id,
  });
  expect(binding).toEqual({ environment: "staging", externalPropertyId: id, groupId });
  await expect(
    runtime.routes.createLink(binding!, { sourceId: id, propertyId: id, state: "x".repeat(43) }),
  ).resolves.toContain("airbnb.com");
  const body = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
  expect(body.connection_link).toMatchObject({ group_id: groupId, properties: [id] });
  await runtime.routes.repository.close();
  await runtime.routes.applications.close();
  await runtime.close();
  expect(end).toHaveBeenCalledTimes(3);
});
it("does not mount Airbnb routes by default", async () => {
  const app = buildApp();
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/hotel-setup/properties/10090000-0000-4000-8000-000000000001/airbnb-import/start",
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
it("refuses mounting without authorization and canonical room ports", () => {
  expect(() => buildApp({ airbnbImports: {} as never })).toThrow(
    "authorization and canonical hotel room setup",
  );
});
it("mounts the enabled route with authentication enforced", async () => {
  const runtime = createAirbnbImportRuntime({
    config: loadAirbnbImportConfig(env)!,
    connectionString: "synthetic",
    allowedOrigins: [env.AIRBNB_IMPORT_CALLBACK_ORIGIN],
  });
  const close = async () => {};
  const app = buildApp({
    logger: false,
    auth: {
      verifier: { verify: async () => null },
      identityRepository: {},
      rolePermissionRepository: {},
      propertyAccessRepository: {},
    } as never,
    airbnbImports: runtime.routes,
    sharedHotelSetupStatusRepository: { close } as never,
    hotelSetupTrackCommandRepository: { close } as never,
    pmsRoomSetup: {
      facts: {
        commandPort: {},
        factsReadPort: {},
        bindingReadPort: {},
        unitReadPort: {},
        capacityReadPort: {},
      },
    } as never,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/hotel-setup/properties/10090000-0000-4000-8000-000000000001/airbnb-import/start",
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await runtime.close();
  }
});
