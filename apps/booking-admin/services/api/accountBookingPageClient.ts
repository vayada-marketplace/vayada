import {
  parseAccountBookingPageSettings,
  parseAccountBookingPageSlug,
  type AccountBookingPageSettings,
  type AccountBookingPageUpdate,
} from "@vayada/domain-booking/account-booking-page";
import type { ApiClient } from "./client";
import { sharedSetupClient } from "./sharedHotelSetupClient";

/** What keeps a stay off the agency page: no booking page guests can see, no property type, no map pin. */
export type AccountBookingPageMissing = "setup" | "type" | "location";

export type AccountBookingPageProperty = {
  propertyId: string;
  name: string;
  propertyType: string | null;
  area: string | null;
  photoUrl: string | null;
  units: number;
  ready: boolean;
  missing: AccountBookingPageMissing[];
  included: boolean;
};

/** GET/PUT /api/booking/account-booking-page (VAY-2456): the selected account's agency booking page. */
export type AccountBookingPageSummary = {
  saved: boolean;
  page: Omit<AccountBookingPageUpdate, "propertyIds"> & { propertyIds: string[] };
  defaults: AccountBookingPageSettings;
  properties: AccountBookingPageProperty[];
  canSave: boolean;
};

type Http = Pick<ApiClient, "get" | "put">;

const PATH = "/api/booking/account-booking-page";
const MISSING = new Set<string>(["setup", "type", "location"]);
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : null);

function parseProperty(v: unknown): AccountBookingPageProperty | null {
  if (
    !record(v) ||
    typeof v.propertyId !== "string" ||
    typeof v.name !== "string" ||
    typeof v.ready !== "boolean" ||
    typeof v.included !== "boolean" ||
    !Array.isArray(v.missing) ||
    !v.missing.every((item) => MISSING.has(item as string))
  )
    return null;
  const photoUrl = text(v.photoUrl);
  return {
    propertyId: v.propertyId,
    name: v.name,
    propertyType: text(v.propertyType),
    area: text(v.area),
    // Only images the browser may load from anywhere.
    photoUrl: photoUrl?.startsWith("https://") ? photoUrl : null,
    units: typeof v.units === "number" && Number.isInteger(v.units) && v.units > 0 ? v.units : 0,
    ready: v.ready,
    missing: v.missing as AccountBookingPageMissing[],
    included: v.included,
  };
}

/** The summary next-api sends, checked with the same rules it saves by. */
export function parseAccountBookingPageSummary(v: unknown): AccountBookingPageSummary | null {
  if (!record(v) || !record(v.page) || typeof v.saved !== "boolean") return null;
  if (typeof v.canSave !== "boolean" || !Array.isArray(v.properties)) return null;
  const { page } = v;
  const settings = parseAccountBookingPageSettings(page.settings);
  const defaults = parseAccountBookingPageSettings(v.defaults);
  const slug = parseAccountBookingPageSlug(page.slug);
  const properties = v.properties.map(parseProperty);
  if (
    !settings ||
    !defaults ||
    !slug ||
    typeof page.live !== "boolean" ||
    typeof page.revision !== "number" ||
    !Array.isArray(page.propertyIds) ||
    !page.propertyIds.every((id) => typeof id === "string") ||
    properties.some((property) => !property)
  )
    return null;
  return {
    saved: v.saved,
    page: {
      slug,
      live: page.live,
      revision: page.revision,
      settings,
      propertyIds: page.propertyIds as string[],
    },
    defaults,
    properties: properties as AccountBookingPageProperty[],
    canSave: v.canSave,
  };
}

export function createAccountBookingPageClient(http: Http) {
  return {
    async load(signal?: AbortSignal): Promise<AccountBookingPageSummary> {
      const summary = parseAccountBookingPageSummary(
        await http.get<unknown>(PATH, { signal, cache: "no-store" }),
      );
      if (!summary) throw new Error("The booking page settings could not be loaded.");
      return summary;
    },
    async save(update: AccountBookingPageUpdate): Promise<AccountBookingPageSummary> {
      const summary = parseAccountBookingPageSummary(await http.put<unknown>(PATH, update));
      if (!summary) throw new Error("The save could not be confirmed. Reload to check the result.");
      return summary;
    },
  };
}

// As Room Sorting's client: it works with either kind of session.
export const accountBookingPageClient = createAccountBookingPageClient(sharedSetupClient);
