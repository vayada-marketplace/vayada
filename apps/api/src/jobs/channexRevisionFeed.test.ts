import { describe, expect, it } from "vitest";
import {
  CHANNEX_FEED_MAX_PAGES,
  channexFeedUrl,
  readChannexFeed,
  type ChannexFeedPage,
} from "./channexRevisionFeed.js";

const input = { apiBaseUrl: "https://app.channex.io", providerPropertyId: "chx-1" };
const rows = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `rev-${from + index}` }));

function feed(total: number, meta = true) {
  const pages: number[] = [];
  const read = async (url: URL): Promise<ChannexFeedPage> => {
    const page = Number(url.searchParams.get("pagination[page]"));
    const limit = Number(url.searchParams.get("pagination[limit]"));
    pages.push(page);
    const start = (page - 1) * limit;
    return {
      data: rows(start, Math.max(0, Math.min(limit, total - start))),
      meta: meta ? { page, limit, total } : null,
    };
  };
  return { read, pages };
}

describe("readChannexFeed (VAY-2108 W1d)", () => {
  it("asks for one property's feed, oldest first, 100 per page", () => {
    expect(String(channexFeedUrl(input.apiBaseUrl, "chx-1", 3))).toBe(
      "https://app.channex.io/api/v1/booking_revisions/feed?filter%5Bproperty_id%5D=chx-1&order%5Binserted_at%5D=asc&pagination%5Bpage%5D=3&pagination%5Blimit%5D=100",
    );
  });

  it("reads every page up to the feed's total", async () => {
    const { read, pages } = feed(250);
    const result = await readChannexFeed(read, input);
    expect(result).toMatchObject({ truncated: false, total: 250 });
    expect(result.revisions).toHaveLength(250);
    expect(pages).toEqual([1, 2, 3]);
  });

  it("stops at a short page when the feed has no total", async () => {
    const { read, pages } = feed(100, false);
    expect((await readChannexFeed(read, input)).revisions).toHaveLength(100);
    expect(pages).toEqual([1, 2]);
  });

  it("stops early once the caller has what it needs", async () => {
    const { read, pages } = feed(1_000);
    const result = await readChannexFeed(read, {
      ...input,
      found: (revisions) => revisions.some((revision) => revision["id"] === "rev-150"),
    });
    expect(pages).toEqual([1, 2]);
    expect(result.truncated).toBe(false);
  });

  it("stops at the page cap and says the feed was truncated", async () => {
    const { read, pages } = feed(5_000);
    const result = await readChannexFeed(read, input);
    expect(pages).toHaveLength(CHANNEX_FEED_MAX_PAGES);
    expect(result).toMatchObject({ truncated: true, total: 5_000 });
    expect(result.revisions).toHaveLength(CHANNEX_FEED_MAX_PAGES * 100);
  });

  it("returns a revision once when acknowledgements shift it onto the next page", async () => {
    const read = async (url: URL): Promise<ChannexFeedPage> =>
      url.searchParams.get("pagination[page]") === "1"
        ? { data: rows(0, 100), meta: { total: 150, limit: 100 } }
        : { data: rows(99, 51), meta: { total: 150, limit: 100 } };
    const result = await readChannexFeed(read, input);
    expect(result.revisions.map((revision) => revision["id"])).toEqual(
      rows(0, 150).map((row) => row.id),
    );
  });
});
