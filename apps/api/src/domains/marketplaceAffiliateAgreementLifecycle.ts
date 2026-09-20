import type pg from "pg";

export type AffiliateAgreementLifecycle =
  | { status: "unavailable" }
  | { status: "invalid_history" }
  | { status: "active" | "paused" | "ended"; revision: number };

/** Read in the caller's transaction when this status gates a write. */
export async function readMarketplaceAffiliateAgreementLifecycle(
  client: pg.PoolClient,
  agreementId: string,
): Promise<AffiliateAgreementLifecycle> {
  const activation = await client.query(
    `SELECT agreement_id FROM marketplace.affiliate_agreement_activations
     WHERE agreement_id=$1 FOR UPDATE`,
    [agreementId],
  );
  if (!activation.rowCount) return { status: "unavailable" };

  const events = (
    await client.query(
      `SELECT revision,action,actor_side
       FROM marketplace.affiliate_agreement_lifecycle_events
       WHERE agreement_id=$1 ORDER BY revision FOR SHARE`,
      [agreementId],
    )
  ).rows as { revision: number; action: string; actor_side: string }[];
  let hotelPaused = false;
  let creatorPaused = false;
  let ended = false;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.revision !== index + 1 || ended) return { status: "invalid_history" };
    if (event.action === "end") {
      ended = true;
      continue;
    }
    const paused = event.actor_side === "hotel" ? hotelPaused : creatorPaused;
    if (
      !["hotel", "creator"].includes(event.actor_side) ||
      (event.action === "pause" && paused) ||
      (event.action === "resume" && !paused) ||
      !["pause", "resume"].includes(event.action)
    )
      return { status: "invalid_history" };
    if (event.actor_side === "hotel") hotelPaused = event.action === "pause";
    else creatorPaused = event.action === "pause";
  }
  return {
    status: ended ? "ended" : hotelPaused || creatorPaused ? "paused" : "active",
    revision: events.length,
  };
}
