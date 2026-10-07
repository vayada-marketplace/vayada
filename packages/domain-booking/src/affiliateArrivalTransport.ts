export const AFFILIATE_ARRIVAL_REFERENCE_PARAMETER = "vref" as const;
export const AFFILIATE_CONTEXT_COOKIE_NAME = "__Host-vayada_affiliate_context" as const;
export const AFFILIATE_CONTEXT_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
export const AFFILIATE_DESTINATION_SAFETY_POLICY_VERSION =
  "booking-affiliate-destination-safety.v1" as const;
export const AFFILIATE_DESTINATION_SAFETY_MAX_AGE_SECONDS = 60;
export const AFFILIATE_DESTINATION_SAFETY_LOCK_NAMESPACE =
  "booking-affiliate-destination-safety" as const;

export const affiliateDestinationSafetyLockKey = (propertyId: string): string =>
  `${AFFILIATE_DESTINATION_SAFETY_LOCK_NAMESPACE}:${propertyId.toLowerCase()}`;

const referenceToken = /^vc_[A-Za-z0-9_-]{22}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nativeEvidenceReference = new RegExp(
  "^booking:native-affiliate-destination-safety:v1:" +
    "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):" +
    "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):" +
    "([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$",
);

export type AffiliateDestinationSafetyEvidence = Readonly<{
  status: "approved";
  policyVersion: typeof AFFILIATE_DESTINATION_SAFETY_POLICY_VERSION;
  method: "native_vayada_host";
  propertyId: string;
  destinationVersionId: string;
  bookingUrl: string;
  redirectChain: readonly [string];
  evidenceReference: string;
  validatedAt: string;
}>;

type RedirectResult =
  | { status: "blocked" }
  | { status: "ready"; redirectUrl: string; referenceToken: string };

export function isCurrentAffiliateDestinationSafetyEvidence(
  value: unknown,
  now = new Date(),
): value is AffiliateDestinationSafetyEvidence {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isFinite(now.getTime())
  )
    return false;
  const evidence = value as Partial<AffiliateDestinationSafetyEvidence>;
  const match =
    typeof evidence.evidenceReference === "string"
      ? nativeEvidenceReference.exec(evidence.evidenceReference)
      : null;
  const validatedAt =
    typeof evidence.validatedAt === "string" ? Date.parse(evidence.validatedAt) : Number.NaN;
  if (
    evidence.status !== "approved" ||
    evidence.policyVersion !== AFFILIATE_DESTINATION_SAFETY_POLICY_VERSION ||
    evidence.method !== "native_vayada_host" ||
    typeof evidence.propertyId !== "string" ||
    typeof evidence.destinationVersionId !== "string" ||
    !uuid.test(evidence.propertyId) ||
    !uuid.test(evidence.destinationVersionId) ||
    evidence.propertyId !== evidence.propertyId.toLowerCase() ||
    evidence.destinationVersionId !== evidence.destinationVersionId.toLowerCase() ||
    !match ||
    match[1] !== evidence.propertyId ||
    match[2] !== evidence.destinationVersionId ||
    !Number.isFinite(validatedAt) ||
    validatedAt > now.getTime() ||
    validatedAt < now.getTime() - AFFILIATE_DESTINATION_SAFETY_MAX_AGE_SECONDS * 1_000 ||
    !Array.isArray(evidence.redirectChain) ||
    evidence.redirectChain.length !== 1 ||
    evidence.redirectChain[0] !== evidence.bookingUrl
  )
    return false;
  const expected = `https://${match[3]}.next-booking.vayada.com/`;
  return evidence.bookingUrl === expected;
}

/** Adds the opaque click reference only to fresh, version-scoped safety evidence. */
export function buildAffiliateArrivalRedirect(
  approvedDestination: AffiliateDestinationSafetyEvidence,
  opaqueReferenceToken: unknown,
  now = new Date(),
): RedirectResult {
  if (!isCurrentAffiliateDestinationSafetyEvidence(approvedDestination, now))
    return { status: "blocked" };
  const approvedBookingUrl = approvedDestination.bookingUrl;
  if (
    approvedBookingUrl.length > 2048 ||
    /[\s\p{Cc}\\]/u.test(approvedBookingUrl) ||
    /%5c/i.test(approvedBookingUrl) ||
    typeof opaqueReferenceToken !== "string" ||
    !referenceToken.test(opaqueReferenceToken)
  )
    return { status: "blocked" };
  try {
    const url = new URL(approvedBookingUrl);
    if (
      url.href !== approvedBookingUrl ||
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.has(AFFILIATE_ARRIVAL_REFERENCE_PARAMETER)
    )
      return { status: "blocked" };
    url.searchParams.set(AFFILIATE_ARRIVAL_REFERENCE_PARAMETER, opaqueReferenceToken);
    if (url.href.length > 2048) return { status: "blocked" };
    return { status: "ready", redirectUrl: url.href, referenceToken: opaqueReferenceToken };
  } catch {
    return { status: "blocked" };
  }
}

export function serializeAffiliateContextCookie(contextId: unknown): string | null {
  if (typeof contextId !== "string" || !uuid.test(contextId)) return null;
  return [
    `${AFFILIATE_CONTEXT_COOKIE_NAME}=${contextId.toLowerCase()}`,
    "Path=/",
    `Max-Age=${AFFILIATE_CONTEXT_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export function clearAffiliateContextCookie(): string {
  return [
    `${AFFILIATE_CONTEXT_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/** Duplicate or malformed values fail closed rather than selecting an attacker-controlled cookie. */
export function readAffiliateContextCookie(cookieHeader: unknown): string | null {
  if (typeof cookieHeader !== "string" || cookieHeader.length > 8192) return null;
  const values: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const [name, ...rawValue] = part.trim().split("=");
    if (name !== AFFILIATE_CONTEXT_COOKIE_NAME) continue;
    try {
      values.push(decodeURIComponent(rawValue.join("=")));
    } catch {
      return null;
    }
  }
  if (values.length !== 1 || !uuid.test(values[0]!)) return null;
  return values[0]!.toLowerCase();
}
