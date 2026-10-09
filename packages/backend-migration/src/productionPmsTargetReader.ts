import type pg from "pg";

import type { IdentityMigrationBlocker } from "./productionIdentityDisposition.js";
import type { ProductionMigrationSourceLink } from "./productionBookingTypes.js";
import type {
  ExistingPmsTargetRecord,
  PmsCohortPropertyState,
  PmsPropertyLink,
  PmsMediaQuarantine,
  PmsMediaReference,
  PmsTargetRecord,
  ProductionPmsTargetState,
} from "./productionPmsTypes.js";
import { PRODUCTION_PMS_TABLES } from "./productionPmsTables.js";

type QueryClient = Pick<pg.ClientBase, "query">;

export async function readProductionPmsPrerequisites(
  client: QueryClient,
  sourceRunId: string,
): Promise<Omit<ProductionPmsTargetState, "records" | "provenance" | "blockers">> {
  const links = await client.query<PmsPropertyLink>(
    `SELECT source_id AS "sourceId", property_id::text AS "propertyId", relationship, status,
            metadata ->> 'migrationRunId' AS "migrationRunId",
            metadata ->> 'migrationDisposition' AS "migrationDisposition",
            CASE WHEN ownership.link_count = 1 THEN ownership.owner_status
                 WHEN ownership.link_count > 1 THEN 'ambiguous' END AS "ownerStatus"
     FROM hotel_catalog.property_source_links source_link
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS link_count, min(owner.status) AS owner_status
       FROM identity.organization_resource_links owner
       WHERE owner.product = 'pms' AND owner.resource_type = 'pms_hotel'
         AND owner.resource_id = source_link.source_id AND owner.relationship = 'operator'
     ) ownership ON TRUE
     WHERE source_system = 'pms' AND source_table = 'hotels'
       AND metadata ->> 'migrationRunId' = $1
     ORDER BY source_id, property_id`,
    [sourceRunId],
  );
  const bookings = await client.query<ProductionPmsTargetState["bookings"][number]>(
    `SELECT id::text, property_id::text AS "propertyId", check_in::text AS "checkIn",
            check_out::text AS "checkOut", adults, children, room_count AS "roomCount", currency,
            lifecycle_status AS "lifecycleStatus", updated_at::text AS "updatedAt",
            provenance.last_run_id AS "migrationRunId"
     FROM booking.guest_bookings booking
     JOIN platform.production_migration_source_links provenance
       ON provenance.source_database = 'pms'
      AND provenance.source_table = 'bookings'
      AND provenance.source_id = booking.id::text
      AND provenance.target_product = 'booking'
      AND provenance.target_table = 'guest_bookings'
      AND provenance.target_id = booking.id::text
      AND provenance.last_run_id = $1
     WHERE booking.source_system = 'pms'
     ORDER BY booking.id`,
    [sourceRunId],
  );
  const users = await client.query<{ id: string }>(
    `SELECT id::text FROM identity.users ORDER BY id`,
  );
  const media = await client.query<{ id: string }>(
    `SELECT id::text FROM platform.media_objects
     WHERE lifecycle_status NOT IN ('deleted', 'rejected')
     ORDER BY id`,
  );
  const mediaReferences = await client.query<PmsMediaReference>(
    `SELECT media.id::text AS "mediaObjectId", media.property_id::text AS "propertyId",
            media.source_table AS "sourceTable", media.source_row_id AS "sourceRowId",
            media.source_url AS "sourceUrl", media.purpose, media.visibility,
            media.lifecycle_status AS "lifecycleStatus",
            media.public_approved AS "publicApproved",
            original.public_cdn_url AS "publicUrl", media.storage_key AS "storageKey"
       FROM platform.media_objects media
       LEFT JOIN platform.media_variants original
         ON original.media_object_id = media.id
        AND original.variant_name = 'original_safe'
        AND original.visibility = 'public'
      WHERE media.source_system = 'pms'
        AND media.source_metadata ->> 'migrationRunId' = $1
        AND media.purpose IN ('pms.room_type.media', 'pms.messaging.attachment')
      ORDER BY media.source_table, media.source_row_id, media.purpose, media.id`,
    [sourceRunId],
  );
  const mediaQuarantines = await client.query<PmsMediaQuarantine>(
    `SELECT source_table AS "sourceTable", source_row_id AS "sourceRowId",
            source_field AS "sourceField", source_value_sha256 AS "sourceValueSha256",
            purpose, reason_code AS "reasonCode"
       FROM platform.production_media_migration_quarantines
      WHERE source_run_id = $1 AND source_system = 'pms'
        AND purpose IN ('pms.room_type.media', 'pms.messaging.attachment')
      ORDER BY source_table, source_row_id, purpose`,
    [sourceRunId],
  );
  const attachmentBindings = await client.query<{ sourceRowId: string }>(
    `SELECT DISTINCT source_row_id AS "sourceRowId"
       FROM platform.media_objects
      WHERE source_system = 'pms' AND source_table = 'message_attachments'
        AND source_row_id IS NOT NULL
      ORDER BY source_row_id`,
  );
  const cohortProperties = await client.query<PmsCohortPropertyState>(
    `SELECT property.id::text AS "propertyId", property.profile_revision::int AS "profileRevision",
            location.timezone AS "timeZone",
            ARRAY(
              SELECT DISTINCT catalog.organization_id::text
                FROM identity.organization_resource_links catalog
                JOIN identity.organization_resource_links pms
                  ON pms.organization_id = catalog.organization_id AND pms.product = 'pms'
                 AND pms.resource_type = 'pms_property' AND pms.resource_id = catalog.resource_id
                 AND pms.status = 'active' AND pms.relationship IN ('owner', 'operator')
                JOIN identity.organizations organization
                  ON organization.id = catalog.organization_id
                 AND organization.kind = 'hotel_group' AND organization.status = 'active'
               WHERE catalog.product = 'hotel_catalog' AND catalog.resource_type = 'property'
                 AND catalog.resource_id = property.id::text AND catalog.status = 'active'
                 AND catalog.relationship IN ('owner', 'operator')
               ORDER BY 1
            ) AS "organizationIds",
            (SELECT jsonb_object_agg(day.room_type_id::text, day.last)
               FROM (SELECT room_type_id, max(stay_date)::text AS last FROM pms.inventory_days
                      WHERE property_id = property.id GROUP BY room_type_id) day
            ) AS "inventoryThroughByRoomType",
            ARRAY(
              SELECT DISTINCT catalog.organization_id::text
                FROM identity.organization_resource_links catalog
                JOIN identity.organization_resource_links pms
                  ON pms.organization_id = catalog.organization_id AND pms.product = 'pms'
                 AND pms.resource_type = 'pms_property' AND pms.resource_id = catalog.resource_id
                 AND pms.relationship = 'owner' AND pms.status = 'active'
                JOIN identity.organizations organization
                  ON organization.id = catalog.organization_id
                 AND organization.kind = 'hotel_group' AND organization.status = 'active'
               WHERE catalog.product = 'hotel_catalog' AND catalog.resource_type = 'property'
                 AND catalog.resource_id = property.id::text AND catalog.status = 'active'
                 AND catalog.relationship = 'owner'
               ORDER BY 1
            ) AS "financialsOwnerOrganizationIds",
            ARRAY(
              SELECT DISTINCT module.organization_id::text
                FROM identity.organization_resource_links catalog
                JOIN identity.product_entitlements module
                  ON module.organization_id = catalog.organization_id AND module.product = 'pms'
                 AND module.entitlement_key = 'module:financials'
                 AND module.resource_product IS NULL
                 AND module.status IN ('active', 'suspended')
                 AND (module.starts_at IS NULL OR module.starts_at <= now())
                 AND (module.expires_at IS NULL OR module.expires_at > now())
               WHERE catalog.product = 'hotel_catalog' AND catalog.resource_type = 'property'
                 AND catalog.resource_id = property.id::text AND catalog.status = 'active'
               ORDER BY 1
            ) AS "organizationFinancialsIds",
            ARRAY(
              SELECT DISTINCT base.organization_id::text
                FROM identity.organization_resource_links catalog
                JOIN identity.product_entitlements base
                  ON base.organization_id = catalog.organization_id AND base.product = 'pms'
                 AND base.entitlement_key IN ('property-management', 'pms-core', 'account_access')
                 AND base.status = 'active'
                 AND (base.starts_at IS NULL OR base.starts_at <= now())
                 AND (base.expires_at IS NULL OR base.expires_at > now())
                 AND (base.resource_product IS NULL OR (base.resource_product = 'pms'
                   AND base.resource_type = 'pms_property'
                   AND lower(base.resource_id) = property.id::text))
               WHERE catalog.product = 'hotel_catalog' AND catalog.resource_type = 'property'
                 AND catalog.resource_id = property.id::text AND catalog.status = 'active'
                 AND NOT EXISTS (
                   SELECT 1 FROM identity.product_entitlements suspended
                    WHERE suspended.organization_id = catalog.organization_id
                      AND suspended.product = 'pms' AND suspended.status = 'suspended'
                      AND suspended.entitlement_key IN
                        ('property-management', 'pms-core', 'account_access')
                      AND (suspended.starts_at IS NULL OR suspended.starts_at <= now())
                      AND (suspended.expires_at IS NULL OR suspended.expires_at > now())
                      AND (suspended.resource_product IS NULL OR (suspended.resource_product = 'pms'
                        AND suspended.resource_type = 'pms_property'
                        AND lower(suspended.resource_id) = property.id::text)))
               ORDER BY 1
            ) AS "pmsBaseOrganizationIds",
            (SELECT jsonb_build_object(
                'idempotencyKeyId', calendar.idempotency_key_id::text,
                'organizationId', calendar.organization_id::text,
                'profileRevision', calendar.property_profile_revision,
                'timeZone', calendar.property_time_zone,
                'scheduleMode', calendar.schedule_mode,
                'periods', (
                  SELECT coalesce(jsonb_agg(jsonb_build_object(
                      'startsOn', lpad(period.start_month::text, 2, '0') || '-'
                                  || lpad(period.start_day::text, 2, '0'),
                      'endsOn', lpad(period.end_month::text, 2, '0') || '-'
                                || lpad(period.end_day::text, 2, '0'))
                    ORDER BY period.period_index), '[]'::jsonb)
                    FROM pms.operating_calendar_recurring_periods period
                   WHERE period.property_id = calendar.property_id
                     AND period.calendar_revision = calendar.calendar_revision),
                'defaultMinimumStayNights', calendar.default_minimum_stay_nights,
                'createdByUserId', calendar.created_by_user_id::text,
                'createdAt', to_char(calendar.created_at AT TIME ZONE 'UTC',
                                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'bindings', (
                  SELECT coalesce(jsonb_agg(jsonb_build_object(
                      'roomTypeId', binding.room_type_id::text,
                      'sourceRoomFactsRevision', binding.source_room_facts_revision,
                      'sourceRoomUnitsRevision', binding.source_room_units_revision,
                      'physicalCapacityCount', binding.physical_capacity_count,
                      'startingSellableLimitCount', binding.starting_sellable_limit_count)
                    ORDER BY binding.room_type_id), '[]'::jsonb)
                    FROM pms.operating_calendar_room_bindings binding
                   WHERE binding.property_id = calendar.property_id
                     AND binding.calendar_revision = calendar.calendar_revision))
               FROM pms.operating_calendar_revisions calendar
              WHERE calendar.property_id = property.id AND calendar.calendar_revision = 1)
              AS "storedCalendar"
       FROM hotel_catalog.properties property
       LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
      WHERE property.id IN (
        SELECT property_id FROM hotel_catalog.property_source_links
         WHERE source_system = 'pms' AND source_table = 'hotels'
           AND metadata ->> 'migrationRunId' = $1)
      ORDER BY property.id`,
    [sourceRunId],
  );
  return {
    propertyLinks: links.rows,
    cohortProperties: cohortProperties.rows,
    bookings: bookings.rows.map((booking) => ({
      ...booking,
      updatedAt: normalizeTimestamp(booking.updatedAt, "booking.guest_bookings.updated_at"),
    })),
    userIds: users.rows.map((row) => row.id),
    media: mediaReferences.rows,
    mediaQuarantines: mediaQuarantines.rows,
    attachmentMediaSourceIds: attachmentBindings.rows.map((row) => row.sourceRowId),
    mediaIds: media.rows.map((row) => row.id),
  };
}

export async function readProductionPmsTargetState(
  client: QueryClient,
  candidates: PmsTargetRecord[],
  prerequisites: Awaited<ReturnType<typeof readProductionPmsPrerequisites>>,
): Promise<ProductionPmsTargetState> {
  const records: ExistingPmsTargetRecord[] = [];
  const grouped = new Map<string, string[]>();
  for (const candidate of candidates) {
    const ids = grouped.get(candidate.targetTable);
    if (ids) ids.push(candidate.targetId);
    else grouped.set(candidate.targetTable, [candidate.targetId]);
  }
  for (const [targetTable, ids] of grouped) {
    const definition = PRODUCTION_PMS_TABLES[targetTable];
    if (!definition) throw new Error(`Unsupported PMS target table ${targetTable}`);
    const targetId = targetIdExpression(targetTable, definition.key);
    const result = await client.query<{
      targetId: string;
      updatedAt: string | null;
      rowData: string;
    }>(
      `SELECT ${targetId} AS "targetId", (${definition.freshness})::text AS "updatedAt",
              to_jsonb(target_row)::text AS "rowData"
       FROM ${definition.table} AS target_row
       WHERE ${targetId} = ANY($1::text[])
       ORDER BY ${targetId}`,
      [[...new Set(ids)]],
    );
    appendProductionPmsTargetRows(
      records,
      definition.product,
      targetTable,
      `${definition.table}.${definition.freshness}`,
      result.rows,
    );
  }
  const roomTypeCohort = await client.query<{
    targetId: string;
    updatedAt: string | null;
    rowData: string;
  }>(
    `SELECT id::text AS "targetId", updated_at::text AS "updatedAt",
            to_jsonb(target_row)::text AS "rowData"
       FROM pms.room_types AS target_row
      WHERE source_system = 'pms'
      ORDER BY id`,
  );
  const inventoryCohort = await client.query<{
    targetId: string;
    updatedAt: string | null;
    rowData: string;
  }>(
    `SELECT inventory.property_id::text || ':' || inventory.room_type_id::text || ':'
              || inventory.stay_date::text AS "targetId",
            inventory.updated_at::text AS "updatedAt",
            to_jsonb(inventory)::text AS "rowData"
       FROM pms.inventory_days inventory
       JOIN pms.room_types room_type
         ON room_type.id = inventory.room_type_id
        AND room_type.property_id = inventory.property_id
      WHERE room_type.source_system = 'pms'
      ORDER BY inventory.property_id, inventory.room_type_id, inventory.stay_date`,
  );
  appendMissingRecords(records, "room_types", roomTypeCohort.rows);
  appendMissingRecords(records, "inventory_days", inventoryCohort.rows);
  const requestedLinks = [
    ...new Map(
      candidates.map((row) => {
        const link = {
          sourceDatabase: row.sourceDatabase,
          sourceTable: row.sourceTable,
          sourceId: row.sourceId,
          targetProduct: row.targetProduct,
          targetTable: row.targetTable,
          targetId: row.targetId,
        };
        return [JSON.stringify(link), link] as const;
      }),
    ).values(),
  ];
  const cohort = await client.query<ProductionMigrationSourceLink>(
    `SELECT link.source_database AS "sourceDatabase", link.source_table AS "sourceTable",
            link.source_id AS "sourceId", link.target_product AS "targetProduct",
            link.target_table AS "targetTable", link.target_id AS "targetId",
            link.source_checksum AS "sourceChecksum",
            link.source_updated_at::text AS "sourceUpdatedAt",
            link.last_migrated_at::text AS "lastMigratedAt"
     FROM platform.production_migration_source_links link
     WHERE link.source_database = 'pms'
       AND link.target_table = ANY($1::text[])
     ORDER BY link.source_database, link.source_table, link.source_id,
              link.target_product, link.target_table, link.target_id`,
    [Object.keys(PRODUCTION_PMS_TABLES)],
  );
  const normalizedCohort = cohort.rows.map((row) => ({
    ...row,
    sourceUpdatedAt: normalizeTimestamp(row.sourceUpdatedAt, "source_updated_at"),
    lastMigratedAt: requiredTimestamp(row.lastMigratedAt, "last_migrated_at"),
  }));
  const requestedKeys = new Set(requestedLinks.map(provenanceIdentity));
  const provenance = normalizedCohort.filter((row) => requestedKeys.has(provenanceIdentity(row)));
  const stale = normalizedCohort.filter((row) => !requestedKeys.has(provenanceIdentity(row)));
  const collisions = [
    ...(await readCollisions(client, candidates)),
    ...(await readInboxSummaryBlockers(client, candidates)),
    ...(await readStaleTargetBlockers(client, stale)),
  ];
  return {
    ...prerequisites,
    records,
    provenance,
    blockers: collisions,
  };
}

function appendMissingRecords(
  records: ExistingPmsTargetRecord[],
  targetTable: "room_types" | "inventory_days",
  rows: Array<{ targetId: string; updatedAt: string | null; rowData: string }>,
): void {
  const existing = new Set(
    records.filter((record) => record.targetTable === targetTable).map((record) => record.targetId),
  );
  appendProductionPmsTargetRows(
    records,
    "pms",
    targetTable,
    `pms.${targetTable}.updated_at`,
    rows.filter((row) => !existing.has(row.targetId)),
  );
}

export function appendProductionPmsTargetRows(
  records: ExistingPmsTargetRecord[],
  targetProduct: string,
  targetTable: string,
  freshnessField: string,
  rows: Array<{ targetId: string; updatedAt: string | null; rowData: string }>,
): void {
  for (const row of rows)
    records.push({
      targetProduct,
      targetTable,
      targetId: row.targetId,
      updatedAt: normalizeTimestamp(row.updatedAt, freshnessField),
      row: camelize(JSON.parse(row.rowData) as Record<string, unknown>),
    });
}

async function readStaleTargetBlockers(
  client: QueryClient,
  stale: ProductionMigrationSourceLink[],
): Promise<IdentityMigrationBlocker[]> {
  const blockers: IdentityMigrationBlocker[] = [];
  const grouped = new Map<string, ProductionMigrationSourceLink[]>();
  for (const link of stale) {
    const definition = PRODUCTION_PMS_TABLES[link.targetTable];
    if (!definition?.mutable || definition.product !== link.targetProduct) continue;
    const links = grouped.get(link.targetTable);
    if (links) links.push(link);
    else grouped.set(link.targetTable, [link]);
  }
  for (const [targetTable, links] of grouped) {
    const definition = PRODUCTION_PMS_TABLES[targetTable]!;
    const targetId = targetIdExpression(targetTable, definition.key);
    const result = await client.query<{ targetId: string }>(
      `SELECT ${targetId} AS "targetId"
       FROM ${definition.table}
       WHERE ${targetId} = ANY($1::text[])
       ORDER BY ${targetId}`,
      [[...new Set(links.map((link) => link.targetId))]],
    );
    const existing = new Set(result.rows.map((row) => row.targetId));
    for (const link of links)
      if (existing.has(link.targetId))
        blockers.push({
          code: "SOURCE_ABSENT_MIGRATED_TARGET",
          source: `${link.sourceDatabase}.${link.sourceTable}`,
          sourceId: link.sourceId,
          message: `${link.targetProduct}.${link.targetTable} ${link.targetId} remains active but its authoritative source row is absent`,
        });
  }
  return blockers;
}

function provenanceIdentity(value: {
  sourceDatabase: string;
  sourceTable: string;
  sourceId: string;
  targetProduct: string;
  targetTable: string;
  targetId: string;
}): string {
  return [
    value.sourceDatabase,
    value.sourceTable,
    value.sourceId,
    value.targetProduct,
    value.targetTable,
    value.targetId,
  ].join(":");
}

async function readInboxSummaryBlockers(
  client: QueryClient,
  candidates: PmsTargetRecord[],
): Promise<IdentityMigrationBlocker[]> {
  const threadIds = [
    ...new Set(
      candidates
        .filter((row) => row.targetProduct === "pms" && row.targetTable === "message_threads")
        .map((row) => row.targetId),
    ),
  ].sort();
  const blockers: IdentityMigrationBlocker[] = [];
  for (let offset = 0; offset < threadIds.length; offset += 500) {
    const result = await client.query<IdentityMigrationBlocker>(
      `SELECT 'INBOX_TARGET_THREAD_SUMMARY_MISMATCH' AS code,
              'pms.message_threads' AS source, thread.id::text AS "sourceId",
              'Property ' || thread.property_id::text || ': target ' || mismatch.field
                || ' disagrees with retained messages' AS message
         FROM pms.message_threads thread
         CROSS JOIN LATERAL (
           SELECT count(*) FILTER (WHERE direction = 'inbound' AND read_at IS NULL) AS unread
             FROM pms.messages
            WHERE property_id = thread.property_id AND thread_id = thread.id
         ) totals
         LEFT JOIN LATERAL (
           SELECT sent_at, body, direction, sender_type, accepted_idempotency_key_id
             FROM pms.messages
            WHERE property_id = thread.property_id AND thread_id = thread.id
            ORDER BY sent_at DESC, id DESC LIMIT 1
         ) latest ON TRUE
         CROSS JOIN LATERAL (VALUES
           ('unreadCount', thread.unread_count IS DISTINCT FROM totals.unread),
           ('lastMessageAt', thread.last_message_at IS DISTINCT FROM latest.sent_at),
           ('lastMessageDirection', thread.last_message_direction IS DISTINCT FROM latest.direction),
           ('lastMessagePreview',
             thread.last_message_preview IS DISTINCT FROM LEFT(latest.body, 280)
             AND NOT (
               latest.accepted_idempotency_key_id IS NOT NULL
               AND latest.direction = 'outbound' AND latest.sender_type = 'property_user'
               AND (thread.last_message_preview IS NOT DISTINCT FROM LEFT(latest.body, 500)
                    OR (latest.body = '' AND thread.last_message_preview IS NULL))
             ))
         ) mismatch(field, invalid)
        WHERE thread.id = ANY($1::uuid[]) AND mismatch.invalid
        ORDER BY thread.id, mismatch.field`,
      [threadIds.slice(offset, offset + 500)],
    );
    blockers.push(...result.rows);
  }
  return blockers;
}

async function readCollisions(
  client: QueryClient,
  candidates: PmsTargetRecord[],
): Promise<IdentityMigrationBlocker[]> {
  // Only these tables participate in the secondary-unique checks below. In particular,
  // inventory days must not inflate the JSON recordset for every collision query.
  const collisionTables = new Set([
    "room_types",
    "rooms",
    "rate_plans",
    "operational_booking_assignments",
    "message_threads",
    "messages",
    "channel_connections",
    "channel_binding_claims",
    "channel_room_type_mappings",
    "channel_rate_plan_mappings",
    "channel_booking_mappings",
    "channel_sync_status",
    "product_audit_events",
    "external_webhook_events",
  ]);
  const relevant = candidates.filter((candidate) => collisionTables.has(candidate.targetTable));
  const blockers: IdentityMigrationBlocker[] = [];
  for (let offset = 0; offset < relevant.length; offset += 500)
    for (const blocker of await readCollisionBatch(client, relevant.slice(offset, offset + 500)))
      blockers.push(blocker);
  return blockers;
}

async function readCollisionBatch(
  client: QueryClient,
  candidates: PmsTargetRecord[],
): Promise<IdentityMigrationBlocker[]> {
  const rows = candidates.map((candidate) => ({
    targetTable: candidate.targetTable,
    targetId: candidate.targetId,
    ...candidate.row,
  }));
  const result = await client.query<IdentityMigrationBlocker>(
    `WITH requested AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS source(
         "targetTable" text, "targetId" text, "propertyId" uuid,
         "sourceSystem" text, "sourceRoomTypeId" text, "sourceRoomId" text,
         name text, active boolean, "roomNumber" text, "operationalLabelStatus" text,
         "roomTypeId" uuid, code text,
         "guestBookingId" uuid, position integer, source text, "sourceThreadId" text,
         "threadId" uuid, "sourceMessageId" text, provider text, "connectionId" uuid,
         "externalPropertyId" text, "claimState" text,
         "externalRoomTypeId" text, "ratePlanId" uuid, channel text,
         "externalRatePlanId" text, "externalBookingId" text, "channelRoomIndex" integer,
         "syncDomain" text, "auditKey" text, "webhookKeyHash" text
       )
     )
     SELECT 'TARGET_UNIQUE_CONFLICT' AS code, 'pms.room_types' AS source,
            target.id::text AS "sourceId", 'Another room type owns this legacy source identity' AS message
     FROM requested JOIN pms.room_types target ON requested."targetTable" = 'room_types'
      AND target.id::text <> requested."targetId" AND target.property_id = requested."propertyId"
      AND target.source_system = requested."sourceSystem"
      AND target.source_room_type_id = requested."sourceRoomTypeId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.room_types', target.id::text,
            'Another active room type owns this case-insensitive property name'
     FROM requested JOIN pms.room_types target ON requested."targetTable" = 'room_types'
      AND target.id::text <> requested."targetId" AND target.property_id = requested."propertyId"
      AND target.active AND requested.active AND lower(target.name) = lower(requested.name)
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.rooms', target.id::text,
            'Another room owns this legacy identity or property room number'
     FROM requested JOIN pms.rooms target ON requested."targetTable" = 'rooms'
      AND target.id::text <> requested."targetId" AND target.property_id = requested."propertyId"
      AND ((target.source_system = requested."sourceSystem" AND target.source_room_id = requested."sourceRoomId")
           OR target.room_number = requested."roomNumber")
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.rooms', target.id::text,
            'Another verified room owns this case-insensitive property room label'
     FROM requested JOIN pms.rooms target ON requested."targetTable" = 'rooms'
      AND target.id::text <> requested."targetId" AND target.property_id = requested."propertyId"
      AND requested."operationalLabelStatus" = 'verified'
      AND target.operational_label_status = 'verified'
      AND lower(target.room_number) = lower(requested."roomNumber")
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.rate_plans', target.id::text,
            'Another rate plan owns this property, room, and code'
     FROM requested JOIN pms.rate_plans target ON requested."targetTable" = 'rate_plans'
      AND target.id::text <> requested."targetId" AND target.property_id = requested."propertyId"
      AND target.room_type_id = requested."roomTypeId" AND target.code = requested.code
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.operational_booking_assignments', target.id::text,
            'Another assignment owns this booking position'
     FROM requested JOIN pms.operational_booking_assignments target
      ON requested."targetTable" = 'operational_booking_assignments'
      AND target.id::text <> requested."targetId"
      AND target.guest_booking_id = requested."guestBookingId" AND target.position = requested.position
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.message_threads', target.id::text,
            'Another message thread owns this provider thread identity'
     FROM requested JOIN pms.message_threads target ON requested."targetTable" = 'message_threads'
      AND target.id::text <> requested."targetId" AND target.property_id = requested."propertyId"
      AND target.source = requested.source AND target.source_thread_id = requested."sourceThreadId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.messages', target.id::text,
            'Another message owns this provider message identity'
     FROM requested JOIN pms.messages target ON requested."targetTable" = 'messages'
      AND target.id::text <> requested."targetId" AND target.thread_id = requested."threadId"
      AND target.source_message_id = requested."sourceMessageId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.channel_connections', target.id::text,
            'Another channel connection owns this property/provider pair'
     FROM requested JOIN pms.channel_connections target
      ON requested."targetTable" = 'channel_connections' AND target.id::text <> requested."targetId"
      AND target.property_id = requested."propertyId" AND target.provider = requested.provider
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.channel_connections', target.id::text,
            'Another channel connection owns this provider external property ID'
     FROM requested JOIN pms.channel_connections target
      ON requested."targetTable" = 'channel_connections' AND target.id::text <> requested."targetId"
      AND requested."externalPropertyId" IS NOT NULL
      AND target.provider = requested.provider
      AND target.external_property_id = requested."externalPropertyId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.channel_binding_claims', target.id::text,
            'Existing Channex claim does not authorize the requested active binding'
     FROM requested JOIN pms.channel_binding_claims target
      ON requested."targetTable" = 'channel_connections'
      AND requested."externalPropertyId" IS NOT NULL
      AND target.provider = requested.provider
      AND (
        (target.property_id = requested."propertyId" AND
          (target.external_property_id <> requested."externalPropertyId" OR
           target.claim_state <> 'active'))
        OR
        (target.external_property_id = requested."externalPropertyId" AND
          (target.property_id <> requested."propertyId" OR target.claim_state <> 'active'))
      )
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.channel_binding_claims', target.id::text,
            'Retained Channex claim conflicts with the quarantined historical binding'
     FROM requested JOIN pms.channel_binding_claims target
      ON requested."targetTable" = 'channel_binding_claims'
      AND target.provider = requested.provider
      AND (
        (target.property_id = requested."propertyId" AND
          (target.external_property_id <> requested."externalPropertyId" OR
           target.claim_state <> requested."claimState" OR target.claim_source <> 'migration'))
        OR
        (target.external_property_id = requested."externalPropertyId" AND
         target.property_id <> requested."propertyId")
      )
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.channel_room_type_mappings', target.id::text,
            'Another channel room mapping owns the external or internal room type'
     FROM requested JOIN pms.channel_room_type_mappings target
      ON requested."targetTable" = 'channel_room_type_mappings'
      AND target.id::text <> requested."targetId" AND target.connection_id = requested."connectionId"
      AND (target.external_room_type_id = requested."externalRoomTypeId"
           OR target.room_type_id = requested."roomTypeId")
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.channel_rate_plan_mappings', target.id::text,
            'Another channel rate mapping owns the external rate or internal rate/channel'
     FROM requested JOIN pms.channel_rate_plan_mappings target
      ON requested."targetTable" = 'channel_rate_plan_mappings'
      AND target.id::text <> requested."targetId" AND target.connection_id = requested."connectionId"
      AND (target.external_rate_plan_id = requested."externalRatePlanId"
           OR (target.rate_plan_id = requested."ratePlanId" AND target.channel = requested.channel))
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.channel_booking_mappings', target.id::text,
            'Another channel booking mapping owns this external booking slot'
     FROM requested JOIN pms.channel_booking_mappings target
      ON requested."targetTable" = 'channel_booking_mappings'
      AND target.id::text <> requested."targetId" AND target.connection_id = requested."connectionId"
      AND target.external_booking_id = requested."externalBookingId"
      AND target.channel_room_index = requested."channelRoomIndex"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'pms.channel_sync_status', target.id::text,
            'Another sync status owns this connection domain'
     FROM requested JOIN pms.channel_sync_status target
      ON requested."targetTable" = 'channel_sync_status' AND target.id::text <> requested."targetId"
      AND target.connection_id = requested."connectionId" AND target.sync_domain = requested."syncDomain"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'platform.product_audit_events', target.id::text,
            'Another PMS audit event owns this audit key'
     FROM requested JOIN platform.product_audit_events target
      ON requested."targetTable" = 'product_audit_events' AND target.id::text <> requested."targetId"
      AND target.product = 'pms' AND target.audit_key = requested."auditKey"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'platform.external_webhook_events', target.id::text,
            'Another Channex receipt owns this webhook dedupe key'
     FROM requested JOIN platform.external_webhook_events target
      ON requested."targetTable" = 'external_webhook_events'
      AND target.id::text <> requested."targetId" AND target.provider = 'channex'
      AND target.webhook_key_hash = requested."webhookKeyHash"
     ORDER BY source, "sourceId"`,
    [JSON.stringify(rows)],
  );
  return result.rows;
}

function targetIdExpression(targetTable: string, key: readonly string[]): string {
  return key.map((column) => `${column}::text`).join(" || ':' || ");
}

function normalizeTimestamp(value: string | null | undefined, field: string): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid ${field} timestamp: ${value}`);
  return new Date(timestamp).toISOString();
}

function requiredTimestamp(value: string | null | undefined, field: string): string {
  const normalized = normalizeTimestamp(value, field);
  if (!normalized) throw new Error(`Missing required ${field} timestamp`);
  return normalized;
}

function camelize(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase()),
      entry,
    ]),
  );
}
