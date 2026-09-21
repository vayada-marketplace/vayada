import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { readMarketplaceAffiliateLinkEligibility } from "./marketplaceAffiliateLinkEligibility.js";

type Source = "instagram" | "tiktok" | "youtube" | "facebook" | "x" | "unknown";

/** Browser referrer is advisory traffic metadata, never beneficiary evidence. */
export function affiliateTrafficSource(referrer: unknown): Source {
  if (typeof referrer !== "string" || !referrer) return "unknown";
  let hostname: string;
  try {
    const url = new URL(referrer);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "unknown";
    hostname = url.hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
  if (matches("instagram.com")) return "instagram";
  if (matches("tiktok.com")) return "tiktok";
  if (matches("youtube.com") || matches("youtu.be")) return "youtube";
  if (matches("facebook.com") || matches("fb.com")) return "facebook";
  if (matches("x.com") || matches("twitter.com")) return "x";
  return "unknown";
}

type ClickResult =
  | { status: "unavailable" }
  | { status: "recorded"; clickId: string; referenceToken: string; source: Source };

async function recordMarketplaceAffiliateClickOccurrence(
  pool: pg.Pool,
  publicToken: unknown,
  referrer: unknown,
  synthetic: boolean,
): Promise<ClickResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const link = await readMarketplaceAffiliateLinkEligibility(client, publicToken);
    if (link.status !== "eligible") {
      await client.query("ROLLBACK");
      return { status: "unavailable" };
    }
    const source = affiliateTrafficSource(referrer);
    const clickId = randomUUID();
    const referenceToken = `vc_${randomBytes(16).toString("base64url")}`;
    await client.query(
      `INSERT INTO marketplace.affiliate_click_occurrences
        (id,link_id,property_id,terms_id,reference_token,source,synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [clickId, link.linkId, link.propertyId, link.termsId, referenceToken, source, synthetic],
    );
    await client.query("COMMIT");
    return { status: "recorded", clickId, referenceToken, source };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Dormant server-owned occurrence; runtime grants and public routing remain separate gates. */
export async function recordMarketplaceAffiliateClick(
  pool: pg.Pool,
  publicToken: unknown,
  referrer?: unknown,
): Promise<ClickResult> {
  return recordMarketplaceAffiliateClickOccurrence(pool, publicToken, referrer, false);
}

/** Internal synthetic capture retained for the existing integration harness. */
export async function recordSyntheticMarketplaceAffiliateClick(
  pool: pg.Pool,
  publicToken: unknown,
  referrer?: unknown,
): Promise<ClickResult> {
  return recordMarketplaceAffiliateClickOccurrence(pool, publicToken, referrer, true);
}

async function readMarketplaceAffiliateClickOccurrence(
  client: pg.PoolClient,
  referenceToken: unknown,
  synthetic: boolean,
): Promise<{ clickId: string; propertyId: string; referenceValid: boolean } | null> {
  if (typeof referenceToken !== "string" || !/^vc_[A-Za-z0-9_-]{22}$/.test(referenceToken))
    return null;
  const result = await client.query(
    `SELECT id,property_id,
            clicked_at > clock_timestamp() - interval '15 minutes' AS reference_valid
     FROM marketplace.affiliate_click_occurrences
     WHERE reference_token=$1 AND synthetic=$2 FOR SHARE`,
    [referenceToken, synthetic],
  );
  if (!result.rowCount) return null;
  return {
    clickId: result.rows[0].id,
    propertyId: result.rows[0].property_id,
    referenceValid: result.rows[0].reference_valid,
  };
}

/** Trusted Marketplace proof consumed by Booking for a live arrival. */
export async function readMarketplaceAffiliateClick(
  client: pg.PoolClient,
  referenceToken: unknown,
) {
  return readMarketplaceAffiliateClickOccurrence(client, referenceToken, false);
}

/** Marketplace-owned proof for the synthetic Booking transport test path. */
export async function readSyntheticMarketplaceAffiliateClick(
  client: pg.PoolClient,
  referenceToken: unknown,
) {
  return readMarketplaceAffiliateClickOccurrence(client, referenceToken, true);
}
