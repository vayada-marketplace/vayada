import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createMarketplaceAffiliatePublicLinkQuota } from "./marketplaceAffiliatePublicLinkQuota.js";

describe("marketplace affiliate public-link quota", () => {
  it("uses only the public link token and maps an allowed result", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ known: true }] })
      .mockResolvedValueOnce({ rows: [{ allowed: true, retry_after_seconds: null }] });
    const quota = createMarketplaceAffiliatePublicLinkQuota(
      { query } as unknown as pg.Pool,
      "quota-test-key",
    );
    await expect(quota({ publicToken: "va_token", requesterIp: "203.0.113.8" })).resolves.toEqual({
      allowed: true,
    });
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("consume_affiliate_click_quota"),
      ["va_token"],
    );
    expect(query.mock.calls.flat().join(" ")).not.toContain("203.0.113.8");
  });

  it("returns the shared window retry delay and rejects malformed database output", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ known: true }] })
      .mockResolvedValueOnce({ rows: [{ allowed: false, retry_after_seconds: 17 }] })
      .mockResolvedValueOnce({ rows: [] });
    const quota = createMarketplaceAffiliatePublicLinkQuota(
      { query } as unknown as pg.Pool,
      "quota-test-key",
    );
    await expect(quota({ publicToken: "va_token", requesterIp: "127.0.0.1" })).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 17,
    });
    await expect(quota({ publicToken: "va_token", requesterIp: "127.0.0.1" })).rejects.toThrow(
      "Invalid affiliate quota result",
    );
  });

  it("limits one source before it can consume the shared link ceiling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T00:00:10Z"));
    const query = vi.fn(async (sql: string) =>
      sql.includes("SELECT EXISTS")
        ? { rows: [{ known: true }] }
        : { rows: [{ allowed: true, retry_after_seconds: null }] },
    );
    const quota = createMarketplaceAffiliatePublicLinkQuota(
      { query } as unknown as pg.Pool,
      "quota-test-key",
    );
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await expect(
          quota({ publicToken: "va_token", requesterIp: "203.0.113.8" }),
        ).resolves.toEqual({ allowed: true });
      }
      await expect(quota({ publicToken: "va_token", requesterIp: "203.0.113.8" })).resolves.toEqual(
        { allowed: false, retryAfterSeconds: 50 },
      );
      await expect(quota({ publicToken: "va_token", requesterIp: "203.0.113.9" })).resolves.toEqual(
        { allowed: true },
      );
      expect(
        query.mock.calls.filter(([sql]) => String(sql).includes("consume_affiliate_click_quota")),
      ).toHaveLength(31);
      expect(query.mock.calls.flat().join(" ")).not.toContain("203.0.113");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retain or charge an unknown token", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ known: false }] });
    const quota = createMarketplaceAffiliatePublicLinkQuota(
      { query } as unknown as pg.Pool,
      "quota-test-key",
    );
    await expect(quota({ publicToken: "va_unknown", requesterIp: "203.0.113.8" })).resolves.toEqual(
      { allowed: true, known: false },
    );
    expect(query).toHaveBeenCalledOnce();
  });

  it("bounds unknown-token lookups per source while preserving not found", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ known: false }] });
    const quota = createMarketplaceAffiliatePublicLinkQuota(
      { query } as unknown as pg.Pool,
      "quota-test-key",
    );
    for (let attempt = 0; attempt < 31; attempt += 1) {
      await expect(
        quota({ publicToken: `va_unknown_${attempt}`, requesterIp: "203.0.113.8" }),
      ).resolves.toEqual({ allowed: true, known: false });
    }
    expect(query).toHaveBeenCalledTimes(30);
  });

  it("groups IPv6 sources by /64 and IPv4-mapped addresses by IPv4", async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes("SELECT EXISTS")
        ? { rows: [{ known: true }] }
        : { rows: [{ allowed: true, retry_after_seconds: null }] },
    );
    const quota = createMarketplaceAffiliatePublicLinkQuota(
      { query } as unknown as pg.Pool,
      "quota-test-key",
    );
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await quota({ publicToken: "va_ipv6", requesterIp: `2001:db8:abcd:12::${attempt + 1}` });
    }
    await expect(
      quota({ publicToken: "va_ipv6", requesterIp: "2001:db8:abcd:12:ffff::1" }),
    ).resolves.toEqual(expect.objectContaining({ allowed: false }));
    await expect(
      quota({ publicToken: "va_ipv6", requesterIp: "2001:db8:abcd:13::1" }),
    ).resolves.toEqual({ allowed: true });

    const mapped = [
      "::ffff:192.0.2.1",
      "0:0:0:0:0:FFFF:C000:0201",
      "0000:0000:0000:0000:0000:ffff:192.0.2.1",
    ];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await quota({ publicToken: "va_mapped", requesterIp: mapped[attempt % mapped.length] });
    }
    await expect(
      quota({ publicToken: "va_mapped", requesterIp: "::FFFF:C000:201" }),
    ).resolves.toEqual(expect.objectContaining({ allowed: false }));
    await expect(quota({ publicToken: "va_mapped", requesterIp: "192.0.2.2" })).resolves.toEqual({
      allowed: true,
    });
  });
});
