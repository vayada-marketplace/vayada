import {
  CURRENT_HOTEL_ACCOUNT_AGREEMENTS,
  type HotelAccountAgreementsStatus,
} from "@vayada/domain-hotels";
import type { Page, Route } from "@playwright/test";

const AGREEMENTS_API = /\/api\/hotel-account\/agreements(\/accept)?$/;

export const ACCEPTED_HOTEL_ACCOUNT_AGREEMENTS: HotelAccountAgreementsStatus["accepted"] = {
  ...CURRENT_HOTEL_ACCOUNT_AGREEMENTS,
  acceptedAt: "2026-10-24T09:00:00.000Z",
  acceptedBy: { name: "Anna Keller", email: "anna@alpenrose-hotels.example" },
  source: "signup",
};

/** VAY-2246: a hotel account that accepted the current terms and DPA at sign-up; nobody sees the banner. */
export function acceptedAgreementsStatus(
  overrides: Partial<HotelAccountAgreementsStatus> = {},
): HotelAccountAgreementsStatus {
  return {
    current: { ...CURRENT_HOTEL_ACCOUNT_AGREEMENTS },
    accepted: ACCEPTED_HOTEL_ACCOUNT_AGREEMENTS,
    canAccept: true,
    accountName: "Alpenrose Hotels",
    ...overrides,
  };
}

export type AgreementsWrite = { path: string; body: unknown };

/**
 * Answers GET /api/hotel-account/agreements from `status` and records each accept, as the server would:
 * the account admin's accept stores their acceptance of the current versions. The apps call it
 * cross-origin, so preflights are answered too. The shell mocks register an accepted account; specs
 * that show the banner or the card register their own state after them.
 */
export async function mockHotelAccountAgreements(
  page: Page,
  status: HotelAccountAgreementsStatus = acceptedAgreementsStatus(),
): Promise<AgreementsWrite[]> {
  const writes: AgreementsWrite[] = [];
  let current = status;
  await page.route(AGREEMENTS_API, (route) => {
    const request = route.request();
    const headers = corsHeaders(route);
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      writes.push({ path, body: request.postDataJSON() });
      current = {
        ...current,
        accepted: {
          ...CURRENT_HOTEL_ACCOUNT_AGREEMENTS,
          acceptedAt: "2026-10-24T10:30:00.000Z",
          acceptedBy: { name: "Booking Owner", email: "owner@example.com" },
          source: "account_admin",
        },
      };
    }
    return route.fulfill({ headers, json: current });
  });
  return writes;
}

function corsHeaders(route: Route) {
  return {
    "Access-Control-Allow-Origin": route.request().headers()["origin"] ?? "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Credentials": "true",
  };
}
