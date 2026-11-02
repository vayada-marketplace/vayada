import type { Page } from "@playwright/test";
import {
  defaultAccountBookingPageSettings,
  type AccountBookingPageUpdate,
} from "@vayada/domain-booking/account-booking-page";
import { corsHeaders, fulfillCorsPreflight } from "./cors";

// VAY-2456/2457: GET/PUT /api/booking/account-booking-page, the agency booking page of the account.
export const ACCOUNT_BOOKING_PAGE_PATH = "/api/booking/account-booking-page";

export type AccountBookingPageMockProperty = {
  propertyId: string;
  name: string;
  propertyType: string | null;
  area: string | null;
  photoUrl: string | null;
  units: number;
  ready: boolean;
  missing: ("setup" | "type" | "location")[];
  included: boolean;
};

export function accountBookingPageSummary(
  accountName: string,
  properties: AccountBookingPageMockProperty[],
  page?: Partial<Omit<AccountBookingPageUpdate, "revision">> & { revision?: number },
) {
  const defaults = defaultAccountBookingPageSettings(accountName);
  const saved = page?.revision !== undefined && page.revision > 0;
  const propertyIds =
    page?.propertyIds ?? properties.filter((p) => p.ready).map((p) => p.propertyId);
  return {
    saved,
    page: {
      slug: page?.slug ?? "the-travel-ubud",
      live: page?.live ?? false,
      revision: page?.revision ?? 0,
      settings: page?.settings ?? defaults,
      propertyIds,
    },
    defaults,
    properties: properties.map((property) => ({
      ...property,
      included: propertyIds.includes(property.propertyId),
    })),
    canSave: properties.length >= 2,
  };
}

/** The default for every Booking Admin spec: a one-property account, so Settings shows no agency page card. */
export async function mockSinglePropertyAccountBookingPage(page: Page): Promise<void> {
  await page.route(`**${ACCOUNT_BOOKING_PAGE_PATH}`, (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    return route.fulfill({
      headers: corsHeaders(route),
      json: accountBookingPageSummary("Alpenrose", [
        {
          propertyId: "f6853000-0000-4000-8000-000000000001",
          name: "Alpenrose",
          propertyType: "hotel",
          area: null,
          photoUrl: null,
          units: 12,
          ready: true,
          missing: [],
          included: false,
        },
      ]),
    });
  });
}
