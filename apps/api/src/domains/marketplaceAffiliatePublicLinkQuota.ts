import { createHmac } from "node:crypto";
import type pg from "pg";

const REQUESTS_PER_SOURCE_PER_MINUTE = 30;
const MAX_SOURCES_PER_PROCESS_PER_MINUTE = 100_000;

export function createMarketplaceAffiliatePublicLinkQuota(pool: pg.Pool, key: string) {
  let minute = -1;
  const sourceCounts = new Map<string, number>();
  return async ({ publicToken, requesterIp }: { publicToken: string; requesterIp: string }) => {
    const known = await pool.query(
      "SELECT EXISTS(SELECT 1 FROM marketplace.affiliate_links WHERE public_token=$1) AS known",
      [publicToken],
    );
    if (known.rows[0]?.known !== true) return { allowed: true };

    const currentMinute = Math.floor(Date.now() / 60_000);
    if (currentMinute !== minute) {
      minute = currentMinute;
      sourceCounts.clear();
    }
    const sourceKey = createHmac("sha256", key)
      .update(publicToken)
      .update("\0")
      .update(requesterIp)
      .digest("base64url");
    const consumed = sourceCounts.get(sourceKey) ?? 0;
    if (
      consumed >= REQUESTS_PER_SOURCE_PER_MINUTE ||
      (consumed === 0 && sourceCounts.size >= MAX_SOURCES_PER_PROCESS_PER_MINUTE)
    )
      return { allowed: false, retryAfterSeconds: 60 - (Math.floor(Date.now() / 1000) % 60) };
    sourceCounts.set(sourceKey, consumed + 1);

    const result = await pool.query(
      `SELECT allowed,retry_after_seconds
       FROM marketplace.consume_affiliate_click_quota($1)`,
      [publicToken],
    );
    const row = result.rows[0] as
      | { allowed: boolean; retry_after_seconds: number | null }
      | undefined;
    if (!row || typeof row.allowed !== "boolean") throw new Error("Invalid affiliate quota result");
    return row.allowed
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds: row.retry_after_seconds ?? 1 };
  };
}
