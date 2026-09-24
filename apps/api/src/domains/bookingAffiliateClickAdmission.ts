import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  readMarketplaceAffiliateClick,
  readSyntheticMarketplaceAffiliateClick,
} from "./marketplaceAffiliateClickOccurrence.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AdmissionResult =
  | { status: "unavailable" | "conflict" }
  | { status: "admitted"; clickId: string; historyPosition: string; replayed: boolean };

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

/** Synthetic first-party context retained for the existing integration harness. */
export async function createSyntheticAffiliateClickContext(pool: pg.Pool, propertyId: string) {
  return createAffiliateClickContextRow(pool, propertyId, true);
}

async function admitAffiliateClickOccurrenceInTransaction(
  client: pg.PoolClient,
  contextId: string,
  referenceToken: unknown,
  synthetic: boolean,
  expectedPropertyId?: string,
): Promise<AdmissionResult> {
  const context = await client.query(
    `SELECT property_id FROM booking.affiliate_click_contexts
     WHERE id=$1 AND synthetic=$2
       AND ($3::uuid IS NULL OR property_id=$3)
     FOR UPDATE`,
    [contextId, synthetic, expectedPropertyId ?? null],
  );
  const readClick = synthetic
    ? readSyntheticMarketplaceAffiliateClick
    : readMarketplaceAffiliateClick;
  const click = await readClick(client, referenceToken);
  if (!context.rowCount || !click || click.propertyId !== context.rows[0].property_id)
    return { status: "unavailable" };
  const prior = await client.query(
    `SELECT context_id,history_position FROM booking.affiliate_click_admissions
     WHERE click_id=$1`,
    [click.clickId],
  );
  if (prior.rowCount) {
    if (prior.rows[0].context_id !== contextId) return { status: "conflict" };
    return {
      status: "admitted",
      clickId: click.clickId,
      historyPosition: String(prior.rows[0].history_position),
      replayed: true,
    };
  }
  if (!click.referenceValid) return { status: "unavailable" };
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
    if (!winner.rowCount || winner.rows[0].context_id !== contextId) return { status: "conflict" };
    return {
      status: "admitted",
      clickId: click.clickId,
      historyPosition: String(winner.rows[0].history_position),
      replayed: true,
    };
  }
  // A competing insert may have delayed this transaction past expiry.
  if (!(await readClick(client, referenceToken))?.referenceValid) return { status: "unavailable" };
  return {
    status: "admitted",
    clickId: click.clickId,
    historyPosition: String(inserted.rows[0].history_position),
    replayed: false,
  };
}

async function admitAffiliateClickOccurrence(
  pool: pg.Pool,
  contextId: string,
  referenceToken: unknown,
  synthetic: boolean,
): Promise<AdmissionResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await admitAffiliateClickOccurrenceInTransaction(
      client,
      contextId,
      referenceToken,
      synthetic,
    );
    if (result.status === "admitted") await client.query("COMMIT");
    else await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Dormant native-arrival primitive. The caller must supply a trusted property
 * resolved from the final booking host. A context handle is returned only when
 * the reference is admitted, so a future route cannot persist an orphan cookie.
 */
export async function admitAffiliateArrival(
  pool: pg.Pool,
  input: { propertyId: string; referenceToken: unknown; contextId?: unknown },
): Promise<
  | { status: "unavailable" | "conflict" }
  | {
      status: "admitted";
      contextId: string;
      contextCreated: boolean;
      clickId: string;
      historyPosition: string;
      replayed: boolean;
    }
> {
  if (
    typeof input.propertyId !== "string" ||
    !uuid.test(input.propertyId) ||
    (input.contextId != null &&
      (typeof input.contextId !== "string" || !uuid.test(input.contextId)))
  )
    return { status: "unavailable" };
  const propertyId = input.propertyId.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const admitted = (
      await client.query(
        `SELECT status,context_id,context_created,click_id,history_position,replayed
         FROM booking.admit_affiliate_click($1,$2,$3)`,
        [
          input.referenceToken,
          propertyId,
          typeof input.contextId === "string" ? input.contextId.toLowerCase() : null,
        ],
      )
    ).rows[0] as
      | {
          status: "unavailable" | "conflict" | "admitted";
          context_id: string | null;
          context_created: boolean;
          click_id: string | null;
          history_position: string | null;
          replayed: boolean;
        }
      | undefined;
    if (!admitted) {
      await client.query("ROLLBACK");
      return { status: "unavailable" };
    }
    if (admitted.status !== "admitted") {
      await client.query("ROLLBACK");
      return { status: admitted.status };
    }
    await client.query("COMMIT");
    return {
      status: "admitted",
      contextId: admitted.context_id!,
      contextCreated: admitted.context_created,
      clickId: admitted.click_id!,
      historyPosition: String(admitted.history_position),
      replayed: admitted.replayed,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Synthetic admission retained for the existing integration harness. */
export async function admitSyntheticAffiliateClick(
  pool: pg.Pool,
  contextId: string,
  referenceToken: unknown,
) {
  return admitAffiliateClickOccurrence(pool, contextId, referenceToken, true);
}
