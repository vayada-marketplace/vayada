import {
  BOOKING_GUEST_POLICY_AUTHORIZATION,
  type BookingGuestPolicyScopeAuthorizationPort,
} from "@vayada/domain-booking";
import type { Pool, PoolClient } from "pg";

type Scope = { propertyId: string; organizationId: string; actorUserId: string };
export const BOOKING_GUEST_TERMS_MAX_LENGTH = 20_000;
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function parseTerms(text: unknown): string | null {
  if (
    !(text === null || typeof text === "string") ||
    (text?.length ?? 0) > BOOKING_GUEST_TERMS_MAX_LENGTH
  )
    throw new Error("invalid_guest_terms");
  return text?.trim() || null;
}

/**
 * The hotel's guest Terms & Conditions (VAY-2176). Writes only that column: the full booking
 * settings write also advances the hotel profile revision, which would make setup drafts stale.
 */
export function createBookingGuestTermsStore(
  pool: Pool,
  authorization: (client: PoolClient) => BookingGuestPolicyScopeAuthorizationPort,
) {
  async function authorized<T>(
    scope: Scope,
    run: (client: PoolClient, propertyId: string) => Promise<T>,
  ) {
    if (![scope.propertyId, scope.organizationId, scope.actorUserId].every(uuid))
      throw new Error("invalid_guest_terms");
    const target = {
      propertyId: scope.propertyId.toLowerCase(),
      organizationId: scope.organizationId.toLowerCase(),
      actorUserId: scope.actorUserId.toLowerCase(),
    };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
      if (
        !(await authorization(client).authorizeGuestPolicyScope({
          ...target,
          ...BOOKING_GUEST_POLICY_AUTHORIZATION,
          checkedAt: now.toISOString(),
        }))
      )
        throw new Error("guest_terms_denied");
      const result = await run(client, target.propertyId);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    read: (scope: Scope) =>
      authorized(scope, async (client, propertyId) => {
        const row = (
          await client.query(
            "SELECT terms_and_conditions FROM hotel_catalog.property_policy_summaries WHERE property_id=$1",
            [propertyId],
          )
        ).rows[0];
        return { termsText: (row?.terms_and_conditions as string | null | undefined) ?? null };
      }),
    /**
     * Blank text clears the terms. `expected` is the text the caller loaded: a save over terms
     * changed elsewhere (for example in booking settings) is refused instead of overwriting them.
     */
    async save(scope: Scope, text: unknown, expected: unknown) {
      const termsText = parseTerms(text),
        expectedText = parseTerms(expected);
      return authorized(scope, async (client, propertyId) => {
        const row = (
          await client.query(
            "SELECT terms_and_conditions FROM hotel_catalog.property_policy_summaries WHERE property_id=$1 FOR UPDATE",
            [propertyId],
          )
        ).rows[0];
        const current = (row?.terms_and_conditions as string | null | undefined)?.trim() || null;
        if (current !== expectedText) throw new Error("guest_terms_stale");
        if (current === termsText) return { termsText };
        // A property without a policy row gets one only for real terms; a concurrent insert of
        // other terms wins and makes this save stale.
        const written = await client.query(
          row
            ? `UPDATE hotel_catalog.property_policy_summaries
                 SET terms_and_conditions=$2, updated_at=now() WHERE property_id=$1`
            : `INSERT INTO hotel_catalog.property_policy_summaries(property_id,terms_and_conditions)
               VALUES($1,$2)
               ON CONFLICT(property_id) DO UPDATE
               SET terms_and_conditions=EXCLUDED.terms_and_conditions, updated_at=now()
               WHERE hotel_catalog.property_policy_summaries.terms_and_conditions IS NULL`,
          [propertyId, termsText],
        );
        if (written.rowCount !== 1) throw new Error("guest_terms_stale");
        return { termsText };
      });
    },
  };
}
