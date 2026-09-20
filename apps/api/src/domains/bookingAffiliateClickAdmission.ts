import { randomUUID } from "node:crypto";
import type pg from "pg";
import { readSyntheticMarketplaceAffiliateClick } from "./marketplaceAffiliateClickOccurrence.js";

/** Synthetic first-party context. A live browser context needs a separate privacy gate. */
export async function createSyntheticAffiliateClickContext(
  pool: pg.Pool,
  propertyId: string,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO booking.affiliate_click_contexts(id,property_id,synthetic)
     VALUES ($1,$2,TRUE)`,
    [id, propertyId],
  );
  return id;
}

/** Admit one trusted click to a destination-owned context, never from creator claims. */
export async function admitSyntheticAffiliateClick(
  pool: pg.Pool,
  contextId: string,
  referenceToken: unknown,
): Promise<
  | { status: "unavailable" | "conflict" }
  | { status: "admitted"; clickId: string; historyPosition: string; replayed: boolean }
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const context = await client.query(
      `SELECT property_id FROM booking.affiliate_click_contexts
       WHERE id=$1 AND synthetic=TRUE FOR UPDATE`,
      [contextId],
    );
    const click = await readSyntheticMarketplaceAffiliateClick(client, referenceToken);
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
    if (!(await readSyntheticMarketplaceAffiliateClick(client, referenceToken))?.referenceValid) {
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
