import pg from "pg";
import type { ApiConfig } from "./config.js";
import { decideChannexAlteration } from "./domains/channexAlterationDecisions.js";
import { createChannexRequestDecisions } from "./integrations/channexRequestDecisions.js";
import { createChannexAlterationFeed } from "./integrations/channexAlterationFeed.js";
import {
  scheduleChannexAlterationScans,
  runChannexAlterationIntake,
} from "./jobs/channexAlterationIntake.js";
import { runChannexAlterationReadback } from "./jobs/channexAlterations.js";

/** Only config validation may enable this property-scoped runtime. No subscriptions are created. */
export function createAirbnbAlterationRuntime(options: {
  config: ApiConfig;
  connectionString: string;
  fetch?: typeof fetch;
}) {
  const { config } = options;
  if (!config.airbnbAlterations) return undefined;
  const propertyIds = config.airbnbAlterations.propertyIds
    ? [...config.airbnbAlterations.propertyIds]
    : undefined;
  const transport = {
    apiBaseUrl: config.channexManagement.apiBaseUrl!,
    apiKey: config.channexManagement.apiKey!,
    fetch: options.fetch,
  };
  const provider = createChannexRequestDecisions(transport);
  const feed = createChannexAlterationFeed(transport);
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: 4,
    connectionTimeoutMillis: 5_000,
  });
  const journalPool = new pg.Pool({
    connectionString: options.connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
    // The server shares equivalent pools; reserve a distinct bounded journal connection.
    application_name: "vayada-airbnb-alteration-journal",
    statement_timeout: 5_000,
  });
  const abort = new AbortController();
  let closed = false;
  let batch: Promise<void> | undefined;
  const decisions = new Set<Promise<unknown>>();
  const ownsMutation = () =>
    !closed &&
    config.backgroundWorkersEnabled &&
    config.channexManagement.workerEnabled &&
    config.channexManagement.capabilityModes.bookingSync === "mutating" &&
    config.channexManagement.bookingMutationOwner === "target";
  return {
    adapter: {
      propertyIds,
      allowUnverifiedAirbnbAlterations: true,
      async decide(input: Parameters<typeof decideChannexAlteration>[1]) {
        if (
          !ownsMutation() ||
          (propertyIds !== undefined && !propertyIds.includes(input.propertyId))
        )
          throw new Error("alteration_runtime_unavailable");
        const pending = decideChannexAlteration(
          { pool, journalPool, provider, allowUnverifiedAirbnbAlterations: true },
          input,
        );
        decisions.add(pending);
        try {
          return await pending;
        } finally {
          decisions.delete(pending);
        }
      },
    },
    bookingWorkerOptions: {
      applyAirbnbAlterations: true,
      allowUnverifiedAirbnbAlterations: true,
      airbnbAlterationPropertyIds: propertyIds,
    },
    webhookOptions: {
      channexAlterationPromotionEnabled: true,
      channexAlterationPropertyIds: propertyIds,
    },
    tick(): Promise<void> {
      if (!ownsMutation()) return Promise.resolve();
      if (batch) return batch;
      batch = (async () => {
        const shared = { pool, propertyIds, ownsMutation, signal: abort.signal };
        await scheduleChannexAlterationScans(shared);
        await runChannexAlterationIntake({ ...shared, provider: feed });
        await runChannexAlterationReadback({ ...shared, provider });
      })().finally(() => {
        batch = undefined;
      });
      return batch;
    },
    async close() {
      closed = true;
      abort.abort();
      await Promise.allSettled([batch, ...decisions]);
      await Promise.all([pool.end(), journalPool.end()]);
    },
  };
}
