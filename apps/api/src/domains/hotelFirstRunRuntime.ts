import { createHash } from "node:crypto";

import type { RequestContext } from "@vayada/backend-auth";
import type { PoolClient } from "pg";

import type { HotelSetupPropertyProfileUpdate } from "../routes/sharedHotelSetupStatus.js";
import {
  createHotelFirstRunFactsReader,
  type HotelFirstRunFactsPorts,
} from "./hotelFirstRunFacts.js";
import { createHotelFirstRunService, type HotelFirstRunPorts } from "./hotelFirstRunService.js";
import { firstRunIdempotencyKey, type HotelFirstRunActor } from "./hotelFirstRunSteps.js";
import { createReplacementPricingCommands } from "./replacementPricingCommands.js";

/**
 * VAY-2247: puts the first run together from the API's existing runtimes, per request (the pricing
 * commands bind the signed-in context). Adds the three adapters the first run needs: a per-property lock,
 * the hotel's booking language, and "show city and country" through the owner's hotel profile writer.
 */

/** Advisory-lock namespace for the first run (one run per property at a time). */
export const HOTEL_FIRST_RUN_LOCK_NAMESPACE = 2247;

type LockPool = { connect(): Promise<Pick<PoolClient, "query" | "release">> };
type PricingPool = Parameters<typeof createReplacementPricingCommands>[0];

export type HotelFirstRunRuntimeDependencies = Omit<
  HotelFirstRunPorts,
  "facts" | "lock" | "locality" | "pricing"
> &
  Omit<HotelFirstRunFactsPorts, "language" | "pricing"> & {
    lockPool: LockPool;
    pricingPool: PricingPool;
    launchSettings: { readDefaultLanguage(propertyId: string): Promise<string | null> };
    profileCommand: HotelSetupPropertyProfileUpdate;
  };

/** Holds a session advisory lock on its own connection for the whole run; "busy" when another run holds it. */
export function createHotelFirstRunLock(pool: LockPool): HotelFirstRunPorts["lock"] {
  return {
    async withPropertyLock(propertyId, work) {
      const client = await pool.connect();
      try {
        const locked = await client.query(
          "SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS locked",
          [HOTEL_FIRST_RUN_LOCK_NAMESPACE, propertyId],
        );
        if (!locked.rows[0]?.locked) return "busy";
        try {
          return await work();
        } finally {
          await client.query("SELECT pg_advisory_unlock($1::int, hashtext($2))", [
            HOTEL_FIRST_RUN_LOCK_NAMESPACE,
            propertyId,
          ]);
        }
      } finally {
        client.release();
      }
    },
  };
}

/** Turns on "show city and country" through the owner's profile writer (it re-locks owner authority). */
export function createHotelFirstRunLocality(
  context: RequestContext,
  profiles: HotelFirstRunFactsPorts["profile"],
  update: HotelSetupPropertyProfileUpdate,
): HotelFirstRunPorts["locality"] {
  return {
    async showCityAndCountry(actor: HotelFirstRunActor) {
      const current = await profiles.getPropertyProfile({
        organizationId: actor.organizationId,
        propertyId: actor.propertyId,
      });
      if (!current) return { ok: false, code: "property_profile_missing" };
      if (current.profile.location.localityPublic) return { ok: true };
      const result = await update(context, actor.propertyId, {
        idempotencyKey: firstRunIdempotencyKey(
          actor.propertyId,
          "locality",
          current.profileRevision,
        ),
        fingerprint: createHash("sha256")
          .update(JSON.stringify(["hotel_first_run_locality", current.profileRevision]))
          .digest("hex"),
        merge: (existing) => ({
          expectedProfileRevision: current.profileRevision,
          profile: { ...existing, location: { ...existing.location, localityPublic: true } },
        }),
      });
      return result.status === "updated" || result.status === "replayed"
        ? { ok: true }
        : { ok: false, code: `first_run_locality_${result.status}` };
    },
  };
}

export function createHotelFirstRunRuntime(deps: HotelFirstRunRuntimeDependencies) {
  const lock = createHotelFirstRunLock(deps.lockPool);
  const language = {
    read: (propertyId: string) => deps.launchSettings.readDefaultLanguage(propertyId),
  };
  return function createService(context: RequestContext) {
    const pricing = createReplacementPricingCommands(deps.pricingPool, context);
    const facts = createHotelFirstRunFactsReader({ ...deps, language, pricing });
    return createHotelFirstRunService({
      ...deps,
      pricing,
      facts,
      lock,
      locality: createHotelFirstRunLocality(context, deps.profile, deps.profileCommand),
    });
  };
}
