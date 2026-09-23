import type pg from "pg";
import { parseMarketplaceAffiliateLink } from "@vayada/domain-marketplace";
import { buildNativeAffiliateArrivalRedirect } from "./bookingAffiliateNativeDestinationSafety.js";
import {
  readAffiliateReferralRoundTripReadiness,
  type AffiliateReferralReadiness,
} from "./bookingAffiliateReferralReadiness.js";
import type { affiliateTrafficSource } from "./marketplaceAffiliateClickOccurrence.js";
import { readMarketplaceAffiliateVisitScope } from "./marketplaceAffiliateVisitScope.js";

type Scope = Extract<
  Awaited<ReturnType<typeof readMarketplaceAffiliateVisitScope>>,
  { status: "eligible" }
>;
type ReadinessInput = Parameters<typeof readAffiliateReferralRoundTripReadiness>[1];
type Configuration = Omit<ReadinessInput, "propertyId" | "destinationVersionId" | "organizationId">;
type ConfigurationPort = (
  client: pg.PoolClient,
  scope: Pick<Scope, "propertyId" | "destinationVersionId" | "organizationId">,
) => Promise<Configuration | undefined>;
type ReadinessPort = (
  client: pg.PoolClient,
  input: ReadinessInput,
) => Promise<AffiliateReferralReadiness>;

const sources = new Set(["instagram", "tiktok", "youtube", "facebook", "x", "unknown"]);

/** Normal earning visit only. No production configuration or public route is wired. */
export async function createMarketplaceAffiliateVisit(
  pool: pg.Pool,
  input: {
    publicToken: unknown;
    campaignLabel: unknown;
    source: ReturnType<typeof affiliateTrafficSource>;
  },
  configuration: ConfigurationPort = async () => undefined,
  readReadiness: ReadinessPort = readAffiliateReferralRoundTripReadiness,
): Promise<{ status: "unavailable" } | { status: "ready"; redirectUrl: string }> {
  const parsed = parseMarketplaceAffiliateLink(input.publicToken, input.campaignLabel);
  if (!parsed.ok || !sources.has(input.source)) return { status: "unavailable" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const scope = await readMarketplaceAffiliateVisitScope(client, parsed.publicToken);
    if (scope.status !== "eligible") {
      await client.query("ROLLBACK");
      return { status: "unavailable" };
    }
    const destination = {
      propertyId: scope.propertyId,
      organizationId: scope.organizationId,
      destinationVersionId: scope.destinationVersionId,
    };
    const captured = (
      await client.query(
        `SELECT click_id,link_id,property_id,terms_id,reference_token
         FROM marketplace.capture_affiliate_click($1,$2,$3)`,
        [parsed.publicToken, input.source, parsed.campaignLabel],
      )
    ).rows[0] as
      | {
          click_id: string;
          link_id: string;
          property_id: string;
          terms_id: string;
          reference_token: string;
        }
      | undefined;
    if (!captured) {
      await client.query("ROLLBACK");
      return { status: "unavailable" };
    }
    if (
      captured.link_id !== scope.linkId ||
      captured.property_id !== scope.propertyId ||
      captured.terms_id !== scope.termsId
    )
      throw new Error("Invalid affiliate click capture scope");
    const referenceToken = captured.reference_token;
    const redirect = await buildNativeAffiliateArrivalRedirect(client, destination, referenceToken);
    if (redirect.status !== "ready") {
      await client.query("ROLLBACK");
      return { status: "unavailable" };
    }
    const selected = await configuration(client, destination);
    if (!selected) {
      await client.query("ROLLBACK");
      return { status: "unavailable" };
    }
    const readiness = await readReadiness(client, { ...selected, ...destination });
    if (readiness.status !== "ready") {
      await client.query("ROLLBACK");
      return { status: "unavailable" };
    }
    await client.query("COMMIT");
    return { status: "ready", redirectUrl: redirect.redirectUrl };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
