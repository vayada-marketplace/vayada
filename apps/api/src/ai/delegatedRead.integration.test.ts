// AI reads as the signed-in user against real PostgreSQL identity, roles, entitlements and property
// scope (VAY-2506): one user in two hotel accounts, assigned to one of two properties in the first.
import { randomUUID } from "node:crypto";

import {
  AuthError,
  createFakeVerifier,
  createPgIdentityRepository,
  DelegationRefusedError,
  delegatedPropertyIds,
  injectAsDelegate,
  resolveDelegatedContext,
  type IdentityRepository,
} from "@vayada/backend-auth";
import {
  createAuthorizationResolver,
  createPgEntitlementRepository,
  createPgPropertyAccessRepository,
  createPgRolePermissionRepository,
} from "@vayada/backend-authorization";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import type { PmsOperationsReadRepository } from "../domains/pmsOperationsReadModel.js";
import type { BookingPromoCodesRepository } from "../routes/bookingPromoCodes.js";
import { runDelegatedRead } from "./delegatedRead.js";

const url = process.env.TEST_DATABASE_URL;
const PREFIX = `vay2506-${randomUUID().slice(0, 8)}`;
const ROOMS = "/api/pms/properties/:propertyId/rooms";
const PROMOS = "/api/booking/hotels/:hotelId/promo-codes";
const DELEGABLE = new Set([ROOMS, PROMOS]);

const member = randomUUID();
const orgA = randomUUID();
const orgB = randomUUID();
const p1 = randomUUID();
const p2 = randomUUID();
const p3 = randomUUID();
const conversation = randomUUID();

const pmsOperationsRepository = {
  async listRoomsByPropertyId(propertyId: string) {
    return { items: [{ roomId: `room-${propertyId}`, roomNumber: "101", status: "available" }] };
  },
} as unknown as PmsOperationsReadRepository;
const promoCodes = {
  async listPromoCodesByHotelId() {
    return [];
  },
} as unknown as BookingPromoCodesRepository;

describe.skipIf(!url)("AI reads as the user on real PostgreSQL (VAY-2506)", () => {
  let admin: pg.Client;
  let app: ReturnType<typeof buildApp>;
  let identity: IdentityRepository;
  let authorizationResolver: ReturnType<typeof createAuthorizationResolver>;
  let toolCall = 0;

  beforeAll(async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    admin = new pg.Client({ connectionString: url });
    await admin.connect();

    for (const [id, label] of [
      [orgA, "a"],
      [orgB, "b"],
    ] as const) {
      await admin.query(
        `INSERT INTO identity.organizations (id, kind, name, slug, workos_org_id)
         VALUES ($1::uuid, 'hotel_group', $2, $2, $3)`,
        [id, `${PREFIX}-${label}`, `wk-${PREFIX}-${label}`],
      );
      await admin.query(
        `INSERT INTO identity.product_entitlements (organization_id, product, entitlement_key, status)
         VALUES ($1, 'pms', 'property-management', 'active'), ($1, 'booking', 'booking-engine', 'active')`,
        [id],
      );
    }
    for (const [propertyId, organizationId] of [
      [p1, orgA],
      [p2, orgA],
      [p3, orgB],
    ] as const) {
      await admin.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, $2, $2)`,
        [propertyId, `${PREFIX}-${propertyId.slice(0, 8)}`],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship)
         VALUES ($1::uuid, 'hotel_catalog', 'property', $2::text, 'owner'),
                ($1::uuid, 'pms', 'pms_property', $2::text, 'owner'),
                ($1::uuid, 'booking', 'booking_hotel', $2::text, 'owner')`,
        [organizationId, propertyId],
      );
    }
    await admin.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
      member,
      `${PREFIX}@example.test`,
    ]);
    await admin.query(
      `INSERT INTO identity.external_identities (user_id, provider, provider_user_id)
       VALUES ($1, 'workos', $2)`,
      [member, `wk-user-${PREFIX}`],
    );
    // Account A: hotel manager assigned to P1 only. Account B: owner of everything.
    const inA = await admin.query<{ id: string }>(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, access_origin, property_access_mode)
       VALUES ($1, $2, 'active', 'hotel_manager', 'agency', 'assigned') RETURNING id::text`,
      [orgA, member],
    );
    await admin.query(
      `INSERT INTO identity.membership_property_assignments (membership_id, property_id) VALUES ($1, $2)`,
      [inA.rows[0]!.id, p1],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, access_origin, property_access_mode)
       VALUES ($1, $2, 'active', 'hotel_owner', 'agency', 'all')`,
      [orgB, member],
    );

    identity = createPgIdentityRepository({ connectionString: url! });
    const auth = {
      verifier: createFakeVerifier(
        new Map([
          [
            "member-a",
            {
              workosUserId: `wk-user-${PREFIX}`,
              workosOrgId: `wk-${PREFIX}-a`,
              sessionId: "browser-session",
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            },
          ],
        ]),
      ),
      repository: identity,
      rolePermissionRepository: createPgRolePermissionRepository({ connectionString: url! }),
      entitlementRepository: createPgEntitlementRepository({ connectionString: url! }),
      propertyAccessRepository: createPgPropertyAccessRepository({ connectionString: url! }),
      delegation: {
        allowsRoute: (method: string, route: string) => method === "GET" && DELEGABLE.has(route),
      },
    };
    authorizationResolver = createAuthorizationResolver(
      auth.rolePermissionRepository,
      auth.entitlementRepository,
      auth.propertyAccessRepository,
    );
    app = buildApp({
      logger: false,
      pmsOperationsRepository,
      bookingPromoCodesRepository: promoCodes,
      auth,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (!admin) return;
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query(
      `DELETE FROM identity.membership_property_assignments WHERE membership_id IN (
         SELECT id FROM identity.organization_memberships WHERE organization_id = ANY($1::uuid[]))`,
      [[orgA, orgB]],
    );
    for (const table of [
      "identity.organization_memberships",
      "identity.organization_resource_links",
      "identity.product_entitlements",
    ])
      await admin.query(`DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`, [
        [orgA, orgB],
      ]);
    await admin.query(`DELETE FROM identity.external_identities WHERE user_id = $1`, [member]);
    await admin.query(`DELETE FROM identity.users WHERE id = $1`, [member]);
    await admin.query(`DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])`, [
      [p1, p2, p3],
    ]);
    await admin.query(`DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])`, [
      [orgA, orgB],
    ]);
    await admin.query("COMMIT");
    await admin.end();
  });

  const as = (organizationId: string) =>
    resolveDelegatedContext(
      identity,
      {
        userId: member,
        organizationId,
        delegation: {
          channel: "in_app",
          conversationId: conversation,
          toolCallId: `call-${++toolCall}`,
        },
      },
      { authorizationResolver },
    );

  it("resolves the member from the database, narrowed to the assigned property", async () => {
    const context = await as(orgA);
    expect(context.actor.internalUserId).toBe(member);
    expect(context.actor.providerIdentity).toMatchObject({ providerUserId: `wk-user-${PREFIX}` });
    expect(context.actor.providerIdentity.sessionId).toBeUndefined();
    expect(context.membership.roleKey).toBe("hotel_manager");
    expect(context.membership.propertyAccess).toMatchObject({
      mode: "assigned",
      assignedPropertyIds: [p1],
    });
    expect(delegatedPropertyIds(context)).toEqual([p1]);
    expect(context.linkedResources.every((link) => link.resourceId === p1)).toBe(true);
  });

  it("reads the assigned property and refuses the other one of the same account", async () => {
    const context = await as(orgA);
    const own = await runDelegatedRead(app, {
      context,
      routeUrl: ROOMS,
      params: { propertyId: p1 },
    });
    expect(own.statusCode).toBe(200);
    await expect(
      runDelegatedRead(app, { context, routeUrl: ROOMS, params: { propertyId: p2 } }),
    ).rejects.toThrow(DelegationRefusedError);
  });

  it("makes a hotel-group-only route refuse unassigned properties for the AI (VAY-2567 1a)", async () => {
    // The website: the promo list checks only the hotel group's link to the property.
    const website = await app.inject({
      method: "GET",
      url: `/api/booking/hotels/${p2}/promo-codes`,
      headers: { authorization: "Bearer member-a" },
    });
    expect(website.statusCode).toBe(200);
    const context = await as(orgA);
    const ai = await injectAsDelegate(app, {
      context,
      method: "GET",
      routeUrl: PROMOS,
      url: `/api/booking/hotels/${p2}/promo-codes`,
    });
    expect(ai.statusCode).toBe(403);
    const own = await runDelegatedRead(app, { context, routeUrl: PROMOS, params: { hotelId: p1 } });
    expect(own.statusCode).toBe(200);
  });

  it("keeps the user's two hotel accounts apart", async () => {
    const inA = await as(orgA);
    const inB = await as(orgB);
    expect(delegatedPropertyIds(inB)).toEqual([p3]);
    const p3FromA = await injectAsDelegate(app, {
      context: inA,
      method: "GET",
      routeUrl: ROOMS,
      url: `/api/pms/properties/${p3}/rooms`,
    });
    expect(p3FromA.statusCode).toBe(403);
    expect(
      (await runDelegatedRead(app, { context: inB, routeUrl: ROOMS, params: { propertyId: p3 } }))
        .statusCode,
    ).toBe(200);
    const p1FromB = await injectAsDelegate(app, {
      context: inB,
      method: "GET",
      routeUrl: ROOMS,
      url: `/api/pms/properties/${p1}/rooms`,
    });
    expect(p1FromB.statusCode).toBe(403);
  });

  it("refuses accounts the user is not a member of, and platform accounts", async () => {
    const stranger = await as(randomUUID()).catch((error: unknown) => error);
    expect((stranger as AuthError).code).toBe("ORGANIZATION_NOT_FOUND");
    const platform = await admin.query<{ id: string }>(
      `SELECT id::text FROM identity.organizations WHERE kind = 'platform' LIMIT 1`,
    );
    if (platform.rows[0]) {
      await expect(as(platform.rows[0].id)).rejects.toThrow(DelegationRefusedError);
    }
  });
});
