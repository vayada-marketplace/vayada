import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  readMarketplaceAffiliateClick,
  readSyntheticMarketplaceAffiliateClick,
} from "./marketplaceAffiliateClickOccurrence.js";

async function createAffiliateClickContextRow(
  pool: pg.Pool,
  propertyId: string,
  synthetic: boolean,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO booking.affiliate_click_contexts(id,property_id,synthetic)
     VALUES ($1,$2,$3)`,
    [id, propertyId, synthetic],
  );
  return id;
}

/** Dormant live context. Runtime grants and trusted destination resolution remain separate gates. */
export async function createAffiliateClickContext(pool: pg.Pool, propertyId: string) {
  return createAffiliateClickContextRow(pool, propertyId, false);
}

/** Synthetic first-party context retained for the existing integration harness. */
export async function createSyntheticAffiliateClickContext(pool: pg.Pool, propertyId: string) {
  return createAffiliateClickContextRow(pool, propertyId, true);
}

async function admitAffiliateClickOccurrence(
  pool: pg.Pool,
  contextId: string,
  referenceToken: unknown,
  synthetic: boolean,
): Promise<
  | { status: "unavailable" | "conflict" }
  | { status: "admitted"; clickId: string; historyPosition: string; replayed: boolean }
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const context = await client.query(
      `SELECT property_id FROM booking.affiliate_click_contexts
       WHERE id=$1 AND synthetic=$2 FOR UPDATE`,
      [contextId, synthetic],
    );
    const readClick = synthetic
      ? readSyntheticMarketplaceAffiliateClick
      : readMarketplaceAffiliateClick;
    const click = await readClick(client, referenceToken);
    if (!context.rowCount || !click || click.propertyId !== context.rows[0].property_id) {
      await client.query("ROLLBACK");
      return { status: "unavailable" };
    }
    const prior = await client.query(
      `SELECT context_id,history_position FROM booking.affiliate_click_admissions
       WHERE click_id=$1`,
      [click.clickId],
    );
    if (prior.rowCount) {
      await client.query("ROLLBACK");
      if (prior.rows[0].context_id !== contextId) return { status: "conflict" };
      return {
        status: "admitted",
        clickId: click.clickId,
        historyPosition: String(prior.rows[0].history_position),
        replayed: true,
      };
    }
    if (!click.referenceValid) {
      await client.query("ROLLBACK");
      return { status: "unavailable" };
    }
    const inserted = await client.query(
      `INSERT INTO booking.affiliate_click_admissions
         (context_id,property_id,click_id,history_position)
       SELECT $1,$2,$3,COALESCE(MAX(history_position),0)+1
       FROM booking.affiliate_click_admissions WHERE context_id=$1
       ON CONFLICT (click_id) DO NOTHING RETURNING history_position`,
      [contextId, click.propertyId, click.clickId],
    );
    if (!inserted.rowCount) {
      const winner = await client.query(
        `SELECT context_id,history_position FROM booking.affiliate_click_admissions
         WHERE click_id=$1`,
        [click.clickId],
      );
      await client.query("ROLLBACK");
      if (!winner.rowCount || winner.rows[0].context_id !== contextId)
        return { status: "conflict" };
      return {
        status: "admitted",
        clickId: click.clickId,
        historyPosition: String(winner.rows[0].history_position),
        replayed: true,
      };
    }
    // A competing insert may have delayed this transaction past expiry.
    if (!(await readClick(client, referenceToken))?.referenceValid) {
      await client.query("ROLLBACK");
      return { status: "unavailable" };
    }
    await client.query("COMMIT");
    return {
      status: "admitted",
      clickId: click.clickId,
      historyPosition: String(inserted.rows[0].history_position),
      replayed: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Dormant live admission; no public arrival path invokes it in this slice. */
export async function admitAffiliateClick(
  pool: pg.Pool,
  contextId: string,
  referenceToken: unknown,
) {
  return admitAffiliateClickOccurrence(pool, contextId, referenceToken, false);
}

/** Synthetic admission retained for the existing integration harness. */
export async function admitSyntheticAffiliateClick(
  pool: pg.Pool,
  contextId: string,
  referenceToken: unknown,
) {
  return admitAffiliateClickOccurrence(pool, contextId, referenceToken, true);
}
