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
  const protocol = input.requestProtocol ?? inferProtocol(input.requestHost);
  const fallbackBaseUrl = `${protocol}://${fallbackHostForSlug(input.slug, input.requestHost)}`;
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

// The hotel page is the only public, indexable page: the former /rooms listing
// redirects to the private room-and-price page.
export function publicHotelSitemapEntries(
  policy: PublicHotelUrlPolicy,
): Array<{ url: string; alternates: Record<string, string> }> {
  return [{ url: policy.canonicalUrl, alternates: policy.hreflangUrls }];
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
    host.endsWith(".next-booking.vayada.com") ||
    host.endsWith(".booking.vayada.com") ||
    host.endsWith(".booking.localhost") ||
    host.endsWith(".localhost")
  );
}

function fallbackHostForSlug(slug: string, requestHost: string): string {
  const host = normalizeRequestHost(requestHost);
  const port = portFromHost(requestHost);
  const portSuffix = port ? `:${port}` : "";

  if (host === "booking.localhost") return `${slug}.booking.localhost${portSuffix}`;
  if (host.endsWith(".booking.localhost")) {
    const localPrefix = host.slice(0, -".booking.localhost".length);
    const localLabels = localPrefix.split(".");
    const worktreePrefix =
      localLabels.length > 1
        ? localLabels.slice(1).join(".")
        : localPrefix === slug.toLowerCase()
          ? ""
          : localPrefix;
    const worktreeSuffix = worktreePrefix ? `.${worktreePrefix}` : "";
    return `${slug}${worktreeSuffix}.booking.localhost${portSuffix}`;
  }
  if (host.endsWith(".localhost")) return `${slug}.localhost${portSuffix}`;
  if (host.endsWith(".next-booking.vayada.com")) return `${slug}.next-booking.vayada.com`;

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
