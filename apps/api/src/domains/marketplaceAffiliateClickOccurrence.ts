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

/** Internal synthetic capture only. Public redirect/retention gates remain separate. */
export async function recordSyntheticMarketplaceAffiliateClick(
  pool: pg.Pool,
  publicToken: unknown,
  referrer?: unknown,
): Promise<
  | { status: "unavailable" }
  | { status: "recorded"; clickId: string; referenceToken: string; source: Source }
> {
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
    // This synthetic slice has only initial accepted terms. Live capture must resolve replacements.
    const terms = await client.query(
      `SELECT a.terms_id FROM marketplace.affiliate_links l
       JOIN marketplace.affiliate_agreement_activations a ON a.id=l.activation_id
       WHERE l.id=$1 AND l.agreement_id=$2`,
      [link.linkId, link.agreementId],
    );
    if (terms.rowCount !== 1) throw new Error("Missing accepted affiliate terms");
    await client.query(
      `INSERT INTO marketplace.affiliate_click_occurrences
        (id,link_id,property_id,terms_id,reference_token,source,synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE)`,
      [clickId, link.linkId, link.propertyId, terms.rows[0].terms_id, referenceToken, source],
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
