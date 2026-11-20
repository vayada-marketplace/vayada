import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createFakeVerifier, createPgIdentityRepository } from "@vayada/backend-auth";
import {
  createPgEntitlementRepository,
  createPgPropertyAccessRepository,
  createPgRolePermissionRepository,
} from "@vayada/backend-authorization";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import {
  createPgPartnerConnectionsRepository,
  pkceChallenge,
  type PartnerConnectionsRepository,
} from "./domains/partnerConnections.js";
import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";
import { registerPartnerApp } from "./platform/partnerAppRegistration.js";

/**
 * VAY-2436: a hotel connects a partner app once and the app gets tokens for that hotel only; a
 * Disconnect or the app's revoke stops them. Identity, roles, property scope and the partner tables
 * are real PostgreSQL; the partner tables are written by the ordinary API login, as in production.
 */
const url = process.env["TEST_DATABASE_URL"];
const readyMadeRoles = new URL(
  "../../../packages/backend-migration/fixtures/ready-made-team-roles.sql",
  import.meta.url,
);
const REDIRECT = "https://partner.example/vayada/callback";
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const [alpina, seeblick, otherHotel] = [randomUUID(), randomUUID(), randomUUID()];
const people = {
  owner: {
    userId: randomUUID(),
    roleKey: "hotel_owner",
    teamRole: "Account admin",
    org: organizationId,
  },
  frontDesk: {
    userId: randomUUID(),
    roleKey: "front_desk",
    teamRole: "Front desk",
    org: organizationId,
  },
  otherOwner: {
    userId: randomUUID(),
    roleKey: "hotel_owner",
    teamRole: null,
    org: otherOrganizationId,
  },
} as const;
type Person = keyof typeof people;
const bearer = (person: Person) => ({ authorization: `Bearer workos-${person}` });
const verifier = randomBytes(32).toString("base64url");
const challenge = pkceChallenge(verifier);

describe.skipIf(!url)("partner apps and the hotel's one-time approval (VAY-2436)", () => {
  let admin: pg.Client;
  let fixture: HotelSetupOrdinaryLoginFixture;
  let pool: pg.Pool;
  let repository: PartnerConnectionsRepository;
  let app: ReturnType<typeof buildApp>;
  let clientId: string;
  let basic: string;

  const authorizeQuery = (overrides: Record<string, string | undefined> = {}) => {
    const values: Record<string, string | undefined> = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "promo_codes bookings",
      state: "state-123",
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...overrides,
    };
    return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Record<
      string,
      string
    >;
  };

  async function approve(propertyId: string, person: Person = "owner") {
    return app.inject({
      method: "POST",
      url: "/api/booking/partner-authorizations",
      headers: bearer(person),
      payload: { authorization: authorizeQuery(), decision: "allow", propertyId },
    });
  }

  const codeOf = (redirectTo: string) => {
    const target = new URL(redirectTo);
    expect(target.origin + target.pathname).toBe(REDIRECT);
    expect(target.searchParams.get("state")).toBe("state-123");
    return target.searchParams.get("code")!;
  };

  const token = (fields: Record<string, string>, authorization = basic) =>
    app.inject({
      method: "POST",
      url: "/partner/oauth/token",
      headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(fields).toString(),
    });

  const exchange = (code: string, codeVerifier = verifier) =>
    token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: codeVerifier,
    });

  async function connect(propertyId = alpina) {
    const approved = await approve(propertyId);
    expect(approved.statusCode).toBe(200);
    const response = await exchange(codeOf(approved.json().redirectTo));
    expect(response.statusCode).toBe(200);
    return response.json() as { access_token: string; refresh_token: string; scope: string };
  }

  const hotel = (accessToken: string) =>
    app.inject({
      method: "GET",
      url: "/partner/v1/hotel",
      headers: { authorization: `Bearer ${accessToken}` },
    });

  beforeAll(async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    for (const [id, name] of [
      [organizationId, "VAY-2436 account"],
      [otherOrganizationId, "VAY-2436 other account"],
    ])
      await admin.query(
        `INSERT INTO identity.organizations (id, kind, name, slug, workos_org_id)
         VALUES ($1::uuid, 'hotel_group', $2, $1::text, 'wk-org-' || $1::text)`,
        [id, name],
      );
    await admin.query(await readFile(readyMadeRoles, "utf8"), [[organizationId]]);
    for (const [id, name, org] of [
      [alpina, "Hotel Alpina", organizationId],
      [seeblick, "Seeblick", organizationId],
      [otherHotel, "Other Hotel", otherOrganizationId],
    ] as const) {
      await admin.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, $1::text, $2)`,
        [id, name],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship)
         VALUES ($1::uuid, 'hotel_catalog', 'property', $2::text, 'owner'),
                ($1::uuid, 'booking', 'booking_hotel', $2::text, 'owner')`,
        [org, id],
      );
    }
    for (const org of [organizationId, otherOrganizationId])
      await admin.query(
        `INSERT INTO identity.product_entitlements (organization_id, product, entitlement_key, status)
         VALUES ($1, 'booking', 'booking-engine', 'active')`,
        [org],
      );
    await admin.query(
      "INSERT INTO pms.room_types (id, property_id, name, active) VALUES ($1, $2, 'Junior Suite', true), ($3, $2, 'Old Room', false)",
      [randomUUID(), alpina, randomUUID()],
    );
    for (const [person, { userId, roleKey, teamRole, org }] of Object.entries(people)) {
      await admin.query(`INSERT INTO identity.users (id, email, name) VALUES ($1, $2, $3)`, [
        userId,
        `${userId}@example.test`,
        person === "owner" ? "Anna Keller" : person,
      ]);
      await admin.query(
        `INSERT INTO identity.external_identities (user_id, provider, provider_user_id)
         VALUES ($1, 'workos', $2)`,
        [userId, `wk-user-${userId}`],
      );
      await admin.query(
        `INSERT INTO identity.organization_memberships
           (organization_id, user_id, status, role_key, access_origin, property_access_mode, role_definition_id)
         VALUES ($1::uuid, $2::uuid, 'active', $3, 'agency', 'all',
                 (SELECT id FROM identity.organization_roles WHERE organization_id = $1::uuid AND name = $4))`,
        [org, userId, roleKey, teamRole],
      );
    }

    fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    pool = new pg.Pool({ connectionString: fixture.connectionString, max: 3 });
    repository = createPgPartnerConnectionsRepository({ pool });
    const registered = await registerPartnerApp(pool, {
      name: "Partner Test App",
      redirectUris: [REDIRECT],
      scopes: ["promo_codes", "bookings"],
      webhookUrl: "https://partner.example/vayada/webhooks",
      contactEmail: null,
      termsVersion: "partner-contract-2026-10-31",
    });
    clientId = registered.clientId;
    basic = `Basic ${Buffer.from(`${clientId}:${registered.clientSecret}`).toString("base64")}`;

    const sessions = new Map(
      Object.entries(people).map(([person, { userId, org }]) => [
        `workos-${person}`,
        {
          workosUserId: `wk-user-${userId}`,
          workosOrgId: `wk-org-${org}`,
          sessionId: `session-${person}`,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      ]),
    );
    const propertyAccessRepository = createPgPropertyAccessRepository({ connectionString: url! });
    app = buildApp({
      logger: false,
      auth: {
        verifier: createFakeVerifier(sessions),
        repository: createPgIdentityRepository({ connectionString: url! }),
        rolePermissionRepository: createPgRolePermissionRepository({ connectionString: url! }),
        entitlementRepository: createPgEntitlementRepository({ connectionString: url! }),
        propertyAccessRepository,
      },
      partnerConnections: { repository, propertyAccessRepository },
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await fixture?.drop();
    await admin?.end();
  });

  it("shows the approval page only for a registered app and return address, with the hotels this person may connect", async () => {
    const page = (query: Record<string, string>, person: Person = "owner") =>
      app.inject({
        method: "GET",
        url: `/api/booking/partner-authorizations?${new URLSearchParams(query)}`,
        headers: bearer(person),
      });

    const owner = await page(authorizeQuery());
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toEqual({
      app: { name: "Partner Test App" },
      scopes: ["promo_codes", "bookings"],
      properties: [
        { propertyId: alpina, name: "Hotel Alpina", promoCodesEnabled: true },
        { propertyId: seeblick, name: "Seeblick", promoCodesEnabled: true },
      ],
    });
    // Front desk can't manage promo codes, so it may connect nothing.
    expect((await page(authorizeQuery(), "frontDesk")).json().properties).toEqual([]);

    // Never sent back to an address that isn't registered.
    expect((await page(authorizeQuery({ client_id: "partner_unknown" }))).json()).toEqual({
      code: "invalid_client",
    });
    expect(
      (await page(authorizeQuery({ redirect_uri: "https://evil.example/callback" }))).json(),
    ).toEqual({ code: "invalid_redirect_uri" });
    // Other mistakes go back to the app, the OAuth way.
    for (const [overrides, error] of [
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: undefined }, "invalid_request"],
      [{ scope: "promo_codes guests" }, "invalid_scope"],
      [{ response_type: "token" }, "unsupported_response_type"],
    ] as const) {
      const response = await page(authorizeQuery(overrides));
      expect(response.statusCode).toBe(400);
      const target = new URL(response.json().redirectTo);
      expect(target.searchParams.get("error")).toBe(error);
      expect(target.searchParams.get("state")).toBe("state-123");
    }
    expect(
      (await app.inject({ method: "GET", url: "/api/booking/partner-authorizations" })).statusCode,
    ).toBe(401);
  });

  it("lets only someone who manages the hotel's promo codes allow it, and sends Cancel back as access_denied", async () => {
    expect((await approve(alpina, "frontDesk")).statusCode).toBe(403);
    expect((await approve(otherHotel, "owner")).statusCode).toBe(403);
    expect((await approve(alpina, "otherOwner")).statusCode).toBe(403);

    const denied = await app.inject({
      method: "POST",
      url: "/api/booking/partner-authorizations",
      headers: bearer("frontDesk"),
      payload: { authorization: authorizeQuery(), decision: "deny" },
    });
    expect(denied.statusCode).toBe(200);
    const target = new URL(denied.json().redirectTo);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("code")).toBeNull();
  });

  it("swaps a code once, with the right secret, return address and PKCE verifier, for tokens that work for that hotel only", async () => {
    const code = codeOf((await approve(alpina)).json().redirectTo);

    const swapped = await exchange(code);
    expect(swapped.statusCode).toBe(200);
    const tokens = swapped.json();
    expect(tokens).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "promo_codes bookings",
      hotel: { hotelId: alpina, name: "Hotel Alpina" },
    });
    expect(tokens.access_token).toMatch(/^vyp_at_/);
    expect(tokens.refresh_token).toMatch(/^vyp_rt_/);
    expect(swapped.headers["cache-control"]).toBe("no-store");

    const read = await hotel(tokens.access_token);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({
      hotelId: alpina,
      name: "Hotel Alpina",
      currency: null,
      bookingPageUrl: null,
      promoCodesEnabled: true,
      rooms: [{ roomId: expect.any(String), name: "Junior Suite" }],
    });

    // The same code again: refused, and what the first swap got stops working (RFC 6749 4.1.2).
    expect((await exchange(code)).json()).toEqual({ error: "invalid_grant" });
    expect((await hotel(tokens.access_token)).statusCode).toBe(401);
    expect(
      (await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).json(),
    ).toEqual({ error: "invalid_grant" });
  });

  it("refuses a wrong client secret, verifier, return address, form or grant type", async () => {
    const code = codeOf((await approve(alpina)).json().redirectTo);
    const wrongClient = await token(
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier },
      `Basic ${Buffer.from(`${clientId}:vyp_cs_wrong`).toString("base64")}`,
    );
    expect(wrongClient.statusCode).toBe(401);
    expect(wrongClient.json()).toEqual({ error: "invalid_client" });
    expect(wrongClient.headers["www-authenticate"]).toContain("Basic");

    expect((await exchange(code, randomBytes(32).toString("base64url"))).json()).toEqual({
      error: "invalid_grant",
    });
    expect(
      (
        await token({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://partner.example/other",
          code_verifier: verifier,
        })
      ).json(),
    ).toEqual({ error: "invalid_grant" });
    const json = await app.inject({
      method: "POST",
      url: "/partner/oauth/token",
      headers: { authorization: basic },
      payload: { grant_type: "authorization_code", code },
    });
    expect(json.statusCode).toBe(400);
    expect(json.json()).toEqual({ error: "invalid_request" });
    expect((await token({ grant_type: "client_credentials" })).json()).toEqual({
      error: "unsupported_grant_type",
    });
    // The code still works after refused attempts, once.
    expect((await exchange(code)).statusCode).toBe(200);
  });

  it("rotates refresh tokens, and a refresh token used twice stops its whole family", async () => {
    const first = await connect();
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
    });
    expect(refreshed.statusCode).toBe(200);
    const second = refreshed.json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await hotel(second.access_token)).statusCode).toBe(200);

    const narrowed = await token({
      grant_type: "refresh_token",
      refresh_token: second.refresh_token,
      scope: "bookings",
    });
    expect(narrowed.json().scope).toBe("bookings");
    const third = narrowed.json();
    // Only that access token was narrowed: the refresh token keeps both scopes (RFC 6749 6).
    const widened = await token({
      grant_type: "refresh_token",
      refresh_token: third.refresh_token,
      scope: "promo_codes",
    });
    expect(widened.json().scope).toBe("promo_codes");
    const fourth = widened.json();
    expect(
      (
        await token({
          grant_type: "refresh_token",
          refresh_token: fourth.refresh_token,
          scope: "guests",
        })
      ).json(),
    ).toEqual({ error: "invalid_scope" });

    // The first refresh token comes back: everything from that approval stops.
    expect(
      (await token({ grant_type: "refresh_token", refresh_token: first.refresh_token })).json(),
    ).toEqual({ error: "invalid_grant" });
    expect((await hotel(fourth.access_token)).statusCode).toBe(401);
    expect(
      (await token({ grant_type: "refresh_token", refresh_token: fourth.refresh_token })).json(),
    ).toEqual({ error: "invalid_grant" });
  });

  it("keeps WorkOS tokens and partner tokens apart: neither works on the other's routes", async () => {
    const tokens = await connect();
    const workosAtPartner = await app.inject({
      method: "GET",
      url: "/partner/v1/hotel",
      headers: bearer("owner"),
    });
    expect(workosAtPartner.statusCode).toBe(401);
    expect(workosAtPartner.json()).toEqual({
      error: { code: "unauthenticated", message: "A valid access token is required." },
    });
    const partnerAtApi = await app.inject({
      method: "GET",
      url: `/api/booking/properties/${alpina}/partner-connections`,
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(partnerAtApi.statusCode).toBe(401);
    const refreshAsAccess = await hotel(tokens.refresh_token);
    expect(refreshAsAccess.statusCode).toBe(401);
    const unknown = await app.inject({
      method: "GET",
      url: "/partner/v1/unknown",
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");
  });

  it("lists the hotel's connected apps and Disconnect stops every token at once", async () => {
    const tokens = await connect();
    const list = await app.inject({
      method: "GET",
      url: `/api/booking/properties/${alpina}/partner-connections`,
      headers: bearer("owner"),
    });
    expect(list.statusCode).toBe(200);
    const { connections, canManage } = list.json();
    expect(canManage).toBe(true);
    // Re-approving keeps one connection per app and hotel.
    expect(connections).toEqual([
      {
        connectionId: expect.any(String),
        appName: "Partner Test App",
        scopes: ["promo_codes", "bookings"],
        approvedAt: expect.any(String),
        approvedByName: "Anna Keller",
      },
    ]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/booking/properties/${alpina}/partner-connections`,
          headers: bearer("otherOwner"),
        })
      ).statusCode,
    ).toBe(403);
    const disconnect = (person: Person) =>
      app.inject({
        method: "DELETE",
        url: `/api/booking/properties/${alpina}/partner-connections/${connections[0].connectionId}`,
        headers: bearer(person),
      });
    expect((await disconnect("frontDesk")).statusCode).toBe(403);
    expect((await disconnect("owner")).statusCode).toBe(204);
    expect((await disconnect("owner")).statusCode).toBe(404);

    expect((await hotel(tokens.access_token)).statusCode).toBe(401);
    expect(
      (await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).json(),
    ).toEqual({ error: "invalid_grant" });
    const after = await app.inject({
      method: "GET",
      url: `/api/booking/properties/${alpina}/partner-connections`,
      headers: bearer("owner"),
    });
    expect(after.json().connections).toEqual([]);
    const row = await admin.query(
      `SELECT status, revocation_reason, revoked_by_user_id::text AS "revokedBy"
       FROM distribution.partner_connections WHERE id = $1`,
      [connections[0].connectionId],
    );
    expect(row.rows[0]).toEqual({
      status: "revoked",
      revocation_reason: "hotel_disconnected",
      revokedBy: people.owner.userId,
    });
  });

  it("lets the app disconnect itself with its revoke call, which answers 200 even for unknown tokens", async () => {
    const tokens = await connect(seeblick);
    const revoke = (value: string, authorization = basic) =>
      app.inject({
        method: "POST",
        url: "/partner/oauth/revoke",
        headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ token: value }).toString(),
      });
    expect((await revoke(tokens.refresh_token, "Basic bm9wZTpub3Bl")).statusCode).toBe(401);
    expect((await hotel(tokens.access_token)).statusCode).toBe(200);
    expect((await revoke("vyp_rt_unknown")).statusCode).toBe(200);
    expect((await revoke(tokens.refresh_token)).statusCode).toBe(200);
    expect((await hotel(tokens.access_token)).statusCode).toBe(401);
    const row = await admin.query(
      `SELECT status, revocation_reason FROM distribution.partner_connections
       WHERE property_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [seeblick],
    );
    expect(row.rows[0]).toEqual({ status: "revoked", revocation_reason: "partner_revoked" });
  });

  it("lets a code expire after five minutes and an access token after an hour", async () => {
    const approved = await approve(alpina);
    const code = codeOf(approved.json().redirectTo);
    const app0 = (await repository.findApp(clientId))!;
    const later = createPgPartnerConnectionsRepository({
      pool,
      now: () => new Date(Date.now() + 301_000),
    });
    expect(
      await later.exchangeCode({ app: app0, code, redirectUri: REDIRECT, codeVerifier: verifier }),
    ).toEqual({ error: "invalid_grant" });

    const grant = await repository.exchangeCode({
      app: app0,
      code,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    if ("error" in grant) throw new Error("expected tokens");
    expect(await repository.authenticateAccessToken(grant.accessToken)).toMatchObject({
      propertyId: alpina,
      scopes: ["promo_codes", "bookings"],
    });
    const nextHour = createPgPartnerConnectionsRepository({
      pool,
      now: () => new Date(Date.now() + 3_601_000),
    });
    expect(await nextHour.authenticateAccessToken(grant.accessToken)).toBeNull();

    // Only hashes are stored.
    const stored = await admin.query(
      `SELECT count(*)::int AS n FROM distribution.partner_tokens WHERE token_hash = $1 OR token_hash = $2`,
      [grant.accessToken, grant.refreshToken],
    );
    expect(stored.rows[0].n).toBe(0);
  });
});
