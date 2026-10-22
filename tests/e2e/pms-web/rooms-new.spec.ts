import { expect, test, type Page, type Route } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

// VAY-2147: the New room page's Prices tab; one "Create Room Type" creates the room, then saves its prices.
const DELUXE = "aaaaaaaa-0000-4000-8000-00000000000a";
const CREATED = "dddddddd-0000-4000-8000-00000000000d";
const TERMS = "66666666-6666-4666-8666-666666666666";
const token = (digit: string) => digit.repeat(64);
const sources = {
  room: `pms.pricing.rooms.v2:${token("3")}`,
  terms: `booking.pricing.terms.v2:${token("4")}`,
  finance: `finance.pricing.source.v2:${token("5")}`,
};
const createdAt = "2026-10-12T10:00:00.000Z";
const unitIds = ["eeeeeeee-0000-4000-8000-000000000001", "eeeeeeee-0000-4000-8000-000000000002"];
const deluxe = { ...pmsWebRoomType, roomTypeId: DELUXE, name: "Deluxe Double Room" };
const created = {
  ...pmsWebRoomType,
  roomTypeId: CREATED,
  version: "room-type-facts-v1",
  name: "Castrop Suite",
  occupancyLimits: { total: 2, adults: 2, children: 2 },
  baseRate: { amountDecimal: "0.00", currency: null },
  roomCount: 2,
  sortOrder: 1,
};
const deluxePrices = {
  version: "pricing.v2",
  propertyId: PMS_WEB_PROPERTY_ID,
  roomTypeId: DELUXE,
  revision: 3,
  currency: "EUR",
  capacity: { total: 3, adults: 2, children: 1 },
  children: {
    adultFromAge: 18,
    bands: [{ fromAge: 0, throughAge: 17, nightlyMinor: "0", countsTowardCapacity: true }],
  },
  offers: [
    {
      id: "flexible",
      termsRevision: TERMS,
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
};

/** The room-facts create and the reads after it; the room list includes the new room once it exists. */
async function mockRooms(page: Page) {
  const state = { created: false };
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  // The Rooms list reads the prepared-import offer after the create redirects there.
  await page.route(`**/api/hotel-setup/properties/${PMS_WEB_PROPERTY_ID}/import`, (route) =>
    route.fulfill({
      headers: {
        "access-control-allow-origin": route.request().headers()["origin"] ?? "*",
        "access-control-allow-credentials": "true",
      },
      json: { import: null },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: state.created ? [deluxe, created] : [deluxe],
        sourceFreshness: {},
      },
    }),
  );
  await page.route(`**/api/pms/setup/properties/${PMS_WEB_PROPERTY_ID}/room-types`, (route) => {
    const body = route.request().postDataJSON() as Record<string, any>;
    state.created = true;
    return route.fulfill({
      status: 201,
      json: {
        contractVersion: "pms-room-facts.v1",
        outcome: "created",
        roomType: {
          contractVersion: "pms-room-facts.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          roomTypeId: CREATED,
          roomFactsRevision: 1,
          lifecycle: "active",
          facts: body.facts,
          createdAt,
          updatedAt: createdAt,
        },
        draftRoomBinding: {
          propertyId: PMS_WEB_PROPERTY_ID,
          draftRoomId: body.draftRoomId,
          roomTypeId: CREATED,
        },
        acceptedAt: createdAt,
      },
    });
  });
  for (const item of [deluxe, created])
    await page.route(
      `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${item.roomTypeId}`,
      (route) =>
        route.fulfill({
          json: {
            contractVersion: "pms-operations.v1",
            propertyId: PMS_WEB_PROPERTY_ID,
            item,
            sourceFreshness: {},
          },
        }),
    );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${CREATED}/amenities`,
    (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-room-amenities.v1",
          outcome: "confirmed",
          roomAmenities: {
            contractVersion: "pms-room-amenities.v1",
            propertyId: PMS_WEB_PROPERTY_ID,
            roomTypeId: CREATED,
            roomAmenitiesRevision: 2,
            reviewed: true,
            amenities: [],
            reviewedAt: createdAt,
          },
          acceptedAt: createdAt,
        },
      }),
  );
  await page.route(
    `**/api/pms/setup/properties/${PMS_WEB_PROPERTY_ID}/room-types/${CREATED}/capacity`,
    (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-room-facts.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          roomTypeId: CREATED,
          roomUnitsRevision: 1,
          activeUnitCount: 2,
          capturedAt: createdAt,
        },
      }),
  );
  await page.route(
    `**/api/pms/setup/properties/${PMS_WEB_PROPERTY_ID}/room-types/${CREATED}/units`,
    (route) =>
      route.fulfill({
        json: {
          items: unitIds.map((roomUnitId) => ({
            contractVersion: "pms-room-facts.v1",
            propertyId: PMS_WEB_PROPERTY_ID,
            roomTypeId: CREATED,
            roomUnitId,
            lifecycle: "active",
            operationalLabel: null,
            operationalLabelStatus: "unverified",
          })),
        },
      }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${CREATED}/physical-units/*/operational-label`,
    (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        json: {
          contractVersion: "pms-room-facts.v1",
          outcome: "updated",
          propertyId: PMS_WEB_PROPERTY_ID,
          roomTypeId: CREATED,
          roomUnitId: new URL(route.request().url()).pathname.split("/").at(-2),
          roomUnitsRevision: Number(body.expectedRevision) + 1,
          operationalLabel: body.operationalLabel,
          operationalLabelStatus: "verified",
          acceptedAt: createdAt,
        },
      });
    },
  );
  return state;
}

/** An in-memory pricing-v2 store with Deluxe priced at revision 3. `refuse` answers the next prepare or publish
 * with an error once. */
async function mockPricing(page: Page) {
  const state = {
    publication: {
      currency: "EUR",
      revision: 3,
      stale: false,
      sources,
      ownerReferences: { finance: `finance.pricing.v2:${token("1")}` },
      rooms: [deluxePrices],
    } as Record<string, any>,
    publishes: [] as Record<string, any>[],
    termsWrites: [] as { roomTypeId: string; body: Record<string, any> }[],
    writes: 0,
    draft: null as Record<string, any> | null,
    refuse: null as { step: "prepare" | "publish"; status: number; json: unknown } | null,
  };
  const ok = (route: Route, json: unknown) => route.fulfill({ json });
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-v2**`, async (route) => {
    const request = route.request();
    const method = request.method();
    const suffix = new URL(request.url()).pathname.split("/pricing-v2")[1] ?? "";
    const body = (method === "GET" ? {} : request.postDataJSON()) as Record<string, any>;
    if (method !== "GET") state.writes += 1;
    // Bank transfer is ready (VAY-2139): the new room's non-refundable first price is paid in advance (VAY-2280).
    if (suffix === "/payment-methods" && method === "GET")
      return ok(route, { acceptanceEnabled: true, readyMethods: ["bank_transfer"] });
    // Card isn't ready on the booking page, as in production today (VAY-2205).
    if (suffix === "/card-readiness" && method === "GET")
      return ok(route, {
        card: { ready: false, reason: "switch_off", charge: "at_booking" },
        deposits: { ready: false },
      });
    if (suffix === "" && method === "GET") return ok(route, state.publication);
    const step = suffix === "/prepare" ? "prepare" : suffix === "/publish" ? "publish" : null;
    if (step && state.refuse?.step === step) {
      const { status, json } = state.refuse;
      state.refuse = null;
      return route.fulfill({ status, json });
    }
    const offerTerms = suffix.match(
      /^(?:\/drafts\/[^/]+)?\/rooms\/([^/]+)\/offers\/([^/]+)\/terms$/,
    );
    if (offerTerms && method === "GET")
      return ok(route, {
        roomTypeId: offerTerms[1],
        offerId: decodeURIComponent(offerTerms[2]!),
        revision: TERMS,
        cancellation: { kind: "non_refundable" },
        payment: { kind: "full", acceptedMethods: ["card", "pay_at_property"] },
      });
    if (offerTerms && method === "PUT") {
      state.termsWrites.push({ roomTypeId: offerTerms[1]!, body });
      return ok(route, {
        roomTypeId: offerTerms[1],
        offerId: decodeURIComponent(offerTerms[2]!),
        revision: `77777777-7777-4777-8777-${String(state.termsWrites.length).padStart(12, "0")}`,
        cancellation: body.cancellation,
        payment: body.payment,
      });
    }
    if (step === "prepare")
      return ok(route, {
        sources,
        effectiveSources: sources,
        snapshot: {
          currency: body.currency,
          rooms: body.rooms,
          ownerReferences: { finance: `finance.pricing.v2:${token("1")}` },
        },
      });
    if (/^\/drafts\/[^/]+$/.test(suffix) && method === "PUT") {
      state.draft = {
        ...body,
        draftId: suffix.split("/")[2],
        revision: body.expectedDraftRevision + 1,
      };
      return ok(route, { revision: state.draft.revision });
    }
    if (/^\/drafts\/[^/]+\/charge-review$/.test(suffix) && method === "GET" && state.draft) {
      const { draftId, snapshot, revision, baseRevision, effectiveSources } = state.draft;
      return ok(route, {
        draftId,
        snapshot,
        revision,
        baseRevision,
        sources,
        effectiveSources,
        stale: false,
        fingerprint: token("2"),
        declaration: "all_mandatory_charges_included",
      });
    }
    if (suffix === "/charges" && method === "POST")
      return ok(route, {
        id: "77777777-7777-4777-8777-777777777777",
        fingerprint: body.claimedFingerprint,
        declaration: body.declaration,
      });
    if (step === "publish") {
      state.publishes.push(body);
      if (body.expectedRevision !== state.publication.revision)
        return route.fulfill({ status: 409, json: { code: "stale" } });
      state.publication = {
        ...body.snapshot,
        revision: body.expectedRevision + 1,
        sources,
        stale: false,
      };
      return ok(route, { revision: body.expectedRevision + 1, replayed: false });
    }
    return route.fulfill({ status: 501, json: { code: "unexpected", method, suffix } });
  });
  return state;
}

const main = (page: Page) => page.locator("main");
/** The room's details, then the Prices tab's first answers: €120 a night, non-refundable, paid by card. */
async function fillRoomAndPrices(page: Page, path = "/rooms/new") {
  await page.goto(path);
  await page.getByPlaceholder("e.g. Two-Bedroom Villa").fill("Castrop Suite");
  await page.getByPlaceholder("50").fill("32");
  await main(page).getByRole("button", { name: "Prices", exact: true }).click();
  await expect(main(page).getByText("Prices are optional here.", { exact: false })).toBeVisible();
  // VAY-2188: one price; the rest is filled in (ways to pay from Payment settings).
  await main(page).getByLabel("Room price per night").fill("120");
  await main(page).getByRole("button", { name: "Non-refundable", exact: true }).click();
  await expect(
    main(page).getByText(
      "By creating the room type, you confirm these prices include all mandatory taxes and fees.",
    ),
  ).toBeVisible();
}
const publishedRooms = (pricing: Awaited<ReturnType<typeof mockPricing>>) =>
  pricing.publishes[0]!.snapshot.rooms as Record<string, any>[];

test("creates a room and its prices with one Create Room Type", async ({ page }, testInfo) => {
  await mockRooms(page);
  const pricing = await mockPricing(page);
  const assertHealthy = watchPageHealth(page, testInfo);
  await fillRoomAndPrices(page);
  // VAY-2188: the typed price stays on the tab, unsaved, until Create Room Type saves it with the room.
  await expect(main(page).getByLabel("Room price per night")).toHaveValue("120");
  // The declaration goes along to the other tabs, where "Create Room Type" saves the prices too.
  await main(page).getByRole("button", { name: "Room Details" }).click();
  await expect(
    main(page)
      .locator("form")
      .getByText("By creating the room type, you confirm", { exact: false }),
  ).toBeVisible();
  await main(page).getByRole("button", { name: "Create Room Type" }).click();

  await expect(page).toHaveURL(/\/rooms$/);
  expect(pricing.publishes).toHaveLength(1);
  const rooms = publishedRooms(pricing);
  expect(rooms.map((room) => room.roomTypeId)).toEqual([DELUXE, CREATED]);
  expect(rooms[0]).toMatchObject({ ...deluxePrices, revision: 4 });
  expect(rooms[1]).toMatchObject({
    revision: 4,
    capacity: { total: 2, adults: 2, children: 2 },
    offers: [{ price: { calendar: { base: { mode: "flat", amountMinor: "12000" } } } }],
  });
  expect(pricing.termsWrites).toEqual([
    expect.objectContaining({
      roomTypeId: CREATED,
      body: expect.objectContaining({
        cancellation: { kind: "non_refundable" },
        // Paid in advance: pay at property is left out (VAY-2280).
        payment: { kind: "full", acceptedMethods: ["bank_transfer"] },
      }),
    }),
  ]);
  await assertHealthy();
});

test("saves a typed first price with Create Room Type", async ({ page }) => {
  await mockRooms(page);
  const pricing = await mockPricing(page);
  await fillRoomAndPrices(page);
  await main(page).getByRole("button", { name: "Create Room Type" }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  expect(publishedRooms(pricing).map((room) => room.roomTypeId)).toEqual([DELUXE, CREATED]);
});

test("creates the room alone when the Prices tab stays empty", async ({ page }) => {
  await mockRooms(page);
  const pricing = await mockPricing(page);
  await page.goto("/rooms/new");
  await page.getByPlaceholder("e.g. Two-Bedroom Villa").fill("Castrop Suite");
  await page.getByPlaceholder("50").fill("32");
  await main(page).getByRole("button", { name: "Prices", exact: true }).click();
  await expect(main(page).getByText("Prices are optional here.", { exact: false })).toBeVisible();
  await expect(main(page).getByText("By creating the room type", { exact: false })).toHaveCount(0);
  await main(page).getByRole("button", { name: "Create Room Type" }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  expect(pricing.writes).toBe(0);
});

test("opens the new room's Prices tab with the typed prices when their save is refused", async ({
  page,
}) => {
  await mockRooms(page);
  const pricing = await mockPricing(page);
  pricing.refuse = { step: "publish", status: 409, json: { code: "stale" } };
  await fillRoomAndPrices(page);
  await main(page).getByRole("button", { name: "Create Room Type" }).click();

  await expect(page).toHaveURL(new RegExp(`/rooms/${CREATED}\\?tab=prices$`));
  await expect(
    main(page).getByText("The room type was created, but its prices were not saved.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(main(page).getByText("Someone else saved prices at the same time.")).toBeVisible();
  await expect(main(page).getByLabel("Castrop Suite Offer 1 Per room")).toHaveValue("120.00");
  await main(page).getByRole("button", { name: "Save and publish" }).click();
  await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible();
  // The refused publish is not recorded; this is the Prices tab's save, from the revision it read.
  expect(pricing.publishes).toHaveLength(1);
  expect(publishedRooms(pricing).map((room) => room.roomTypeId)).toEqual([DELUXE, CREATED]);
  expect(pricing.publication.revision).toBe(4);
});

test("says why when Finance is not ready, keeping the typed prices", async ({ page }) => {
  await mockRooms(page);
  const pricing = await mockPricing(page);
  pricing.refuse = {
    step: "prepare",
    status: 403,
    json: { code: "denied", reason: "payments_disabled" },
  };
  await fillRoomAndPrices(page);
  await main(page).getByRole("button", { name: "Create Room Type" }).click();

  await expect(page).toHaveURL(new RegExp(`/rooms/${CREATED}\\?tab=prices$`));
  await expect(
    main(page).getByText("Payments are switched off for this property.", { exact: false }),
  ).toBeVisible();
  await expect(main(page).getByLabel("Castrop Suite Offer 1 Per room")).toHaveValue("120.00");
  expect(pricing.publishes).toHaveLength(0);
});

test("asks before leaving typed prices, from any tab", async ({ page }) => {
  await mockRooms(page);
  await mockPricing(page);
  await fillRoomAndPrices(page);
  await main(page).getByRole("button", { name: "Room Details" }).click();
  await main(page).getByRole("link", { name: "Cancel", exact: true }).click();
  // The question shows on the Prices tab, which comes to the front.
  await expect(main(page).getByText("Leave pricing?")).toBeVisible();
  await expect(main(page).getByLabel("Room price per night")).toHaveValue("120");
  await main(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(/\/rooms\/new$/);
  await main(page).getByRole("link", { name: "Cancel", exact: true }).click();
  await main(page).getByRole("button", { name: "Leave", exact: true }).click();
  await expect(page).toHaveURL(/\/rooms$/);
});

test("finishes onboarding with the first room and its prices saved", async ({ page }, testInfo) => {
  await mockRooms(page);
  const pricing = await mockPricing(page);
  const assertHealthy = watchPageHealth(page, testInfo);
  await fillRoomAndPrices(page, "/rooms/new?onboarding=pms-activation");
  await main(page).getByRole("button", { name: "Finish PMS Setup" }).click();
  await expect(main(page).getByText("Room details and prices are saved.")).toBeVisible();
  await expect(main(page).getByRole("link", { name: "Edit prices" })).toHaveAttribute(
    "href",
    `/rooms/${CREATED}?tab=prices`,
  );
  expect(publishedRooms(pricing).map((room) => room.roomTypeId)).toEqual([DELUXE, CREATED]);
  await assertHealthy();
});

// VAY-2184: with a price error showing, Cancel and Create Room Type stay side by side in a sticky bar on screen,
// with its own background so the page scrolls under the bar rather than through it.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])
  test(`keeps the Prices tab's buttons side by side in a solid bar at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockRooms(page);
    await mockPricing(page);
    await fillRoomAndPrices(page);
    await main(page).getByLabel("Room price per night").fill("12,5");
    const create = main(page).getByRole("button", { name: "Create Room Type" });
    await create.click();
    await expect(
      main(page).getByText("Enter a valid price using a decimal point.", { exact: true }).first(),
    ).toBeVisible();

    const cancel = (await main(page)
      .getByRole("link", { name: "Cancel", exact: true })
      .boundingBox())!;
    const submit = (await create.boundingBox())!;
    expect(cancel.x + cancel.width).toBeLessThanOrEqual(submit.x);
    expect(Math.abs(cancel.y + cancel.height / 2 - (submit.y + submit.height / 2))).toBeLessThan(2);
    const bar = create.locator("xpath=..");
    expect(await bar.evaluate((node) => getComputedStyle(node).position)).toBe("sticky");
    expect(await bar.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    // The page is taller than the screen, so the form really scrolls under the bar.
    expect(await main(page).evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    const box = (await bar.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  });
