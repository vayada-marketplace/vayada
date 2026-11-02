/**
 * The agency booking page (VAY-2450, VAY-2456): one public booking page per account that lists the
 * account's stays. These are its settings as Booking Admin saves them, sections C1–C7 of VAY-2450 (the
 * address slug, the Live switch and the included properties are stored beside them). Browser-safe:
 * Booking Admin and booking-web import it as `@vayada/domain-booking/account-booking-page`.
 *
 * Saves are checked strictly (`parseAccountBookingPageUpdate`). A stored value is read leniently
 * (`readAccountBookingPageSettings`): unknown keys are dropped and a missing or broken field falls back
 * to its default, so a later shape or a rollback keeps what the account chose.
 */

export const ACCOUNT_BOOKING_PAGE_LAYOUTS = ["list", "split", "map"] as const;
export const ACCOUNT_BOOKING_PAGE_SORTS = ["price_low", "recommended", "price_high"] as const;
export const ACCOUNT_BOOKING_PAGE_FILTERS = [
  "propertyType",
  "area",
  "price",
  "privatePool",
  "breakfast",
  "freeCancellation",
  "bedrooms",
] as const;
/** Host labels a booking address can never take (the same as for hotel addresses). */
export const ACCOUNT_BOOKING_PAGE_RESERVED_SLUGS = Object.freeze(["www", "booking"] as const);
export const ACCOUNT_BOOKING_PAGE_MAX_PROPERTIES = 200;
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 300;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WHATSAPP_PATTERN = /^\+[1-9][0-9]{7,14}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001f\u007f]+/g;

export type AccountBookingPageLayout = (typeof ACCOUNT_BOOKING_PAGE_LAYOUTS)[number];
export type AccountBookingPageSort = (typeof ACCOUNT_BOOKING_PAGE_SORTS)[number];
export type AccountBookingPageFilter = (typeof ACCOUNT_BOOKING_PAGE_FILTERS)[number];

export type AccountBookingPageSettings = {
  /** C1: the big headline on the header image and the line under it (also the page's meta description). */
  page: { title: string; description: string };
  /** C2: the top of the page, which stands for the whole agency. */
  header: {
    /** What sits top left. The guest page shows the account name while the account has no logo. */
    topLeft: "name" | "logo";
    /** Colours and fonts are copied from this included property's booking page; null: the first
     * included one. (The header image arrives with its upload, VAY-2457.) */
    designPropertyId: string | null;
    gallery: boolean;
    contact: boolean;
    language: boolean;
    currency: boolean;
    contactEmail: string | null;
    contactWhatsapp: string | null;
  };
  /** C4: the layouts guests can switch between (List always) and the one they see first. */
  layout: { allowed: AccountBookingPageLayout[]; default: AccountBookingPageLayout };
  /** C5 */
  results: {
    defaultSort: AccountBookingPageSort;
    lowestPriceBadge: boolean;
    showFullStays: boolean;
  };
  /** C6: which filter chips guests may see. A chip still hides itself when it would not split the stays. */
  filters: Record<AccountBookingPageFilter, boolean>;
  /** C7 */
  stayPage: { nearby: boolean; map: boolean };
};

/** A save from Booking Admin. `revision` is the one the member edited; 0 creates the page. */
export type AccountBookingPageUpdate = {
  revision: number;
  slug: string;
  live: boolean;
  settings: AccountBookingPageSettings;
  /** Included properties in their "Recommended" order (C3). */
  propertyIds: string[];
};

/** The defaults Timo's mockup starts from: every layout with List first, lowest price first, the badge,
 * full stays at the end, and the type, price, pool and breakfast filters. Contact stays off until the
 * account gives an email address or a WhatsApp number. */
export function defaultAccountBookingPageSettings(accountName: string): AccountBookingPageSettings {
  return {
    page: { title: defaultTitle(accountName), description: "" },
    header: {
      topLeft: "name",
      designPropertyId: null,
      gallery: true,
      contact: false,
      language: true,
      currency: true,
      contactEmail: null,
      contactWhatsapp: null,
    },
    layout: { allowed: [...ACCOUNT_BOOKING_PAGE_LAYOUTS], default: "list" },
    results: { defaultSort: "price_low", lowestPriceBadge: true, showFullStays: true },
    filters: {
      propertyType: true,
      area: false,
      price: true,
      privatePool: true,
      breakfast: true,
      freeCancellation: false,
      bedrooms: false,
    },
    stayPage: { nearby: true, map: true },
  };
}

/** A booking address label: lowercase letters and digits in hyphen-separated words, at most 63
 * characters, never a reserved host label. Null when it isn't one. */
export function parseAccountBookingPageSlug(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= 63 &&
    SLUG_PATTERN.test(value) &&
    !(ACCOUNT_BOOKING_PAGE_RESERVED_SLUGS as readonly string[]).includes(value)
    ? value
    : null;
}

/** A first address to offer, made from the account's name ("The Travel Ubud" → "the-travel-ubud"). */
export function suggestAccountBookingPageSlug(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 63) break;
    slug = next;
  }
  return parseAccountBookingPageSlug(slug) ?? "stays";
}

/** Checks a save strictly: exact keys everywhere, valid values, no duplicate properties. */
export function parseAccountBookingPageUpdate(value: unknown): AccountBookingPageUpdate | null {
  if (!exactRecord(value, ["revision", "slug", "live", "settings", "propertyIds"])) return null;
  const { revision, live } = value;
  const slug = parseAccountBookingPageSlug(value["slug"]);
  const settings = parseAccountBookingPageSettings(value["settings"]);
  const propertyIds = parsePropertyIds(value["propertyIds"]);
  if (
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 0 ||
    revision > 2147483647 ||
    typeof live !== "boolean" ||
    !slug ||
    !settings ||
    !propertyIds
  )
    return null;
  return { revision, slug, live, settings, propertyIds };
}

/** Strict check of the settings object alone. */
export function parseAccountBookingPageSettings(value: unknown): AccountBookingPageSettings | null {
  if (!exactRecord(value, ["page", "header", "layout", "results", "filters", "stayPage"]))
    return null;
  const page = value["page"];
  const header = value["header"];
  const layout = value["layout"];
  const results = value["results"];
  const filters = value["filters"];
  const stayPage = value["stayPage"];
  if (
    !exactRecord(page, ["title", "description"]) ||
    !exactRecord(header, HEADER_KEYS) ||
    !exactRecord(layout, ["allowed", "default"]) ||
    !exactRecord(results, ["defaultSort", "lowestPriceBadge", "showFullStays"]) ||
    !exactRecord(filters, ACCOUNT_BOOKING_PAGE_FILTERS) ||
    !exactRecord(stayPage, ["nearby", "map"])
  )
    return null;
  const title = field.title(page["title"]);
  const description = field.description(page["description"]);
  const headerValue = readHeader(header, null);
  const allowed = field.layouts(layout["allowed"]);
  const defaultLayout = field.layout(layout["default"]);
  const defaultSort = field.sort(results["defaultSort"]);
  const resultsValue = booleans(results, ["lowestPriceBadge", "showFullStays"] as const, null);
  const filtersValue = booleans(filters, ACCOUNT_BOOKING_PAGE_FILTERS, null);
  const stayValue = booleans(stayPage, ["nearby", "map"] as const, null);
  if (
    title === undefined ||
    description === undefined ||
    !headerValue ||
    !allowed ||
    !defaultLayout ||
    !allowed.includes(defaultLayout) ||
    !defaultSort ||
    !resultsValue ||
    !filtersValue ||
    !stayValue ||
    (headerValue.contact && !headerValue.contactEmail && !headerValue.contactWhatsapp)
  )
    return null;
  return {
    page: { title, description },
    header: headerValue,
    layout: { allowed, default: defaultLayout },
    results: { defaultSort, ...resultsValue },
    filters: filtersValue,
    stayPage: stayValue,
  };
}

/** Reads a stored settings value leniently onto `defaults`; never fails. */
export function readAccountBookingPageSettings(
  stored: unknown,
  defaults: AccountBookingPageSettings,
): AccountBookingPageSettings {
  const section = (key: string) => {
    const value = isRecord(stored) ? stored[key] : undefined;
    return isRecord(value) ? value : {};
  };
  const page = section("page");
  const layout = section("layout");
  const results = section("results");
  const allowed = field.layouts(layout["allowed"]) ?? [...defaults.layout.allowed];
  const preferred = field.layout(layout["default"]) ?? defaults.layout.default;
  const header = readHeader(section("header"), defaults.header)!;
  return {
    page: {
      title: field.title(page["title"]) ?? defaults.page.title,
      description: field.description(page["description"]) ?? defaults.page.description,
    },
    header: {
      ...header,
      contact: header.contact && Boolean(header.contactEmail || header.contactWhatsapp),
    },
    layout: { allowed, default: allowed.includes(preferred) ? preferred : "list" },
    results: {
      defaultSort: field.sort(results["defaultSort"]) ?? defaults.results.defaultSort,
      ...booleans(results, ["lowestPriceBadge", "showFullStays"] as const, defaults.results)!,
    },
    filters: booleans(section("filters"), ACCOUNT_BOOKING_PAGE_FILTERS, defaults.filters)!,
    stayPage: booleans(section("stayPage"), ["nearby", "map"] as const, defaults.stayPage)!,
  };
}

const HEADER_KEYS = [
  "topLeft",
  "designPropertyId",
  "gallery",
  "contact",
  "language",
  "currency",
  "contactEmail",
  "contactWhatsapp",
] as const;

/** Each reader returns undefined for a value it doesn't accept. */
const field = {
  title: (value: unknown) => {
    const text = cleanText(value, TITLE_MAX);
    return text ? text : undefined;
  },
  description: (value: unknown) => cleanText(value, DESCRIPTION_MAX),
  topLeft: (value: unknown) => (value === "name" || value === "logo" ? value : undefined),
  propertyId: (value: unknown) => (value === null ? null : uuid(value)),
  email: (value: unknown) =>
    value === null
      ? null
      : typeof value === "string" && value.length <= 254 && EMAIL_PATTERN.test(value)
        ? value
        : undefined,
  whatsapp: (value: unknown) =>
    value === null
      ? null
      : typeof value === "string" && WHATSAPP_PATTERN.test(value)
        ? value
        : undefined,
  layout: (value: unknown) => ACCOUNT_BOOKING_PAGE_LAYOUTS.find((layout) => layout === value),
  /** Unique known layouts that include List, put in the fixed List, List + map, Map order. */
  layouts: (value: unknown) => {
    if (!Array.isArray(value) || new Set(value).size !== value.length) return undefined;
    if (!value.every((item) => field.layout(item)) || !value.includes("list")) return undefined;
    return ACCOUNT_BOOKING_PAGE_LAYOUTS.filter((layout) => value.includes(layout));
  },
  sort: (value: unknown) => ACCOUNT_BOOKING_PAGE_SORTS.find((sort) => sort === value),
};

/** The header section. Strict when `defaults` is null (undefined on any bad field), lenient otherwise. */
function readHeader(value: Record<string, unknown>, defaults: Header | null): Header | undefined {
  const read = <K extends keyof Header>(
    key: K,
    parse: (item: unknown) => Header[K] | undefined,
  ) => {
    const parsed = parse(value[key]);
    return parsed !== undefined ? parsed : defaults ? defaults[key] : undefined;
  };
  const topLeft = read("topLeft", field.topLeft);
  const designPropertyId = read("designPropertyId", field.propertyId);
  const contactEmail = read("contactEmail", field.email);
  const contactWhatsapp = read("contactWhatsapp", field.whatsapp);
  const switches = booleans(
    value,
    ["gallery", "contact", "language", "currency"] as const,
    defaults,
  );
  if (
    !switches ||
    topLeft === undefined ||
    designPropertyId === undefined ||
    contactEmail === undefined ||
    contactWhatsapp === undefined
  )
    return undefined;
  return { topLeft, designPropertyId, ...switches, contactEmail, contactWhatsapp };
}

type Header = AccountBookingPageSettings["header"];

/** The boolean `keys` of `value`. Strict when `defaults` is null (null on any non-boolean), lenient
 * otherwise. */
function booleans<K extends string>(
  value: Record<string, unknown>,
  keys: readonly K[],
  defaults: { [key in K]: boolean } | null,
): { [key in K]: boolean } | null {
  const result = {} as { [key in K]: boolean };
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "boolean") result[key] = item;
    else if (defaults) result[key] = defaults[key];
    else return null;
  }
  return result;
}

function parsePropertyIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > ACCOUNT_BOOKING_PAGE_MAX_PROPERTIES) return null;
  const ids: string[] = [];
  for (const item of value) {
    const id = uuid(item);
    if (!id) return null;
    ids.push(id);
  }
  return new Set(ids).size === ids.length ? ids : null;
}

function uuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

/** Trimmed one-line text of at most `max` characters, or undefined. */
function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length <= max && !CONTROL_CHARACTERS.test(text) ? text : undefined;
}

/** The account name as a valid title: one line, cut to the maximum length, never empty. */
function defaultTitle(accountName: string): string {
  const title = accountName
    .replace(CONTROL_CHARACTERS_GLOBAL, " ")
    .trim()
    .slice(0, TITLE_MAX)
    .trim();
  return title || "Our stays";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
