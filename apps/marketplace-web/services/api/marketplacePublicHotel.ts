import { VAYADA_API_BASE_URL } from "./client";

export type MarketplacePublicHotel = {
  propertyId: string;
  revisionId: string;
  displayName: string;
  propertyType: string;
  shortDescription: string;
  locality: { city: string; countryCode: string } | null;
  media: {
    mediaType: "logo" | "hero_image" | "gallery_image";
    url: string;
    altText: string | null;
  }[];
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function marketplacePublicHotelPath(propertyId: string) {
  if (!uuid(propertyId)) throw new Error("Invalid hotel address");
  return `/api/marketplace/hotels/${propertyId.toLowerCase()}`;
}
export function parseMarketplacePublicHotel(
  raw: unknown,
  propertyId: string,
): MarketplacePublicHotel {
  if (
    !record(raw) ||
    raw.propertyId !== propertyId.toLowerCase() ||
    !uuid(raw.revisionId) ||
    ![raw.displayName, raw.propertyType, raw.shortDescription].every(
      (value) => typeof value === "string" && value.trim(),
    ) ||
    !(
      raw.locality === null ||
      (record(raw.locality) &&
        typeof raw.locality.city === "string" &&
        typeof raw.locality.countryCode === "string")
    ) ||
    !Array.isArray(raw.media) ||
    !raw.media.length ||
    raw.media.length > 100 ||
    !raw.media.every(
      (item) =>
        record(item) &&
        ["logo", "hero_image", "gallery_image"].includes(String(item.mediaType)) &&
        (item.altText === null || typeof item.altText === "string") &&
        safeUrl(item.url),
    )
  )
    throw new Error("Hotel details are unavailable");
  return raw as MarketplacePublicHotel;
}
function safeUrl(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
export async function loadMarketplacePublicHotel(
  propertyId: string,
  signal?: AbortSignal,
): Promise<MarketplacePublicHotel | null> {
  const response = await fetch(
    `${VAYADA_API_BASE_URL.replace(/\/$/, "")}${marketplacePublicHotelPath(propertyId)}`,
    { cache: "no-store", credentials: "omit", signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Hotel details are temporarily unavailable");
  return parseMarketplacePublicHotel(await response.json(), propertyId);
}
