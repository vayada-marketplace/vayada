import type { Pool } from "pg";

export async function seedChannexAssignmentFixture(db: Pool, propertyId: string) {
  const room = (
    await db.query(
      `INSERT INTO pms.room_types(property_id,name,currency,base_rate_amount) VALUES($1,'Channel room','EUR',100) RETURNING id`,
      [propertyId],
    )
  ).rows[0].id as string;
  const rate = (
    await db.query(
      `INSERT INTO pms.rate_plans(property_id,room_type_id,code,name,currency) VALUES($1,$2,'channel','Channel rate','EUR') RETURNING id`,
      [propertyId, room],
    )
  ).rows[0].id as string;
  await db.query(
    `INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id)
    SELECT $1,id,$2,'provider-room' FROM pms.channel_connections WHERE property_id=$1`,
    [propertyId, room],
  );
  await db.query(
    `INSERT INTO pms.channel_rate_plan_mappings(property_id,connection_id,room_type_id,rate_plan_id,external_room_type_id,external_rate_plan_id)
    SELECT $1,id,$2,$3,'provider-room','provider-rate' FROM pms.channel_connections WHERE property_id=$1`,
    [propertyId, room, rate],
  );
  const client = await db.connect();
  try {
    await client.query("BEGIN; SET LOCAL session_replication_role=replica");
    await client.query(
      `INSERT INTO pms.operating_calendar_revisions
      (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,
       property_time_zone,schedule_mode,recurring_period_count,room_binding_count,default_minimum_stay_nights,
       idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at)
      VALUES(gen_random_uuid(),$1,1,'pms-operating-calendar.v1',1,'Europe/Athens','year_round',0,1,1,
       gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now(),now())`,
      [propertyId],
    );
    await client.query(
      `INSERT INTO pms.operating_calendar_room_bindings(property_id,calendar_revision,room_type_id,
      source_room_facts_revision,source_room_units_revision,physical_capacity_count,starting_sellable_limit_count)
      VALUES($1,1,$2,1,1,100,100)`,
      [propertyId, room],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await db.query(
    `INSERT INTO pms.inventory_days(property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,effective_sellable_limit_count,inventory_revision,generated_sellable_limit_count,generated_source_revision,channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
    SELECT $1,$2,day,100,100,1,100,1,100,1,0,0,0,0 FROM generate_series('2026-09-01'::date,'2026-09-30'::date,'1 day') day`,
    [propertyId, room],
  );
  return { room, rate };
}

export async function clearChannexAssignmentFixture(db: Pool, propertyId: string) {
  // Test-only callers already disable triggers while deleting their own fixture.
  for (const table of [
    "platform.outbox_events",
    "platform.domain_events",
    "booking.nightly_revenue_evidence",
    "booking.nightly_revenue_room_scopes",
    "pms.operational_booking_assignments",
    "pms.channel_booking_revision_tombstones",
    "pms.channel_rate_plan_mappings",
    "pms.channel_room_type_mappings",
    "pms.inventory_days",
    "pms.operating_calendar_room_bindings",
    "pms.operating_calendar_revisions",
    "pms.rate_plans",
    "pms.rooms",
    "pms.room_types",
  ]) {
    await db.query(`DELETE FROM ${table} WHERE property_id=$1`, [propertyId]);
  }
}
