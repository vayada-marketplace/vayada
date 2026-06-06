export type PublicHotelUrlPolicyInput = {
  requestHost: string;
  requestProtocol?: "http" | "https";
  slug: string;
  locale: string;
  supportedLocales?: string[];
  customDomainUrl?: string | null;
};

export type PublicHotelUrlPolicy = {
  canonicalUrl: string;
  bookingBaseUrl: string;
  fallbackBaseUrl: string;
  customDomainUrl: string | null;
  sitemapUrl: string;
  jsonLdUrl: string;
  hreflangUrls: Record<string, string>;
};

export function resolvePublicHotelUrls(input: PublicHotelUrlPolicyInput): PublicHotelUrlPolicy {
  const requestHost = normalizeRequestHost(input.requestHost);
  const protocol = input.requestProtocol ?? inferProtocol(requestHost);
  const fallbackBaseUrl = `${protocol}://${fallbackHostForSlug(input.slug, requestHost)}`;
  const customDomainUrl = normalizeCustomDomainUrl(input.customDomainUrl);
  const bookingBaseUrl = customDomainUrl ?? fallbackBaseUrl;
  const canonicalUrl = withLocalePath(bookingBaseUrl, input.locale);
  const locales = input.supportedLocales?.length ? input.supportedLocales : [input.locale];

  return {
    canonicalUrl,
    bookingBaseUrl,
    fallbackBaseUrl,
    customDomainUrl,
    sitemapUrl: `${bookingBaseUrl}/sitemap.xml`,
    jsonLdUrl: canonicalUrl,
    hreflangUrls: Object.fromEntries(
      locales.map((locale) => [locale, withLocalePath(bookingBaseUrl, locale)]),
    ),
  };
}

export function getCanonicalHostRedirectUrl(
  policy: PublicHotelUrlPolicy,
  requestUrl: URL,
): string | null {
  if (
    normalizeRequestHost(requestUrl.host) ===
    normalizeRequestHost(new URL(policy.bookingBaseUrl).host)
  ) {
    return null;
  }
  if (!isFallbackBookingHost(requestUrl.hostname)) return null;

  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, policy.bookingBaseUrl);
  return target.toString();
}

export function isFallbackBookingHost(hostname: string): boolean {
  const host = normalizeRequestHost(hostname);
  return (
    host.endsWith(".booking.vayada.com") ||
    host.endsWith(".booking.localhost") ||
    host.endsWith(".localhost")
  );
}

function fallbackHostForSlug(slug: string, requestHost: string): string {
  const host = normalizeRequestHost(requestHost);
  const port = portFromHost(requestHost);
  const portSuffix = port ? `:${port}` : "";

  if (host.endsWith(".booking.localhost")) return `${slug}.booking.localhost${portSuffix}`;
  if (host.endsWith(".localhost")) return `${slug}.localhost${portSuffix}`;

  return `${slug}.booking.vayada.com`;
}

function withLocalePath(baseUrl: string, locale: string): string {
  return new URL(`/${locale.replace(/^\/+/, "")}`, baseUrl).toString().replace(/\/$/, "");
}

function normalizeCustomDomainUrl(value?: string | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const withScheme =
    raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function inferProtocol(requestHost: string): "http" | "https" {
  return requestHost.includes(":3002") || requestHost.startsWith("127.0.0.1") ? "http" : "https";
}

function normalizeRequestHost(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[")) {
    return normalized.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1");
  }
  return normalized.replace(/:\d+$/, "");
}

function portFromHost(hostname: string): string | null {
  const match = hostname.match(/:(\d+)$/);
  return match ? match[1] : null;
}
