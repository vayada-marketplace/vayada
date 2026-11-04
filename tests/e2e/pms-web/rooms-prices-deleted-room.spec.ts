import { expect, test, type Page, type Route } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

// VAY-2471: a room type deleted after its prices were published stays in that publication. The server leaves it out
// of the Prices read, and answers a save that still has it with 409 "reload" instead of 403 "no access". Here the
// room is deleted while the Prices tab is open: the page must say to reload, keep the edit, and then save.
const SUITE = "aaaaaaaa-0000-4000-8000-00000000000a";
const GARDEN = "bbbbbbbb-0000-4000-8000-00000000000b";
const TERMS = "66666666-6666-4666-8666-666666666666";
const token = (digit: string) => digit.repeat(64);
const sources = {
  room: `pms.pricing.rooms.v2:${token("3")}`,
  terms: `booking.pricing.terms.v2:${token("4")}`,
  finance: `finance.pricing.source.v2:${token("5")}`,
};
const suite = { ...pmsWebRoomType, roomTypeId: SUITE, name: "Alpine Suite" };

const pricedRoom = (roomTypeId: string, amountMinor: string) => ({
  version: "pricing.v2",
  propertyId: PMS_WEB_PROPERTY_ID,
  roomTypeId,
  revision: 3,
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

/** Pricing as the server answers it after VAY-2471, with Garden Room deleted once the tab has loaded. */
async function mockPricing(page: Page) {
  const state = {
    gardenDeleted: false,
    prepares: [] as Record<string, any>[],
    publishes: [] as Record<string, any>[],
    draft: null as Record<string, any> | null,
  };
  const ok = (route: Route, json: unknown) => route.fulfill({ json });
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-v2**`, async (route) => {
    const request = route.request();
    const method = request.method();
    const suffix = new URL(request.url()).pathname.split("/pricing-v2")[1] ?? "";
    const body = (method === "GET" ? {} : request.postDataJSON()) as Record<string, any>;
    if (suffix === "/payment-methods")
      return ok(route, { acceptanceEnabled: false, readyMethods: [] });
    if (suffix === "/card-readiness")
      return ok(route, {
        card: { ready: false, reason: "switch_off", charge: "at_booking" },
        deposits: { ready: false },
      });
    if (suffix === "/not-selling")
      return ok(route, {
        version: "pricing-rates-not-selling.v1",
        publishedRevision: 3,
        rates: [],
      });
    if (suffix === "/guest-display-rate") return ok(route, { guestDisplay: null });
    if (suffix === "" && method === "GET") {
      // The read leaves a deleted room out of the published prices.
      const rooms = [
        pricedRoom(SUITE, "12000"),
        ...(state.gardenDeleted ? [] : [pricedRoom(GARDEN, "9000")]),
      ];
      return ok(route, {
        currency: "EUR",
        revision: 3,
        stale: false,
        sources,
        ownerReferences: { finance: `finance.pricing.v2:${token("1")}` },
        rooms,
      });
    }
    const terms = suffix.match(/\/rooms\/([^/]+)\/offers\/([^/]+)\/terms$/);
    if (terms && method === "GET")
      return ok(route, {
        roomTypeId: terms[1],
        offerId: decodeURIComponent(terms[2]!),
        revision: TERMS,
        cancellation: { kind: "non_refundable" },
        payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
      });
    if (suffix === "/prepare" && method === "POST") {
      state.prepares.push(body);
      // A copy that still has the deleted room no longer matches: changed, reload.
      if (
        state.gardenDeleted &&
        body.rooms.some((room: { roomTypeId: string }) => room.roomTypeId === GARDEN)
      )
        return route.fulfill({ status: 409, json: { code: "stale", reason: "room_unavailable" } });
      // The page prepares with a draft context, so it expects the draft-projected terms sources too.
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
    if (/^\/drafts\/[^/]+\/charge-review$/.test(suffix) && state.draft) {
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
      state.publishes.push(body);
      return ok(route, { revision: 4, replayed: false });
    }
    return route.fulfill({ status: 501, json: { code: "unexpected", method, suffix } });
  });
  return state;
}

async function openSuitePrices(page: Page) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: [suite],
        sourceFreshness: {},
      },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${SUITE}`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        item: suite,
        sourceFreshness: {},
      },
    }),
  );
  const pricing = await mockPricing(page);
  await page.goto(`/rooms/${SUITE}?tab=prices`);
  await expect(page.locator("main").getByLabel("Alpine Suite Offer 1 Per room")).toHaveValue(
    "120.00",
  );
  return pricing;
}

// No page-health watch: the refused prepare (409) is the point of this test and logs to the console.
test("a room deleted meanwhile: the page says reload, keeps the edit and saves without that room", async ({
  page,
}) => {
  const pricing = await openSuitePrices(page);
  const main = page.locator("main");
  await main.getByLabel("Alpine Suite Offer 1 Per room").fill("135.50");
  pricing.gardenDeleted = true;
  await main.getByRole("button", { name: "Save and publish" }).click();

  const alert = main.getByRole("alert").first();
  await expect(alert).toContainText("Pricing or its settings changed. Reload pricing");
  await expect(alert).toContainText("Your changes to this room are kept");
  await expect(alert).not.toContainText("do not have access");
  expect(pricing.prepares).toHaveLength(1);
  expect(pricing.publishes).toHaveLength(0);

  await main.getByRole("button", { name: "Reload pricing" }).click();
  await expect(main.getByLabel("Alpine Suite Offer 1 Per room")).toHaveValue("135.50");
  await expect(main.getByRole("button", { name: "Save and publish" })).toBeEnabled();
  await main.getByRole("button", { name: "Save and publish" }).click();
  await expect(main.getByText("Prices saved.", { exact: false })).toBeVisible();

  expect(pricing.publishes).toHaveLength(1);
  const published = pricing.publishes[0]!.snapshot.rooms as {
    roomTypeId: string;
    offers: unknown[];
  }[];
  expect(published.map((room) => room.roomTypeId)).toEqual([SUITE]);
  expect(published[0]).toMatchObject({
    revision: 4,
    offers: [{ price: { calendar: { base: { amountMinor: "13550" } } } }],
  });
});
