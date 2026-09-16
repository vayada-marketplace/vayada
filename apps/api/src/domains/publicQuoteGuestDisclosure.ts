import type { Pool } from "pg";
import { lockCurrentQuoteGuestDisclosure } from "./currentQuoteGuestDisclosure.js";

/** Public projection only. The immutable quote, owner policy revision and serialized
 * internal disclosure remain private; the caller must mark its HTTP response no-store. */
export function createPublicQuoteGuestDisclosure(pool: Pool) {
  return {
    async read(slug: string, quoteId: string) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(quoteId))
        return null;
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const current = await lockCurrentQuoteGuestDisclosure(client, slug, quoteId);
        if (!current) return null;
        return {
          version: "public-quote-guest-disclosure.v1" as const,
          quoteId: current.quote.quoteId,
          quoteEvidenceId: current.quoteEvidenceId,
          guestPolicyEvidenceId: current.guestPolicyEvidenceId,
          issuedAt: current.quote.evidence.issuedAt,
          expiresAt: current.quote.evidence.expiresAt,
          checkedAt: current.checkedAt,
          propertyTimeZone: current.disclosure.propertyTimeZone,
          choices: structuredClone(current.disclosure.choices),
        };
      } finally {
        try {
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
    },
  };
}
