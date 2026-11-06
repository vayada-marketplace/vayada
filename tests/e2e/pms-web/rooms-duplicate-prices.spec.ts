import { expect, test, type Page, type Route } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

// VAY-2487: Duplicate on Rooms & Rates gives the copy the original's prices: the standard price, every season with its
// dates, minimum stay and price, and each rate's terms. They are saved right away and belong to the copy alone.
const VILLA = "aaaaaaaa-0000-4000-8000-00000000000a";
const COPY = "dddddddd-0000-4000-8000-00000000000d";
const FLEXIBLE_TERMS = "66666666-6666-4666-8666-666666666661";
const NON_REFUNDABLE_TERMS = "66666666-6666-4666-8666-666666666662";
const token = (digit: string) => digit.repeat(64);
const sources = {
  room: `pms.pricing.rooms.v2:${token("3")}`,
  terms: `booking.pricing.terms.v2:${token("4")}`,
  finance: `finance.pricing.source.v2:${token("5")}`,
};
const villa = {
  ...pmsWebRoomType,
  roomTypeId: VILLA,
  version: "room-type-facts-v3",
  name: "Hilltop Villa",
  category: "villa",
  occupancyLimits: { total: 2, adults: 2, children: 0 },
  roomCount: 2,
};
// As the server answers a duplicate: the room facts copied, no rooms yet.
const copy = {
  ...villa,
  roomTypeId: COPY,
  version: "room-type-facts-v1",
  name: "Hilltop Villa Copy",
  sortOrder: 1,
  roomCount: 0,
};

type Room = Record<string, any>;
const rules = (minArrivalNights: number) => ({
  minArrivalNights,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
});
const flat = (dollars: number) => ({ mode: "flat", amountMinor: String(dollars * 100) });
const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// Aether Hilltop Villas' year: 400 a night standard, one season a month (the ticket's screenshot, then the rest of the
// year). In EUR, the shared mocks' payment currency, so no currency change shows.
const monthPrices = [325, 325, 300, 275, 250, 225, 250, 275, 300, 325, 350, 375];
const two = (value: number) => String(value).padStart(2, "0");
const monthlySeasons = monthNames.map((name, index) => ({
  name,
  tier: "",
  from: `${two(index + 1)}-01`,
  through: `${two(index + 1)}-${monthDays[index]}`,
  price: flat(monthPrices[index]!),
}));
/** The villa's prices: a standard price, the seasons (December with a 3-night minimum stay), a Flexible rate and a
 * Non-refundable one 10% cheaper. */
const pricesFor = (roomTypeId: string, seasons: Room[] = monthlySeasons): Room => ({
  version: "pricing.v2",
  propertyId: PMS_WEB_PROPERTY_ID,
  roomTypeId,
  revision: 3,
  currency: "EUR",
  capacity: { total: 2, adults: 2, children: 0 },
  children: {
    adultFromAge: 18,
    bands: [{ fromAge: 0, throughAge: 17, nightlyMinor: "0", countsTowardCapacity: true }],
  },
  offers: [
    {
      id: "flexible",
      termsRevision: FLEXIBLE_TERMS,
      meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
      price: {
        kind: "independent",
        calendar: { base: flat(400), months: [], seasons, weekdays: [], dates: [] },
      },
      restrictions: {
        kind: "own",
        rules: rules(1),
        seasons: seasons.some((season) => season.name === "December")
          ? [{ from: "12-01", through: "12-31", rules: rules(3) }]
          : [],
        dates: [],
      },
    },
    {
      id: "nonrefundable",
      termsRevision: NON_REFUNDABLE_TERMS,
      meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
      price: {
        kind: "linked",
        parentId: "flexible",
        adjustment: { kind: "percentage", basisPoints: -1000 },
        dateOverrides: [],
      },
      restrictions: { kind: "inherit" },
    },
  ],
});
const flexibleTerms = {
  cancellation: {
    kind: "flexible",
    terms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    },
  },
  payment: { kind: "full", acceptedMethods: ["bank_transfer", "pay_at_property"] },
};
const nonRefundableTerms = {
  cancellation: { kind: "non_refundable" },
  payment: { kind: "full", acceptedMethods: ["bank_transfer"] },
};

/** The Rooms & Rates reads and the duplicate command; the list has the copy once it exists. */
async function mockRooms(page: Page, { copied = false } = {}) {
  const state = { duplicates: [] as Record<string, unknown>[], copied };
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  // The Rooms list reads the prepared-import offer.
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
        items: state.copied ? [villa, copy] : [villa],
        sourceFreshness: {},
      },
    }),
  );
  for (const item of [villa, copy])
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
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${VILLA}/duplicate`,
    (route) => {
      state.duplicates.push(route.request().postDataJSON() as Record<string, unknown>);
      state.copied = true;
      return route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          item: copy,
          commandMeta: {},
        },
      });
    },
  );
  return state;
}

/** An in-memory pricing-v2 store: the published rooms, each rate's terms per room, every terms write and publish.
 * As on the server, staged terms become a rate's current terms only when a publish names them. `refuse` answers the
 * next publish with an error once. */
async function mockPricing(page: Page, rooms: Room[], { saved = nonRefundableTerms } = {}) {
  const heads = new Map<string, string>(),
    terms = new Map<string, Record<string, unknown>>();
  for (const room of rooms)
    for (const offer of room.offers) {
      heads.set(`${room.roomTypeId}/${offer.id}`, offer.termsRevision);
      terms.set(offer.termsRevision, offer.id === "flexible" ? flexibleTerms : saved);
    }
  const state = {
    publication: rooms.length
      ? ({
          currency: "EUR",
          revision: 3,
          stale: false,
          sources,
          ownerReferences: { finance: `finance.pricing.v2:${token("1")}` },
          rooms,
        } as Record<string, any> | null)
      : null,
    publishes: [] as Record<string, any>[],
    termsWrites: [] as { roomTypeId: string; offerId: string; body: Record<string, any> }[],
    writes: 0,
    draft: null as Record<string, any> | null,
    refuse: null as { status: number; json: unknown } | null,
  };
  const ok = (route: Route, json: unknown) => route.fulfill({ json });
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-v2**`, async (route) => {
    const request = route.request();
    const method = request.method();
    const suffix = new URL(request.url()).pathname.split("/pricing-v2")[1] ?? "";
    const body = (method === "GET" ? {} : request.postDataJSON()) as Record<string, any>;
    if (method !== "GET") state.writes += 1;
    // Bank transfer is ready (VAY-2139); card isn't, as in production today (VAY-2205).
    if (suffix === "/payment-methods" && method === "GET")
      return ok(route, { acceptanceEnabled: true, readyMethods: ["bank_transfer"] });
    if (suffix === "/card-readiness" && method === "GET")
      return ok(route, {
        card: { ready: false, reason: "switch_off", charge: "at_booking" },
        deposits: { ready: false },
      });
    if (suffix === "/not-selling" && method === "GET")
      return ok(route, {
        version: "pricing-rates-not-selling.v1",
        publishedRevision: state.publication?.revision ?? null,
        rates: [],
      });
    if (suffix === "/guest-display-rate" && method === "GET")
      return ok(route, { guestDisplay: null });
    if (suffix === "" && method === "GET")
      return state.publication
        ? ok(route, state.publication)
        : route.fulfill({ status: 404, json: { code: "not_found" } });
    const offerTerms = suffix.match(
      /^(?:\/drafts\/[^/]+)?\/rooms\/([^/]+)\/offers\/([^/]+)\/terms$/,
    );
    if (offerTerms) {
      const roomTypeId = offerTerms[1]!,
        offerId = decodeURIComponent(offerTerms[2]!),
        key = `${roomTypeId}/${offerId}`;
      const head = heads.get(key);
      if (method === "GET")
        return head
          ? ok(route, { roomTypeId, offerId, revision: head, ...terms.get(head) })
          : route.fulfill({ status: 404, json: { code: "not_found" } });
      if (body.expectedRevision !== (head ?? null))
        return route.fulfill({ status: 409, json: { code: "stale" } });
      // As the server: new terms may not take non-refundable stays at the property (VAY-2280).
      if (
        body.cancellation.kind === "non_refundable" &&
        body.payment.acceptedMethods?.includes("pay_at_property")
      )
        return route.fulfill({ status: 400, json: { code: "non_refundable_pay_at_property" } });
      state.termsWrites.push({ roomTypeId, offerId, body });
      const revision = `77777777-7777-4777-8777-${String(state.termsWrites.length).padStart(12, "0")}`;
      terms.set(revision, { cancellation: body.cancellation, payment: body.payment });
      return ok(route, {
        roomTypeId,
        offerId,
        revision,
        cancellation: body.cancellation,
        payment: body.payment,
      });
    }
    if (suffix === "/prepare" && method === "POST")
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
    if (suffix === "/publish" && method === "POST") {
      if (state.refuse) {
        const { status, json } = state.refuse;
        state.refuse = null;
        return route.fulfill({ status, json });
      }
      state.publishes.push(body);
      if (body.expectedRevision !== (state.publication?.revision ?? 0))
        return route.fulfill({ status: 409, json: { code: "stale" } });
      state.publication = {
        ...body.snapshot,
        revision: body.expectedRevision + 1,
        sources,
        stale: false,
      };
      for (const room of body.snapshot.rooms as Room[])
        for (const offer of room.offers)
          heads.set(`${room.roomTypeId}/${offer.id}`, offer.termsRevision);
      return ok(route, { revision: body.expectedRevision + 1, replayed: false });
    }
    return route.fulfill({ status: 501, json: { code: "unexpected", method, suffix } });
  });
  return state;
}

const main = (page: Page) => page.locator("main");
async function duplicateVilla(page: Page) {
  await page.goto("/rooms");
  await expect(main(page).getByText("Hilltop Villa", { exact: true }).first()).toBeVisible();
  await main(page).getByRole("button", { name: "Duplicate room type" }).first().click();
}
const publishedRoom = (pricing: { publication: Record<string, any> | null }, roomTypeId: string) =>
  (pricing.publication!.rooms as Room[]).find((room) => room.roomTypeId === roomTypeId)!;
/** A room's prices without what a save assigns: its revision and its rates' terms revisions. */
const withoutRevisions = (room: Room) => ({
  ...room,
  roomTypeId: "",
  revision: 0,
  offers: room.offers.map((offer: Room) => ({ ...offer, termsRevision: "" })),
});
async function openPrices(page: Page, roomTypeId: string) {
  await page.goto(`/rooms/${roomTypeId}?tab=prices`);
  await expect(
    main(page).getByRole("heading", { name: "Prices and seasons", exact: true }).first(),
  ).toBeVisible();
  await expect(
    main(page).getByText("Loading the cancellation terms", { exact: false }),
  ).toHaveCount(0);
}
const seasonTable = (page: Page) => main(page).getByRole("table", { name: "Prices and seasons" });

test("Duplicate saves the original's standard price, 12 seasons and rate terms for the copy (VAY-2487)", async ({
  page,
}, testInfo) => {
  const rooms = await mockRooms(page);
  const pricing = await mockPricing(page, [pricesFor(VILLA)]);
  const assertHealthy = watchPageHealth(page, testInfo);
  await duplicateVilla(page);

  await expect(main(page).getByText("Hilltop Villa Copy", { exact: true }).first()).toBeVisible();
  expect(rooms.duplicates).toHaveLength(1);
  // One save right away, from the prices read for the copy: the original as it was, the copy with the same prices.
  await expect.poll(() => pricing.publishes.length).toBe(1);
  expect(pricing.publishes[0]!.expectedRevision).toBe(3);
  expect(pricing.publication!.rooms.map((room: Room) => room.roomTypeId)).toEqual([VILLA, COPY]);
  expect(publishedRoom(pricing, VILLA)).toEqual({ ...pricesFor(VILLA), revision: 4 });
  expect(withoutRevisions(publishedRoom(pricing, COPY))).toEqual(
    withoutRevisions(pricesFor(VILLA)),
  );
  // Each rate keeps its terms, as new terms of the copy; the original's terms stay its own.
  expect(pricing.termsWrites).toEqual([
    {
      roomTypeId: COPY,
      offerId: "flexible",
      body: expect.objectContaining({ expectedRevision: null, ...flexibleTerms }),
    },
    {
      roomTypeId: COPY,
      offerId: "nonrefundable",
      body: expect.objectContaining({ expectedRevision: null, ...nonRefundableTerms }),
    },
  ]);
  expect(
    publishedRoom(pricing, COPY).offers.map((offer: Room) => offer.termsRevision),
  ).not.toContain(FLEXIBLE_TERMS);
  expect(publishedRoom(pricing, VILLA).offers.map((offer: Room) => offer.termsRevision)).toEqual([
    FLEXIBLE_TERMS,
    NON_REFUNDABLE_TERMS,
  ]);
  // The list shows the copy priced, like the original.
  await expect(main(page).locator(`a[href="/rooms/${COPY}?tab=prices"]`)).toHaveText("Edit prices");
  await expect(main(page).getByRole("alert")).toHaveCount(0);

  // The copy's Prices tab shows the same standard price and seasons.
  await openPrices(page, COPY);
  const table = seasonTable(page);
  await expect(table.getByLabel("Hilltop Villa Copy Offer 1 Per room")).toHaveValue("400.00");
  for (const [index, name] of monthNames.entries())
    await expect(table.getByLabel(`${name} price Per room`)).toHaveValue(
      `${monthPrices[index]}.00`,
    );
  await expect(table.getByRole("group", { name: "December minimum stay" })).toContainText(
    "3 nights",
  );
  await expect(main(page).getByText("All prices saved and live")).toBeVisible();
  await assertHealthy();
});

test("a season price changed on the copy leaves the original's prices as they were", async ({
  page,
}) => {
  await mockRooms(page);
  const pricing = await mockPricing(page, [pricesFor(VILLA)]);
  await duplicateVilla(page);
  await expect(main(page).locator(`a[href="/rooms/${COPY}?tab=prices"]`)).toHaveText("Edit prices");
  expect(pricing.publishes).toHaveLength(1);
  await openPrices(page, COPY);
  const table = seasonTable(page);
  await table.getByLabel("June price Per room").fill("240");
  await table.getByLabel("June price Per room").press("Enter");
  await main(page).getByRole("button", { name: "Save and publish" }).click();
  await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible();

  expect(pricing.publishes).toHaveLength(2);
  const june = (room: Room) =>
    room.offers[0].price.calendar.seasons.find((season: Room) => season.name === "June").price;
  expect(june(publishedRoom(pricing, COPY))).toEqual(flat(240));
  expect(publishedRoom(pricing, VILLA)).toEqual({ ...pricesFor(VILLA), revision: 5 });

  await openPrices(page, VILLA);
  await expect(seasonTable(page).getByLabel("June price Per room")).toHaveValue("225.00");
});

test("a room type with only a standard price is copied with that price", async ({ page }) => {
  await mockRooms(page);
  const pricing = await mockPricing(page, [pricesFor(VILLA, [])]);
  await duplicateVilla(page);
  await expect(main(page).getByText("Hilltop Villa Copy", { exact: true }).first()).toBeVisible();
  await expect.poll(() => pricing.publishes.length).toBe(1);
  const copied = publishedRoom(pricing, COPY);
  expect(copied.offers[0].price.calendar).toEqual({
    base: flat(400),
    months: [],
    seasons: [],
    weekdays: [],
    dates: [],
  });
  expect(withoutRevisions(copied)).toEqual(withoutRevisions(pricesFor(VILLA, [])));
});

test("a room type without prices is copied without prices, saving none", async ({ page }) => {
  const rooms = await mockRooms(page);
  const pricing = await mockPricing(page, []);
  await duplicateVilla(page);
  await expect(main(page).getByText("Hilltop Villa Copy", { exact: true }).first()).toBeVisible();
  expect(rooms.duplicates).toHaveLength(1);
  expect(pricing.writes).toBe(0);
  await expect(main(page).getByRole("alert")).toHaveCount(0);
  await expect(page).toHaveURL(/\/rooms$/);
});

test("when the copied prices can't be saved, the copy's Prices tab opens on them and says why", async ({
  page,
}) => {
  await mockRooms(page);
  const pricing = await mockPricing(page, [pricesFor(VILLA)]);
  pricing.refuse = { status: 409, json: { code: "stale" } };
  await duplicateVilla(page);

  await expect(page).toHaveURL(new RegExp(`/rooms/${COPY}\\?tab=prices$`));
  await expect(
    main(page).getByText("The room type was created, but its prices were not saved.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(main(page).getByText("Someone else saved prices at the same time.")).toBeVisible();
  const table = seasonTable(page);
  await expect(table.getByLabel("Hilltop Villa Copy Offer 1 Per room")).toHaveValue("400.00");
  await expect(table.getByLabel("June price Per room")).toHaveValue("225.00");
  expect(pricing.publishes).toHaveLength(0);

  await main(page).getByRole("button", { name: "Save and publish" }).click();
  await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible();
  expect(pricing.publication!.rooms.map((room: Room) => room.roomTypeId)).toEqual([VILLA, COPY]);
  expect(withoutRevisions(publishedRoom(pricing, COPY))).toEqual(
    withoutRevisions(pricesFor(VILLA)),
  );
});

test("a rate whose older terms today's rules refuse: the copy's Prices tab opens on the copied prices and names the rule", async ({
  page,
}) => {
  await mockRooms(page);
  // Saved before VAY-2280: non-refundable, yet payable at the property. The original keeps selling with it.
  const older = {
    ...nonRefundableTerms,
    payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
  };
  const pricing = await mockPricing(page, [pricesFor(VILLA)], { saved: older });
  await duplicateVilla(page);

  await expect(page).toHaveURL(new RegExp(`/rooms/${COPY}\\?tab=prices$`));
  await expect(
    main(page).getByText("The room type was created, but its prices were not saved.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    main(page).getByText("Non-refundable stays are paid in advance", { exact: false }),
  ).toBeVisible();
  const table = seasonTable(page);
  await expect(table.getByLabel("Hilltop Villa Copy Offer 1 Per room")).toHaveValue("400.00");
  await expect(table.getByLabel("June price Per room")).toHaveValue("225.00");
  expect(pricing.publishes).toHaveLength(0);
  expect(pricing.publication!.rooms).toEqual([pricesFor(VILLA)]);
});
