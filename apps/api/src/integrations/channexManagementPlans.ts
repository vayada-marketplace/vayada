import pg from "pg";

import { applyPmsChannexManagementProgress } from "../jobs/pmsChannexManagementTargetState.js";
import type { ChannexManagementJob } from "../jobs/pmsChannexManagementWorker.js";
import {
  channexRequests,
  type ChannexManagementActionPlan,
  type ChannexManagementPlanPort,
} from "./channexManagement.js";

type Pool = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  connect(): Promise<Pick<Pool, "query"> & { release(error?: Error | boolean): void }>;
  end(): Promise<void>;
};
type PropertyRow = {
  title: string;
  currency: string;
  propertyType: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  zipCode: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
};
type BindingRow = {
  externalPropertyId: string | null;
  claimExternalPropertyId: string | null;
  claimState: string | null;
};

export type ChannexBookingRevisionHandoff = (input: {
  propertyId: string;
  providerPropertyId: string;
  revisions: unknown[];
}) => Promise<void>;

export function createPgChannexManagementPlanPort(config: {
  connectionString: string;
  bookingRevisionHandoff: ChannexBookingRevisionHandoff;
  stagingMealsPropertyId?: string;
  pool?: Pool;
  now?: () => Date;
}): ChannexManagementPlanPort & { close(): Promise<void> } {
  const pool =
    config.pool ?? new pg.Pool({ connectionString: required(config.connectionString), max: 5 });
  async function preparePlan(planPool: Pool, job: ChannexManagementJob) {
    const result = await plan(
      planPool,
      config.bookingRevisionHandoff,
      job,
      config.now?.() ?? new Date(),
    );
    if (
      config.stagingMealsPropertyId === job.propertyId &&
      job.input.operationType === "provision" &&
      job.input.mealRatePlanId
    ) {
      const meals =
        result.meals?.filter((meal) => meal.externalRatePlanId && meal.externalRoomTypeId) ?? [];
      if (!meals.length)
        throw new Error("Staging meal reconciliation requires an existing mapped rate");
      return { ...result, requests: [], meals };
    }
    return result;
  }
  return {
    async withPropertyLock(job, work) {
      const client = await pool.connect();
      let locked = false;
      try {
        const result = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
          [`channex.management:${job.propertyId}`],
        );
        locked = result.rows[0]?.locked === true;
        if (!locked)
          throw new Error("Another Channex operation is running for this property. Retry shortly.");
        const lockedPool: Pool = {
          query: client.query.bind(client),
          connect: async () => ({ query: client.query.bind(client), release() {} }),
          end: async () => {},
        };
        return await work(() => preparePlan(lockedPool, job));
      } finally {
        try {
          if (locked)
            await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
              `channex.management:${job.propertyId}`,
            ]);
        } catch (error) {
          client.release(true);
          throw error;
        }
        client.release();
      }
    },
    plan: (job) => preparePlan(pool, job),
    async close() {
      await pool.end();
    },
  };
}

async function basePlan(
  pool: Pool,
  handoff: ChannexBookingRevisionHandoff,
  job: ChannexManagementJob,
  now: Date,
): Promise<ChannexManagementActionPlan> {
  const binding = await connectionBinding(pool, job.propertyId);
  const externalPropertyId = activeExternalPropertyId(binding);
  if (job.input.operationType === "enable") {
    if (!externalPropertyId && binding?.claimExternalPropertyId)
      throw new Error("A retained Channex binding claim requires audited repair");
    return externalPropertyId ? { externalPropertyId, requests: [] } : enablePlan(pool, job);
  }
  if (job.input.operationType === "disable") {
    return externalPropertyId
      ? {
          externalPropertyId,
          requests: [channexRequests.deleteProperty(externalPropertyId)],
          checkpoint: checkpoint(pool, job),
        }
      : { requests: [] };
  }
  if (!externalPropertyId) throw new Error("Channex connection is not enabled");
  if (job.input.operationType === "update_inventory_rules") {
    const state = await pool.query<{
      rules: import("@vayada/domain-pms-channex").ChannexInventoryRule[];
    }>(
      `SELECT connection_metadata -> 'inventoryRules' -> 'rules' AS rules
       FROM pms.channel_connections WHERE property_id = $1::uuid AND provider = 'channex'`,
      [job.propertyId],
    );
    const mappings = await pool.query<{ id: string; externalId: string }>(
      `SELECT mapping.room_type_id::text AS id, mapping.external_room_type_id AS "externalId"
       FROM pms.channel_room_type_mappings mapping JOIN pms.channel_connections connection
         ON connection.id = mapping.connection_id AND connection.property_id = mapping.property_id
         AND connection.provider = 'channex'
       JOIN pms.room_types room ON room.id = mapping.room_type_id AND room.property_id = mapping.property_id
       WHERE mapping.property_id = $1::uuid AND mapping.status = 'active' AND room.active
         AND NOT EXISTS (SELECT 1 FROM pms.room_type_closures closure
           WHERE closure.property_id=room.property_id AND closure.room_type_id=room.id)`,
      [job.propertyId],
    );
    if (!state.rows[0]?.rules) throw new Error("Desired inventory rules are missing");
    return {
      requests: [],
      externalPropertyId,
      inventoryRules: {
        propertyId: job.propertyId,
        externalPropertyId,
        rules: state.rows[0].rules,
        roomMappings: Object.fromEntries(mappings.rows.map((row) => [row.id, row.externalId])),
      },
    };
  }
  if (job.input.operationType === "provision") {
    return provisioningPlan(pool, job, externalPropertyId);
  }
  if (job.input.operationType === "sync_ari" || job.input.operationType === "update_markups") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await ariPlan(client, job, externalPropertyId, now);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  if (job.input.operationType === "sync_bookings") {
    return {
      externalPropertyId,
      requests: [channexRequests.bookingRevisionFeed(externalPropertyId)],
      bookingRevisionHandoff: (revisions) =>
        handoff({ propertyId: job.propertyId, providerPropertyId: externalPropertyId, revisions }),
    };
  }
  return {
    externalPropertyId,
    requests: [
      channexRequests.listInstalledApplications(externalPropertyId),
      channexRequests.installMessaging(externalPropertyId),
    ],
    checkpoint: checkpoint(pool, job),
  };
}

async function enablePlan(
  pool: Pool,
  job: ChannexManagementJob,
): Promise<ChannexManagementActionPlan> {
  const result = await pool.query<PropertyRow>(
    `SELECT property.display_name AS title, COALESCE(room.currency, 'EUR') AS currency,
       property.property_type AS "propertyType", location.country_code AS country,
       location.city, location.street_address AS address, location.postal_code AS "zipCode",
       location.latitude::float8 AS latitude, location.longitude::float8 AS longitude,
       location.timezone
     FROM hotel_catalog.properties property
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
     LEFT JOIN LATERAL (
       SELECT currency FROM pms.room_types WHERE property_id = property.id AND active LIMIT 1
     ) room ON TRUE WHERE property.id = $1::uuid`,
    [job.propertyId],
  );
  const property = result.rows[0];
  if (!property) throw new Error("Target property was not found");
  const providerPropertyTitle = providerTitle(property.title, job.propertyId);
  return {
    requests: [
      channexRequests.findProperty(providerPropertyTitle),
      channexRequests.createProperty(
        compact({
          title: providerPropertyTitle,
          currency: property.currency,
          property_type: property.propertyType,
          country: property.country,
          city: property.city,
          address: property.address,
          zip_code: property.zipCode,
          latitude: property.latitude,
          longitude: property.longitude,
          timezone: property.timezone,
          settings: { min_stay_type: "arrival" },
        }),
      ),
    ],
    checkpoint: checkpoint(pool, job),
  };
}

async function provisioningPlan(
  pool: Pool,
  job: ChannexManagementJob,
  externalPropertyId: string,
): Promise<ChannexManagementActionPlan> {
  throw Object.assign(
    new Error("Pricing is unavailable while the TypeScript pricing system is rebuilt."),
    { statusCode: 503, code: "PRICING_UNAVAILABLE" },
  );
}

async function ariPlan(
  pool: Pick<Pool, "query">,
  job: ChannexManagementJob,
  externalPropertyId: string,
  now: Date,
): Promise<ChannexManagementActionPlan> {
  throw Object.assign(
    new Error("Pricing is unavailable while the TypeScript pricing system is rebuilt."),
    { statusCode: 503, code: "PRICING_UNAVAILABLE" },
  );
}

function checkpoint(pool: Pool, job: ChannexManagementJob) {
  return async (progress: Parameters<typeof applyPmsChannexManagementProgress>[2]) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await applyPmsChannexManagementProgress(client, job, progress, new Date());
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
}

function providerTitle(title: string, identity: string) {
  const marker = ` [Vayada:${identity}]`;
  return `${Array.from(title)
    .slice(0, Math.max(0, 255 - marker.length))
    .join("")}${marker}`;
}

async function connectionBinding(pool: Pool, propertyId: string): Promise<BindingRow | null> {
  const result = await pool.query<BindingRow>(
    `SELECT connection.external_property_id AS "externalPropertyId",
       claim.external_property_id AS "claimExternalPropertyId", claim.claim_state AS "claimState"
     FROM hotel_catalog.properties property
     LEFT JOIN pms.channel_connections connection
       ON connection.property_id = property.id AND connection.provider = 'channex'
     LEFT JOIN pms.channel_binding_claims claim
       ON claim.property_id = property.id AND claim.provider = 'channex'
     WHERE property.id = $1::uuid`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

function activeExternalPropertyId(binding: BindingRow | null): string | null {
  if (!binding?.externalPropertyId) return null;
  if (
    binding.claimState !== "active" ||
    binding.claimExternalPropertyId !== binding.externalPropertyId
  )
    throw new Error("Channex binding claim is not active");
  return binding.externalPropertyId;
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined),
  );
}

function required(value: string) {
  if (!value.trim()) throw new Error("Channex connectionString must not be empty");
  return value;
}

async function plan(
  pool: Pool,
  handoff: ChannexBookingRevisionHandoff,
  job: ChannexManagementJob,
  now: Date,
): Promise<ChannexManagementActionPlan> {
  const result = await basePlan(pool, handoff, job, now);
  if (!job.input.recoveryAlertId) return result;
  const alert = (
    await pool.query<{
      eventType: string;
      channelId: string | null;
      impact: Record<string, string | null>;
    }>(
      `SELECT alert.event_type AS "eventType",alert.impact->>'channelId' AS "channelId",alert.impact FROM pms.channel_operational_alerts alert JOIN pms.channel_connections connection ON connection.id=alert.connection_id AND connection.binding_generation=alert.binding_generation WHERE alert.id=$1::uuid AND alert.property_id=$2::uuid AND connection.external_property_id=$3`,
      [job.input.recoveryAlertId, job.propertyId, result.externalPropertyId],
    )
  ).rows[0];
  if (!alert) throw new Error("Alert connection is no longer owned by this property");
  if (alert.eventType === "disconnected_channel" && !alert.channelId)
    throw new Error("Channel identity is unknown; contact support");
  result.verifyRecovery = true;
  result.recoveryScopeCovered =
    alert.eventType === "disconnected_channel" || coversAlertScope(result, alert.impact);
  if (alert.channelId) result.recoveryChannelId = alert.channelId;
  if (result.bookingRevisionHandoff) {
    const ingest = result.bookingRevisionHandoff;
    result.bookingRevisionHandoff = async (revisions) => {
      // Keep exact revision identities across attempts after acknowledged feed entries disappear.
      const ids = revisions
        .map((value) => String((value as { id?: unknown })?.id ?? ""))
        .filter(Boolean);
      await pool.query(
        `UPDATE platform.jobs SET job_metadata=job_metadata || jsonb_build_object('recoveryRevisionIds',(SELECT COALESCE(jsonb_agg(DISTINCT entries.value),'[]'::jsonb) FROM jsonb_array_elements_text(COALESCE(job_metadata->'recoveryRevisionIds','[]'::jsonb)||$2::jsonb) AS entries(value))) WHERE id=$1::uuid`,
        [job.jobId, JSON.stringify(ids)],
      );
      await ingest(revisions);
      const pending = (
        await pool.query<{ pending: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(parent.job_metadata->'recoveryRevisionIds','[]'::jsonb)) AS expected(revision_id) WHERE NOT EXISTS(SELECT 1 FROM platform.jobs child WHERE child.job_type='channex.ingest-booking' AND child.payload->>'propertyId'=$2 AND child.payload->>'providerPropertyId'=$3 AND child.payload->>'revision'=expected.revision_id AND child.status='succeeded')) AS pending FROM platform.jobs parent WHERE parent.id=$1::uuid`,
          [job.jobId, job.propertyId, result.externalPropertyId],
        )
      ).rows[0];
      if (!pending || pending.pending)
        throw new Error(
          "Booking revisions are still processing. Recovery will retry automatically.",
        );
    };
  }
  return result;
}

export function coversAlertScope(
  plan: ChannexManagementActionPlan,
  impact: Record<string, string | null>,
): boolean {
  const from = impact.dateFrom,
    to = impact.dateTo;
  if (!from || !to || (!impact.roomTypeId && !impact.ratePlanId)) return false;
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!Number.isInteger(days) || days < 0 || days > 365) return false;
  for (let offset = 0; offset <= days; offset++) {
    const date = new Date(Date.parse(from) + offset * 86_400_000).toISOString().slice(0, 10);
    for (const [field, id, path] of [
      ["room_type_id", impact.roomTypeId, "/api/v1/availability"],
      ["rate_plan_id", impact.ratePlanId, "/api/v1/restrictions"],
    ] as const) {
      if (!id) continue;
      const covered = plan.requests.some(
        (request) =>
          request.path === path &&
          ((request.body as { values?: Array<Record<string, unknown>> })?.values ?? []).some(
            (value) => value[field] === id && value.date_from === date && value.date_to === date,
          ),
      );
      if (!covered) return false;
    }
  }
  return true;
}
