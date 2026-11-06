import {
  parseAccountBookingPageSlug,
  type AccountBookingPageFilter,
  type AccountBookingPageSettings,
} from "@vayada/domain-booking/account-booking-page";
import type {
  AccountBookingPageHeaderImage,
  AccountBookingPageProperty,
  AccountBookingPageSummary,
} from "@/services/api/accountBookingPageClient";

/** The page as the form edits it (VAY-2457). */
export type AccountBookingPageDraft = {
  slug: string;
  live: boolean;
  settings: AccountBookingPageSettings;
  propertyIds: string[];
  headerImage: AccountBookingPageHeaderImage | null;
};

export type PropertyStatus =
  | "live"
  | "hidden"
  | "notSetUp"
  | "noType"
  | "noLocation"
  | "noTypeNoLocation";

/** The pill next to a stay: what's missing while it isn't ready, else whether the page shows it. */
export function propertyStatus(
  property: Pick<AccountBookingPageProperty, "ready" | "missing">,
  included: boolean,
): PropertyStatus {
  if (property.ready) return included ? "live" : "hidden";
  if (property.missing.includes("setup")) return "notSetUp";
  const type = property.missing.includes("type");
  const location = property.missing.includes("location");
  return type && location ? "noTypeNoLocation" : type ? "noType" : "noLocation";
}

/** What guests find at the page's address now (VAY-2483), from the saved page: live with a stay to
 * book, live with none ready (its address says "not online"), or off. While it isn't live, the
 * form's switch tells whether a save puts it online. */
export type PageStatus = "live" | "noReadyStay" | "liveOnSave" | "off";

export function pageStatus(
  summary: {
    saved: boolean;
    page: Pick<AccountBookingPageSummary["page"], "live">;
    properties: readonly Pick<AccountBookingPageProperty, "included" | "ready">[];
  },
  draftLive: boolean,
): PageStatus {
  if (summary.saved && summary.page.live)
    return summary.properties.some((property) => property.included && property.ready)
      ? "live"
      : "noReadyStay";
  return draftLive ? "liveOnSave" : "off";
}

/** Includes a stay at the end of the order, or leaves it out. The design can only be copied from an
 * included stay, so leaving that one out resets the design to the first included stay. */
export function setIncluded(
  draft: AccountBookingPageDraft,
  propertyId: string,
  included: boolean,
): AccountBookingPageDraft {
  const without = draft.propertyIds.filter((id) => id !== propertyId);
  const propertyIds = included ? [...without, propertyId] : without;
  const header = draft.settings.header;
  return {
    ...draft,
    propertyIds,
    settings:
      !included && header.designPropertyId === propertyId
        ? { ...draft.settings, header: { ...header, designPropertyId: null } }
        : draft.settings,
  };
}

/** Every ready stay not yet included joins at the end, in the list's order. */
export function includeAllReady(
  draft: AccountBookingPageDraft,
  properties: readonly AccountBookingPageProperty[],
): AccountBookingPageDraft {
  const added = properties
    .filter((property) => property.ready && !draft.propertyIds.includes(property.propertyId))
    .map((property) => property.propertyId);
  return added.length ? { ...draft, propertyIds: [...draft.propertyIds, ...added] } : draft;
}

/** Moves an included stay to position `to` of the "Recommended" order. */
export function moveIncluded(ids: readonly string[], propertyId: string, to: number): string[] {
  const from = ids.indexOf(propertyId);
  if (from < 0 || to < 0 || to >= ids.length || from === to) return [...ids];
  const next = ids.filter((id) => id !== propertyId);
  next.splice(to, 0, propertyId);
  return next;
}

/** The stays in the list's order: included ones first in their order, then the rest by name. */
export function orderedProperties(
  properties: readonly AccountBookingPageProperty[],
  propertyIds: readonly string[],
): AccountBookingPageProperty[] {
  const byId = new Map(properties.map((property) => [property.propertyId, property]));
  const included = propertyIds.flatMap((id) => byId.get(id) ?? []);
  return [...included, ...properties.filter((p) => !propertyIds.includes(p.propertyId))];
}

/**
 * Whether a switched-on filter can split the included stays. Type and area are known here; the
 * others depend on prices, rooms and rates the guest page reads, so they show while switched on.
 * `values` lists the types or areas guests could pick from.
 */
export function filterSplit(
  filter: AccountBookingPageFilter,
  included: readonly AccountBookingPageProperty[],
): { splits: boolean; values: string[] } {
  const pick =
    filter === "propertyType"
      ? (property: AccountBookingPageProperty) => property.propertyType
      : filter === "area"
        ? (property: AccountBookingPageProperty) => property.area?.trim() || null
        : null;
  if (!pick) return { splits: true, values: [] };
  const values = Array.from(
    new Set(included.map(pick).filter((value): value is string => !!value)),
  );
  return { splits: values.length > 1, values };
}

export type DraftProblem =
  | "titleRequired"
  | "titleTooLong"
  | "descriptionTooLong"
  | "invalidSlug"
  | "contactNeeded"
  | "invalidEmail"
  | "invalidWhatsapp";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WHATSAPP = /^\+[1-9][0-9]{7,14}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

export const validEmail = (value: string | null) =>
  value !== null && value.length <= 254 && EMAIL.test(value);
export const validWhatsapp = (value: string | null) => value !== null && WHATSAPP.test(value);

/** Page title and description are one line: tabs, line breaks and other control characters become
 * a space, as next-api refuses them. */
export const controlFree = (value: string) => value.replace(CONTROL_CHARACTERS, " ");

/** What would stop next-api from saving the draft, field by field (the same rules it checks). */
export function draftProblems(draft: AccountBookingPageDraft): Set<DraftProblem> {
  const problems = new Set<DraftProblem>();
  const { page, header } = draft.settings;
  const title = page.title.trim();
  if (!title) problems.add("titleRequired");
  if (title.length > 100) problems.add("titleTooLong");
  if (page.description.trim().length > 300) problems.add("descriptionTooLong");
  if (!parseAccountBookingPageSlug(draft.slug)) problems.add("invalidSlug");
  if (header.contactEmail !== null && !validEmail(header.contactEmail))
    problems.add("invalidEmail");
  if (header.contactWhatsapp !== null && !validWhatsapp(header.contactWhatsapp))
    problems.add("invalidWhatsapp");
  if (header.contact && !header.contactEmail && !header.contactWhatsapp)
    problems.add("contactNeeded");
  return problems;
}

/** A typed email or phone number as the draft keeps it: trimmed, spaces out of numbers, empty is none. */
export function contactValue(value: string, kind: "email" | "whatsapp"): string | null {
  const trimmed = kind === "whatsapp" ? value.replace(/[\s()-]/g, "") : value.trim();
  return trimmed ? trimmed : null;
}
