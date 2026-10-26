/** Room location coordinates as hosts type them (VAY-2126): a comma or a dot as the decimal separator,
 * stored and shown with a dot, as Google Maps shows them. */

export type CoordinateAxis = "latitude" | "longitude";

const LIMIT: Record<CoordinateAxis, number> = { latitude: 90, longitude: 180 };

/** Six decimals is about 10 cm: plenty for a pin, and a dragged pin doesn't store float noise. */
export function roundCoordinate(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function formatCoordinate(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(roundCoordinate(value)) : "";
}

/** A number typed with either separator ("6,02957" or "6.02957"); undefined when it isn't one. */
function parseNumber(text: string): number | undefined {
  const cleaned = text.trim().replace(/−/g, "-").replace(/°$/, "").trim();
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(cleaned)) return undefined;
  const value = Number(cleaned.replace(",", "."));
  return Number.isFinite(value) ? roundCoordinate(value) : undefined;
}

export type CoordinateResult =
  | { kind: "empty" }
  | { kind: "value"; value: number }
  | { kind: "invalid" }
  | { kind: "out_of_range" };

export function parseCoordinate(text: string, axis: CoordinateAxis): CoordinateResult {
  if (!text.trim()) return { kind: "empty" };
  const value = parseNumber(text);
  if (value === undefined) return { kind: "invalid" };
  return Math.abs(value) > LIMIT[axis] ? { kind: "out_of_range" } : { kind: "value", value };
}

/** "48.15634, 11.58242" as Google Maps copies it, or "48,15634; 11,58242" with comma decimals. */
export function parseCoordinatePair(text: string): { latitude: number; longitude: number } | null {
  const trimmed = text.trim();
  // A comma alone is a decimal separator ("48,15"), so a comma only separates the two values when a space
  // follows it or both values have a dot.
  const parts = trimmed.includes(";")
    ? trimmed.split(";")
    : ((
        trimmed.match(/^(\S+?)\s*,\s+(\S+)$/) ??
        trimmed.match(/^(\S*\.\S*),(\S*\.\S*)$/) ??
        trimmed.match(/^(\S+)\s+(\S+)$/)
      )?.slice(1) ?? []);
  if (parts.length !== 2) return null;
  const latitude = parseCoordinate(parts[0], "latitude");
  const longitude = parseCoordinate(parts[1], "longitude");
  return latitude.kind === "value" && longitude.kind === "value"
    ? { latitude: latitude.value, longitude: longitude.value }
    : null;
}

export type CoordinateError =
  | "latitudeInvalid"
  | "longitudeInvalid"
  | "latitudeRange"
  | "longitudeRange"
  | "coordinatesPair";

/** Both fields typed: the pair to save (null, null when both are empty), or what is wrong with it. */
export function readCoordinates(
  latitudeText: string,
  longitudeText: string,
):
  | { ok: true; latitude: number | null; longitude: number | null }
  | { ok: false; error: CoordinateError } {
  const latitude = parseCoordinate(latitudeText, "latitude");
  const longitude = parseCoordinate(longitudeText, "longitude");
  if (latitude.kind === "invalid") return { ok: false, error: "latitudeInvalid" };
  if (latitude.kind === "out_of_range") return { ok: false, error: "latitudeRange" };
  if (longitude.kind === "invalid") return { ok: false, error: "longitudeInvalid" };
  if (longitude.kind === "out_of_range") return { ok: false, error: "longitudeRange" };
  if (latitude.kind === "empty" && longitude.kind === "empty") {
    return { ok: true, latitude: null, longitude: null };
  }
  if (latitude.kind === "empty" || longitude.kind === "empty") {
    return { ok: false, error: "coordinatesPair" };
  }
  return { ok: true, latitude: latitude.value, longitude: longitude.value };
}

export type RoomPin = { latitude: number; longitude: number };

/** Where a link copied from Google Maps puts its pin: a place's own point (!3d…!4d…), a search or route
 * point (?q=, query=, ll=, destination=), else the map's centre (@lat,lng). Short share links
 * (maps.app.goo.gl) carry no coordinates. */
export function parseGoogleMapsLink(text: string): RoomPin | "short_link" | null {
  const link = text.trim();
  if (/^(https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(link)) return "short_link";
  if (!/google\.[a-z.]+\/maps|maps\.google\./i.test(link)) return null;
  let decoded = link;
  try {
    decoded = decodeURIComponent(link);
  } catch {
    // A malformed escape: read the link as it is.
  }
  const number = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
  const match =
    decoded.match(new RegExp(String.raw`!3d${number}!4d${number}`)) ??
    decoded.match(
      new RegExp(String.raw`[?&](?:q|query|ll|destination|center)=${number},\s*${number}`),
    ) ??
    decoded.match(new RegExp(String.raw`@${number},${number}`));
  if (!match) return null;
  const latitude = parseCoordinate(match[1], "latitude");
  const longitude = parseCoordinate(match[2], "longitude");
  return latitude.kind === "value" && longitude.kind === "value"
    ? { latitude: latitude.value, longitude: longitude.value }
    : null;
}

/** Straight-line distance; fine for the few kilometres between a villa and its main property. */
export function metresBetween(a: RoomPin, b: RoomPin): number {
  const toRadians = Math.PI / 180;
  const x =
    (b.longitude - a.longitude) * toRadians * Math.cos(((a.latitude + b.latitude) / 2) * toRadians);
  const y = (b.latitude - a.latitude) * toRadians;
  return Math.hypot(x, y) * 6_371_000;
}

/** "350 m" or "2.1 km" in the host's language. */
export function formatDistance(metres: number, locale: string): string {
  if (metres < 1000) {
    return `${new Intl.NumberFormat(locale).format(Math.max(10, Math.round(metres / 10) * 10))} m`;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(metres / 1000)} km`;
}

/** Pins this close count as one place on the guest map (as @vayada/domain-hotels' isSamePlace does). */
export function isSamePlace(a: RoomPin, b: RoomPin): boolean {
  return metresBetween(a, b) < 25;
}

/** How a room's place is set (VAY-2321). A room saved before had no choice: one with its own pin away from
 * the property has its own place, as guests are shown. */
export function roomLocationSource(
  room: {
    locationSource?: "property" | "custom";
    latitude: number | null;
    longitude: number | null;
  },
  propertyPin: RoomPin | null,
): "property" | "custom" {
  if (room.locationSource) return room.locationSource;
  if (room.latitude === null || room.longitude === null) return "property";
  const pin = { latitude: room.latitude, longitude: room.longitude };
  return propertyPin && isSamePlace(pin, propertyPin) ? "property" : "custom";
}

type AddressComponent = { longText?: string | null; types?: string[] | null };
const AREA_TYPES = [
  "sublocality_level_1",
  "sublocality",
  "neighborhood",
  "locality",
  "postal_town",
  "administrative_area_level_3",
  "administrative_area_level_2",
];

/** The name of the district or town Google puts an address in, for an "Approximate area". */
export function areaFromAddressComponents(
  components: AddressComponent[] | null | undefined,
): string {
  for (const type of AREA_TYPES) {
    const name = components?.find((component) => component.types?.includes(type))?.longText?.trim();
    if (name) return name;
  }
  return "";
}
