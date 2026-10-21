import { createHash } from "node:crypto";

import type { RequestContext } from "@vayada/backend-auth";
import pg, { type PoolClient } from "pg";

import type { HotelSetupPropertyActivation } from "../platform/hotelSetupProfileWriter.js";
import type { HotelSetupPropertyProfileUpdate } from "../routes/sharedHotelSetupStatus.js";
import {
  createHotelFirstRunFactsReader,
  type HotelFirstRunFactsPorts,
} from "./hotelFirstRunFacts.js";
import { createHotelFirstRunService, type HotelFirstRunPorts } from "./hotelFirstRunService.js";
import { firstRunIdempotencyKey, type HotelFirstRunActor } from "./hotelFirstRunSteps.js";
import { createReplacementPricingCommands } from "./replacementPricingCommands.js";
import { readCurrentPricingSnapshot } from "./replacementPricingSnapshot.js";

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
  "facts" | "lock" | "locality" | "pricing" | "activation"
> &
  Omit<HotelFirstRunFactsPorts, "language" | "pricing" | "unlockedPricing"> & {
    lockPool: LockPool;
    pricingPool: PricingPool;
    launchSettings: { readDefaultLanguage(propertyId: string): Promise<string | null> };
    profileCommand: HotelSetupPropertyProfileUpdate;
    activateProperty: HotelSetupPropertyActivation;
  };

/** Every lock connection stayed in use for longer than the wait: the run answers "busy" (retry later). */
export class HotelFirstRunLockCapacityError extends Error {
  constructor() {
    super("Every first-run lock connection is in use");
    this.name = "HotelFirstRunLockCapacityError";
  }
}

type LockClient = Pick<pg.Client, "connect" | "query" | "end" | "on">;

/**
 * The lock's connections: one plain client per run, opened for the run and closed after it, outside the
 * API's shared pools (VAY-2247 incident, 2026-10-21). Taking it from a shared pool pinned one of its few
 * connections for the whole run while the run's own steps needed more from the same pool. At most `max`
 * are open at once; a run that can't get one within `waitMs` answers "busy".
 */
export function createDedicatedLockConnections(
  connectionString: string,
  {
    max = 3,
    waitMs = 3_000,
    createClient = () => new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 }),
  }: { max?: number; waitMs?: number; createClient?: () => LockClient } = {},
): LockPool {
  let open = 0;
  const waiting: (() => void)[] = [];
  const free = () => {
    open -= 1;
    waiting.shift()?.();
  };
  const acquire = () =>
    new Promise<void>((resolve, reject) => {
      if (open < max) {
        open += 1;
        resolve();
        return;
      }
      const grant = () => {
        clearTimeout(timer);
        open += 1;
        resolve();
      };
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(grant), 1);
        reject(new HotelFirstRunLockCapacityError());
      }, waitMs);
      waiting.push(grant);
    });
  return {
    async connect() {
      await acquire();
      const client = createClient();
      // A dropped connection fails the lock's queries instead of exiting the process.
      client.on("error", () => undefined);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        free();
        void client.end().catch(() => undefined);
      };
      try {
        await client.connect();
      } catch (error) {
        release();
        throw error;
      }
      return { query: client.query.bind(client) as PoolClient["query"], release };
    },
  };
}

/**
 * The current prices in a read-only snapshot: no advisory lock and no row lock, unlike the pricing commands'
 * read (VAY-2247 incident, 2026-10-21). The checklist route has already checked the owner's access.
 */
export function createUnlockedPricingRead(
  pool: Pick<PricingPool, "connect">,
): HotelFirstRunFactsPorts["unlockedPricing"] {
  return {
    async read(propertyId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const current = await readCurrentPricingSnapshot(client, propertyId.toLowerCase());
        await client.query("COMMIT");
        return current;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** Holds a session advisory lock on its own connection for the whole run; "busy" when another run holds it. */
export function createHotelFirstRunLock(pool: LockPool): HotelFirstRunPorts["lock"] {
  return {
    async withPropertyLock(propertyId, work) {
      let client: Awaited<ReturnType<LockPool["connect"]>>;
      try {
        client = await pool.connect();
      } catch (error) {
        if (error instanceof HotelFirstRunLockCapacityError) return "busy";
        throw error;
      }
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

/** Makes the hotel live at the end of the first run through the owner's activation (VAY-2247 1.5). */
export function createHotelFirstRunActivation(
  context: RequestContext,
  activate: HotelSetupPropertyActivation,
): HotelFirstRunPorts["activation"] {
  return {
    async activateWhenComplete(actor: HotelFirstRunActor) {
      const result = await activate(context, actor.propertyId);
      if (result.status === "activated") return { ok: true, activated: true };
      if (result.status === "already_active") return { ok: true, activated: false };
      return {
        ok: false,
        code:
          result.status === "incomplete"
            ? "first_run_profile_incomplete"
            : "first_run_hotel_not_provisioning",
      };
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
    const facts = createHotelFirstRunFactsReader({
      ...deps,
      language,
      pricing,
      unlockedPricing: createUnlockedPricingRead(deps.pricingPool),
    });
    return createHotelFirstRunService({
      ...deps,
      pricing,
      facts,
      lock,
      locality: createHotelFirstRunLocality(context, deps.profile, deps.profileCommand),
      activation: createHotelFirstRunActivation(context, deps.activateProperty),
    });
  };
}
