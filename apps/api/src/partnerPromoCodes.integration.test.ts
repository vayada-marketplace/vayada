import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import {
  createPgPartnerConnectionsRepository,
  pkceChallenge,
  type PartnerConnectionsRepository,
  type PartnerScope,
} from "./domains/partnerConnections.js";
import { createPgPartnerPromoCodesRepository } from "./domains/partnerPromoCodes.js";
import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";
import { registerPartnerApp } from "./platform/partnerAppRegistration.js";
import {
  PartnerManagedPromoCodeError,
  createPgTargetBookingPromoCodesRepository,
} from "./routes/bookingPromoCodes.js";
import { validateTargetPromo } from "./routes/bookingWebPublic.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";

/**
 * VAY-2437: a connected partner app makes, changes and retires its own promo codes for its hotel; a
 * guest can use them on the booking page, the hotel sees but can't change them, other apps can't see
 * them, and a disconnect retires them. Real PostgreSQL, written by the ordinary API login.
 */
const url = process.env["TEST_DATABASE_URL"];
const REDIRECT = "https://partner.example/vayada/callback";
const hotelId = randomUUID();
const ownerId = randomUUID();
const verifier = randomBytes(32).toString("base64url");

describe.skipIf(!url)("a partner app's own promo codes (VAY-2437)", () => {
  let admin: pg.Client;
  let fixture: HotelSetupOrdinaryLoginFixture;
  let pool: pg.Pool;
  let connections: PartnerConnectionsRepository;
  let app: ReturnType<typeof buildApp>;
  const apps: Record<"a" | "b", string> = { a: "", b: "" };

  /** Approves the app for the hotel and swaps the code, as the approval page and the app would. */
  async function connect(clientId: string, scopes: PartnerScope[] = ["promo_codes", "bookings"]) {
    const partnerApp = (await connections.findApp(clientId))!;
    const { code } = await connections.approve({
      request: {
        app: partnerApp,
        redirectUri: REDIRECT,
        scopes,
        codeChallenge: pkceChallenge(verifier),
        state: null,
      },
      propertyId: hotelId,
      approvedByUserId: ownerId,
    });
    const grant = await connections.exchangeCode({
      app: partnerApp,
      code,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    });
    if ("error" in grant) throw new Error(grant.error);
    return grant.accessToken;
  }

  const call = (
    token: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path = "",
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/partner/v1/promo-codes${path}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });

  const mia10 = {
    code: "mia10",
    discountType: "percentage",
    discountValue: "10",
    maxUses: 2147483647,
    externalId: "cl-code-1",
  };

  beforeAll(async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, $1::text, 'Hotel Alpina')`,
      [hotelId],
    );
    await admin.query(
      `INSERT INTO identity.users (id, email, name) VALUES ($1, $2, 'Anna Keller')`,
      [ownerId, `${ownerId}@example.test`],
    );
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    pool = new pg.Pool({ connectionString: fixture.connectionString, max: 3 });
    connections = createPgPartnerConnectionsRepository({ pool });
    for (const [key, name] of [
      ["a", "Partner A"],
      ["b", "Partner B"],
    ] as const) {
      const registered = await registerPartnerApp(pool, {
        name,
        redirectUris: [REDIRECT],
        scopes: ["promo_codes", "bookings"],
        webhookUrl: null,
        contactEmail: null,
        termsVersion: "partner-contract-2026-10-31",
      });
      apps[key] = registered.clientId;
    }
    app = buildApp({
      logger: false,
      partnerConnections: {
        repository: connections,
        propertyAccessRepository: agencyPropertyAccessRepository,
        promoCodes: createPgPartnerPromoCodesRepository({ pool }),
      },
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await fixture?.drop();
    await admin?.end();
  });

  it("makes a code a guest can use on the booking page, and lists it with the partner's id", async () => {
    const token = await connect(apps.a);
    const created = await call(token, "POST", "", mia10);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      promoCodeId: expect.any(String),
      code: "MIA10",
      discountType: "percentage",
      discountValue: "10.00",
      maxUses: 2147483647,
      currentUses: 0,
      isActive: true,
      status: "active",
      validFrom: null,
      validUntil: null,
      stayDateFrom: null,
      stayDateUntil: null,
      minBookingValue: null,
      applicableRoomIds: null,
      externalId: "cl-code-1",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect((await call(token, "GET")).json()).toEqual({ promoCodes: [created.json()] });

    // The booking page takes it like any of the hotel's own codes.
    const guest = await validateTargetPromo(
      pool,
      { propertyId: hotelId, timezone: "Europe/Vienna" } as Parameters<
        typeof validateTargetPromo
      >[1],
      "mia10",
      { checkIn: null, roomTypeId: null, bookingTotal: null, occurredAt: new Date() },
    );
    expect(guest).toMatchObject({ valid: true, code: "MIA10" });
  });

  it("answers 409 for a clash with an active code at the hotel, and 422 with details for bad input", async () => {
    const token = await connect(apps.a);
    await admin.query(
      `INSERT INTO booking.promo_definitions (property_id, code, discount_type, discount_value, max_uses)
       VALUES ($1, 'HOTEL15', 'percentage', 15, 10)`,
      [hotelId],
    );
    const clash = await call(token, "POST", "", { ...mia10, code: "hotel15", externalId: "x" });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("conflict");
    const bad = await call(token, "POST", "", {
      code: "X",
      discountType: "percentage",
      discountValue: "120",
      maxUses: 0,
      externalId: "",
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({
      error: {
        code: "invalid_payload",
        message: "The promo code is not valid.",
        details: ["externalId must be a string of 1 to 200 characters."],
      },
    });
    const worse = await call(token, "POST", "", {
      code: "X",
      discountType: "percentage",
      discountValue: "120",
      maxUses: 0,
    });
    expect(worse.json().error.details).toEqual(
      expect.arrayContaining([
        "code must be 2-40 characters using letters, numbers, underscores, or hyphens.",
        "percentage discountValue must be less than or equal to 100.",
      ]),
    );
  });

  it("changes the discount, limits and externalId but never the code's text, and retires once or twice with 204", async () => {
    const token = await connect(apps.a);
    const code = (
      await call(token, "POST", "", { ...mia10, code: "SPRING5", externalId: "cl-2" })
    ).json();
    const changed = await call(token, "PATCH", `/${code.promoCodeId}`, {
      discountValue: "5",
      validUntil: "2027-03-31",
      isActive: false,
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      discountValue: "5.00",
      validUntil: "2027-03-31",
      isActive: false,
    });
    expect(
      (await call(token, "PATCH", `/${code.promoCodeId}`, { externalId: "cl-2b" })).json()
        .externalId,
    ).toBe("cl-2b");
    const rename = await call(token, "PATCH", `/${code.promoCodeId}`, { code: "SPRING6" });
    expect(rename.statusCode).toBe(422);
    expect(rename.json().error.details).toEqual([
      "code can't change: retire the code and make a new one.",
    ]);

    expect((await call(token, "DELETE", `/${code.promoCodeId}`)).statusCode).toBe(204);
    expect((await call(token, "DELETE", `/${code.promoCodeId}`)).statusCode).toBe(204);
    const listed = (await call(token, "GET")).json().promoCodes;
    expect(
      listed.find((c: { promoCodeId: string }) => c.promoCodeId === code.promoCodeId),
    ).toMatchObject({
      status: "retired",
      isActive: false,
    });
    expect(
      (await call(token, "PATCH", `/${code.promoCodeId}`, { discountValue: "6" })).statusCode,
    ).toBe(409);
    // Still a row: bookings keep pointing at a retired code.
    const row = await admin.query("SELECT status FROM booking.promo_definitions WHERE id = $1", [
      code.promoCodeId,
    ]);
    expect(row.rows[0].status).toBe("retired");
  });

  it("shows each app only its own codes, and needs the promo_codes scope", async () => {
    const tokenA = await connect(apps.a);
    const own = (
      await call(tokenA, "POST", "", { ...mia10, code: "ONLYA", externalId: "a" })
    ).json();
    const tokenB = await connect(apps.b);
    expect((await call(tokenB, "GET")).json()).toEqual({ promoCodes: [] });
    expect(
      (await call(tokenB, "PATCH", `/${own.promoCodeId}`, { discountValue: "1" })).statusCode,
    ).toBe(404);
    expect((await call(tokenB, "DELETE", `/${own.promoCodeId}`)).statusCode).toBe(404);
    expect((await call(tokenB, "DELETE", "/not-a-uuid")).statusCode).toBe(404);

    const readOnly = await connect(apps.b, ["bookings"]);
    const refused = await call(readOnly, "GET");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("forbidden");
  });

  it("lets the hotel see a partner's code as managed by it, but not change or retire it", async () => {
    const token = await connect(apps.a);
    const code = (
      await call(token, "POST", "", { ...mia10, code: "HOTELSEES", externalId: "h" })
    ).json();
    const hotelSide = createPgTargetBookingPromoCodesRepository({
      connectionString: "unused",
      pool,
    });
    const listed = (await hotelSide.listPromoCodesByHotelId(hotelId))!;
    const seen = listed.find((c) => c.promoCodeId === code.promoCodeId)!;
    expect(seen.managedBy).toBe("Partner A");
    expect(seen).not.toHaveProperty("externalId");
    expect(listed.find((c) => c.code === "HOTEL15")?.managedBy).toBeNull();
    await expect(
      hotelSide.updatePromoCodeByHotelId(hotelId, code.promoCodeId, { discountValue: "50" }),
    ).rejects.toBeInstanceOf(PartnerManagedPromoCodeError);
    await expect(
      hotelSide.retirePromoCodeByHotelId(hotelId, code.promoCodeId),
    ).rejects.toBeInstanceOf(PartnerManagedPromoCodeError);
    expect(
      (await call(token, "GET"))
        .json()
        .promoCodes.find((c: { code: string }) => c.code === "HOTELSEES"),
    ).toMatchObject({
      discountValue: "10.00",
      status: "active",
    });
  });

  it("retires an app's codes when it is approved again without promo_codes", async () => {
    const token = await connect(apps.b);
    const code = (
      await call(token, "POST", "", { ...mia10, code: "NARROWB", externalId: "n" })
    ).json();
    await connect(apps.b, ["bookings"]);
    const row = await admin.query(
      "SELECT status, is_active FROM booking.promo_definitions WHERE id = $1",
      [code.promoCodeId],
    );
    expect(row.rows[0]).toEqual({ status: "retired", is_active: false });
  });

  it("retires an app's active codes at the hotel when the hotel disconnects it or the app revokes", async () => {
    const tokenA = await connect(apps.a);
    await call(tokenA, "POST", "", { ...mia10, code: "BYEA", externalId: "bye-a" });
    const tokenB = await connect(apps.b);
    await call(tokenB, "POST", "", { ...mia10, code: "STAYB", externalId: "stay-b" });
    const active = async (clientId: string) =>
      (
        await admin.query(
          `SELECT promo.code FROM booking.promo_definitions promo
           JOIN distribution.external_api_clients app ON app.id = promo.partner_client_id
           WHERE app.public_client_id = $1 AND promo.status = 'active' ORDER BY promo.code`,
          [clientId],
        )
      ).rows.map((row) => row.code);
    expect(await active(apps.a)).toEqual(expect.arrayContaining(["BYEA"]));

    const connectionA = (await connections.listConnections(hotelId)).find(
      (c) => c.appName === "Partner A",
    )!;
    expect(
      await connections.disconnect({
        propertyId: hotelId,
        connectionId: connectionA.connectionId,
        userId: ownerId,
      }),
    ).toBe(true);
    expect(await active(apps.a)).toEqual([]);
    expect(await active(apps.b)).toEqual(["STAYB"]);

    const partnerB = (await connections.findApp(apps.b))!;
    await connections.revokeByPartner({ app: partnerB, token: tokenB });
    expect(await active(apps.b)).toEqual([]);

    // A code can't be made on a connection that is gone (the create locks and rechecks it).
    const partnerA = (await connections.findApp(apps.a))!;
    const late = await createPgPartnerPromoCodesRepository({ pool }).create(
      { appId: partnerA.appId, propertyId: hotelId, connectionId: connectionA.connectionId },
      {
        code: "TOOLATE",
        discountType: "percentage",
        discountValue: "5",
        minBookingValue: null,
        applicableRoomIds: null,
        validFrom: null,
        validUntil: null,
        stayDateFrom: null,
        stayDateUntil: null,
        isActive: true,
        maxUses: 10,
        externalId: null,
      },
    );
    expect(late).toBeNull();
    // The hotel's own code is untouched.
    const hotelCode = await admin.query(
      "SELECT status FROM booking.promo_definitions WHERE property_id = $1 AND code = 'HOTEL15'",
      [hotelId],
    );
    expect(hotelCode.rows[0].status).toBe("active");
  });
});
