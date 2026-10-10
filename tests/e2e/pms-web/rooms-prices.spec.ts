import { expect, test, type Page, type Route } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

// VAY-2093: room prices live in each room's Prices tab on Rooms & Rates; /pricing is retired.
const SUITE = "aaaaaaaa-0000-4000-8000-00000000000a";
const GARDEN = "bbbbbbbb-0000-4000-8000-00000000000b";
const TERMS = "66666666-6666-4666-8666-666666666666";
const token = (digit: string) => digit.repeat(64);
const sources = {
  room: `pms.pricing.rooms.v2:${token("3")}`,
  terms: `booking.pricing.terms.v2:${token("4")}`,
  finance: `finance.pricing.source.v2:${token("5")}`,
};
const roomTypes = [
  { ...pmsWebRoomType, roomTypeId: SUITE, name: "Alpine Suite" },
  { ...pmsWebRoomType, roomTypeId: GARDEN, name: "Garden Room", sortOrder: 1 },
];

type Room = Record<string, unknown>;
const pricedRoom = (roomTypeId: string, amountMinor: string, revision: number): Room => ({
  version: "pricing.v2",
  propertyId: PMS_WEB_PROPERTY_ID,
  roomTypeId,
  revision,
  currency: "EUR",
  capacity: { total: 3, adults: 2, children: 1 },
  children: {
    adultFromAge: 12,
    bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
  },
  offers: [
    {
      id: "flex",
      termsRevision: TERMS,
      meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
      price: {
        kind: "independent",
        calendar: {
          base: { mode: "flat", amountMinor },
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
});
const publicationOf = (revision: number, rooms: Room[], stale = false) => ({
  currency: "EUR",
  revision,
  stale,
  sources,
  ownerReferences: { finance: `finance.pricing.v2:${token("1")}` },
  rooms: rooms.map((room) => ({ ...room, revision })),
});

/** An in-memory pricing-v2 store: one publication per property, refused (409) on a stale base revision. */
async function mockPricing(page: Page, initial: ReturnType<typeof publicationOf> | null) {
  const state = {
    publication: initial,
    publishes: [] as Record<string, any>[],
    draft: null as Record<string, any> | null,
  };
  const ok = (route: Route, json: unknown) => route.fulfill({ json });
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-v2**`, async (route) => {
    const request = route.request();
    const method = request.method();
    const suffix = new URL(request.url()).pathname.split("/pricing-v2")[1] ?? "";
    const body = (method === "GET" ? {} : request.postDataJSON()) as Record<string, any>;
    if (suffix === "" && method === "GET") {
      if (!state.publication) return route.fulfill({ status: 404, json: { code: "not_found" } });
      return ok(route, state.publication);
    }
    const terms = suffix.match(/\/rooms\/([^/]+)\/offers\/([^/]+)\/terms$/);
    if (terms && method === "GET") {
      return ok(route, {
        roomTypeId: terms[1],
        offerId: decodeURIComponent(terms[2]!),
        revision: TERMS,
        cancellation: { kind: "non_refundable" },
        payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
      });
    }
    if (suffix === "/prepare" && method === "POST") {
      return ok(route, {
        sources,
        snapshot: {
          currency: body.currency,
          rooms: body.rooms,
          ownerReferences: { finance: `finance.pricing.v2:${token("1")}` },
        },
      });
    }
    if (/^\/drafts\/[^/]+$/.test(suffix) && method === "PUT") {
      state.draft = {
        ...body,
        draftId: suffix.split("/")[2],
        revision: body.expectedDraftRevision + 1,
      };
      return ok(route, { revision: state.draft.revision });
    }
    if (/^\/drafts\/[^/]+\/charge-review$/.test(suffix) && method === "GET" && state.draft) {
      const { draftId, snapshot, revision, baseRevision } = state.draft;
      return ok(route, {
        draftId,
        snapshot,
        revision,
        baseRevision,
        sources,
        stale: false,
        fingerprint: token("2"),
        declaration: "all_mandatory_charges_included",
      });
    }
    if (suffix === "/charges" && method === "POST") {
      return ok(route, {
        id: "77777777-7777-4777-8777-777777777777",
        fingerprint: body.claimedFingerprint,
        declaration: body.declaration,
      });
    }
    if (suffix === "/publish" && method === "POST") {
      state.publishes.push(body);
      if (body.expectedRevision !== (state.publication?.revision ?? 0))
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

async function openPms(page: Page) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "test-owner",
        roleKey: "hotel_owner",
        permissions: [
          "pms.operations.read",
          "pms.operations.manage",
          "pms.rooms_rates.read",
          "pms.rooms_rates.manage",
        ],
      },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: roomTypes,
        sourceFreshness: {},
      },
    }),
  );
  for (const item of roomTypes) {
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
  }
}

const main = (page: Page) => page.locator("main");
const priceInput = (page: Page, room: string) => main(page).getByLabel(`${room} Offer 1 Per room`);

test("prices a room in its Prices tab and publishes the other rooms unchanged", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await openPms(page);
  const pricing = await mockPricing(page, publicationOf(3, [pricedRoom(SUITE, "12000", 3)]));

  await page.goto("/rooms");
  await expect(main(page).getByText("All prices are in EUR.", { exact: false })).toBeVisible();
  await expect(main(page).getByText("1 rate · from 120.00 EUR")).toBeVisible();
  await expect(main(page).getByRole("link", { name: "Set prices" })).toHaveAttribute(
    "href",
    `/rooms/${GARDEN}?tab=prices`,
  );
  await main(page).getByRole("link", { name: "Edit prices" }).click();

  await expect(page).toHaveURL(new RegExp(`/rooms/${SUITE}\\?tab=prices$`));
  await expect(main(page).getByRole("heading", { name: "Prices", exact: true })).toBeVisible();
  await expect(priceInput(page, "Alpine Suite")).toHaveValue("120.00");
  await expect(main(page).getByText("Garden Room")).toHaveCount(0);
  await priceInput(page, "Alpine Suite").fill("135.50");
  await main(page).getByRole("button", { name: "Save prices" }).click();
  await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible();

  expect(pricing.publishes).toHaveLength(1);
  expect(pricing.publishes[0]).toMatchObject({ expectedRevision: 3 });
  expect(pricing.publishes[0].snapshot.rooms).toHaveLength(1);
  expect(pricing.publishes[0].snapshot.rooms[0].offers[0].price.calendar.base.amountMinor).toBe(
    "13550",
  );
  await expect(priceInput(page, "Alpine Suite")).toHaveValue("135.50");
  await expect(main(page).getByRole("button", { name: "Save prices" })).toBeDisabled();

  await page.goto(`/rooms/${GARDEN}?tab=prices`);
  await expect(main(page).getByText("This room has no prices yet")).toBeVisible();
  await expect(main(page).getByLabel("Currency code (for example EUR)")).toHaveValue("EUR");
  await expect(main(page).getByLabel("Currency code (for example EUR)")).toBeDisabled();
  await assertHealthy();
});

test("keeps this room's edits over a reload when someone else published another room meanwhile", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await openPms(page);
  const pricing = await mockPricing(
    page,
    publicationOf(3, [pricedRoom(SUITE, "12000", 3), pricedRoom(GARDEN, "9000", 3)]),
  );

  await page.goto(`/rooms/${SUITE}?tab=prices`);
  await priceInput(page, "Alpine Suite").fill("140");
  // Another staff member publishes a change to Garden Room first.
  pricing.publication = publicationOf(4, [
    pricedRoom(SUITE, "12000", 4),
    pricedRoom(GARDEN, "9500", 4),
  ]);
  await main(page).getByRole("button", { name: "Save prices" }).click();
  await expect(
    main(page).getByText("Your changes to this room are kept if nobody else changed this room."),
  ).toBeVisible();
  await main(page).getByRole("button", { name: "Reload pricing" }).click();
  await expect(priceInput(page, "Alpine Suite")).toHaveValue("140.00");
  await main(page).getByRole("button", { name: "Save prices" }).click();
  await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible();

  const published = pricing.publishes.at(-1)!;
  expect(published.expectedRevision).toBe(4);
  const rooms = published.snapshot.rooms as Room[];
  expect(rooms.find((room) => room.roomTypeId === GARDEN)).toMatchObject({
    offers: [{ price: { calendar: { base: { amountMinor: "9500" } } } }],
  });
  expect(rooms.find((room) => room.roomTypeId === SUITE)).toMatchObject({
    offers: [{ price: { calendar: { base: { amountMinor: "14000" } } } }],
  });
  await assertHealthy();
});

test("republishes stale prices from the Rooms list", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await openPms(page);
  const pricing = await mockPricing(page, publicationOf(5, [pricedRoom(SUITE, "12000", 5)], true));

  await page.goto("/rooms");
  await expect(main(page).getByText("Prices need to be saved again")).toBeVisible();
  await main(page).getByRole("button", { name: "Save prices again" }).click();
  await expect(main(page).getByText("Prices saved.")).toBeVisible();
  await expect(main(page).getByText("Prices need to be saved again")).toHaveCount(0);
  expect(pricing.publishes).toHaveLength(1);
  expect(pricing.publishes[0]).toMatchObject({
    expectedRevision: 5,
    snapshot: { ownerReferences: { charges: "77777777-7777-4777-8777-777777777777" } },
  });
  expect(pricing.publishes[0].snapshot.rooms[0]).toMatchObject({
    roomTypeId: SUITE,
    revision: 6,
    offers: [{ price: { calendar: { base: { amountMinor: "12000" } } } }],
  });
  await assertHealthy();
});

test("sends old Pricing links to Rooms & Rates", async ({ page }) => {
  await openPms(page);
  await mockPricing(page, null);
  await page.goto("/pricing");
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(
    main(page).getByText("No prices yet. Open a room's Prices tab", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Pricing", exact: true })).toHaveCount(0);
});
