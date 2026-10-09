import type { RequestContext } from "@vayada/backend-auth";
import type { PricingConfiguration } from "@vayada/domain-pms";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsManualBookingPreviewRoutes,
  type PmsManualBookingPreviewRoutesOptions,
} from "./routes/pmsManualBookingPreview.js";
import { calculateManualBookingPreview } from "./routes/pmsManualBookingPreviewCalculation.js";

const id = (value: number) => `71000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const propertyId = id(1),
  organizationId = id(2),
  roomTypeId = id(3),
  termsRevision = id(4),
  roomIds = [id(10), id(11), id(12)],
  addonIds = [id(20), id(21), id(22), id(23)],
  now = "2026-08-12T12:00:00.000Z";
type State = {
  reads: string[];
  unavailable?: boolean;
  addonCurrency?: string;
  unpublished?: boolean;
  minStay?: number;
  /** Publication currency and Flexible occupancy amounts in that currency's minor units. */
  currency?: string;
  amountsMinor?: string[];
  propertyCurrency?: string | null;
  roomTypeCurrency?: string | null;
};
type Auth = Partial<Record<"token" | "permission" | "entitlement" | "link", boolean>> & {
  organizationKind?: "hotel_group" | "creator_workspace";
  relationship?: string;
  entitlementResourceId?: string;
  linkResourceId?: string;
};

describe("target manual-booking preview", () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined;
  afterEach(async () => app?.close());

  // prettier-ignore
  it("lists only active add-on fields for front-desk PMS users", async () => { const state: State = { reads: [] }; app = await testApp(state, { relationship: "front_desk" }); const response = await app.inject({ method: "GET", url: `/properties/${propertyId}/manual-bookings/addons`, headers: headers() }); expect(response.statusCode).toBe(200); expect(response.json().addOns.map((addon: any) => addon.addonItemId)).toEqual(addonIds); expect(Object.keys(response.json().addOns[0]).sort()).toEqual(["addonItemId", "category", "currency", "description", "name", "price", "pricingModel"]); expect((await app.inject({ method: "GET", url: `/properties/${propertyId}/manual-bookings/addons?propertyId=other`, headers: headers() })).statusCode).toBe(400); expect(state.reads).toEqual(["addons"]); });

  it.each([
    ["unauthenticated", { token: false }],
    ["forbidden", { permission: false }],
    ["entitlement_required", { entitlement: false }],
    ["forbidden", { link: false }],
    ["entitlement_required", { entitlementResourceId: id(99) }],
    ["forbidden", { linkResourceId: id(99) }],
    ["forbidden", { relationship: "viewer" }],
    ["forbidden", { organizationKind: "creator_workspace" }],
  ] as const)("denies %s before query validation or reads", async (code, auth) => {
    const state: State = { reads: [] };
    app = await testApp(state, auth);
    const response = await request(
      app,
      { broken: true },
      "token" in auth && auth.token === false ? { "content-type": "application/json" } : headers(),
      "?scope=other",
    );
    expect(response.json()).toMatchObject({ code });
    expect(state.reads).toEqual([]);
  });

  it("rejects query aliases and contradictory pricing shapes", async () => {
    app = await testApp({ reads: [] });
    expect((await request(app, { ...command(), channel: "ota" })).json().code).toBe(
      "unknown_field",
    );
    expect((await request(app, command(), headers(), "?propertyId=other")).json().code).toBe(
      "unknown_field",
    );
    for (const mutate of [
      (body: any) => (body.stays[1].ratePlanId = "flex"),
      (body: any) => (body.stays[0].ratePlanId = null),
    ]) {
      const body = command();
      mutate(body);
      expect((await request(app, body)).json().code).toBe("invalid_body");
    }
  });

  // prettier-ignore
  const errors: [number, string, (body: any) => void, Partial<State>][] = [
    [409, "room_unavailable", () => undefined, { unavailable: true }],
    [404, "room_not_found", (body) => (body.stays[0].roomId = propertyId), {}],
    [422, "invalid_dates", (body) => (body.stays[0].checkOut = "2027-06-29"), {}],
    [422, "occupancy_exceeded", (body) => (body.stays[0].adults = 5), {}],
    [422, "occupancy_exceeded", (body) => (body.stays[0].adults = 0), {}],
    [422, "occupancy_exceeded", (body) => (body.stays[0].adults = 4), {}],
    [404, "rate_plan_not_found", (body) => (body.stays[0].ratePlanId = "unknown-offer"), {}],
    [409, "pricing_not_published", () => undefined, { unpublished: true }],
    [422, "child_ages_required", (body) => (body.stays[0].children = 1), {}],
    [422, "rate_restricted", () => undefined, { minStay: 3 }],
    [422, "currency_mismatch", () => undefined, { addonCurrency: "USD" }],
    [404, "addon_not_found", (body) => (body.addOns[0].addonId = propertyId), {}],
    [422, "invalid_addon_selection", (body) => (body.addOns[0].packageCount = 0), {}],
  ];
  it.each(errors)("returns %s %s", async (status, code, mutate, state) => {
    app = await testApp({ reads: [], ...state });
    const body = command();
    mutate(body);
    const response = await request(app, body);
    expect([response.statusCode, response.json().code]).toEqual([status, code]);
  });

  it("prices published offers per night, keeps overrides and custom rates, and adds add-ons", async () => {
    app = await testApp({ reads: [] });
    const response = await request(app, command());
    expect(response.statusCode).toBe(200);
    const preview = response.json();
    expect(preview).toMatchObject({
      currency: "EUR",
      pricingRevision: 7,
      grandTotal: { amountDecimal: "649.00" },
    });
    // Flexible, one adult: the published occupancy price of 100.00 a night.
    expect(preview.stays[0]).toMatchObject({
      ratePlanId: "flex",
      standardTotal: { amountDecimal: "200.00" },
      appliedTotal: { amountDecimal: "200.00" },
    });
    expect(preview.stays[0].nightly[0]).toEqual({
      serviceDate: "2027-06-30",
      standard: { amountDecimal: "100.00", currency: "EUR" },
      applied: { amountDecimal: "100.00", currency: "EUR" },
    });
    // Custom rate: no standard price.
    expect(preview.stays[1]).toMatchObject({
      ratePlanId: null,
      standardTotal: null,
      appliedTotal: { amountDecimal: "160.00" },
    });
    // Non-refundable is 10% below Flexible for three adults (155.00 → 139.50); the override applies.
    expect(preview.stays[2]).toMatchObject({
      ratePlanId: "nr",
      standardTotal: { amountDecimal: "279.00" },
      appliedTotal: { amountDecimal: "180.00" },
    });
    expect(preview.addOns.map((addon: any) => addon.total.amountDecimal)).toEqual([
      "20.00",
      "25.00",
      "16.00",
      "48.00",
    ]);
  });

  it("refuses a create priced from another revision before any other price outcome", async () => {
    // A restricted stay would otherwise answer rate_restricted; the republish wins.
    const body = command();
    body.stays = [body.stays[0]];
    body.addOns = [];
    const scope = { propertyId, organizationId };
    await expect(
      calculateManualBookingPreview(
        scope,
        { ...body, expectedPricingRevision: 6 },
        ports({ reads: [], minStay: 3 }),
      ),
    ).rejects.toMatchObject({ status: 409, body: { code: "pricing_changed" } });
    await expect(
      calculateManualBookingPreview(
        scope,
        { ...body, expectedPricingRevision: 7 },
        ports({ reads: [] }),
      ),
    ).resolves.toMatchObject({ pricingRevision: 7 });
  });

  it("prices children by age band", async () => {
    app = await testApp({ reads: [] });
    const body = command();
    body.stays = [{ ...body.stays[0], children: 1, childAgesAtCheckIn: [5] }];
    body.addOns = [];
    const priced = (await request(app, body)).json();
    expect(priced.stays[0].nightly[0].standard.amountDecimal).toBe("120.00");
  });

  // prettier-ignore
  const scales: [string, string, number, string | undefined][] = [
    ["JPY", "8000", 200, "8000.00"],
    ["KWD", "25500", 200, "25.50"],
    ["KWD", "25505", 422, undefined],
  ];
  it.each(scales)(
    "stores %s %s minor units as PMS money (%s)",
    async (currency, amount, status, decimal) => {
      app = await testApp({ reads: [], currency, amountsMinor: [amount, amount, amount] });
      const body = command();
      body.stays = [body.stays[0]];
      body.addOns = [];
      const response = await request(app, body);
      expect(response.statusCode).toBe(status);
      if (decimal)
        expect(response.json().stays[0].nightly[0].standard).toEqual({
          amountDecimal: decimal,
          currency,
        });
      else expect(response.json().code).toBe("currency_mismatch");
    },
  );

  it("prices custom-only stays in the property currency without a publication", async () => {
    const custom = command();
    custom.stays = [{ ...custom.stays[1], position: 1 }];
    custom.addOns = [];
    // With a publication, custom stays use its currency but cite no revision.
    app = await testApp({ reads: [] });
    const published = await request(app, custom);
    expect([published.statusCode, published.json().pricingRevision]).toEqual([200, null]);
    await app.close();

    // Room types from the room-facts flow carry no rate or currency.
    const state: State = { reads: [], unpublished: true, roomTypeCurrency: null };
    app = await testApp(state);
    const response = await request(app, custom);
    expect([
      response.statusCode,
      response.json().currency,
      response.json().pricingRevision,
    ]).toEqual([200, "EUR", null]);
    expect(state.reads).toContain("currency");

    await app.close();
    app = await testApp({
      reads: [],
      unpublished: true,
      roomTypeCurrency: null,
      propertyCurrency: null,
    });
    const unconfigured = await request(app, custom);
    expect([unconfigured.statusCode, unconfigured.json().code]).toEqual([
      409,
      "pricing_not_published",
    ]);
  });

  // VAY-2065: the client cannot know the currency of a room type from the room-facts flow, so a
  // custom rate may omit it and takes the resolved one; a sent currency must still match.
  it("prices a custom rate without a currency in the resolved currency", async () => {
    const custom = command();
    custom.stays = [{ ...custom.stays[1], position: 1 }];
    custom.stays[0].pricing = { kind: "custom", nightlyAmount: { amountDecimal: "80" } };
    custom.addOns = [];
    app = await testApp({
      reads: [],
      unpublished: true,
      roomTypeCurrency: null,
      propertyCurrency: "CHF",
    });
    const property = await request(app, custom);
    expect([property.statusCode, property.json().currency]).toEqual([200, "CHF"]);
    expect(property.json().stays[0].appliedTotal).toEqual({
      amountDecimal: "160.00",
      currency: "CHF",
    });
    await app.close();

    app = await testApp({ reads: [], currency: "USD", amountsMinor: ["10000"] });
    const published = await request(app, custom);
    expect([published.statusCode, published.json().currency]).toEqual([200, "USD"]);
    custom.stays[0].pricing = {
      kind: "custom",
      nightlyAmount: { amountDecimal: "80", currency: "EUR" },
    };
    const mismatch = await request(app, custom);
    expect([mismatch.statusCode, mismatch.json().code]).toEqual([422, "currency_mismatch"]);
    custom.stays[0].pricing = { kind: "rate_plan", manualOverride: { amountDecimal: "80" } };
    custom.stays[0].ratePlanId = "flex";
    expect((await request(app, custom)).json().code).toBe("invalid_body");
  });
});

async function testApp(state: State, auth: Auth = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid" || auth.token === false) return;
    request.authContext = {
      actor: { internalUserId: id(40) },
      selectedOrganization: { organizationId, kind: auth.organizationKind ?? "hotel_group" },
      membership: { permissions: auth.permission === false ? [] : ["pms.operations.manage"] },
      entitlements:
        auth.entitlement === false
          ? []
          : [
              {
                product: "pms",
                key: "property-management",
                status: "active",
                resource: {
                  product: "pms",
                  resourceType: "pms_property",
                  resourceId: auth.entitlementResourceId ?? propertyId,
                },
              },
            ],
      linkedResources:
        auth.link === false
          ? []
          : [
              {
                product: "pms",
                resourceType: "pms_property",
                resourceId: auth.linkResourceId ?? propertyId,
                relationship: auth.relationship ?? "operator",
                status: "active",
              },
            ],
      audit: { requestId: "request-1", source: "api", receivedAt: now },
    } as RequestContext;
  });
  await app.register(registerPmsManualBookingPreviewRoutes, ports(state));
  return app;
}

function ports(state: State): PmsManualBookingPreviewRoutesOptions {
  const read = (name: string) => state.reads.push(name);
  // prettier-ignore
  return {
    pms: {
      async listRoomsByPropertyId() { read("rooms"); return { items: roomIds.map((roomId) => ({ roomId, roomTypeId })) } as any; },
      async listRoomTypesByPropertyId() { read("types"); return { items: [{ roomTypeId, active: true, occupancyLimits: { adults: 4, children: 4, total: 4 }, baseRate: { amountDecimal: state.roomTypeCurrency === null ? null : "0", currency: state.roomTypeCurrency === undefined ? "EUR" : state.roomTypeCurrency } }] } as any; },
      async getPhysicalRoomAvailability(_propertyId, stays) { read("available"); return stays.map(() => !state.unavailable); },
    },
    publication: {
      async readCurrentPricingPublication() {
        read("publication");
        if (state.unpublished) return null;
        return { revision: 7, currency: state.currency ?? "EUR", rooms: [configuration(state)], terms: [
          { roomTypeId, offerId: "flex", revision: termsRevision, cancellation: { kind: "non_refundable" }, payment: { kind: "full" } },
          { roomTypeId, offerId: "nr", revision: termsRevision, cancellation: { kind: "non_refundable" }, payment: { kind: "full" } },
        ] } as any;
      },
      async readPropertyPricingCurrency() {
        read("currency");
        return state.propertyCurrency === undefined ? "EUR" : state.propertyCurrency;
      },
    },
    booking: {
      async listAddonItemsByHotelId() { read("addons"); return { addonItems: addonIds.map((addonItemId, index) => ({ addonItemId, propertyId, name: `Add-on ${index + 1}`, description: "", category: "dining", price: ["10.00", "5.00", "4.00", "2.00"][index], currency: state.addonCurrency ?? "EUR", pricingModel: ["per_stay", "per_guest", "per_night", "per_guest_night"][index], status: "active" })), propertyPlan: {} } as any; },
    },
  };
}

function configuration(state: State): PricingConfiguration {
  const rules = {
    minArrivalNights: state.minStay ?? 1,
    maxStayNights: null,
    closedToArrival: false,
    closedToDeparture: false,
    stopSell: false,
  };
  const meal = { kind: "room_only" as const, charge: { kind: "room" as const, amountMinor: "0" } };
  return {
    version: "pricing.v2",
    propertyId,
    roomTypeId,
    revision: 7,
    currency: state.currency ?? "EUR",
    capacity: { total: 4, adults: 3, children: 2 },
    children: {
      adultFromAge: 12,
      bands: [
        { fromAge: 0, throughAge: 2, nightlyMinor: "0", countsTowardCapacity: false },
        { fromAge: 3, throughAge: 11, nightlyMinor: "2000", countsTowardCapacity: true },
      ],
    },
    offers: [
      {
        id: "flex",
        termsRevision,
        meal,
        price: {
          kind: "independent",
          calendar: {
            base: {
              mode: "occupancy",
              amountsMinor: state.amountsMinor ?? ["10000", "13000", "15500"],
            },
            months: [],
            seasons: [],
            weekdays: [],
            dates: [],
          },
        },
        restrictions: { kind: "own", rules, seasons: [], dates: [] },
      },
      {
        id: "nr",
        termsRevision,
        meal,
        price: {
          kind: "linked",
          parentId: "flex",
          adjustment: { kind: "percentage", basisPoints: -1000 },
          dateOverrides: [],
        },
        restrictions: { kind: "inherit" },
      },
    ],
  };
}

function command(): any {
  const stay = (
    position: number,
    roomId: string,
    checkIn: string,
    checkOut: string,
    adults: number,
    pricing: any,
    ratePlanId: string | null,
  ) => ({ position, roomId, checkIn, checkOut, adults, children: 0, ratePlanId, pricing });
  const dates = ["2027-06-30", "2027-07-01", "2027-07-02", "2027-07-03"];
  // prettier-ignore
  const body = {
    contractVersion: "pms-manual-booking.v1",
    stays: [
      stay(1, roomIds[0]!, "2027-06-30", "2027-07-02", 1, { kind: "rate_plan", manualOverride: null }, "flex"),
      stay(2, roomIds[1]!, "2027-07-01", "2027-07-03", 2, { kind: "custom", nightlyAmount: { amountDecimal: "80", currency: "EUR" } }, null),
      stay(3, roomIds[2]!, "2027-07-02", "2027-07-04", 3, { kind: "rate_plan", manualOverride: { amountDecimal: "90", currency: "EUR" } }, "nr"),
    ],
    addOns: [
      { addonId: addonIds[0], packageCount: 2, serviceUnits: [{ serviceDate: null, guestCount: null }] },
      { addonId: addonIds[1], packageCount: 1, serviceUnits: [{ serviceDate: null, guestCount: 5 }] },
      { addonId: addonIds[2], packageCount: 1, serviceUnits: dates.map((serviceDate) => ({ serviceDate, guestCount: null })) },
      { addonId: addonIds[3], packageCount: 2, serviceUnits: dates.map((serviceDate, index) => ({ serviceDate, guestCount: [1, 3, 5, 3][index] })) },
    ],
  };
  return body;
}

const headers = () => ({ authorization: "Bearer valid", "content-type": "application/json" });
function request(
  app: Awaited<ReturnType<typeof testApp>>,
  body: unknown,
  customHeaders: Record<string, string> = headers(),
  query = "",
) {
  return app.inject({
    method: "POST",
    url: `/properties/${propertyId}/manual-bookings/preview${query}`,
    headers: customHeaders,
    payload: JSON.stringify(body),
  });
}
