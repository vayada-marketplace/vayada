import { describe, expect, it } from "vitest";
import {
  AFFILIATE_CONTEXT_COOKIE_MAX_AGE_SECONDS,
  AFFILIATE_CONTEXT_COOKIE_NAME,
  AFFILIATE_DESTINATION_SAFETY_POLICY_VERSION,
  buildAffiliateArrivalRedirect,
  clearAffiliateContextCookie,
  isCurrentAffiliateDestinationSafetyEvidence,
  readAffiliateContextCookie,
  serializeAffiliateContextCookie,
} from "./affiliateArrivalTransport.js";

const contextId = "15060000-0000-4000-8000-000000000001";
const propertyId = "15060000-0000-4000-8000-000000000002";
const destinationVersionId = "15060000-0000-4000-8000-000000000003";
const referenceToken = "vc_1234567890123456789012";
const now = new Date("2026-09-22T06:00:00.000Z");
const bookingUrl = "https://hotel-alpenrose.next-booking.vayada.com/";
const safetyEvidence = () => ({
  status: "approved" as const,
  policyVersion: AFFILIATE_DESTINATION_SAFETY_POLICY_VERSION,
  method: "native_vayada_host" as const,
  propertyId,
  destinationVersionId,
  bookingUrl,
  redirectChain: [bookingUrl] as const,
  evidenceReference:
    `booking:native-affiliate-destination-safety:v1:${propertyId}:` +
    `${destinationVersionId}:hotel-alpenrose`,
  validatedAt: "2026-09-22T05:59:30.000Z",
});

describe("affiliate arrival transport", () => {
  it("adds one opaque reference to an approved HTTPS destination", () => {
    expect(buildAffiliateArrivalRedirect(safetyEvidence(), referenceToken, now)).toEqual({
      status: "ready",
      redirectUrl: `${bookingUrl}?vref=vc_1234567890123456789012`,
      referenceToken,
    });
  });

  it("blocks raw URLs and stale, mismatched or malformed safety evidence", () => {
    expect(buildAffiliateArrivalRedirect(bookingUrl as never, referenceToken, now)).toEqual({
      status: "blocked",
    });
    for (const override of [
      { policyVersion: "booking-affiliate-destination-safety.v0" },
      { propertyId: destinationVersionId },
      { destinationVersionId: propertyId },
      { bookingUrl: "https://other.next-booking.vayada.com/" },
      { redirectChain: [bookingUrl, "https://other.example/"] },
      { evidenceReference: "browser:approved" },
      { validatedAt: "2026-09-22T05:58:59.999Z" },
      { validatedAt: "2026-09-22T06:00:00.001Z" },
    ])
      expect(
        buildAffiliateArrivalRedirect(
          { ...safetyEvidence(), ...override } as never,
          referenceToken,
          now,
        ),
      ).toEqual({
        status: "blocked",
      });
    expect(buildAffiliateArrivalRedirect(safetyEvidence(), "creator-123", now)).toEqual({
      status: "blocked",
    });
  });

  it("accepts evidence only inside its short live-read window", () => {
    expect(isCurrentAffiliateDestinationSafetyEvidence(safetyEvidence(), now)).toBe(true);
    expect(isCurrentAffiliateDestinationSafetyEvidence(safetyEvidence(), new Date("invalid"))).toBe(
      false,
    );
  });

  it("serializes only an opaque host-only first-party context", () => {
    expect(serializeAffiliateContextCookie(contextId.toUpperCase())).toBe(
      `${AFFILIATE_CONTEXT_COOKIE_NAME}=${contextId}; Path=/; Max-Age=${AFFILIATE_CONTEXT_COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(serializeAffiliateContextCookie("creator-123")).toBeNull();
    expect(serializeAffiliateContextCookie(contextId)).not.toContain("Domain=");
  });

  it("reads exactly one valid context and rejects duplicate or malformed cookies", () => {
    expect(
      readAffiliateContextCookie(`session=x; ${AFFILIATE_CONTEXT_COOKIE_NAME}=${contextId}`),
    ).toBe(contextId);
    expect(
      readAffiliateContextCookie(
        `${AFFILIATE_CONTEXT_COOKIE_NAME}=${contextId}; ${AFFILIATE_CONTEXT_COOKIE_NAME}=${contextId}`,
      ),
    ).toBeNull();
    expect(readAffiliateContextCookie(`${AFFILIATE_CONTEXT_COOKIE_NAME}=creator-123`)).toBeNull();
    expect(readAffiliateContextCookie(`${AFFILIATE_CONTEXT_COOKIE_NAME}=%E0%A4%A`)).toBeNull();
  });

  it("clears the same host-only cookie", () => {
    expect(clearAffiliateContextCookie()).toBe(
      `${AFFILIATE_CONTEXT_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
  });
});
