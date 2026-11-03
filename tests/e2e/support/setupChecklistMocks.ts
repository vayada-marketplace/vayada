import { buildHotelGoLiveChecklist, type HotelGoLiveChecklistFacts } from "@vayada/domain-hotels";
import type { Page, Route } from "@playwright/test";

/**
 * VAY-2451: a hotel that finished the four-step setup with a priced, photographed room. Three of six are
 * done: the booking rules are still the defaults, the property photos and publishing are left.
 */
export function goLiveChecklistFacts(propertyId: string): HotelGoLiveChecklistFacts {
  return {
    propertyId,
    propertyDetails: true,
    setupFinished: true,
    roomTypes: [{ name: "Classic Double", rooms: 2, maxGuests: 2, photos: 1, priced: true }],
    placeholderPrices: false,
    bookingRules: "default",
    propertyPhotos: false,
    bookingPublished: false,
    onlineCardReady: false,
    onlineCardsOffered: false,
    viewer: { hidden: false, dismissed: false },
  };
}

const CHECKLIST_API = /\/api\/hotel-setup\/properties\/[^/]+\/checklist(\/v2)?(\/[a-z]+)?$/;
/** The go-live list both dashboards read. */
const GO_LIVE_PATH = /\/checklist\/v2(\/[a-z]+)?$/;

/**
 * The checklist API as production has it while the server's first run is off: not mounted (404). The
 * dashboards then keep what they show today. Specs that show the cards register `mockSetupChecklist`.
 */
export async function mockSetupChecklistUnavailable(page: Page): Promise<void> {
  await page.route(CHECKLIST_API, (route) => {
    const headers = corsHeaders(route);
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    return route.fulfill({ status: 404, headers, json: { error: "Not Found" } });
  });
}

export type SetupChecklistWrite = { method: string; path: string; body: unknown };

/**
 * VAY-2247 wave 2, VAY-2451: answers the go-live checklist API (GET, Review booking rules, Dismiss) from
 * `facts`, keeping each write, as the server would. The dashboards call it cross-origin, so preflights are
 * answered too. The first checklist (no /v2) isn't read by the dashboards any more: it answers 404.
 */
export async function mockSetupChecklist(
  page: Page,
  facts: HotelGoLiveChecklistFacts,
): Promise<SetupChecklistWrite[]> {
  const writes: SetupChecklistWrite[] = [];
  let current = facts;
  await page.route(CHECKLIST_API, (route) => {
    const request = route.request();
    const headers = corsHeaders(route);
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const path = new URL(request.url()).pathname;
    if (!GO_LIVE_PATH.test(path))
      return route.fulfill({ status: 404, headers, json: { error: "Not Found" } });
    if (request.method() !== "GET") {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method: request.method(), path, body });
      if (path.endsWith("/acknowledgements") && body["item"] === "guest_terms") {
        current = { ...current, bookingRules: "acknowledged" };
      } else if (path.endsWith("/viewer")) {
        current = { ...current, viewer: { ...current.viewer, ...body } };
      }
    }
    return route.fulfill({ headers, json: buildHotelGoLiveChecklist(current) });
  });
  return writes;
}

function corsHeaders(route: Route) {
  return {
    "Access-Control-Allow-Origin": route.request().headers()["origin"] ?? "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Credentials": "true",
  };
}
