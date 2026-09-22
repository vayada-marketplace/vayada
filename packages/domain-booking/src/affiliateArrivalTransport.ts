export const AFFILIATE_ARRIVAL_REFERENCE_PARAMETER = "vref" as const;
export const AFFILIATE_CONTEXT_COOKIE_NAME = "__Host-vayada_affiliate_context" as const;
export const AFFILIATE_CONTEXT_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

const referenceToken = /^vc_[A-Za-z0-9_-]{22}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RedirectResult =
  | { status: "blocked" }
  | { status: "ready"; redirectUrl: string; referenceToken: string };

/** Adds the opaque click reference only to a URL already approved by the safety owner. */
export function buildAffiliateArrivalRedirect(
  approvedBookingUrl: unknown,
  opaqueReferenceToken: unknown,
): RedirectResult {
  if (
    typeof approvedBookingUrl !== "string" ||
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
