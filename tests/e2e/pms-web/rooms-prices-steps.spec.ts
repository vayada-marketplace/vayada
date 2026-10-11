import { expect, test, type Page, type Route } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

// VAY-2125: the room Prices tab as the Paper design's step-by-step questions, against an in-memory pricing-v2 store.
const DELUXE = "aaaaaaaa-0000-4000-8000-00000000000a";
const GARDEN = "bbbbbbbb-0000-4000-8000-00000000000b";
const LAKE = "cccccccc-0000-4000-8000-00000000000c";
const TERMS = "66666666-6666-4666-8666-666666666666";
const token = (digit: string) => digit.repeat(64);
const sources = {
  room: `pms.pricing.rooms.v2:${token("3")}`,
  terms: `booking.pricing.terms.v2:${token("4")}`,
  finance: `finance.pricing.source.v2:${token("5")}`,
};
const roomTypes = [
  { ...pmsWebRoomType, roomTypeId: DELUXE, name: "Deluxe Double Room" },
  { ...pmsWebRoomType, roomTypeId: GARDEN, name: "Garden Room", sortOrder: 1 },
  { ...pmsWebRoomType, roomTypeId: LAKE, name: "Lake Loft", sortOrder: 2 },
];

type Room = Record<string, any>;
const rules = (minArrivalNights = 1, extra: Record<string, unknown> = {}) => ({
  minArrivalNights,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
  ...extra,
});
const roomOnly = { kind: "room_only", charge: { kind: "room", amountMinor: "0" } };
const flat = (amountMinor: string) => ({ mode: "flat", amountMinor });
const calendar = (base: unknown, extra: Record<string, unknown> = {}) => ({
  base,
  months: [],
  seasons: [],
  weekdays: [],
  dates: [],
  ...extra,
});
const room = (roomTypeId: string, offers: Room[], revision: number): Room => ({
  version: "pricing.v2",
  propertyId: PMS_WEB_PROPERTY_ID,
  roomTypeId,
  revision,
  currency: "EUR",
  capacity: { total: 3, adults: 2, children: 1 },
  children: {
    adultFromAge: 18,
    bands: [
      { fromAge: 0, throughAge: 5, nightlyMinor: "0", countsTowardCapacity: true },
      { fromAge: 6, throughAge: 17, nightlyMinor: "2000", countsTowardCapacity: true },
    ],
  },
  offers,
});
/** The Paper design's room: €100, Low and High seasons, weekends +15%, Flexible / Non-refundable / With breakfast. */
const designRoom = (revision: number) =>
  room(
    DELUXE,
    [
      {
        id: "flexible",
        termsRevision: TERMS,
        meal: roomOnly,
        price: {
          kind: "independent",
          calendar: calendar(flat("10000"), {
            seasons: [
              { name: "Low", tier: "Low", from: "01-01", through: "03-31", price: flat("8000") },
              { name: "High", tier: "High", from: "07-01", through: "08-31", price: flat("14000") },
            ],
            weekdays: [
              { day: 4, adjustment: { kind: "percentage", basisPoints: 1500 } },
              { day: 5, adjustment: { kind: "percentage", basisPoints: 1500 } },
            ],
          }),
        },
        restrictions: { kind: "own", rules: rules(2), seasons: [], dates: [] },
      },
      {
        id: "nonrefundable",
        termsRevision: TERMS,
        meal: roomOnly,
        price: {
          kind: "linked",
          parentId: "flexible",
          adjustment: { kind: "percentage", basisPoints: -1000 },
          dateOverrides: [],
        },
        restrictions: { kind: "inherit" },
      },
      {
        id: "breakfast",
        termsRevision: TERMS,
        meal: { kind: "breakfast", charge: { kind: "room", amountMinor: "1500" } },
        price: {
          kind: "linked",
          parentId: "flexible",
          adjustment: { kind: "fixed", deltaMinor: "0" },
          dateOverrides: [],
        },
        restrictions: { kind: "inherit" },
      },
    ],
    revision,
  );
/** What the simple steps can't show: two independent options, a linked chain, months, single dates, an occupancy
 * price and stay rules that differ between options. */
const complexRoom = (revision: number) =>
  room(
    GARDEN,
    [
      {
        id: "standard",
        termsRevision: TERMS,
        meal: roomOnly,
        price: {
          kind: "independent",
          calendar: calendar(
            { mode: "occupancy", amountsMinor: ["9000", "11000"] },
            {
              months: [
                { month: 12, price: { mode: "occupancy", amountsMinor: ["13000", "15000"] } },
              ],
              dates: [
                {
                  date: "2026-12-31",
                  price: { mode: "occupancy", amountsMinor: ["20000", "22000"] },
                },
              ],
              weekdays: [{ day: 5, adjustment: { kind: "fixed", deltaMinor: "1000" } }],
            },
          ),
        },
        restrictions: {
          kind: "own",
          rules: rules(1),
          seasons: [{ from: "12-20", through: "01-05", rules: rules(3) }],
          dates: [{ date: "2026-12-31", rules: rules(1, { closedToArrival: true }) }],
        },
      },
      {
        id: "package",
        termsRevision: TERMS,
        meal: {
          kind: "half_board",
          charge: { kind: "person", adultMinor: "2500", childBandAmountsMinor: ["0", "1200"] },
        },
        price: {
          kind: "independent",
          calendar: calendar({ mode: "per_person", unitMinor: "7000" }),
        },
        restrictions: {
          kind: "own",
          rules: rules(2, { maxStayNights: 14 }),
          seasons: [],
          dates: [],
        },
      },
      {
        id: "package-early",
        termsRevision: TERMS,
        meal: {
          kind: "half_board",
          charge: { kind: "person", adultMinor: "2500", childBandAmountsMinor: ["0", "1200"] },
        },
        price: {
          kind: "linked",
          parentId: "package",
          adjustment: { kind: "percentage", basisPoints: -800 },
          dateOverrides: [{ date: "2026-08-15", price: { mode: "per_person", unitMinor: "9000" } }],
        },
        restrictions: { kind: "own", rules: rules(4), seasons: [], dates: [] },
      },
    ],
    revision,
  );
const flexible = {
  kind: "flexible",
  terms: {
    type: "free_until_days_before_arrival",
    freeCancellationDeadlineDays: 7,
    afterDeadlinePenalty: "full_booking_amount",
    noShowPenalty: "full_booking_amount",
  },
};
const publicationOf = (revision: number, rooms: Room[]) => ({
  currency: "EUR",
  revision,
  stale: false,
  sources,
  ownerReferences: { finance: `finance.pricing.v2:${token("1")}` },
  rooms: rooms.map((value) => ({ ...value, revision })),
});

/** An in-memory pricing-v2 store: published rooms, terms per offer (saved through drafts), and every publish. */
async function mockPricing(page: Page, initial: ReturnType<typeof publicationOf> | null) {
  const terms = new Map<string, Record<string, unknown>>([
    ["flexible", { revision: TERMS, cancellation: flexible }],
    ["breakfast", { revision: TERMS, cancellation: flexible }],
    ["standard", { revision: TERMS, cancellation: flexible }],
    ["package", { revision: TERMS, cancellation: flexible }],
  ]);
  const state = {
    publication: initial,
    publishes: [] as Record<string, any>[],
    termsWrites: [] as Record<string, any>[],
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
    const offerTerms = suffix.match(
      /^(?:\/drafts\/[^/]+)?\/rooms\/([^/]+)\/offers\/([^/]+)\/terms$/,
    );
    if (offerTerms && method === "GET") {
      const offerId = decodeURIComponent(offerTerms[2]!);
      const saved = terms.get(offerId) ?? {
        revision: TERMS,
        cancellation: { kind: "non_refundable" },
      };
      return ok(route, {
        roomTypeId: offerTerms[1],
        offerId,
        revision: saved.revision,
        cancellation: saved.cancellation,
        payment: { kind: "full", acceptedMethods: ["card", "pay_at_property"] },
      });
    }
    if (offerTerms && method === "PUT") {
      const offerId = decodeURIComponent(offerTerms[2]!);
      const revision = `77777777-7777-4777-8777-${String(state.termsWrites.length + 1).padStart(12, "0")}`;
      state.termsWrites.push({ offerId, ...body });
      terms.set(offerId, { revision, cancellation: body.cancellation });
      return ok(route, {
        roomTypeId: offerTerms[1],
        offerId,
        revision,
        cancellation: body.cancellation,
        payment: body.payment,
      });
    }
    if (suffix === "/prepare" && method === "POST") {
      return ok(route, {
        sources,
        effectiveSources: sources,
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
  for (const item of roomTypes)
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

const main = (page: Page) => page.locator("main");
const prices = async (page: Page, id: string) => {
  await page.goto(`/rooms/${id}?tab=prices`);
  // An unpriced room shows "Set this room's prices" and step 1's question together.
  await expect(
    main(page)
      .getByRole("heading", { name: /What does this room cost per night\?|Set this room's prices/ })
      .first(),
  ).toBeVisible();
};
// Every option keeps a hidden Edit window mounted; the open window or form is the visible dialog.
const dialog = (page: Page) => page.locator('[role="dialog"]:visible');

test("answers the steps for a priced room and publishes only what changed", async ({
  page,
}, testInfo) => {
  await openPms(page);
  const pricing = await mockPricing(page, publicationOf(3, [designRoom(3), complexRoom(3)]));
  const assertHealthy = watchPageHealth(page, testInfo);
  await prices(page, DELUXE);
  for (const heading of [
    "Is it more expensive at certain times of year?",
    "Do weekends cost more?",
    "What can guests choose when they book?",
    "Any rules for stays?",
  ])
    await expect(main(page).getByRole("heading", { name: heading })).toBeVisible();
  // Step 4 matches the design: names from meal and terms, the engine's normal night.
  for (const [name, price] of [
    ["Flexible", "€100"],
    ["Non-refundable", "€90"],
    ["With breakfast", "€115"],
  ])
    await expect(
      main(page).getByRole("listitem").filter({ hasText: name }).filter({ hasText: price }).first(),
    ).toBeVisible();
  await expect(main(page).getByText("Save 10%")).toBeVisible();

  await main(page).getByRole("button", { name: "+10%" }).click();
  await expect(main(page).getByRole("button", { name: "+10%" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await main(page).getByRole("button", { name: "Add season" }).click();
  await dialog(page).getByLabel("Season name").fill("Peak");
  await dialog(page).getByLabel("Starts: day").fill("20");
  await dialog(page).getByLabel("Starts: month").selectOption("12");
  await dialog(page).getByLabel("Ends: day").fill("31");
  await dialog(page).getByLabel("Ends: month").selectOption("12");
  await dialog(page).getByLabel("Season price Per room").fill("160");
  await dialog(page).getByRole("button", { name: "Save season" }).click();
  await expect(
    main(page)
      .getByRole("button", { name: /^Edit season Peak/ })
      .first(),
  ).toBeVisible();

  await main(page).getByRole("button", { name: "Half board", exact: true }).click();
  await dialog(page).getByLabel("Half board price").fill("25");
  await dialog(page).getByRole("button", { name: "Add option" }).click();
  await expect(
    main(page).getByRole("listitem").filter({ hasText: "Half board €25 per adult" }),
  ).toBeVisible();

  await main(page).getByRole("button", { name: "Edit With breakfast" }).click();
  await dialog(page).getByRole("button", { name: "Delete option" }).click();
  await page.getByRole("button", { name: "Delete option" }).last().click();
  await expect(main(page).getByRole("listitem").filter({ hasText: "With breakfast" })).toHaveCount(
    0,
  );

  await main(page).getByRole("button", { name: "Save prices" }).click();
  await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible();
  expect(pricing.publishes).toHaveLength(1);
  const published = pricing.publishes[0].snapshot.rooms as Room[];
  const deluxe = published.find((value) => value.roomTypeId === DELUXE)!;
  expect(deluxe.offers.map((offer: Room) => offer.id).slice(0, 2)).toEqual([
    "flexible",
    "nonrefundable",
  ]);
  expect(deluxe.offers).toHaveLength(3);
  expect(deluxe.offers[0].price.calendar.weekdays).toEqual([
    { day: 4, adjustment: { kind: "percentage", basisPoints: 1000 } },
    { day: 5, adjustment: { kind: "percentage", basisPoints: 1000 } },
  ]);
  expect(deluxe.offers[0].price.calendar.seasons).toContainEqual({
    name: "Peak",
    tier: "",
    from: "12-20",
    through: "12-31",
    price: flat("16000"),
  });
  expect(deluxe.offers[2]).toMatchObject({
    meal: {
      kind: "half_board",
      charge: { kind: "person", adultMinor: "2500", childBandAmountsMinor: ["0", "0"] },
    },
    price: { kind: "linked", parentId: "flexible", adjustment: { kind: "fixed", deltaMinor: "0" } },
    restrictions: { kind: "inherit" },
  });
  expect(pricing.termsWrites).toEqual([
    expect.objectContaining({
      offerId: deluxe.offers[2].id,
      expectedRevision: null,
      cancellation: flexible,
    }),
  ]);
  // The other room goes out exactly as it was read, at the new revision.
  expect(published.find((value) => value.roomTypeId === GARDEN)).toEqual(complexRoom(4));
  await assertHealthy();
});

test("keeps a setup the steps can't show unchanged through a save", async ({ page }, testInfo) => {
  await openPms(page);
  const pricing = await mockPricing(page, publicationOf(3, [designRoom(3), complexRoom(3)]));
  const assertHealthy = watchPageHealth(page, testInfo);
  await prices(page, GARDEN);
  await expect(main(page).getByRole("button", { name: "Other days…" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    main(page).getByText("1 monthly price · 1 single date · 2 date or season rules"),
  ).toBeVisible();
  await expect(
    main(page).getByRole("listitem").filter({ hasText: "Based on Half board · 8% cheaper" }),
  ).toBeVisible();
  // Typing the same amount differently ("90" for "90.00") is a change React sees, with nothing to publish.
  await main(page).getByLabel("Garden Room Offer 1 1 adult").fill("90");
  await main(page).getByRole("button", { name: "Save prices" }).click();
  await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible();
  const published = pricing.publishes[0].snapshot.rooms as Room[];
  expect(published.find((value) => value.roomTypeId === GARDEN)).toEqual(complexRoom(4));
  expect(published.find((value) => value.roomTypeId === DELUXE)).toEqual(designRoom(4));
  expect(pricing.termsWrites).toHaveLength(0);
  await assertHealthy();
});

test("sets the first prices of an unpriced room as steps, then saves them next to the other rooms", async ({
  page,
}, testInfo) => {
  await openPms(page);
  const pricing = await mockPricing(page, publicationOf(3, [designRoom(3)]));
  const assertHealthy = watchPageHealth(page, testInfo);
  await prices(page, LAKE);
  await expect(main(page).getByText("This room has no prices yet")).toBeVisible();
  await expect(main(page).getByLabel("Room type")).toHaveCount(0);
  await main(page).getByLabel("Room price per night").fill("120");
  await main(page).getByRole("button", { name: "No, non-refundable" }).click();
  await main(page).getByRole("checkbox", { name: "Card online" }).check();
  await main(page).getByLabel("Adult pricing starts at age (1–18)").fill("12");
  await main(page).getByLabel("Price per child per night (0 is allowed)").fill("0");
  await main(page).getByRole("button", { name: "Yes", exact: true }).click();
  await main(page).getByRole("button", { name: "Continue" }).click();
  await expect(
    main(page).getByRole("heading", { name: "What does this room cost per night?" }),
  ).toBeVisible();
  await expect(main(page).getByLabel("Lake Loft Offer 1 Per room")).toHaveValue("120.00");
  await main(page).getByRole("button", { name: "Save prices" }).click();
  await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible();
  const published = pricing.publishes[0].snapshot.rooms as Room[];
  expect(published.map((value) => value.roomTypeId)).toEqual([DELUXE, LAKE]);
  expect(published[1].offers[0].price.calendar.base).toEqual(flat("12000"));
  expect(pricing.termsWrites).toEqual([
    expect.objectContaining({ cancellation: { kind: "non_refundable" } }),
  ]);
  await assertHealthy();
});
