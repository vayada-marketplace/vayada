import type { DistributionBookingPublicationTransaction } from "./distributionBookingPublicationProjection.js";

/** Close the receipt's inclusive future horizon before retiring its units. */
export async function closeRoomClosureInventory(
  client: DistributionBookingPublicationTransaction,
  scope: { propertyId: string; roomTypeId: string; commandId: string },
): Promise<number> {
  const result = await client.query(
    `UPDATE pms.inventory_days day SET status='closed',available_count=0,
      closure_source_revision=1,inventory_revision=inventory_revision+1
    FROM pms.room_type_closures closure
    WHERE closure.property_id=$1::uuid AND closure.room_type_id=$2::uuid AND closure.command_id=$3::uuid
      AND day.property_id=closure.property_id AND day.room_type_id=closure.room_type_id
      AND day.stay_date>=closure.cutoff_date AND day.closure_source_revision=0`,
    [scope.propertyId, scope.roomTypeId, scope.commandId],
  );
  return result.rowCount ?? 0;
}

/** Caller has authorized/rechecked closure under inventory/facts/units/publication
 * locks, and inserted the receipt and correlated owner events in this transaction.
 */
export async function appendRoomClosureCalendar(
  client: DistributionBookingPublicationTransaction,
  scope: { propertyId: string; roomTypeId: string; commandId: string },
  events: { idempotencyId: string; domainEventId: string; outboxEventId: string },
): Promise<{ calendarRevision: number }> {
  const values = [scope.propertyId, scope.roomTypeId, scope.commandId];
  const receipt = (
    await client.query<{ previous: number; next: number; cutoff: string }>(
      `SELECT previous_calendar_revision::int AS previous,closed_calendar_revision::int AS next,
      cutoff_date::text AS cutoff FROM pms.room_type_closures
    WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND command_id=$3::uuid`,
      values,
    )
  ).rows[0];
  if (!receipt) throw new Error("Calendar closure requires its PMS receipt");
  const calendar = await client.query(
    `INSERT INTO pms.operating_calendar_revisions
    (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,
      property_time_zone,schedule_mode,recurring_period_count,room_binding_count,default_minimum_stay_nights,
      idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at)
    SELECT previous.organization_id,previous.property_id,closure.closed_calendar_revision,previous.contract_version,
      previous.property_profile_revision,previous.property_time_zone,previous.schedule_mode,previous.recurring_period_count,
      previous.room_binding_count-1,previous.default_minimum_stay_nights,$4::uuid,$5::uuid,$6::uuid,
      closure.actor_user_id,closure.accepted_at,closure.accepted_at
    FROM pms.room_type_closures closure JOIN pms.operating_calendar_revisions previous
      ON previous.property_id=closure.property_id AND previous.calendar_revision=closure.previous_calendar_revision
    JOIN platform.domain_events event ON event.id=$5::uuid AND event.property_id=closure.property_id
      AND event.source_system='pms' AND event.event_type='pms.room_type.closed'
      AND event.resource_product='pms' AND event.resource_type='room_type'
      AND event.resource_id=closure.room_type_id::text AND event.payload->>'commandId'=closure.command_id::text
    WHERE closure.property_id=$1::uuid AND closure.room_type_id=$2::uuid AND closure.command_id=$3::uuid
      AND previous.room_binding_count>1
      AND EXISTS(SELECT 1 FROM pms.operating_calendar_room_bindings binding
        WHERE binding.property_id=closure.property_id AND binding.calendar_revision=closure.previous_calendar_revision
          AND binding.room_type_id=closure.room_type_id)
      AND NOT EXISTS(SELECT 1 FROM pms.operating_calendar_revisions newer
        WHERE newer.property_id=closure.property_id AND newer.calendar_revision>closure.previous_calendar_revision)`,
    [...values, events.idempotencyId, events.domainEventId, events.outboxEventId],
  );
  if (calendar.rowCount !== 1) throw new Error("Calendar closure source or event changed");
  const revisions = [scope.propertyId, receipt.previous, receipt.next];
  await client.query(
    `INSERT INTO pms.operating_calendar_recurring_periods
    (property_id,calendar_revision,schedule_mode,period_index,start_month,start_day,end_month,end_day)
    SELECT property_id,$3::int,schedule_mode,period_index,start_month,start_day,end_month,end_day
    FROM pms.operating_calendar_recurring_periods WHERE property_id=$1::uuid AND calendar_revision=$2::int`,
    revisions,
  );
  await client.query(
    `INSERT INTO pms.operating_calendar_room_bindings
    (property_id,calendar_revision,room_type_id,source_room_facts_revision,source_room_units_revision,
      physical_capacity_count,starting_sellable_limit_count)
    SELECT property_id,$3::int,room_type_id,source_room_facts_revision,source_room_units_revision,
      physical_capacity_count,starting_sellable_limit_count
    FROM pms.operating_calendar_room_bindings WHERE property_id=$1::uuid AND calendar_revision=$2::int
      AND room_type_id<>$4::uuid`,
    [...revisions, scope.roomTypeId],
  );
  const retained = await client.query(
    `UPDATE pms.inventory_days day SET calendar_revision=$3::int,generated_source_revision=$3::int,
      inventory_revision=inventory_revision+1
    FROM pms.inventory_materialization_coverage coverage
    WHERE day.property_id=$1::uuid AND coverage.property_id=day.property_id
      AND coverage.calendar_revision=$2::int
      AND day.stay_date BETWEEN coverage.coverage_from AND coverage.coverage_through
      AND day.calendar_revision=$2::int AND day.generated_source_revision=$2::int
      AND EXISTS(SELECT 1 FROM pms.operating_calendar_room_bindings binding
        WHERE binding.property_id=day.property_id AND binding.calendar_revision=$3::int AND binding.room_type_id=day.room_type_id)`,
    revisions,
  );
  const coverage = await client.query(
    `UPDATE pms.inventory_materialization_coverage SET calendar_revision=$3::int,materialized_revision=$3::int,
      room_type_count=room_type_count-1,expected_day_count=(room_type_count-1)*(coverage_through-coverage_from+1),
      materialized_day_count=(room_type_count-1)*(coverage_through-coverage_from+1),
      last_changed_materialization_idempotency_key_id=$4::uuid,last_changed_materialization_domain_event_id=$5::uuid,
      last_changed_materialization_outbox_event_id=$6::uuid,updated_at=GREATEST(now(),updated_at+interval '1 microsecond')
    WHERE property_id=$1::uuid AND calendar_revision=$2::int AND room_type_count>1
      AND (room_type_count-1)*(coverage_through-coverage_from+1)=$7::int`,
    [
      ...revisions,
      events.idempotencyId,
      events.domainEventId,
      events.outboxEventId,
      retained.rowCount,
    ],
  );
  if (coverage.rowCount !== 1) throw new Error("Calendar closure retained coverage is incomplete");
  return { calendarRevision: receipt.next };
}
