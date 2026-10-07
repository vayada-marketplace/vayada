import { createHmac } from "node:crypto";
import { isIPv6 } from "node:net";
import type pg from "pg";

const REQUESTS_PER_SOURCE_PER_MINUTE = 30;
const LOOKUPS_PER_SOURCE_PER_MINUTE = 30;
const MAX_SOURCES_PER_PROCESS_PER_MINUTE = 100_000;

function expandIpv4Tail(ip: string): string {
  const match = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (!match) return ip;
  const octets = match[1].split(".").map(Number);
  return `${ip.slice(0, -match[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${(
    (octets[2] << 8) |
    octets[3]
  ).toString(16)}`;
}

function sourcePrefix(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const [head, tail = ""] = expandIpv4Tail(ip.toLowerCase()).split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map(
    (group) => Number.parseInt(group, 16),
  );
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

export function createMarketplaceAffiliatePublicLinkQuota(pool: pg.Pool, key: string) {
  let minute = -1;
  const sourceCounts = new Map<string, number>();
  const lookupCounts = new Map<string, number>();
  const knownTokens = new Set<string>();
  return async ({ publicToken, requesterIp }: { publicToken: string; requesterIp: string }) => {
    const currentMinute = Math.floor(Date.now() / 60_000);
    if (currentMinute !== minute) {
      minute = currentMinute;
      sourceCounts.clear();
      lookupCounts.clear();
      knownTokens.clear();
    }
    const normalizedSource = sourcePrefix(requesterIp);
    const sourceKey = createHmac("sha256", key)
      .update(publicToken)
      .update("\0")
      .update(normalizedSource)
      .digest("base64url");
    const lookupKey = createHmac("sha256", key).update(normalizedSource).digest("base64url");
    if (!knownTokens.has(publicToken)) {
      const lookups = lookupCounts.get(lookupKey) ?? 0;
      if (
        lookups >= LOOKUPS_PER_SOURCE_PER_MINUTE ||
        (lookups === 0 && lookupCounts.size >= MAX_SOURCES_PER_PROCESS_PER_MINUTE)
      )
        return { allowed: true, known: false };
      lookupCounts.set(lookupKey, lookups + 1);
      const known = await pool.query(
        "SELECT EXISTS(SELECT 1 FROM marketplace.affiliate_links WHERE public_token=$1) AS known",
        [publicToken],
      );
      if (known.rows[0]?.known !== true) return { allowed: true, known: false };
      knownTokens.add(publicToken);
    }

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
      { allowed: boolean; retry_after_seconds: number | null } | undefined;
    if (!row || typeof row.allowed !== "boolean") throw new Error("Invalid affiliate quota result");
    return row.allowed
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds: row.retry_after_seconds ?? 1 };
  };
}
