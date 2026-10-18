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
    // Bank-transfer and PayPal acceptance is off, as in production today (VAY-2139).
    if (suffix === "/payment-methods" && method === "GET")
      return ok(route, { acceptanceEnabled: false, readyMethods: [] });
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
  // An unpriced room shows the first price ("Set this room's prices", or "Price per night" for one room); a priced one
  // "Prices and seasons" (VAY-2280).
  await expect(
    main(page)
      .getByRole("heading", {
        name: /^Prices and seasons$|^Price per night$|Set this room's prices/,
      })
      .first(),
  ).toBeVisible();
};
// Every option keeps a hidden Edit window mounted; the open window or form is the visible dialog.
const dialog = (page: Page) => page.locator('[role="dialog"]:visible');
/** The card's switch for an extra choice (VAY-2188). */
const extra = (page: Page, name: string) =>
  main(page).getByRole("switch", { name: `Offer “${name}”` });

test("edits a priced room on the simple card and publishes only what changed (VAY-2188)", async ({
  page,
}, testInfo) => {
  await openPms(page);
  const pricing = await mockPricing(page, publicationOf(3, [designRoom(3), complexRoom(3)]));
  const assertHealthy = watchPageHealth(page, testInfo);
  await prices(page, DELUXE);
  for (const heading of ["Prices and seasons", "Rates", "Extra choices for guests"])
    await expect(main(page).getByRole("heading", { name: heading })).toBeVisible();
  // "Prices by date" comes first (VAY-2280), showing the main option's nightly prices.
  const calendar = main(page).getByRole("region", { name: "Prices by date" });
  await expect(calendar).toBeVisible();
  await expect(calendar.getByRole("button", { name: "Show prices for Flexible" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    calendar.getByRole("button", { name: /^\d+ \w+ \d{4}, €\d+/ }).first(),
  ).toBeVisible();
  // The design's options are the card's free cancellation and its two switches, with the engine's normal night.
  await expect(
    main(page).getByRole("button", { name: "Free cancellation", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // Step "Rates" (VAY-2282): the Flexible rate's free cancellation days, the Non-refundable rate beside it.
  await expect(main(page).getByRole("button", { name: "7 days", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(main(page).getByRole("region", { name: "Flexible rate" })).toContainText(
    "Always on",
  );
  // Non-refundable stays are paid in advance; the mock's old "pay at property" shows as not offered (VAY-2282).
  await expect(main(page).getByRole("region", { name: "Non-refundable rate" })).toContainText(
    "Not offered: non-refundable stays are paid in advance",
  );
  await expect(extra(page, "Non-refundable")).toHaveAttribute("aria-checked", "true");
  await expect(main(page).getByLabel("How much cheaper, in percent")).toHaveValue("10");
  await expect(main(page).getByText("€90 a night", { exact: true })).toBeVisible();
  await expect(extra(page, "With breakfast")).toHaveAttribute("aria-checked", "true");
  await expect(main(page).getByText("€115 a night for 2", { exact: true })).toBeVisible();
  await expect(main(page).getByText("Save 10%")).toBeVisible();

  await main(page).getByRole("button", { name: "+10%" }).click();
  await expect(main(page).getByRole("button", { name: "+10%" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await main(page).getByRole("button", { name: "Add a season" }).click();
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

  // Other booking options sit at the bottom of Rates (VAY-2283).
  await main(page).getByRole("button", { name: "Half board", exact: true }).click();
  await dialog(page).getByLabel("Half board price").fill("25");
  await dialog(page).getByRole("button", { name: "Add option" }).click();
  await expect(
    main(page).getByRole("listitem").filter({ hasText: "Half board €25 per adult" }),
  ).toBeVisible();

  // Switching breakfast off asks, then deletes its option.
  await extra(page, "With breakfast").click();
  await page.getByRole("button", { name: "Delete option" }).last().click();
  await expect(extra(page, "With breakfast")).toHaveAttribute("aria-checked", "false");

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

test("closes a night and gives another its own price from the calendar (VAY-2280)", async ({
  page,
}, testInfo) => {
  await openPms(page);
  const pricing = await mockPricing(page, publicationOf(3, [designRoom(3), complexRoom(3)]));
  const assertHealthy = watchPageHealth(page, testInfo);
  await prices(page, DELUXE);
  const calendar = main(page).getByRole("region", { name: "Prices by date" });
  const panel = main(page).getByRole("region", { name: "Picked nights" });
  await expect(panel.getByText("Click a date to change it")).toBeVisible();
  // The 1st of the shown month: close it.
  await calendar.getByRole("button", { name: /^1 \w+ \d{4}, €/ }).click();
  await panel.getByRole("button", { name: "Close this night" }).click();
  await expect(panel.getByRole("button", { name: "Open this night" })).toBeVisible();
  await expect(calendar.getByRole("button", { name: /^1 \w+ \d{4}, €\d+, closed/ })).toBeVisible();
  // The 3rd of July, in the High season: its own price keeps the season's colour and gets the dot (VAY-2284).
  await panel.getByRole("button", { name: "Clear" }).click();
  const months = [
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
  const shown = (await calendar.getByText(/^[A-Z][a-z]+ \d{4}$/).textContent())!.split(" ")[0];
  for (let step = (6 - months.indexOf(shown) + 12) % 12; step > 0; step--)
    await calendar.getByRole("button", { name: "Next month" }).click();
  await expect(calendar.getByText(/^July \d{4}$/)).toBeVisible();
  await expect(calendar.getByRole("button", { name: /^3 July \d{4}, €/ })).toHaveClass(
    /bg-amber-50/,
  );
  await calendar.getByRole("button", { name: /^3 July \d{4}, €/ }).click();
  await panel.getByRole("button", { name: "Own price for this night" }).click();
  await panel.getByLabel("Own price: Per room").fill("130");
  await panel.getByRole("button", { name: "Apply" }).click();
  const owned = calendar.getByRole("button", { name: /^3 July \d{4}, €130, own price/ });
  await expect(owned).toHaveClass(/bg-amber-50/);
  await expect(owned.locator("span.bg-gray-900")).toBeVisible();
  // VAY-2284: picked days can join a season, or start a new one (opened and left here: it depends on the month).
  await panel.getByRole("button", { name: "Add to a season" }).click();
  await expect(panel.getByRole("radio", { name: "New season" })).toBeVisible();
  await panel.getByRole("button", { name: "Cancel" }).click();

  await main(page).getByRole("button", { name: "Save prices" }).click();
  await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible();
  const deluxe = (pricing.publishes[0].snapshot.rooms as Room[]).find(
    (value) => value.roomTypeId === DELUXE,
  )!;
  const [flexibleOffer] = deluxe.offers;
  expect(flexibleOffer.restrictions.dates).toEqual([
    { date: expect.stringMatching(/-01$/), rules: rules(2, { stopSell: true }) },
  ]);
  expect(flexibleOffer.price.calendar.dates).toEqual([
    { date: expect.stringMatching(/-07-03$/), price: flat("13000") },
  ]);
  await assertHealthy();
});

test("edits a season's price in the table and adds dates to a season (VAY-2280)", async ({
  page,
}, testInfo) => {
  await openPms(page);
  const pricing = await mockPricing(page, publicationOf(3, [designRoom(3), complexRoom(3)]));
  const assertHealthy = watchPageHealth(page, testInfo);
  await prices(page, DELUXE);
  const table = main(page).getByRole("table", { name: "Prices and seasons" });
  await expect(table.getByLabel("Deluxe Double Room Offer 1 Per room")).toHaveValue("100.00");
  // A season's price applies when the field is left.
  await table.getByLabel("High price Per room").fill("150");
  await table.getByLabel("High price Per room").press("Enter");
  await expect(table.getByRole("button", { name: /^Edit season High · €150/ })).toBeVisible();
  // "+ Dates" adds another range with the season's name and price.
  await table.getByRole("button", { name: "Add dates to Low" }).click();
  await expect(dialog(page).getByLabel("Season name")).toHaveValue("Low");
  await dialog(page).getByLabel("Starts: day").fill("1");
  await dialog(page).getByLabel("Starts: month").selectOption("11");
  await dialog(page).getByLabel("Ends: day").fill("15");
  await dialog(page).getByLabel("Ends: month").selectOption("11");
  await dialog(page).getByRole("button", { name: "Save season" }).click();
  await expect(
    table.getByRole("button", { name: /^Edit season Low · €80, 1 Nov – 15 Nov/ }),
  ).toBeVisible();
  // A season's minimum stay goes on all its ranges; step 1 closes a period every year (VAY-2280 PR 4).
  await table.getByRole("button", { name: "One night more for Low" }).click();
  await expect(table.getByRole("group", { name: "Low minimum stay" })).toContainText("3 nights");
  const opening = main(page).getByRole("region", { name: "When guests can book" });
  await opening.getByRole("switch", { name: "Open all year" }).click();
  await opening.getByLabel("From: day").fill("16");
  await opening.getByLabel("From: month").selectOption("11");
  await opening.getByLabel("Until: day").fill("30");
  await opening.getByLabel("Until: month").selectOption("11");
  await opening.getByRole("button", { name: "Close these days" }).click();
  await expect(opening.getByText("350 nights a year open, 15 closed")).toBeVisible();

  await main(page).getByRole("button", { name: "Save prices" }).click();
  await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible();
  const deluxe = (pricing.publishes[0].snapshot.rooms as Room[]).find(
    (value) => value.roomTypeId === DELUXE,
  )!;
  expect(deluxe.offers[0].price.calendar.seasons).toEqual([
    { name: "Low", tier: "Low", from: "01-01", through: "03-31", price: flat("8000") },
    { name: "High", tier: "High", from: "07-01", through: "08-31", price: flat("15000") },
    { name: "Low", tier: "Low", from: "11-01", through: "11-15", price: flat("8000") },
  ]);
  expect(deluxe.offers[0].restrictions.seasons).toEqual(
    expect.arrayContaining([
      { from: "01-01", through: "03-31", rules: rules(3) },
      { from: "11-01", through: "11-15", rules: rules(3) },
      { from: "11-16", through: "11-30", rules: rules(2, { stopSell: true }) },
    ]),
  );
  expect(deluxe.offers[0].restrictions.seasons).toHaveLength(3);
  await assertHealthy();
});

test("keeps a setup the simple card can't show unchanged through a save", async ({
  page,
}, testInfo) => {
  await openPms(page);
  const pricing = await mockPricing(page, publicationOf(3, [designRoom(3), complexRoom(3)]));
  const assertHealthy = watchPageHealth(page, testInfo);
  await prices(page, GARDEN);
  await expect(
    main(page).getByText("This room has more settings than the simple view shows.", {
      exact: false,
    }),
  ).toBeVisible();
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

test("sets the first price of an unpriced room with one Save, next to the other rooms (VAY-2188)", async ({
  page,
}, testInfo) => {
  await openPms(page);
  const pricing = await mockPricing(page, publicationOf(3, [designRoom(3)]));
  const assertHealthy = watchPageHealth(page, testInfo);
  await prices(page, LAKE);
  await expect(main(page).getByText("Lake Loft has no price yet", { exact: false })).toBeVisible();
  await expect(main(page).getByLabel("Room type")).toHaveCount(0);
  // Save without a price names what is missing; nothing else needs an answer.
  await main(page).getByRole("button", { name: "Save prices" }).click();
  await expect(
    main(page).getByRole("listitem").filter({ hasText: "Room price per night" }),
  ).toHaveCount(1);
  await expect(main(page).getByLabel("Room price per night")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await main(page).getByLabel("Room price per night").fill("120");
  await main(page).getByRole("button", { name: "Save prices" }).click();
  await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible();
  const published = pricing.publishes[0].snapshot.rooms as Room[];
  expect(published.map((value) => value.roomTypeId)).toEqual([DELUXE, LAKE]);
  expect(published[1].offers).toHaveLength(1);
  expect(published[1].offers[0].price.calendar.base).toEqual(flat("12000"));
  // Children under 12 free, counted toward the room's guests; no minimum stay.
  expect(published[1].children).toEqual({
    adultFromAge: 12,
    bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
  });
  expect(published[1].offers[0].restrictions.rules.minArrivalNights).toBe(1);
  // Free cancellation until 3 days before arrival, paid as Payment settings allow (the shared mock: at the property).
  expect(pricing.termsWrites).toEqual([
    expect.objectContaining({
      cancellation: expect.objectContaining({
        kind: "flexible",
        terms: expect.objectContaining({ freeCancellationDeadlineDays: 3 }),
      }),
      payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
    }),
  ]);
  await assertHealthy();
});

test("adds the switches and a season to a first price before saving it (VAY-2188)", async ({
  page,
}, testInfo) => {
  await openPms(page);
  const pricing = await mockPricing(page, publicationOf(3, [designRoom(3)]));
  const assertHealthy = watchPageHealth(page, testInfo);
  await prices(page, LAKE);
  await main(page).getByLabel("Room price per night").fill("100");
  await extra(page, "Non-refundable").click();
  await extra(page, "With breakfast").click();
  await main(page).getByLabel("Breakfast price").fill("12");
  // "Add a season" adds the prices to the tab, unsaved, and opens the season window.
  await main(page).getByRole("button", { name: "Add a season" }).click();
  await dialog(page).getByLabel("Season name").fill("Peak");
  await dialog(page).getByLabel("Starts: day").fill("20");
  await dialog(page).getByLabel("Starts: month").selectOption("12");
  await dialog(page).getByLabel("Ends: day").fill("31");
  await dialog(page).getByLabel("Ends: month").selectOption("12");
  await dialog(page).getByLabel("Season price Per room").fill("160");
  await dialog(page).getByRole("button", { name: "Save season" }).click();
  await expect(extra(page, "Non-refundable")).toHaveAttribute("aria-checked", "true");
  await expect(extra(page, "With breakfast")).toHaveAttribute("aria-checked", "true");
  await main(page).getByRole("button", { name: "Save prices" }).click();
  await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible();
  const lake = (pricing.publishes[0].snapshot.rooms as Room[]).find(
    (value) => value.roomTypeId === LAKE,
  )!;
  expect(lake.offers).toHaveLength(3);
  expect(lake.offers[0].price.calendar.seasons).toContainEqual(
    expect.objectContaining({ name: "Peak", price: flat("16000") }),
  );
  expect(lake.offers[1]).toMatchObject({
    price: { kind: "linked", adjustment: { kind: "percentage", basisPoints: -1000 } },
  });
  expect(lake.offers[2]).toMatchObject({
    meal: { kind: "breakfast", charge: { kind: "person", adultMinor: "1200" } },
  });
  expect(pricing.termsWrites.map((write) => write.cancellation.kind)).toEqual([
    "flexible",
    "non_refundable",
    "flexible",
  ]);
  await assertHealthy();
});

test("shows one stale-prices warning, a plain Price-free main window and a retry when rooms can't be read (VAY-2157)", async ({
  page,
}) => {
  // No page-health watch: the failed room read (500) is the point of this test.
  await openPms(page);
  await mockPricing(page, { ...publicationOf(3, [designRoom(3)]), stale: true });
  let failing = true;
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`, (route) =>
    failing
      ? route.fulfill({ status: 500, json: { message: "Internal Server Error" } })
      : route.fallback(),
  );
  await page.goto(`/rooms/${DELUXE}?tab=prices`);
  await expect(
    main(page).getByText("Prices couldn't be loaded right now. Try again in a moment."),
  ).toBeVisible();
  await expect(main(page).getByText("Internal Server Error")).toHaveCount(0);
  failing = false;
  await main(page).getByRole("button", { name: "Retry" }).click();
  await expect(
    main(page).getByRole("heading", { name: "Prices and seasons", exact: true }),
  ).toBeVisible();
  // The room page's banner, with its "Save prices again", is the only warning.
  await expect(main(page).getByRole("button", { name: "Save prices again" })).toBeVisible();
  await expect(main(page).getByText("Prices need to be saved again")).toHaveCount(1);
  // The main option's price is the card's: its window has no empty "Price" group.
  await main(page).getByRole("button", { name: "Edit what the price includes" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Meals" })).toBeVisible();
  await expect(dialog(page).getByRole("heading", { name: "Price", exact: true })).toHaveCount(0);
});

test("shows the whole year and closes dates picked in the Year view (VAY-2284)", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPms(page);
  const pricing = await mockPricing(page, publicationOf(3, [designRoom(3), complexRoom(3)]));
  const assertHealthy = watchPageHealth(page, testInfo);
  await prices(page, DELUXE);
  const calendar = main(page).getByRole("region", { name: "Prices by date" });
  const toggle = calendar.getByRole("group", { name: "Calendar view" });
  await toggle.getByRole("button", { name: "Year" }).click();
  await expect(toggle.getByRole("button", { name: "Year" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Next year, so every date is still ahead.
  const title = calendar.locator('[aria-live="polite"]');
  await expect(title).toHaveText(/^\d{4}$/);
  const year = String(Number(await title.textContent()) + 1);
  await calendar.getByRole("button", { name: "Next year" }).click();
  await expect(title).toHaveText(year);
  const months = calendar.getByRole("group", { name: new RegExp(`^\\w+ ${year}$`) });
  await expect(months).toHaveCount(12);
  // Each month's lowest and highest price: Low season €80 and €100 standard, Fri & Sat +15%; High season €140.
  await expect(months.nth(0)).toContainText("€80 to €92");
  await expect(months.nth(3)).toContainText("€100 to €115");
  await expect(months.nth(6)).toContainText("€140 to €161");
  // Four months in a row at 1440px (the approved board), inside the card.
  const tops = await months.evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
  );
  expect(new Set(tops.slice(0, 4)).size).toBe(1);
  expect(tops[4]).toBeGreaterThan(tops[0]);
  expect(await calendar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);

  // Click a date, then a second one: the side panel closes everything in between.
  await calendar.getByRole("button", { name: new RegExp(`^10 March ${year}, €`) }).click();
  await calendar.getByRole("button", { name: new RegExp(`^12 March ${year}, €`) }).click();
  const panel = main(page).getByRole("region", { name: "Picked nights" });
  await expect(panel.getByText("3 nights selected")).toBeVisible();
  await panel.getByRole("button", { name: "Close these nights" }).click();
  for (const day of [10, 11, 12])
    await expect(
      calendar.getByRole("button", { name: new RegExp(`^${day} March ${year}, €\\d+, closed`) }),
    ).toHaveAttribute("aria-pressed", "true");
  await expect(calendar.getByText("Closed on this date")).toBeVisible();
  await main(page).getByRole("button", { name: "Save prices" }).click();
  await expect(main(page).getByText("Prices saved.", { exact: false })).toBeVisible();
  const deluxe = (pricing.publishes[0].snapshot.rooms as Room[]).find(
    (value) => value.roomTypeId === DELUXE,
  )!;
  expect(deluxe.offers[0].restrictions.dates).toEqual(
    [10, 11, 12].map((day) => ({
      date: `${year}-03-${day}`,
      rules: rules(2, { stopSell: true }),
    })),
  );

  // Phones get the month view only (the approved 390px board): the toggle hides and the picked month shows.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(toggle).toBeHidden();
  await expect(title).toHaveText(`March ${year}`);
  await expect(months).toHaveCount(0);
  for (const element of [calendar, main(page)])
    expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await assertHealthy();
});
