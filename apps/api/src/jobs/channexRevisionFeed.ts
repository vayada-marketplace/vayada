/**
 * VAY-2108 W1d: Channex keeps every unacknowledged booking revision in a property's feed, oldest
 * first, and a refused revision stays unacknowledged (the PMS alert and Channex's own warning are
 * the signals). So both readers page through the feed: a run that stopped at the first page would
 * never see a new booking behind 100 refused ones. Paging uses Channex's standard
 * `pagination[page]`/`pagination[limit]` (limit at most 100) and the feed's `meta.total`.
 */
export const CHANNEX_FEED_PAGE_SIZE = 100;
/** Pages one run reads at most (2,000 revisions); a longer feed is logged with the hotel. */
export const CHANNEX_FEED_MAX_PAGES = 20;

export type ChannexFeedPage = {
  data: Record<string, unknown>[];
  meta: Record<string, unknown> | null;
};

export function channexFeedUrl(apiBaseUrl: string, providerPropertyId: string, page: number) {
  const url = new URL("/api/v1/booking_revisions/feed", `${apiBaseUrl}/`);
  url.searchParams.set("filter[property_id]", providerPropertyId);
  url.searchParams.set("order[inserted_at]", "asc");
  url.searchParams.set("pagination[page]", String(page));
  url.searchParams.set("pagination[limit]", String(CHANNEX_FEED_PAGE_SIZE));
  return url;
}

/**
 * Reads the feed page by page until it ends, `found` says the caller has what it needs, or the
 * page cap is reached (`truncated`). Revisions acknowledged while it pages shift later rows
 * forward, so a row can be missed until the next run; a row seen twice is returned once. A later
 * page with nothing new means Channex ignored the page number: the read stops as truncated.
 */
export async function readChannexFeed(
  readPage: (url: URL) => Promise<ChannexFeedPage>,
  input: {
    apiBaseUrl: string;
    providerPropertyId: string;
    found?: (revisions: readonly Record<string, unknown>[]) => boolean;
  },
): Promise<{
  revisions: Record<string, unknown>[];
  truncated: boolean;
  total: number | null;
  /** A later page repeated the earlier ones: Channex ignored the page number. */
  unpaged: boolean;
}> {
  const revisions: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  let seen = 0;
  let total: number | null = null;
  for (let page = 1; page <= CHANNEX_FEED_MAX_PAGES; page += 1) {
    const { data, meta } = await readPage(
      channexFeedUrl(input.apiBaseUrl, input.providerPropertyId, page),
    );
    seen += data.length;
    const before = revisions.length;
    for (const item of data) {
      const id = typeof item["id"] === "string" ? item["id"] : null;
      if (id && ids.has(id)) continue;
      if (id) ids.add(id);
      revisions.push(item);
    }
    total = typeof meta?.["total"] === "number" ? meta["total"] : null;
    if (page > 1 && data.length > 0 && revisions.length === before)
      return { revisions, truncated: true, total, unpaged: true };
    const limit = typeof meta?.["limit"] === "number" ? meta["limit"] : CHANNEX_FEED_PAGE_SIZE;
    const ended = total !== null ? seen >= total || data.length === 0 : data.length < limit;
    if (ended || input.found?.(revisions))
      return { revisions, truncated: false, total, unpaged: false };
  }
  return { revisions, truncated: true, total, unpaged: false };
}
