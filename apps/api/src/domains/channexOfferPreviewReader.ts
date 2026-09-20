import type { RequestContext } from "@vayada/backend-auth";
import type { Pool } from "pg";
import { PricingStorageError, readCurrentPricingSnapshot } from "./replacementPricingSnapshot.js";
import { lockReplacementPricingSources } from "./replacementPricingStorageGuard.js";

/** User-authorized metadata only. No delivery-owner, capability or send approval. */
export async function readChannexOfferPreview(
  pool: Pool,
  context: RequestContext,
  propertyId: string,
) {
  const trusted = structuredClone(context);
  const scope = {
    propertyId,
    organizationId: trusted.selectedOrganization.organizationId,
    actorUserId: trusted.actor.internalUserId,
  };
  // pg bounds both new connections and waiting for a pooled connection. Refuse an
  // unbounded pool rather than leave a timed-out acquisition queued in the pool.
  const acquisitionTimeout = pool.options.connectionTimeoutMillis;
  if (
    !Number.isInteger(acquisitionTimeout) ||
    acquisitionTimeout! < 1 ||
    acquisitionTimeout! > 5_000
  )
    throw new Error("Bounded preview pool required");
  const connection = await pool.connect(),
    started = performance.now();
  let committed = false;
  const remaining = () => {
    const ms = Math.floor(5_000 - (performance.now() - started));
    if (ms <= 0) throw new Error("Preview read deadline exceeded");
    return ms;
  };
  // pg supports per-query timeout although its QueryConfig type omits the field.
  const bounded = (text: string, values?: unknown[]) => ({
    text,
    values,
    query_timeout: remaining(),
  });
  // Owner-source helpers share the aggregate budget. Client-side query timeout
  // also bounds transport waits; a failed connection is destroyed in finally.
  const client = new Proxy(connection, {
    get(target, key) {
      if (key !== "query") return Reflect.get(target, key);
      return async (text: string, values?: unknown[]) => {
        await target.query(
          bounded("SELECT set_config('statement_timeout',$1,true)", [`${remaining()}ms`]),
        );
        const result = await target.query(bounded(text, values));
        remaining();
        return result;
      };
    },
  });
  try {
    await connection.query(bounded("BEGIN ISOLATION LEVEL SERIALIZABLE"));
    await client.query("SET LOCAL lock_timeout='150ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
    const sources = await lockReplacementPricingSources(client, trusted, scope, "preview");
    if (!sources) throw new PricingStorageError("denied");
    const snapshot = await readCurrentPricingSnapshot(client, propertyId);
    const result = snapshot && {
      ...snapshot,
      stale:
        Object.keys(snapshot.sources).length !== Object.keys(sources).length ||
        Object.entries(sources).some(([key, value]) => snapshot.sources[key] !== value),
    };
    await client.query("COMMIT");
    committed = true;
    return result;
  } finally {
    // Destroying on failure rolls back server-side work and cannot hang on cleanup.
    connection.release(!committed);
  }
}
