import { describe, expect, it } from "vitest";
import {
  AFFILIATE_CONTEXT_COOKIE_MAX_AGE_SECONDS,
  AFFILIATE_CONTEXT_COOKIE_NAME,
  buildAffiliateArrivalRedirect,
  clearAffiliateContextCookie,
  readAffiliateContextCookie,
  serializeAffiliateContextCookie,
} from "./affiliateArrivalTransport.js";

const contextId = "15060000-0000-4000-8000-000000000001";
const referenceToken = "vc_1234567890123456789012";

describe("affiliate arrival transport", () => {
  it("adds one opaque reference to an approved HTTPS destination", () => {
    expect(
      buildAffiliateArrivalRedirect(
        "https://hotel.example/book?property=42&locale=en",
        referenceToken,
      ),
    ).toEqual({
      status: "ready",
      redirectUrl:
        "https://hotel.example/book?property=42&locale=en&vref=vc_1234567890123456789012",
      referenceToken,
    });
  });

  it("blocks unsafe, ambiguous or visitor-controlled redirect input", () => {
    for (const bookingUrl of [
      "http://hotel.example/",
      "https://user:password@hotel.example/",
      "https://hotel.example/#section",
      "https://hotel.example/?vref=vc_aaaaaaaaaaaaaaaaaaaaaa",
      "https://hotel.example/%5Credirect",
      " https://hotel.example/",
      "https://hotel.example",
    ])
      expect(buildAffiliateArrivalRedirect(bookingUrl, referenceToken)).toEqual({
        status: "blocked",
      });
    expect(buildAffiliateArrivalRedirect("https://hotel.example/", "creator-123")).toEqual({
      status: "blocked",
    });
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
