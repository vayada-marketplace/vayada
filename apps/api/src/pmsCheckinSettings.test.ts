import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type ResourceRelationship,
} from "@vayada/backend-auth";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import {
  DEFAULT_PMS_CHECKIN_SETTINGS,
  withDefaults,
  type PmsCheckinSettings,
  type PmsCheckinSettingsRepository,
  type PmsCheckinSettingsResponse,
  type PmsCheckinSettingsSave,
} from "./routes/pmsCheckinSettings.js";

const propertyId = "23740000-0000-4000-8000-000000000001";
const addonId = "23740000-0000-4000-8000-0000000000a1";
const organizationId = "11111111-1111-1111-1111-111111111111";
const actorUserId = "22222222-2222-2222-2222-222222222222";
const url = `/api/pms/properties/${propertyId}/check-in-settings`;
const headers = { authorization: "Bearer valid-token" };

function createRepository() {
  let stored: { settings: PmsCheckinSettings; updatedAt: string | null } = {
    settings: DEFAULT_PMS_CHECKIN_SETTINGS,
    updatedAt: null,
  };
  const saves: PmsCheckinSettingsSave[] = [];
  const repository: PmsCheckinSettingsRepository & { saves: typeof saves } = {
    saves,
    async find(id) {
      expect(id).toBe(propertyId);
      return stored;
    },
    async save(command) {
      saves.push(command);
      if (command.settings.addonIds?.some((id) => id !== addonId))
        return { ok: false, code: "unknown_addon" };
      stored = { settings: command.settings, updatedAt: "2026-10-26T12:00:00.000Z" };
      return { ok: true, ...stored, updatedAt: "2026-10-26T12:00:00.000Z" };
    },
  };
  return repository;
}

function buildAuthenticatedApp(
  options: {
    repository?: PmsCheckinSettingsRepository;
    permissions?: PermissionKey[];
    relationship?: ResourceRelationship;
  } = {},
) {
  const identityRepository: IdentityRepository = {
    async findUserByProviderUserId() {
      return { userId: actorUserId, email: "owner@example.com", status: "active" };
    },
    async findOrganizationByWorkosOrgId() {
      return { organizationId, workosOrgId: "workos-org-1", kind: "hotel_group", status: "active" };
    },
    async findActiveMembership() {
      return {
        membershipId: "33333333-3333-3333-3333-333333333333",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "workos-membership-1",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      const relationship = options.relationship ?? "owner";
      return [
        {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
          relationship,
          status: "active",
        },
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
          relationship,
          status: "active",
        },
      ];
    },
  };
  return buildApp({
    logger: false,
    pmsCheckinSettingsRepository: options.repository ?? createRepository(),
    auth: {
      verifier: createFakeVerifier(
        new Map([
          [
            "valid-token",
            {
              workosUserId: "workos-user-1",
              workosOrgId: "workos-org-1",
              sessionId: "session-1",
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            },
          ],
        ]),
      ),
      repository: identityRepository,
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return (
            options.permissions ?? [
              "pms.operations.read",
              "pms.settings.read",
              "pms.settings.manage",
            ]
          );
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return [
            {
              product: "pms",
              key: "property-management",
              status: "active",
              resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
            },
          ];
        },
      },
    },
  });
}

const changed: PmsCheckinSettings = {
  ...DEFAULT_PMS_CHECKIN_SETTINGS,
  showSpecialRequest: false,
  confirmSpecialRequest: false,
  registrationScope: "all",
  guestFields: DEFAULT_PMS_CHECKIN_SETTINGS.guestFields.map((entry) =>
    entry.field === "gender" ? { ...entry, show: true, required: true } : entry,
  ),
  addonIds: [addonId],
  settlementOptions: ["already_paid", "cash"],
  keyHandover: "none",
};

describe("PMS check-in settings routes (VAY-2374)", () => {
  let app: ReturnType<typeof buildApp> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("starts every property on the approved defaults", async () => {
    app = buildAuthenticatedApp();
    const response = await app.inject({ method: "GET", url, headers });

    expect(response.statusCode).toBe(200);
    expect(response.json<PmsCheckinSettingsResponse>()).toEqual({
      propertyId,
      canManage: true,
      settings: DEFAULT_PMS_CHECKIN_SETTINGS,
      updatedAt: null,
    });
    expect(DEFAULT_PMS_CHECKIN_SETTINGS.guestFields.filter((entry) => entry.required)).toHaveLength(
      4,
    );
  });

  it("saves a whole settings object, keeping settlement options in their fixed order", async () => {
    const repository = createRepository();
    app = buildAuthenticatedApp({ repository });
    const response = await app.inject({ method: "PUT", url, headers, payload: changed });

    expect(response.statusCode).toBe(200);
    expect(repository.saves[0]).toMatchObject({
      propertyId,
      settings: { ...changed, settlementOptions: ["cash", "already_paid"] },
      audit: { actorUserId, organizationId },
    });
    const read = await app.inject({ method: "GET", url, headers });
    expect(read.json<PmsCheckinSettingsResponse>().settings.keyHandover).toBe("none");
  });

  it("lets front desk staff read the settings while checking in, but not change them", async () => {
    const repository = createRepository();
    app = buildAuthenticatedApp({
      repository,
      permissions: ["pms.operations.read", "pms.operations.manage"],
      relationship: "front_desk",
    });
    const read = await app.inject({ method: "GET", url, headers });
    expect(read.statusCode).toBe(200);
    expect(read.json<PmsCheckinSettingsResponse>().canManage).toBe(false);
    const write = await app.inject({ method: "PUT", url, headers, payload: changed });
    expect(write.statusCode).toBe(403);
    expect(repository.saves).toEqual([]);
  });

  it("refuses incomplete or inconsistent settings before saving", async () => {
    const repository = createRepository();
    app = buildAuthenticatedApp({ repository });
    const fields = DEFAULT_PMS_CHECKIN_SETTINGS.guestFields;
    const partial: Record<string, unknown> = { ...changed };
    delete partial.keyHandover;

    for (const payload of [
      partial,
      { ...changed, doorCodes: true },
      { ...changed, showSpecialRequest: false, confirmSpecialRequest: true },
      { ...changed, registrationScope: "children" },
      { ...changed, keyHandover: "access_code" },
      { ...changed, guestFields: fields.slice(1) },
      { ...changed, guestFields: [...fields].reverse() },
      {
        ...changed,
        guestFields: fields.map((entry) => ({ ...entry, show: false, required: true })),
      },
      { ...changed, settlementOptions: [] },
      { ...changed, settlementOptions: ["card", "paypal"] },
      { ...changed, addonIds: [addonId, addonId] },
    ]) {
      const response = await app.inject({ method: "PUT", url, headers, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(repository.saves).toEqual([]);

    const unknownAddon = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: { ...changed, addonIds: ["23740000-0000-4000-8000-0000000000ff"] },
    });
    expect(unknownAddon.statusCode).toBe(400);
  });
});

describe("check-in settings read back from storage", () => {
  it("fills what a stored object doesn't hold and drops what it holds invalidly", () => {
    expect(withDefaults(null)).toEqual(DEFAULT_PMS_CHECKIN_SETTINGS);
    expect(
      withDefaults({ showSpecialRequest: false, registrationScope: "nobody", futureSetting: 1 }),
    ).toEqual({
      ...DEFAULT_PMS_CHECKIN_SETTINGS,
      showSpecialRequest: false,
      confirmSpecialRequest: false,
    });
    expect(withDefaults({ keyHandover: "none", addonIds: [addonId] })).toMatchObject({
      keyHandover: "none",
      addonIds: [addonId],
    });
  });
});
