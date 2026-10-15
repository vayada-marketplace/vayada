import { VAYADA_API_BASE_URL } from "@vayada/marketplace-shared/api/client";

/**
 * Absolute URL for a creator share path such as `/r/va_…`. The origin is deployment
 * configuration: `https://affiliate.vayada.com` once share links go live (VAY-2209).
 * Without it, links use the API host, which serves `/r` itself.
 */
export function affiliateShareUrl(path: string): string {
  const origin = process.env.NEXT_PUBLIC_AFFILIATE_LINK_ORIGIN || VAYADA_API_BASE_URL;
  return new URL(path, origin).toString();
}
