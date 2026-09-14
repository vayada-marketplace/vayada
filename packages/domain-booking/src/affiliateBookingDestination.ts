/** VAY-1501: configuration is separate from property ownership and tracking proof. */
export type AffiliateBookingDestinationConfiguration = Readonly<{
  displayName: string;
  bookingUrl: string;
}>;

export function parseAffiliateBookingDestinationConfiguration(
  input: unknown,
): AffiliateBookingDestinationConfiguration | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes("displayName") || !keys.includes("bookingUrl"))
    return null;
  const name = Object.getOwnPropertyDescriptor(input, "displayName");
  const link = Object.getOwnPropertyDescriptor(input, "bookingUrl");
  const displayName: unknown = name && "value" in name ? name.value : undefined;
  const bookingUrl: unknown = link && "value" in link ? link.value : undefined;
  if (
    typeof displayName !== "string" ||
    !displayName.trim() ||
    displayName.trim().length > 120 ||
    typeof bookingUrl !== "string" ||
    bookingUrl.length > 2048 ||
    /[\s\p{Cc}#\\]/u.test(bookingUrl)
  )
    return null;
  try {
    const url = new URL(bookingUrl);
    if (
      !/^https:\/\/[^/?@]+(?:[/?]|$)/.test(bookingUrl) ||
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
    if (url.href.length > 2048) return null;
    return Object.freeze({ displayName: displayName.trim(), bookingUrl: url.href });
  } catch {
    return null;
  }
}

export const AFFILIATE_TRACKING_PURPOSES = Object.freeze([
  "referral_round_trip",
  "reservation_lifecycle",
  "stay_completion",
  "accommodation_revenue",
] as const);
export type AffiliateTrackingPurpose = (typeof AFFILIATE_TRACKING_PURPOSES)[number];

/** Trusted owner-domain evidence, never hotel form input or an unsigned provider claim. */
export type AffiliateDestinationTrackingEvidence = Readonly<{
  destinationVersionId: string;
  propertyId: string;
  connectionId: string;
  connectionStatus: "active" | "revoked";
  purpose: AffiliateTrackingPurpose;
  support: "supported" | "unsupported" | "unknown";
  validation: "validated" | "documented" | "not_validated";
  evidenceReference: string | null;
  validatedAt: string | null;
  health: "healthy" | "stale" | "unavailable";
}>;

/** No provider names, fallback, network calls or publication/earning authorization. */
export function assessAffiliateDestinationTracking(
  destination: { destinationVersionId: string; propertyId: string; enabled: boolean },
  evidence: readonly AffiliateDestinationTrackingEvidence[],
  now = new Date(),
): { status: "verified" | "pending"; missing: AffiliateTrackingPurpose[] } {
  const missing = AFFILIATE_TRACKING_PURPOSES.filter(
    (purpose) =>
      !destination.enabled ||
      !destination.destinationVersionId.trim() ||
      !destination.propertyId.trim() ||
      !Number.isFinite(now.getTime()) ||
      evidence.filter((item) => item.purpose === purpose).length !== 1 ||
      !evidence.some(
        (item) =>
          item.purpose === purpose &&
          item.destinationVersionId === destination.destinationVersionId &&
          item.propertyId === destination.propertyId &&
          !!item.connectionId.trim() &&
          item.connectionStatus === "active" &&
          item.support === "supported" &&
          item.validation === "validated" &&
          item.health === "healthy" &&
          !!item.evidenceReference?.trim() &&
          !!item.validatedAt &&
          Number.isFinite(Date.parse(item.validatedAt)) &&
          Date.parse(item.validatedAt) <= now.getTime(),
      ),
  );
  return { status: missing.length ? "pending" : "verified", missing };
}
