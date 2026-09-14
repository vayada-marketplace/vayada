import { planPmsInventoryMaterialization } from "@vayada/domain-pms";
import { loadPmsOperatingCalendarConfigurationByRevision } from "./pmsOperatingCalendarReadModel.js";
import { lockPmsInventoryDaysForMaterialization } from "./pmsInventoryMaterializationRepository.js";
import { persistChannexAssignments } from "./channexBookingAssignments.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptChannexStagingCatalog } from "./channexStagingCatalogAdoption.js";
import { prepareChannexStagingDay, stagingDay, noShowStagingDay } from "./pmsChannexStagingDay.js";
import { retainedRevisionScope as scope } from "./channexStagingCatalogEvidence.js";
import { config, databaseUrl } from "./channexStagingCatalogTestFixture.js";
import { seedChannexAssignmentInventory } from "../jobs/channexAssignmentTestFixture.js";

// Provider catalog parsing is covered by the retained catalog transaction suite.
// These tests exercise the real PMS transaction, locks, triggers and ownership.
vi.mock("./channexStagingCatalogAdoption.js", () => ({
  adoptChannexStagingCatalog: vi.fn(async () => ({
    outcome: "replayed",
    hash: "a".repeat(64),
    roomTypeId: "487d717d-6e61-4696-9ea9-3338f069ca06",
  })),
}));
const input = { catalogHash: "a".repeat(64), approvalRef: "VAY-2013:synthetic-day-test" };
describe.skipIf(!databaseUrl)("bounded staging date exception", () => {
  const db = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const ids = [scope.propertyId, stagingDay.roomTypeId];
  const fixtureTransaction = async (body: (client: pg.PoolClient) => Promise<void>) => {
    const client = await db.connect();
    try {
      await client.query("BEGIN; SET LOCAL session_replication_role=replica");
      await body(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
  const request = vi.fn<typeof fetch>(async (url) =>
    Response.json({
      data: String(url).includes("/availability?")
        ? { [scope.roomId]: { [stagingDay.stayDate]: -1, [noShowStagingDay.stayDate]: 0 } }
        : {
            [scope.rateId]: {
              [stagingDay.stayDate]: { stop_sell: true },
              [noShowStagingDay.stayDate]: { stop_sell: true },
            },
          },
    }),
  );
  const run = (applyHash?: string) =>
    prepareChannexStagingDay(config(), { ...input, applyHash }, request);
  const noShowInput = {
    ...input,
    noShow: true,
    approvalRef: "VAY-1535:no-show-test",
    catalogApprovalRef: input.approvalRef,
  };
  const runNoShow = (applyHash?: string) =>
    prepareChannexStagingDay(config(), { ...noShowInput, applyHash }, request);
  beforeEach(async () => {
    request.mockClear();
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Bounded day test')",
      [scope.propertyId],
    );
    const other = (
      await db.query(
        "INSERT INTO pms.room_types(property_id,name) VALUES($1,'Unrelated room') RETURNING id",
        [scope.propertyId],
      )
    ).rows[0].id;
    await seedChannexAssignmentInventory(db, scope.propertyId, other);
    // Synthetic immutable base calendar is seeded locally; live commands never rewrite it.
    await fixtureTransaction(async (client) => {
      await client.query(
        "UPDATE pms.operating_calendar_revisions SET calendar_revision=8,schedule_mode='recurring',recurring_period_count=1 WHERE property_id=$1",
        [scope.propertyId],
      );
      await client.query(
        "UPDATE pms.operating_calendar_room_bindings SET calendar_revision=8 WHERE property_id=$1",
        [scope.propertyId],
      );
      await client.query(
        "INSERT INTO pms.operating_calendar_recurring_periods(property_id,calendar_revision,period_index,start_month,start_day,end_month,end_day) VALUES($1,8,0,9,20,9,21)",
        [scope.propertyId],
      );
    });
    await db.query(
      `INSERT INTO pms.room_types(id,property_id,name,occupancy_limits,room_attributes,room_facts_revision,room_units_revision)
      VALUES($2,$1,'Approved double','{"total":2,"adults":2,"children":0}',
      '{"beds":[{"type":"double","quantity":1}],"bathroomType":"private","bedrooms":null,"bathrooms":null,"size":null}',2,2)`,
      ids,
    );
    await fixtureTransaction(async (client) => {
      await client.query(
        `UPDATE pms.inventory_days SET calendar_revision=8,generated_source_revision=8,
        status=CASE WHEN stay_date BETWEEN '2026-09-20' AND '2026-09-21' THEN 'open' ELSE 'closed' END,
        available_count=CASE WHEN stay_date BETWEEN '2026-09-20' AND '2026-09-21' THEN 100 ELSE 0 END WHERE property_id=$1`,
        [scope.propertyId],
      );
      await client.query(
        `INSERT INTO pms.operating_calendar_revisions
        (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,property_time_zone,schedule_mode,recurring_period_count,room_binding_count,default_minimum_stay_nights,idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at)
        SELECT organization_id,property_id,9,contract_version,property_profile_revision,property_time_zone,schedule_mode,1,2,default_minimum_stay_nights,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),created_by_user_id,now(),now() FROM pms.operating_calendar_revisions WHERE property_id=$1 AND calendar_revision=8`,
        [scope.propertyId],
      );
      await client.query(
        "INSERT INTO pms.operating_calendar_recurring_periods(property_id,calendar_revision,period_index,start_month,start_day,end_month,end_day) SELECT property_id,9,period_index,start_month,start_day,end_month,end_day FROM pms.operating_calendar_recurring_periods WHERE property_id=$1 AND calendar_revision=8",
        [scope.propertyId],
      );
      await client.query(
        "INSERT INTO pms.operating_calendar_room_bindings(property_id,calendar_revision,room_type_id,source_room_facts_revision,source_room_units_revision,physical_capacity_count,starting_sellable_limit_count) SELECT property_id,9,room_type_id,source_room_facts_revision,source_room_units_revision,physical_capacity_count,starting_sellable_limit_count FROM pms.operating_calendar_room_bindings WHERE property_id=$1 AND calendar_revision=8",
        [scope.propertyId],
      );
      await client.query(
        "INSERT INTO pms.operating_calendar_room_bindings(property_id,calendar_revision,room_type_id,source_room_facts_revision,source_room_units_revision,physical_capacity_count,starting_sellable_limit_count) VALUES($1,9,$2,2,2,1,1)",
        ids,
      );
      await client.query(
        `INSERT INTO pms.inventory_materialization_coverage(property_id,organization_id,calendar_revision,materialized_revision,coverage_from,coverage_through,room_type_count,expected_day_count,materialized_day_count,last_changed_materialization_idempotency_key_id,last_changed_materialization_domain_event_id,last_changed_materialization_outbox_event_id,updated_at)
        SELECT property_id,organization_id,8,8,'2026-09-01','2026-09-30',1,30,30,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now() FROM pms.operating_calendar_revisions WHERE property_id=$1 AND calendar_revision=8`,
        [scope.propertyId],
      );
    });
    await db.query(
      "INSERT INTO pms.rooms(property_id,room_type_id,room_number) VALUES($1,$2,'synthetic')",
      ids,
    );
    await db.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'active','repair')",
      [scope.propertyId, scope.providerPropertyId],
    );
    const binding = (
      await db.query(
        "INSERT INTO pms.channel_connections(property_id,provider,external_property_id,connection_status) VALUES($1,'channex',$2,'connected') RETURNING id,binding_generation",
        [scope.propertyId, scope.providerPropertyId],
      )
    ).rows[0];
    await db.query(
      "INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id,status) VALUES($1,$2,$3,$4,'active')",
      [scope.propertyId, binding.id, stagingDay.roomTypeId, scope.roomId],
    );
    const audit = (
      await db.query(
        `INSERT INTO platform.product_audit_events(audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,target_resource_product,target_resource_type,target_resource_id,retention_class,privacy_scope)
      VALUES($1,'pms','test.catalog',now(),'property',$2,'system','pms','room_type',$3,'provider_receipt','restricted') RETURNING id`,
        [randomUUID(), ...ids],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO pms.channex_staging_catalog_references(property_id,connection_id,binding_generation,provider_property_id,provider_booking_id,provider_revision_id,room_type_id,external_room_type_id,external_rate_plan_id,evidence_hash,audit_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        scope.propertyId,
        binding.id,
        binding.binding_generation,
        scope.providerPropertyId,
        scope.bookingId,
        scope.revisionId,
        stagingDay.roomTypeId,
        scope.roomId,
        scope.rateId,
        input.catalogHash,
        audit,
      ],
    );
  });
  afterEach(async () => {
    await fixtureTransaction(async (client) => {
      const tables = (
        await client.query(
          `SELECT c.table_schema,c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema,table_name) WHERE c.column_name='property_id' AND t.table_type='BASE TABLE' AND c.table_schema IN ('pms','platform','booking','distribution')`,
        )
      ).rows;
      for (const t of tables)
        await client.query(
          `DELETE FROM "${t.table_schema}"."${t.table_name}" WHERE property_id=$1`,
          [scope.propertyId],
        );
      await client.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [scope.propertyId]);
    });
  });
  afterAll(() => db.end());
  const snapshot = async () => {
    const result: Record<string, unknown> = {};
    for (const table of [
      "pms.inventory_days",
      "pms.operating_calendar_revisions",
      "pms.operating_calendar_recurring_periods",
      "pms.operating_calendar_room_bindings",
      "pms.inventory_materialization_coverage",
      "platform.product_audit_events",
      "platform.outbox_events",
    ])
      result[table] = (
        await db.query(
          `SELECT to_jsonb(t) row FROM ${table} t WHERE property_id=$1 ORDER BY to_jsonb(t)::text`,
          [scope.propertyId],
        )
      ).rows;
    return result;
  };
  it("previews without writes and concurrently applies once, preserving every other row and recurrence", async () => {
    const before = await snapshot(),
      preview = await run();
    expect(await run()).toEqual(preview);
    expect(await snapshot()).toEqual(before);
    const results = await Promise.all([run(preview.hash), run(preview.hash)]);
    expect(results.map((x) => x.outcome).sort()).toEqual(["applied", "replayed"]);
    const after = await snapshot();
    for (const key of Object.keys(before).filter(
      (k) => !["pms.inventory_days", "platform.product_audit_events"].includes(k),
    ))
      expect(after[key]).toEqual(before[key]);
    const day = (
      await db.query(
        "SELECT * FROM pms.inventory_days WHERE property_id=$1 AND room_type_id=$2",
        ids,
      )
    ).rows;
    expect(day).toHaveLength(1);
    expect(day[0]).toMatchObject({
      status: "open",
      available_count: 1,
      assigned_count: 0,
      calendar_revision: 9,
    });
    expect(
      (after["pms.inventory_days"] as any[]).filter(
        (x) => x.row.room_type_id !== stagingDay.roomTypeId,
      ),
    ).toEqual(before["pms.inventory_days"]);
    expect((after["platform.product_audit_events"] as unknown[]).length).toBe(
      (before["platform.product_audit_events"] as unknown[]).length + 1,
    );
    expect((await run(preview.hash)).outcome).toBe("replayed");
    expect(await snapshot()).toEqual(after);
  });
  it.each(["facts", "units", "binding", "calendar", "block", "existing"])(
    "rejects changed %s without writes",
    async (change) => {
      const preview = await run();
      if (change === "facts")
        await db.query(
          "UPDATE pms.room_types SET room_facts_revision=3 WHERE property_id=$1 AND id=$2",
          ids,
        );
      if (change === "units")
        await db.query(
          "UPDATE pms.room_types SET room_units_revision=3 WHERE property_id=$1 AND id=$2",
          ids,
        );
      if (change === "binding")
        await db.query(
          "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE property_id=$1",
          [scope.propertyId],
        );
      if (change === "calendar") {
        await fixtureTransaction(async (client) => {
          await client.query(
            "UPDATE pms.operating_calendar_revisions SET calendar_revision=10 WHERE property_id=$1 AND calendar_revision=9",
            [scope.propertyId],
          );
        });
      }
      if (change === "block")
        await db.query(
          "INSERT INTO pms.room_blocks(property_id,room_type_id,starts_on,ends_on) VALUES($1,$2,'2026-09-14','2026-09-14')",
          ids,
        );
      if (change === "existing")
        await db.query(
          "INSERT INTO pms.inventory_days(property_id,room_type_id,stay_date,total_count,available_count) VALUES($1,$2,'2026-09-14',1,0)",
          ids,
        );
      const before = await snapshot();
      await expect(run(preview.hash)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );
  it("rejects wrong approval/hash and provider openings", async () => {
    const before = await snapshot();
    await expect(
      prepareChannexStagingDay(config(), { ...input, approvalRef: "VAY-1:no" }, request),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await expect(run("b".repeat(64))).rejects.toThrow();
    request.mockImplementationOnce(async () =>
      Response.json({ data: { [scope.roomId]: { [stagingDay.stayDate]: 1 } } }),
    );
    await expect(run()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  const importOccupancy = async (date: string, checkout: string) => {
    const booking = (
      await db.query(
        `INSERT INTO booking.guest_bookings(property_id,public_reference,source_system,source_booking_id,lifecycle_status,payment_status,check_in,check_out,adults,children,room_count,currency,total_amount,balance_amount,booking_channel)
      VALUES($1,$2,'pms',$3,'confirmed','unpaid',$4::date,$5::date,2,0,1,'GBP',700,700,'booking_com') RETURNING id`,
        [
          scope.propertyId,
          randomUUID(),
          `channex:${scope.propertyId}:${scope.bookingId}`,
          date,
          checkout,
        ],
      )
    ).rows[0].id;
    const binding = (
      await db.query(
        "SELECT id,binding_generation FROM pms.channel_connections WHERE property_id=$1",
        [scope.propertyId],
      )
    ).rows[0];
    await db.query(
      "INSERT INTO pms.channel_booking_mappings(property_id,connection_id,guest_booking_id,external_booking_id,external_revision_id) VALUES($1,$2,$3,$4,$5)",
      [scope.propertyId, binding.id, booking, scope.bookingId, scope.revisionId],
    );
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await lockPmsInventoryMutationScope(client, scope.propertyId);
      await persistChannexAssignments(client, {
        propertyId: scope.propertyId,
        connectionId: binding.id,
        bookingId: booking,
        providerBookingId: scope.bookingId,
        revisionId: scope.revisionId,
        channel: "BookingCom",
        canceled: false,
        bootstrapHash: input.catalogHash,
        stagingCatalogBindingGeneration: binding.binding_generation,
        rooms: [
          {
            externalRoomTypeId: scope.roomId,
            externalRatePlanId: scope.rateId,
            checkIn: date,
            checkOut: checkout,
            adults: 2,
            children: 0,
          },
        ],
      });
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  };
  it("preserves exact imported occupancy on replay and rejects an unrelated revision", async () => {
    const preview = await run();
    await run(preview.hash);
    await importOccupancy("2026-09-14", "2026-09-15");
    const occupied = await snapshot();
    expect((await run(preview.hash)).outcome).toBe("replayed");
    expect(await snapshot()).toEqual(occupied);
    expect(
      (
        await db.query(
          "SELECT assigned_count,available_count FROM pms.inventory_days WHERE property_id=$1 AND room_type_id=$2",
          ids,
        )
      ).rows,
    ).toEqual([{ assigned_count: 1, available_count: 0 }]);
    const noShowPreview = await runNoShow();
    expect(await snapshot()).toEqual(occupied);
    const results = await Promise.all([
      runNoShow(noShowPreview.hash),
      runNoShow(noShowPreview.hash),
    ]);
    expect(results.map((x) => x.outcome).sort()).toEqual(["applied", "replayed"]);
    const both = await snapshot();
    for (const key of Object.keys(occupied)) {
      const rows = both[key] as any[];
      expect(
        rows.filter((x) =>
          key === "pms.inventory_days"
            ? x.row.stay_date !== noShowStagingDay.stayDate ||
              x.row.room_type_id !== stagingDay.roomTypeId
            : key === "platform.product_audit_events"
              ? !String(x.row.audit_key).includes(noShowStagingDay.stayDate)
              : true,
        ),
      ).toEqual(occupied[key]);
    }
    expect((await runNoShow(noShowPreview.hash)).outcome).toBe("replayed");
    expect(await snapshot()).toEqual(both);
    await db.query(
      "UPDATE pms.channel_booking_mappings SET external_revision_id='other' WHERE property_id=$1",
      [scope.propertyId],
    );
    await expect(run(preview.hash)).rejects.toThrow();
  });
  it("does not turn the exception into normal full-horizon coverage", async () => {
    await run((await run()).hash);
    const registry = {
      ownerDomain: "hotel_catalog" as const,
      registryVersion: "test",
      isCanonicalIanaTimeZone: () => true,
    };
    const configuration = (await loadPmsOperatingCalendarConfigurationByRevision(
      db,
      scope.propertyId,
      9,
      registry,
    ))!;
    const previousConfiguration = (await loadPmsOperatingCalendarConfigurationByRevision(
      db,
      scope.propertyId,
      8,
      registry,
    ))!;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const horizon = { from: "2026-09-01", through: "2026-09-30" };
      const currentDays = await lockPmsInventoryDaysForMaterialization(
        client,
        { propertyId: scope.propertyId, horizon } as any,
        configuration,
      );
      expect(
        planPmsInventoryMaterialization({
          propertyId: scope.propertyId,
          configurationSource: configuration.source,
          configuration,
          previousConfiguration,
          horizon,
          currentDays,
        }),
      ).toMatchObject({ ok: false, error: { code: "current_day_coverage_gap" } });
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    expect(
      (
        await db.query(
          "SELECT calendar_revision,materialized_revision,room_type_count FROM pms.inventory_materialization_coverage WHERE property_id=$1",
          [scope.propertyId],
        )
      ).rows,
    ).toEqual([{ calendar_revision: 8, materialized_revision: 8, room_type_count: 1 }]);
  });
  it("rejects provider stop-sell removal", async () => {
    const before = await snapshot();
    request.mockImplementationOnce(async () =>
      Response.json({ data: { [scope.roomId]: { [stagingDay.stayDate]: -1 } } }),
    );
    request.mockImplementationOnce(async () =>
      Response.json({ data: { [scope.rateId]: { [stagingDay.stayDate]: { stop_sell: false } } } }),
    );
    await expect(run()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it("rolls back inventory creation when the audit insert fails", async () => {
    const preview = await run(),
      before = await snapshot();
    await db.query(`CREATE FUNCTION pms.fail_staging_day_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='pms.staging_date_exception.applied' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_staging_day_test BEFORE INSERT ON platform.product_audit_events FOR EACH ROW EXECUTE FUNCTION pms.fail_staging_day_test()`);
    try {
      await expect(run(preview.hash)).rejects.toThrow("synthetic failure");
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.query(
        "DROP TRIGGER fail_staging_day_test ON platform.product_audit_events;DROP FUNCTION pms.fail_staging_day_test()",
      );
    }
  });
  it("uses the retained reference for new capacity when historical OTA pricing changes", async () => {
    const adoption = vi.mocked(adoptChannexStagingCatalog);
    adoption.mockRejectedValueOnce(new Error("invalid_retained_ota_catalog"));
    await expect(run()).rejects.toThrow("invalid_retained_ota_catalog");
    adoption.mockClear();
    const preview = await runNoShow();
    expect(preview.outcome).toBe("preview");
    expect((await runNoShow(preview.hash)).outcome).toBe("applied");
    expect((await runNoShow(preview.hash)).outcome).toBe("replayed");
    expect(adoption).not.toHaveBeenCalled();
    await expect(
      prepareChannexStagingDay(
        config(),
        {
          ...noShowInput,
          catalogHash: "b".repeat(64),
        },
        request,
      ),
    ).rejects.toThrow("staging_day_conflict");
  });

  it.each([
    "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE property_id=$1",
    "UPDATE pms.channel_room_type_mappings SET external_room_type_id='changed-provider-room' WHERE property_id=$1",
  ])("rejects no-show reference drift without writing capacity: %s", async (mutation) => {
    const preview = await runNoShow();
    await db.query(mutation, [scope.propertyId]);
    const before = await snapshot();
    await expect(runNoShow(preview.hash)).rejects.toThrow("staging_day_conflict");
    expect(await snapshot()).toEqual(before);
  });

  it("rejects unsafe no-show runtime before authenticated provider reads", async () => {
    const base = config();
    for (const unsafe of [
      { ...base, apiRuntime: "legacy" as typeof base.apiRuntime },
      { ...base, backgroundWorkersEnabled: true },
      { ...base, targetDatabaseUrl: undefined },
      ...[
        { apiBaseUrl: "https://app.channex.io" },
        { apiKey: undefined },
        { stagingRestrictionsPropertyId: randomUUID() },
        {
          capabilityModes: {
            ...base.channexManagement.capabilityModes,
            bookingSync: "enabled" as typeof base.channexManagement.capabilityModes.bookingSync,
          },
        },
      ].map((overrides) => ({
        ...base,
        channexManagement: { ...base.channexManagement, ...overrides },
      })),
    ]) {
      await expect(prepareChannexStagingDay(unsafe, noShowInput, request)).rejects.toThrow(
        "staging_day_conflict",
      );
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps no-show approval and hashes distinct and rolls back rejected applies", async () => {
    const before = await snapshot();
    const old = await run();
    const next = await runNoShow();
    expect(next.stayDate).toBe("2026-09-20");
    expect(next.hash).not.toBe(old.hash);
    await expect(runNoShow(old.hash)).rejects.toThrow();
    await expect(
      prepareChannexStagingDay(
        config(),
        { ...input, noShow: true, catalogApprovalRef: input.approvalRef },
        request,
      ),
    ).rejects.toThrow();
    await expect(
      prepareChannexStagingDay(
        config(),
        { ...noShowInput, catalogApprovalRef: "VAY-1535:wrong" },
        request,
      ),
    ).rejects.toThrow();
    await expect(
      prepareChannexStagingDay(
        config(),
        { ...noShowInput, catalogApprovalRef: undefined },
        request,
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await db.query(
      `CREATE FUNCTION public.reject_noshow_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='pms.staging_date_exception.applied' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$`,
    );
    await db.query(
      `CREATE TRIGGER reject_noshow_audit BEFORE INSERT ON platform.product_audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_noshow_audit()`,
    );
    try {
      await expect(runNoShow(next.hash)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.query(
        "DROP TRIGGER reject_noshow_audit ON platform.product_audit_events; DROP FUNCTION public.reject_noshow_audit()",
      );
    }
  });
  it("replays occupied no-show capacity without resetting it and rejects broken booking mapping", async () => {
    const preview = await runNoShow();
    await runNoShow(preview.hash);
    await importOccupancy("2026-09-20", "2026-09-21");
    const occupied = await snapshot();
    expect((await runNoShow(preview.hash)).outcome).toBe("replayed");
    expect(await snapshot()).toEqual(occupied);
    await db.query(
      "UPDATE pms.channel_booking_mappings SET external_booking_id='wrong' WHERE property_id=$1",
      [scope.propertyId],
    );
    await expect(runNoShow(preview.hash)).rejects.toThrow();
    expect(await snapshot()).toEqual(occupied);
  });
});
