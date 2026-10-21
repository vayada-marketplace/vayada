import { buildHotelSetupChecklist, type HotelSetupChecklistFacts } from "@vayada/domain-hotels";
import type { Page, Route } from "@playwright/test";

/** A live hotel four of nine in: setup's four done, the five improvements left (Paper rev 4 c01-1). */
export function liveChecklistFacts(propertyId: string): HotelSetupChecklistFacts {
  return {
    propertyId,
    nextSetupStep: null,
    hotelBasics: true,
    firstRoom: true,
    guestPayment: true,
    bookingPublished: true,
    photos: false,
    style: false,
    calendar: "default",
    guestTerms: "default",
    onlineCardReady: false,
    onlineCardsOffered: false,
    viewer: { hidden: false, dismissed: false },
  };
}

const CHECKLIST_API = /\/api\/hotel-setup\/properties\/[^/]+\/checklist(\/[a-z]+)?$/;

/**
 * The checklist API as production has it while the server's first run is off: not mounted (404). The
 * dashboards then keep what they show today. Specs that show the checklist register `mockSetupChecklist`.
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
 * VAY-2247 wave 2: answers the setup checklist API (GET, Looks good, Hide for now) from `facts`, keeping
 * each write, as the server would. The dashboards call it cross-origin, so preflights are answered too.
 */
export async function mockSetupChecklist(
  page: Page,
  facts: HotelSetupChecklistFacts,
): Promise<SetupChecklistWrite[]> {
  const writes: SetupChecklistWrite[] = [];
  let current = facts;
  await page.route(CHECKLIST_API, (route) => {
    const request = route.request();
    const headers = corsHeaders(route);
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method: request.method(), path, body });
      if (path.endsWith("/acknowledgements")) {
        current = {
          ...current,
          [body["item"] === "calendar" ? "calendar" : "guestTerms"]: "acknowledged",
        };
      } else if (path.endsWith("/viewer")) {
        current = { ...current, viewer: { ...current.viewer, ...body } };
      }
    }
    return route.fulfill({ headers, json: buildHotelSetupChecklist(current) });
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
