import {
  applyBookingPriceMarkup,
  createBookingNightlyRoomPriceResolver,
  evaluateSameDayBooking,
  propertyLocalClock,
  SAME_DAY_BOOKING_POLICY_DEFAULTS,
} from "@vayada/domain-booking";
import pg from "pg";
import { loadPmsPricingSourceSnapshot } from "../domains/pmsPricingReadModel.js";
import { loadPmsRecurringPricingBookingEvidence } from "../domains/pmsRecurringPricingReadModel.js";
import {
  CHANNEX_ARI_ACTIVE_ROOM_SQL,
  CHANNEX_ARI_MAPPING_MISSING_SQL,
} from "../domains/pmsChannexAriMapping.js";

import type { ChannexManagementJob } from "../jobs/pmsChannexManagementWorker.js";
import { applyPmsChannexManagementProgress } from "../jobs/pmsChannexManagementTargetState.js";
import {
  ChannexAriMappingMissingError,
  channexRequests,
  type ChannexManagementActionPlan,
  type ChannexManagementPlanPort,
} from "./channexManagement.js";

type Pool = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  connect(): Promise<Pick<Pool, "query"> & { release(): void }>;
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
type RoomRow = {
  roomTypeId: string;
  name: string;
  currency: string;
  countOfRooms: number;
  adults: number;
  children: number;
};
type RateRow = {
  roomTypeId: string;
  roomTypeName: string;
  ratePlanId: string;
  name: string;
  currency: string;
  sellMode: "per_room" | "per_person";
  baseRate: number;
  channel: string;
  channelLabel: string;
  markupPercent: number;
  defaultOccupancy: number;
  externalRoomTypeId: string | null;
  externalRatePlanId: string | null;
  mealPlan: string | null;
  pricingContractVersion: string | null;
};
type AriRow = {
  mappingMissing: boolean;
  restrictions: Record<string, number | boolean>;
  stayDate: string;
  available: number;
  externalRoomTypeId: string;
  externalRatePlanId: string;
  roomTypeId: string;
  ratePlanId: string;
  roomFactsRevision: number;
  planActive: boolean;
  datePrice: { amountDecimal: string; currency: string } | null;
  channel: string;
  markupPercent: number;
};
type SameDayPolicyRow = {
  timezone: string | null;
  enabled: boolean;
  cutoffLocalTime: string | null;
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
  pool?: Pool;
  now?: () => Date;
}): ChannexManagementPlanPort & { close(): Promise<void> } {
  const pool =
    config.pool ?? new pg.Pool({ connectionString: required(config.connectionString), max: 5 });
  return {
    plan: (job) => plan(pool, config.bookingRevisionHandoff, job, config.now?.() ?? new Date()),
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
  const [rooms, rates] = await Promise.all([
    pool.query<RoomRow>(
      `SELECT room.id::text AS "roomTypeId", room.name, room.currency,
         count(unit.id)::integer AS "countOfRooms",
         COALESCE((room.occupancy_limits ->> 'maxAdults')::integer, 2) AS adults,
         COALESCE((room.occupancy_limits ->> 'maxChildren')::integer, 0) AS children
       FROM pms.room_types room LEFT JOIN pms.rooms unit
         ON unit.room_type_id = room.id AND unit.status <> 'retired'
       LEFT JOIN pms.channel_connections connection
         ON connection.property_id = room.property_id AND connection.provider = 'channex'
       LEFT JOIN pms.channel_room_type_mappings mapping
         ON mapping.connection_id = connection.id AND mapping.room_type_id = room.id
       WHERE room.property_id = $1::uuid AND room.active
         AND ($2::uuid IS NULL OR EXISTS (
           SELECT 1 FROM pms.rate_plans selected_plan
           WHERE selected_plan.id = $2::uuid AND selected_plan.property_id = room.property_id
             AND selected_plan.room_type_id = room.id AND selected_plan.active
         ))
         AND (mapping.id IS NULL OR mapping.status <> 'active')
       GROUP BY room.id ORDER BY room.sort_order, room.name`,
      [job.propertyId, job.input.mealRatePlanId ?? null],
    ),
    pool.query<RateRow>(
      `SELECT plan.room_type_id::text AS "roomTypeId", room.name AS "roomTypeName",
         plan.id::text AS "ratePlanId", plan.meal_plan AS "mealPlan",
         plan.pricing_contract_version AS "pricingContractVersion",
         CASE WHEN mapping.status = 'active' THEN mapping.external_rate_plan_id END AS "externalRatePlanId",
         plan.name, plan.currency, 'per_room' AS "sellMode", plan.base_rate_amount::float8 AS "baseRate",
         channel.key AS channel, channel.label AS "channelLabel", 0::float8 AS "markupPercent",
         LEAST(2, GREATEST(1, COALESCE((room.occupancy_limits ->> 'maxAdults')::integer, 2))) AS "defaultOccupancy",
         room_mapping.external_room_type_id AS "externalRoomTypeId"
       FROM pms.rate_plans plan
       JOIN pms.room_types room ON room.id = plan.room_type_id AND room.active
       CROSS JOIN (VALUES ('direct', 'Standard'), ('booking_com', 'BDC Standard'),
         ('airbnb', 'Airbnb Standard')) AS channel(key, label)
       LEFT JOIN pms.channel_connections connection
         ON connection.property_id = plan.property_id AND connection.provider = 'channex'
       LEFT JOIN pms.channel_rate_plan_mappings mapping
         ON mapping.connection_id = connection.id AND mapping.rate_plan_id = plan.id
           AND mapping.channel = channel.key
       LEFT JOIN pms.channel_room_type_mappings room_mapping
         ON room_mapping.connection_id = connection.id AND room_mapping.room_type_id = plan.room_type_id
           AND room_mapping.status = 'active'
       WHERE plan.property_id = $1::uuid AND plan.active
         AND ($2::uuid IS NULL OR plan.id = $2::uuid)
       ORDER BY plan.name, channel.key`,
      [job.propertyId, job.input.mealRatePlanId ?? null],
    ),
  ]);
  const roomIds = new Set(rooms.rows.map(({ roomTypeId }) => roomTypeId));
  const plannedRates = rates.rows.map((rate) => ({
    ...rate,
    providerTitle: providerRateTitle(rate),
    mealType: canonicalMeal(rate),
  }));
  return {
    externalPropertyId,
    meals: plannedRates.flatMap((rate) =>
      rate.mealType
        ? [
            {
              ratePlanId: rate.ratePlanId,
              channel: rate.channel,
              mealType: rate.mealType,
              externalRatePlanId: rate.externalRatePlanId ?? undefined,
              externalRoomTypeId: rate.externalRoomTypeId ?? undefined,
            },
          ]
        : [],
    ),
    requests: [
      ...rooms.rows.flatMap((room) => {
        const title = providerTitle(room.name, room.roomTypeId);
        return [
          channexRequests.listRoomTypes(externalPropertyId, [
            { roomTypeId: room.roomTypeId, roomTypeName: title },
          ]),
          channexRequests.createRoomType({
            roomTypeId: room.roomTypeId,
            roomTypeName: title,
            roomType: {
              property_id: externalPropertyId,
              title,
              count_of_rooms: Math.max(1, room.countOfRooms),
              occ_adults: Math.max(1, room.adults),
              occ_children: Math.max(0, room.children),
              occ_infants: 0,
              default_occupancy: Math.min(2, Math.max(1, room.adults)),
              room_kind: "room",
            },
          }),
        ];
      }),
      ...plannedRates
        .filter((rate) => !rate.externalRatePlanId)
        .filter(
          ({ roomTypeId, externalRoomTypeId }) =>
            roomIds.has(roomTypeId) || Boolean(externalRoomTypeId),
        )
        .flatMap((rate) => [
          channexRequests.listRatePlans(externalPropertyId, [
            {
              roomTypeId: rate.roomTypeId,
              ratePlanId: rate.ratePlanId,
              ratePlanName: rate.name,
              providerTitle: rate.providerTitle,
              channel: rate.channel,
              sellMode: rate.sellMode,
              markupPercent: rate.markupPercent,
              externalRoomTypeId: rate.externalRoomTypeId ?? undefined,
            },
          ]),
          channexRequests.createRatePlan({
            ...rate,
            ratePlanName: rate.name,
            externalRoomTypeId: rate.externalRoomTypeId ?? undefined,
            ratePlan: {
              property_id: externalPropertyId,
              title: rate.providerTitle,
              sell_mode: rate.sellMode,
              rate_mode: "manual",
              currency: rate.currency,
              options: [
                { occupancy: rate.defaultOccupancy, is_primary: true, rate: rate.baseRate },
              ],
              ...(rate.mealType ? { meal_type: rate.mealType } : {}),
            },
          }),
        ]),
      channexRequests.listChannels(externalPropertyId),
    ],
    checkpoint: checkpoint(pool, job),
  };
}

async function ariPlan(
  pool: Pick<Pool, "query">,
  job: ChannexManagementJob,
  externalPropertyId: string,
  now: Date,
): Promise<ChannexManagementActionPlan> {
  const policyResult = await pool.query<SameDayPolicyRow>(
    `SELECT location.timezone, COALESCE(policy.enabled, $2::boolean) AS enabled,
       CASE WHEN policy.property_id IS NULL THEN $3::text ELSE policy.cutoff_local_time END
         AS "cutoffLocalTime"
     FROM hotel_catalog.properties property
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
     LEFT JOIN booking.same_day_booking_policies policy ON policy.property_id = property.id
     WHERE property.id = $1::uuid`,
    [
      job.propertyId,
      SAME_DAY_BOOKING_POLICY_DEFAULTS.enabled,
      SAME_DAY_BOOKING_POLICY_DEFAULTS.cutoffLocalTime,
    ],
  );
  const policy = policyResult.rows[0];
  if (!policy?.timezone) throw new Error("Canonical property timezone is unavailable");
  const from = propertyLocalClock(now, policy.timezone).date;
  const result = await pool.query<AriRow>(
    `SELECT inventory.stay_date::text AS "stayDate",
       ${CHANNEX_ARI_MAPPING_MISSING_SQL} AS "mappingMissing",
       CASE WHEN COALESCE(inventory.rate_gate_open, TRUE)
         THEN inventory.available_count ELSE 0 END AS available,
       room_mapping.external_room_type_id AS "externalRoomTypeId",
       rate_mapping.external_rate_plan_id AS "externalRatePlanId",
       inventory.room_type_id::text AS "roomTypeId", plan.id::text AS "ratePlanId",
       room.room_facts_revision::int AS "roomFactsRevision", plan.active AS "planActive",
       CASE WHEN date_price.amount IS NOT NULL THEN jsonb_build_object(
         'amountDecimal',date_price.amount::text,'currency',date_price.currency::text) END AS "datePrice",
       rate_mapping.channel,
       rate_mapping.markup_percent::float8 AS "markupPercent",
       to_jsonb(restrictions) AS restrictions
     FROM pms.inventory_days inventory
     JOIN pms.room_types room ON room.id=inventory.room_type_id AND room.property_id=inventory.property_id
     JOIN pms.channel_connections connection
       ON connection.property_id = inventory.property_id AND connection.provider = 'channex'
     LEFT JOIN pms.channel_room_type_mappings room_mapping
       ON room_mapping.connection_id = connection.id AND room_mapping.room_type_id = inventory.room_type_id
       AND room_mapping.status = 'active'
     LEFT JOIN pms.channel_rate_plan_mappings rate_mapping
       ON rate_mapping.connection_id = connection.id AND rate_mapping.room_type_id = inventory.room_type_id
       AND rate_mapping.status = 'active'
     LEFT JOIN pms.rate_plans plan ON plan.id = rate_mapping.rate_plan_id
       AND plan.property_id=inventory.property_id AND plan.room_type_id=inventory.room_type_id
     LEFT JOIN pms.channel_date_prices date_price ON date_price.property_id=inventory.property_id
       AND date_price.room_type_id=inventory.room_type_id AND date_price.rate_plan_id=plan.id
       AND date_price.stay_date=inventory.stay_date
     LEFT JOIN LATERAL pms.effective_stay_restrictions(
       inventory.property_id, inventory.room_type_id, plan.id, inventory.stay_date
     ) restrictions ON TRUE
     WHERE inventory.property_id = $1::uuid
       AND ${CHANNEX_ARI_ACTIVE_ROOM_SQL}
       AND inventory.stay_date >= $2::date
     ORDER BY inventory.stay_date`,
    [job.propertyId, from],
  );
  if (result.rows.some((row) => row.mappingMissing)) throw new ChannexAriMappingMissingError();
  const queryable = {
    async query<T extends pg.QueryResultRow>(sql: string, values?: readonly unknown[]) {
      const result = await pool.query<T>(sql, values ? [...values] : undefined);
      return { ...result, rowCount: result.rows.length };
    },
  };
  const resolvers = new Map<string, ReturnType<typeof createBookingNightlyRoomPriceResolver>>();
  if (!job.input.restrictionsOnly) {
    const pricing = await loadPmsPricingSourceSnapshot(queryable, job.propertyId, now);
    const recurringPricing = await loadPmsRecurringPricingBookingEvidence(
      queryable,
      job.propertyId,
      now,
    );
    if (!pricing || !recurringPricing)
      throw new Error("Channex pricing unavailable: configure canonical PMS pricing first.");
    for (const row of result.rows) {
      if (!row.planActive)
        throw new Error(`Channex rate plan ${row.ratePlanId} is inactive or missing.`);
      if (!resolvers.has(row.ratePlanId))
        resolvers.set(
          row.ratePlanId,
          createBookingNightlyRoomPriceResolver({
            pricing,
            recurringPricing,
            roomTypeId: row.roomTypeId,
            flexibleRatePlanId: row.ratePlanId,
            roomFactsRevision: row.roomFactsRevision,
          }),
        );
    }
  }
  const overrides = new Map(
    (job.input.markups ?? []).map((item) => [item.channel, item.markupPercent]),
  );
  const availability = [
    ...new Map(
      result.rows.map((row) => [
        `${row.externalRoomTypeId}:${row.stayDate}`,
        {
          property_id: externalPropertyId,
          room_type_id: row.externalRoomTypeId,
          date_from: row.stayDate,
          date_to: row.stayDate,
          availability: evaluateSameDayBooking({
            checkIn: row.stayDate,
            policy,
            propertyTimeZone: policy.timezone!,
            now,
          }).eligible
            ? row.available
            : 0,
        },
      ]),
    ).values(),
  ];
  return {
    externalPropertyId,
    requests: [
      channexRequests.updateProperty(externalPropertyId, {
        settings: {
          min_stay_type: "arrival",
          ...(job.input.restrictionsOnly
            ? {}
            : {
                cut_off_time:
                  policy.enabled && policy.cutoffLocalTime ? `${policy.cutoffLocalTime}:00` : null,
                cut_off_days: policy.enabled ? (policy.cutoffLocalTime ? 0 : null) : 1,
              }),
        },
      }),
      ...(job.input.restrictionsOnly ? [] : [channexRequests.availability(availability)]),
      channexRequests.restrictions(
        result.rows.map((row) => ({
          property_id: externalPropertyId,
          rate_plan_id: row.externalRatePlanId,
          ...row.restrictions,
          date_from: row.stayDate,
          date_to: row.stayDate,
          ...(job.input.restrictionsOnly
            ? {}
            : {
                rate: applyBookingPriceMarkup(
                  resolvers.get(row.ratePlanId)!(row.stayDate, row.datePrice ?? undefined),
                  overrides.get(row.channel) ?? row.markupPercent,
                ),
              }),
        })),
      ),
    ],
  };
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

function canonicalMeal(rate: RateRow): "room_only" | "breakfast" | null {
  if (rate.mealPlan === "room_only" || rate.mealPlan === "breakfast") return rate.mealPlan;
  if (rate.mealPlan == null)
    return rate.pricingContractVersion === "pms-pricing.v1" ? "room_only" : null;
  throw new Error(`Unsupported configured meal inclusion for rate ${rate.ratePlanId}`);
}

function providerTitle(title: string, identity: string) {
  const marker = ` [Vayada:${identity}]`;
  return `${Array.from(title)
    .slice(0, Math.max(0, 255 - marker.length))
    .join("")}${marker}`;
}

function providerRateTitle(rate: RateRow) {
  return providerTitle(
    `${rate.roomTypeName} - ${rate.name} - ${rate.channelLabel}`,
    `${rate.roomTypeId}:${rate.channel}:${rate.ratePlanId}`,
  );
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
