import { VAYADA_API_BASE_URL } from "@vayada/marketplace-shared/api/client";

/**
 * Absolute URL for a creator share path such as `/r/va_…`. The origin is a build setting:
 * `https://affiliate.vayada.com` once share links go live (VAY-2209). Without a usable
 * value, links use the API host, which serves `/r` itself.
 */
export function affiliateShareUrl(path: string): string {
  const configured = process.env.NEXT_PUBLIC_AFFILIATE_LINK_ORIGIN;
  if (configured) {
    try {
      return new URL(path, configured).toString();
    } catch {
      // A value without a scheme is a misconfiguration; never break the link panel over it.
    }
  }
  return new URL(path, VAYADA_API_BASE_URL).toString();
}
