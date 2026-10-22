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
