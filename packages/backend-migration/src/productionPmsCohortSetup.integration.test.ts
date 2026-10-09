import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  createPmsOperatingCalendarSourceRevision,
  parsePmsOperatingCalendarConfigurationSnapshot,
  parseRoomTypeFactsSnapshot,
  planPmsInventoryMaterialization,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeProductionMigrationProvenance } from "./productionBookingWriter.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { buildProductionPmsPlan } from "./productionPmsPlan.js";
import {
  readProductionPmsPrerequisites,
  readProductionPmsTargetState,
} from "./productionPmsTargetReader.js";
import { activateReadyCohortProperties } from "./productionPmsCohortActivation.js";
import {
  pmsCohortModuleBlockers,
  readPmsCohortModules,
  samePmsCohortModule,
  writePmsCohortModule,
} from "./productionPmsCohortModules.js";
import { readCohortReadiness, readyForActivation } from "./productionPmsCohortReadiness.js";
import type { PmsTargetRecord } from "./productionPmsTypes.js";
import { writeProductionPmsRecords } from "./productionPmsWriter.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const RUN = "vay1351-13620000000000000000c0a1";
const AT = "2026-09-04T00:00:00.000Z";
const ORGANIZATION = "13620000-0000-4000-8000-0000000000a0";
const PROPERTY = "13620000-0000-4000-8000-0000000000a1";
const NATIVE_PROPERTY = "13620000-0000-4000-8000-0000000000a2";
const HOTEL = "13620000-0000-4000-8000-0000000000a3";
const ROOM_TYPE = "13620000-0000-4000-8000-0000000000a4";
const ROOM_A = "13620000-0000-4000-8000-0000000000a5";
const ROOM_B = "13620000-0000-4000-8000-0000000000a6";
const OWNER = "13620000-0000-4000-8000-0000000000a7";

describe.skipIf(!URL)("production PMS cohort setup completeness (PostgreSQL)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    client = new pg.Client({ connectionString: URL });
    await client.connect();
  });
  afterAll(async () => client.end());

  it("gives a cohort hotel native pricing settings and verified room labels", async () => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await seed(client);
      const prerequisites = await readProductionPmsPrerequisites(client, RUN);
      const plan = async (records: PmsTargetRecord[] = []) =>
        buildProductionPmsPlan({
          sourceRunId: RUN,
          snapshotAt: AT,
          completedAt: AT,
          rows: sourceRows(),
          cohort: { bookingHotelIds: [], pmsHotelIds: [HOTEL], marketplaceHotelIds: [] },
          target: await readProductionPmsTargetState(client, records, prerequisites),
        });
      const planned = await plan((await plan()).records);
      expect(planned.blockers).toEqual([]);
      const written = await writeProductionPmsRecords(client, planned.writes);
      expect([written["property_pricing_settings"], written["rooms"]]).toEqual([1, 2]);
      await writeProductionMigrationProvenance(client, planned.provenance, RUN);
      // Fire the deferred triggers (0448 first-currency completion) as a commit would.
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      const verified = await plan(planned.records);
      expect([verified.blockers, verified.writes, verified.checksum]).toEqual([
        [],
        [],
        planned.checksum,
      ]);

      // The native room-facts read (pmsRoomFactsSnapshotFromRow) accepts the stored room type.
      const roomType = (
        await client.query<{ row: Record<string, unknown> }>(
          `SELECT to_jsonb(room_type) AS row FROM pms.room_types room_type WHERE id = $1`,
          [ROOM_TYPE],
        )
      ).rows[0]!.row;
      const occupancy = roomType["occupancy_limits"] as Record<string, unknown>;
      const attributes = roomType["room_attributes"] as Record<string, unknown>;
      expect(
        parseRoomTypeFactsSnapshot({
          contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
          propertyId: PROPERTY,
          roomTypeId: ROOM_TYPE,
          roomFactsRevision: roomType["room_facts_revision"],
          lifecycle: "active",
          facts: {
            name: roomType["name"],
            description: roomType["description"],
            category: roomType["category"],
            occupancy: {
              maxGuests: occupancy["total"],
              maxAdults: occupancy["adults"],
              maxChildren: occupancy["children"],
            },
            beds: attributes["beds"],
            bedrooms: attributes["bedrooms"],
            bathrooms: attributes["bathrooms"],
            bathroomType: attributes["bathroomType"],
            size: attributes["size"],
          },
          createdAt: AT,
          updatedAt: AT,
        }),
      ).toMatchObject({ facts: { category: "standard", size: { value: 18, unit: "sqm" } } });

      // The same row the native first-currency insert writes, run from its own source text.
      const source = await readFile(
        join(import.meta.dirname, "../../../apps/api/src/domains/pmsPricingCommandRepository.ts"),
        "utf8",
      );
      const nativeInsert =
        /`(INSERT INTO pms\.property_pricing_settings[^`]*?VALUES \([^)]*\))/.exec(source)?.[1];
      expect(nativeInsert).toBeDefined();
      await client.query(nativeInsert!, [NATIVE_PROPERTY, "EUR", AT]);
      const pricing = await client.query<{ propertyId: string; shape: unknown }>(
        `SELECT property_id::text AS "propertyId", to_jsonb(settings) - 'property_id' AS shape
           FROM pms.property_pricing_settings settings
          WHERE property_id = ANY($1::uuid[]) ORDER BY property_id`,
        [[PROPERTY, NATIVE_PROPERTY]],
      );
      expect(pricing.rows[0]!.shape).toEqual(pricing.rows[1]!.shape);
      expect(pricing.rows[0]!.shape).toMatchObject({
        currency: "EUR",
        pricing_currency_revision: 1,
        optional_pricing_aggregate_revision: 0,
      });

      // The VAY-2066 producer's room gate (pmsChannexScheduler) now selects the hotel.
      const unverified = await client.query(
        `SELECT 1 FROM pms.rooms physical_room
           JOIN pms.room_types room_type ON room_type.property_id = physical_room.property_id
            AND room_type.id = physical_room.room_type_id AND room_type.active IS TRUE
          WHERE physical_room.property_id = $1 AND physical_room.status <> 'retired'
            AND (physical_room.operational_label_status <> 'verified'
                 OR physical_room.room_number IS NULL)`,
        [PROPERTY],
      );
      expect(unverified.rows).toEqual([]);

      // A verified label elsewhere in the property blocks the plan, not the unique index.
      await client.query(`UPDATE pms.rooms SET room_number = 'X-102' WHERE id = $1`, [ROOM_B]);
      await client.query(
        `INSERT INTO pms.rooms (property_id, room_type_id, room_number, operational_label_status)
         VALUES ($1, $2, 'a-102', 'verified')`,
        [PROPERTY, ROOM_TYPE],
      );
      expect((await plan(planned.records)).blockers).toContainEqual(
        expect.objectContaining({
          code: "TARGET_UNIQUE_CONFLICT",
          message: "Another verified room owns this case-insensitive property room label",
        }),
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it("gives a cohort hotel the native operating calendar its readiness checks expect", async () => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await seedCalendar(client);
      const prerequisites = await readProductionPmsPrerequisites(client, RUN);
      const rows = sourceRows();
      rows[0]!.data["user_id"] = OWNER;
      // Open February to December: the calendar takes the legacy season as its schedule.
      Object.assign(rows[1]!.data, { operating_periods: [{ from: "02-01", to: "12-31" }] });
      // A legacy block past the year extends the coverage to its last night (396 days).
      rows.push({
        ...rows[1]!,
        sourceTable: "room_blocks",
        data: {
          id: "13620000-0000-4000-8000-0000000000a8",
          hotel_id: HOTEL,
          room_type_id: ROOM_TYPE,
          start_date: "2027-10-01",
          end_date: "2027-10-05",
          blocked_count: 1,
          reason: "renovation",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-08-29T00:00:00Z",
        },
      });
      const plan = async (records: PmsTargetRecord[] = []) =>
        buildProductionPmsPlan({
          sourceRunId: RUN,
          snapshotAt: AT,
          completedAt: AT,
          rows,
          cohort: { bookingHotelIds: [], pmsHotelIds: [HOTEL], marketplaceHotelIds: [] },
          target: await readProductionPmsTargetState(client, records, prerequisites),
        });
      const planned = await plan((await plan()).records);
      expect(planned.blockers).toEqual([]);
      const written = await writeProductionPmsRecords(client, planned.writes);
      // The calendar save, and the materialization of its coverage.
      expect(written).toMatchObject({
        idempotency_keys: 2,
        domain_events: 2,
        outbox_events: 2,
        operating_calendar_revisions: 1,
        operating_calendar_recurring_periods: 1,
        operating_calendar_room_bindings: 1,
        product_audit_events: 2,
      });
      await writeProductionMigrationProvenance(client, planned.provenance, RUN);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE"); // the deferred manifest trigger
      const verified = await plan(planned.records);
      expect([verified.blockers, verified.writes, verified.checksum]).toEqual([
        [],
        [],
        planned.checksum,
      ]);

      // A later run (parity's dry run, a resume) reads the stored calendar and plans the same.
      const later = buildProductionPmsPlan({
        sourceRunId: RUN,
        snapshotAt: AT,
        completedAt: AT,
        rows,
        cohort: { bookingHotelIds: [], pmsHotelIds: [HOTEL], marketplaceHotelIds: [] },
        target: await readProductionPmsTargetState(
          client,
          planned.records,
          await readProductionPmsPrerequisites(client, RUN),
        ),
      });
      expect([later.blockers, later.writes, later.checksum]).toEqual([[], [], planned.checksum]);

      // Readiness criteria d and e (VAY-2066), as the producer reads them.
      const criteria = await client.query(
        `WITH latest AS (
           SELECT * FROM pms.operating_calendar_revisions WHERE property_id = $1
            ORDER BY calendar_revision DESC LIMIT 1)
         SELECT latest.organization_id IS NOT NULL
                  AND latest.property_profile_revision = property.profile_revision
                  AND latest.property_time_zone = location.timezone AS d,
                (SELECT count(*) FROM pms.room_types room_type WHERE room_type.property_id = $1
                    AND room_type.active AND EXISTS (
                      SELECT 1 FROM pms.operating_calendar_room_bindings binding
                       WHERE binding.property_id = $1
                         AND binding.calendar_revision = latest.calendar_revision
                         AND binding.room_type_id = room_type.id
                         AND binding.source_room_facts_revision = room_type.room_facts_revision
                         AND binding.source_room_units_revision = room_type.room_units_revision))
                = (SELECT count(*) FROM pms.operating_calendar_room_bindings binding
                    WHERE binding.property_id = $1
                      AND binding.calendar_revision = latest.calendar_revision)
                AND (SELECT count(*) FROM pms.room_types room_type
                      WHERE room_type.property_id = $1 AND room_type.active)
                = (SELECT count(*) FROM pms.operating_calendar_room_bindings binding
                    WHERE binding.property_id = $1
                      AND binding.calendar_revision = latest.calendar_revision) AS e,
                (SELECT status FROM platform.idempotency_keys WHERE id = latest.idempotency_key_id)
                  AS idempotency,
                (SELECT destination FROM platform.outbox_events
                  WHERE id = latest.outbox_event_id AND domain_event_id = latest.domain_event_id)
                  AS outbox
           FROM latest
           JOIN hotel_catalog.properties property ON property.id = latest.property_id
           JOIN hotel_catalog.property_locations location ON location.property_id = property.id`,
        [PROPERTY],
      );
      expect(criteria.rows).toEqual([
        { d: true, e: true, idempotency: "completed", outbox: "pms.inventory-source" },
      ]);

      // The configuration the runtime loads from these rows (pmsOperatingCalendarReadModel).
      expect(await readCalendar(client)).toMatchObject({
        schedule: { mode: "recurring", periods: [{ startsOn: "02-01", endsOn: "12-31" }] },
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("materializes canonical inventory with the native coverage of the calendar", async () => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await seedCalendar(client);
      const prerequisites = await readProductionPmsPrerequisites(client, RUN);
      const rows = sourceRows();
      rows[0]!.data["user_id"] = OWNER;
      Object.assign(rows[1]!.data, { operating_periods: [{ from: "02-01", to: "12-31" }] });
      // A legacy block past the year extends the coverage to its last night (396 days).
      rows.push({
        ...rows[1]!,
        sourceTable: "room_blocks",
        data: {
          id: "13620000-0000-4000-8000-0000000000a8",
          hotel_id: HOTEL,
          room_type_id: ROOM_TYPE,
          start_date: "2027-10-01",
          end_date: "2027-10-05",
          blocked_count: 1,
          reason: "renovation",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-08-29T00:00:00Z",
        },
      });
      const plan = async (records: PmsTargetRecord[] = []) =>
        buildProductionPmsPlan({
          sourceRunId: RUN,
          snapshotAt: AT,
          completedAt: AT,
          rows,
          cohort: { bookingHotelIds: [], pmsHotelIds: [HOTEL], marketplaceHotelIds: [] },
          target: await readProductionPmsTargetState(client, records, prerequisites),
        });
      const planned = await plan((await plan()).records);
      expect(planned.blockers).toEqual([]);
      expect(await writeProductionPmsRecords(client, planned.writes)).toMatchObject({
        idempotency_keys: 2,
        domain_events: 2,
        outbox_events: 2,
        inventory_days: 396,
        room_blocks: 1,
        inventory_materialization_coverage: 1,
        product_audit_events: 2,
      });
      await writeProductionMigrationProvenance(client, planned.provenance, RUN);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE"); // coverage and calendar manifests
      const verified = await plan(planned.records);
      expect([verified.blockers, verified.writes, verified.checksum]).toEqual([
        [],
        [],
        planned.checksum,
      ]);
      const coverage = await client.query(
        `SELECT coverage.calendar_revision AS "calendarRevision",
                coverage.coverage_from::text AS "from", coverage.coverage_through::text AS through,
                outbox.destination, outbox.event_type AS "eventType",
                (SELECT count(*)::int FROM pms.inventory_days day
                  WHERE day.property_id = coverage.property_id
                    AND day.status = 'closed') AS "closedDays"
           FROM pms.inventory_materialization_coverage coverage
           JOIN platform.outbox_events outbox
             ON outbox.id = coverage.last_changed_materialization_outbox_event_id
          WHERE coverage.property_id = $1`,
        [PROPERTY],
      );
      expect(coverage.rows).toEqual([
        {
          calendarRevision: 1,
          from: "2026-09-04",
          through: "2027-10-04",
          destination: "distribution.inventory-projection",
          eventType: "pms.inventory.projection_refresh_requested",
          closedDays: 31, // the legacy January closure, closed by the calendar's schedule
        },
      ]);

      // The native planner adopts the stored days unchanged (pmsInventoryMaterialization).
      const days = await client.query<Record<string, number | string | boolean | null>>(
        `SELECT property_id::text AS "propertyId", room_type_id::text AS "roomTypeId",
                stay_date::text AS "stayDate", calendar_revision AS "calendarRevision",
                inventory_revision AS "inventoryRevision", status AS "operatingStatus",
                total_count AS "physicalCapacityCount",
                generated_sellable_limit_count AS "generatedSellableLimitCount",
                channel_sellable_limit_count AS "channelSellableLimitCount",
                manual_sellable_limit_count AS "manualSellableLimitCount",
                effective_sellable_limit_count AS "effectiveSellableLimitCount",
                assigned_count AS "assignedCount", blocked_count AS "blockedCount",
                linked_stop_sell AS "linkedStopSell", linked_source_revision AS "linkedSourceRevision",
                available_count AS "availableCount", generated_source_revision AS generated,
                channel_source_revision AS channel, manual_source_revision AS manual,
                block_source_revision AS block, booking_source_revision AS booking
           FROM pms.inventory_days WHERE property_id = $1 ORDER BY stay_date`,
        [PROPERTY],
      );
      const configuration = (await readCalendar(client))!;
      // In batches of at most 366 days, as the native jobs plan a longer coverage.
      for (const [from, through] of [
        ["2026-09-04", "2027-09-04"],
        ["2027-09-05", "2027-10-04"],
      ] as const) {
        const native = planPmsInventoryMaterialization({
          propertyId: PROPERTY,
          configurationSource: configuration.source,
          configuration,
          horizon: { from, through },
          currentDays: days.rows
            .filter((day) => String(day["stayDate"]) >= from && String(day["stayDate"]) <= through)
            .map(({ generated, channel, manual, block, booking, ...day }) => ({
              ...day,
              sourceRevisions: { generated, channel, manual, block, booking },
            })) as never,
        });
        expect(native).toMatchObject({ ok: true, outcome: "unchanged", changedDays: [] });
      }
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("activates a complete cohort hotel that meets every readiness item, and no other", async () => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await seedCalendar(client);
      await client.query(
        `UPDATE hotel_catalog.properties SET profile_status = 'complete', completeness_reasons = '{}'
          WHERE id = $1`,
        [PROPERTY],
      );
      const prerequisites = await readProductionPmsPrerequisites(client, RUN);
      const rows = sourceRows();
      rows[0]!.data["user_id"] = OWNER;
      const plan = async (records: PmsTargetRecord[] = []) =>
        buildProductionPmsPlan({
          sourceRunId: RUN,
          snapshotAt: AT,
          completedAt: AT,
          rows,
          cohort: { bookingHotelIds: [], pmsHotelIds: [HOTEL], marketplaceHotelIds: [] },
          target: await readProductionPmsTargetState(client, records, prerequisites),
        });
      const planned = await plan((await plan()).records);
      expect(planned.cohortPropertyIds).toEqual([PROPERTY]);
      const readiness = async () => (await readCohortReadiness(client, [PROPERTY]))[0];
      expect(readyForActivation((await readiness())!)).toBe(false); // nothing written yet
      await writeProductionPmsRecords(client, planned.writes);
      await writeProductionMigrationProvenance(client, planned.provenance, RUN);
      expect(await readiness()).toMatchObject({
        lifecycleStatus: "provisioning",
        a: true,
        b: true,
        c: true,
        d: true,
        e: true,
        f: true,
        g: true,
        complete: true,
      });
      // Missing any item keeps the hotel as it is, without aborting the import.
      for (const [item, change] of [
        [
          "profile",
          "UPDATE hotel_catalog.properties SET profile_status = 'incomplete' WHERE id = $1",
        ],
        [
          "reasons",
          "UPDATE hotel_catalog.properties SET completeness_reasons = '{city}' WHERE id = $1",
        ],
        [
          "labels",
          "UPDATE pms.rooms SET operational_label_status = 'unverified' WHERE property_id = $1",
        ],
        [
          "lifecycle",
          "UPDATE hotel_catalog.properties SET lifecycle_status = 'suspended' WHERE id = $1",
        ],
      ] as const) {
        await client.query("SAVEPOINT missing_item");
        await client.query(change, [PROPERTY]);
        const skipped = await activateReadyCohortProperties(client, {
          sourceRunId: RUN,
          completedAt: AT,
          propertyIds: planned.cohortPropertyIds!,
        });
        expect([item, skipped.activated, skipped.active]).toEqual([item, 0, 0]);
        await client.query("ROLLBACK TO SAVEPOINT missing_item");
      }
      const report = await activateReadyCohortProperties(client, {
        sourceRunId: RUN,
        completedAt: AT,
        propertyIds: planned.cohortPropertyIds!,
      });
      expect(report).toMatchObject({
        cohortProperties: 1,
        active: 1,
        provisioning: 0,
        activated: 1,
      });
      const stored = await client.query(
        `SELECT lifecycle_status AS "lifecycleStatus", lifecycle_revision::int AS revision,
                (SELECT count(*)::int FROM platform.product_audit_events audit
                  WHERE audit.property_id = property.id
                    AND audit.action = 'platform.property.lifecycle.status') AS audits
           FROM hotel_catalog.properties property WHERE id = $1`,
        [PROPERTY],
      );
      expect(stored.rows).toEqual([{ lifecycleStatus: "active", revision: 2, audits: 1 }]);
      // A rerun activates nothing more.
      expect(
        await activateReadyCohortProperties(client, {
          sourceRunId: RUN,
          completedAt: AT,
          propertyIds: planned.cohortPropertyIds!,
        }),
      ).toMatchObject({ active: 1, activated: 0 });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("imports a Financials activation the way native onboarding activates it", async () => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await seedCalendar(client);
      await client.query(
        `INSERT INTO identity.product_entitlements
           (organization_id, product, entitlement_key, status, resource_product, resource_type,
            resource_id)
         VALUES ($1, 'pms', 'property-management', 'active', 'pms', 'pms_property', $2),
                ($1, 'pms', 'property-management', 'active', 'pms', 'pms_property', $3)`,
        [ORGANIZATION, PROPERTY, NATIVE_PROPERTY],
      );
      // Native: hotel creation's pending default, the first currency with its starter categories
      // and completion, then the Owner switches Financials off in the Feature Hub (Writer A).
      const api = join(import.meta.dirname, "../../../apps/api/src");
      const statement = async (file: string, pattern: RegExp) => {
        const sql = pattern.exec(await readFile(join(api, file), "utf8"))?.[1];
        expect(sql).toBeDefined();
        return sql!.replaceAll("${OWNER_OFF}", "featureHubOwnerDisabled");
      };
      const creation = await readFile(
        join(api, "platform/sharedHotelSetupStatusReadModel.ts"),
        "utf8",
      );
      expect(creation.replace(/\s+/g, " ")).toContain(
        `SELECT $1::uuid, 'pms', 'module:financials', 'suspended', 'pms', 'pms_property', ` +
          `resource_id, '{"newHotelFinancialsDefault":"pending"}'::jsonb`,
      );
      const nativeId = (
        await client.query<{ id: string }>(
          `INSERT INTO identity.product_entitlements (organization_id, product, entitlement_key,
             status, resource_product, resource_type, resource_id, metadata)
           VALUES ($1, 'pms', 'module:financials', 'suspended', 'pms', 'pms_property', $2,
                   '{"newHotelFinancialsDefault":"pending"}'::jsonb)
           RETURNING id::text`,
          [ORGANIZATION, NATIVE_PROPERTY],
        )
      ).rows[0]!.id;
      await client.query(
        await statement(
          "domains/pmsPricingCommandRepository.ts",
          /`(INSERT INTO pms\.property_pricing_settings[^`]*?VALUES \([^)]*\))/,
        ),
        [NATIVE_PROPERTY, "EUR", AT],
      );
      await client.query(
        await statement(
          "domains/financeStarterCategories.ts",
          /`(INSERT INTO finance\.expense_categories[^`]*)`/,
        ),
        [NATIVE_PROPERTY],
      );
      await client.query(
        await statement(
          "domains/hotelSetupFirstCurrencyCompletion.ts",
          /`(UPDATE identity\.product_entitlements SET status='active'[^`]*)`/,
        ),
        [nativeId],
      );
      await client.query(
        await statement(
          "hotelSetupFeatureHubOrdinary.ts",
          /`(UPDATE identity\.product_entitlements SET status=\$2[^`]*)`/,
        ),
        [nativeId, "suspended", true],
      );

      // Import: legacy had Financials switched off for the same kind of hotel.
      const prerequisites = await readProductionPmsPrerequisites(client, RUN);
      const rows = sourceRows();
      rows[0]!.data["user_id"] = OWNER;
      const legacy = (isActive: boolean): IdentitySourceRow => ({
        ...rows[0]!,
        sourceTable: "property_module_activations",
        data: { hotel_id: HOTEL, module_id: "financials", is_active: isActive },
      });
      const plan = async (records: PmsTargetRecord[] = [], active = false) =>
        buildProductionPmsPlan({
          sourceRunId: RUN,
          snapshotAt: AT,
          completedAt: AT,
          rows,
          cohort: { bookingHotelIds: [], pmsHotelIds: [HOTEL], marketplaceHotelIds: [] },
          moduleActivations: [legacy(active)],
          target: await readProductionPmsTargetState(client, records, prerequisites),
        });
      const planned = await plan((await plan()).records);
      expect(planned.blockers).toEqual([]);
      expect(planned.moduleActivations).toEqual([
        {
          organizationId: ORGANIZATION,
          propertyId: PROPERTY,
          entitlementKey: "module:financials",
          active: false,
          currency: "EUR",
          legacy: "off",
        },
      ]);
      await writeProductionPmsRecords(client, planned.writes);
      for (const module of planned.moduleActivations!)
        await writePmsCohortModule(client, { sourceRunId: RUN, completedAt: AT }, module);

      const state = await client.query(
        `SELECT entitlement.resource_id AS "propertyId", entitlement.status,
                entitlement.starts_at IS NULL AND entitlement.expires_at IS NULL AS unbounded,
                (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(entitlement.metadata) key)
                  AS "metadataKeys",
                entitlement.metadata->>'newHotelFinancialsDefault' AS "default",
                entitlement.metadata->>'newHotelFinancialsActivationTransaction'
                  = pg_current_xact_id()::text AS "readyNow",
                entitlement.metadata->>'featureHubOwnerDisabled' = entitlement.xmin::text
                  AS "ownerOff",
                (SELECT array_agg(category.system_key || ':' || category.name || ':'
                         || category.color || ':' || category.sort_order ORDER BY category.system_key)
                   FROM finance.expense_categories category
                  WHERE category.property_id::text = entitlement.resource_id
                    AND category.archived_at IS NULL) AS categories
           FROM identity.product_entitlements entitlement
          WHERE entitlement.entitlement_key = 'module:financials'
            AND entitlement.resource_id = ANY($1::text[])
          ORDER BY entitlement.resource_id`,
        [[PROPERTY, NATIVE_PROPERTY]],
      );
      const [imported, native] = state.rows.map(({ propertyId: _id, ...rest }) => rest);
      expect(imported).toEqual(native);
      expect(imported).toMatchObject({
        status: "suspended",
        default: "ready",
        readyNow: true,
        ownerOff: true,
        unbounded: true,
        metadataKeys: [
          "featureHubOwnerDisabled",
          "newHotelFinancialsActivationTransaction",
          "newHotelFinancialsDefault",
        ],
      });
      expect(imported!["categories"]).toHaveLength(7);
      // Never the 0449 hotel-setup marker. The audit rows of the completion and the switch-off,
      // which the 0449 trigger would reject (and apply) as financials_module_deactivated here.
      const audits = await client.query(
        `SELECT action, redacted_payload AS payload, privacy_scope AS privacy
           FROM platform.product_audit_events WHERE property_id = $1 AND product = 'pms'
            AND action LIKE '%financials%' ORDER BY action`,
        [PROPERTY],
      );
      expect(audits.rows).toEqual([
        {
          action: "pms.financials.default_activated",
          payload: { propertyId: PROPERTY, currency: "EUR" },
          privacy: "confidential",
        },
        {
          action: "pms.financials.owner_off_imported",
          payload: { moduleId: "financials", isActive: false },
          privacy: "internal",
        },
      ]);
      // The module reader agrees with the runtime, so a rerun plans no conflict and no write.
      const stored = await readPmsCohortModules(client, planned.moduleActivations!);
      expect(pmsCohortModuleBlockers(planned.moduleActivations!, stored)).toEqual([]);
      expect(samePmsCohortModule(planned.moduleActivations![0]!, stored[0])).toBe(true);
      // Legacy on now differs from the stored Owner-off module: it blocks instead of rewriting.
      const switched = await plan(planned.records, true);
      expect(
        pmsCohortModuleBlockers(
          switched.moduleActivations!,
          await readPmsCohortModules(client, switched.moduleActivations!),
        ),
      ).toEqual([expect.objectContaining({ code: "COHORT_MODULE_ACTIVATION_CONFLICT" })]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("reads one owner organization only where runtime tenancy finds one", async () => {
    await client.query("BEGIN");
    try {
      await seedCalendar(client);
      const organizations = async () =>
        (await readProductionPmsPrerequisites(client, RUN)).cohortProperties?.find(
          (row) => row.propertyId === PROPERTY,
        )?.organizationIds;
      expect(await organizations()).toEqual([ORGANIZATION]);
      for (const [change, undo] of [
        [
          "UPDATE identity.organizations SET status = 'archived' WHERE id = $1",
          "UPDATE identity.organizations SET status = 'active' WHERE id = $1",
        ],
        [
          `UPDATE identity.organization_resource_links SET status = 'archived'
            WHERE organization_id = $1 AND resource_type = 'pms_property'`,
          `UPDATE identity.organization_resource_links SET status = 'active'
            WHERE organization_id = $1 AND resource_type = 'pms_property'`,
        ],
        [
          "UPDATE identity.organizations SET kind = 'creator_workspace' WHERE id = $1",
          "UPDATE identity.organizations SET kind = 'hotel_group' WHERE id = $1",
        ],
      ]) {
        await client.query(change!, [ORGANIZATION]);
        expect(await organizations()).toEqual([]);
        await client.query(undo!, [ORGANIZATION]);
      }
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

async function seed(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO identity.organizations (id, kind, name, slug)
     VALUES ($1, 'hotel_group', 'Cohort setup', 'cohort-setup-integration')`,
    [ORGANIZATION],
  );
  await client.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1, 'cohort-setup', 'Cohort setup'), ($2, 'cohort-setup-native', 'Native')`,
    [PROPERTY, NATIVE_PROPERTY],
  );
  await client.query(
    `INSERT INTO hotel_catalog.property_source_links
       (property_id, source_system, source_table, source_id, relationship, metadata)
     VALUES ($1, 'pms', 'hotels', $2, 'operational_input', $3::jsonb)`,
    [PROPERTY, HOTEL, JSON.stringify({ migrationRunId: RUN, migrationDisposition: "canonical" })],
  );
  await client.query(
    `INSERT INTO identity.organization_resource_links
       (organization_id, product, resource_type, resource_id, relationship, status)
     VALUES ($1, 'pms', 'pms_hotel', $2, 'operator', 'active')`,
    [ORGANIZATION, HOTEL],
  );
}

function sourceRows(): IdentitySourceRow[] {
  const row = (sourceTable: string, data: Record<string, unknown>): IdentitySourceRow => ({
    sourceDatabase: "pms",
    sourceTable,
    rowOrdinal: 1,
    data: { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-08-29T00:00:00Z", ...data },
  });
  const room = (id: string, number: string) =>
    row("rooms", { id, hotel_id: HOTEL, room_type_id: ROOM_TYPE, room_number: number });
  return [
    row("hotels", { id: HOTEL, timezone: "Europe/Berlin" }),
    row("room_types", {
      id: ROOM_TYPE,
      hotel_id: HOTEL,
      name: "Double",
      total_rooms: 2,
      base_rate: "100.00",
      currency: "EUR",
      is_active: true,
      category: "Standard",
      bed_type: "1 Double Bed",
      size: 18,
    }),
    room(ROOM_A, "A-101"),
    room(ROOM_B, "A-102"),
  ];
}

async function seedCalendar(client: pg.Client): Promise<void> {
  await seed(client);
  await client.query(
    `INSERT INTO identity.users (id, email) VALUES ($1, 'cohort-owner@example.invalid')`,
    [OWNER],
  );
  await client.query(
    `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
     VALUES ($1, 'Europe/Berlin')`,
    [PROPERTY],
  );
  await client.query(`UPDATE hotel_catalog.properties SET profile_revision = 4 WHERE id = $1`, [
    PROPERTY,
  ]);
  await client.query(
    `INSERT INTO identity.organization_resource_links
       (organization_id, product, resource_type, resource_id, relationship, status)
     VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active'),
            ($1, 'pms', 'pms_property', $2, 'owner', 'active')`,
    [ORGANIZATION, PROPERTY],
  );
}

/** The configuration the runtime loads from the stored rows (pmsOperatingCalendarReadModel). */
async function readCalendar(client: pg.Client) {
  const root = (
    await client.query(
      `SELECT calendar_revision AS "calendarRevision", property_profile_revision AS profile,
              property_time_zone AS "timeZone", default_minimum_stay_nights AS "minimumStay",
              schedule_mode AS "scheduleMode",
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
         FROM pms.operating_calendar_revisions WHERE property_id = $1`,
      [PROPERTY],
    )
  ).rows[0];
  const bindings = await client.query(
    `SELECT room_type_id::text AS "roomTypeId",
            source_room_facts_revision AS "sourceRoomFactsRevision",
            source_room_units_revision AS "sourceRoomUnitsRevision",
            physical_capacity_count AS "physicalCapacityCount",
            starting_sellable_limit_count AS "startingSellableLimitCount"
       FROM pms.operating_calendar_room_bindings WHERE property_id = $1 ORDER BY room_type_id`,
    [PROPERTY],
  );
  return parsePmsOperatingCalendarConfigurationSnapshot(
    {
      contractVersion: "pms-operating-calendar.v1",
      propertyId: PROPERTY,
      calendarRevision: root.calendarRevision,
      source: createPmsOperatingCalendarSourceRevision(PROPERTY, root.calendarRevision),
      sourceInputs: {
        propertyProfile: {
          ownerDomain: "hotel_catalog",
          entityType: "property_profile",
          entityId: PROPERTY,
          revision: `profile:${root.profile}`,
        },
        propertyTimeZone: root.timeZone,
        roomBindings: bindings.rows,
      },
      schedule: {
        mode: root.scheduleMode,
        periods: (
          await client.query(
            `SELECT lpad(start_month::text, 2, '0') || '-' || lpad(start_day::text, 2, '0')
                      AS "startsOn",
                    lpad(end_month::text, 2, '0') || '-' || lpad(end_day::text, 2, '0') AS "endsOn"
               FROM pms.operating_calendar_recurring_periods
              WHERE property_id = $1 ORDER BY period_index`,
            [PROPERTY],
          )
        ).rows,
      },
      defaultMinimumStayNights: root.minimumStay,
      createdAt: root.at,
      updatedAt: root.at,
    },
    {
      ownerDomain: "hotel_catalog",
      registryVersion: "test",
      isCanonicalIanaTimeZone: (zone) => zone === "Europe/Berlin",
    },
  );
}
