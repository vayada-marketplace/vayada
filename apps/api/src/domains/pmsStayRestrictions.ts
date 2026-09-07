import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { z } from "zod";
import type pg from "pg";

const rule = z
  .strictObject({
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    minStayNights: z.number().int().min(1).max(366).nullable(),
    maxStayNights: z.number().int().min(1).max(366).nullable(),
    closedToArrival: z.boolean(),
    closedToDeparture: z.boolean(),
    stopSell: z.boolean(),
    enabled: z.boolean(),
  })
  .refine(
    (value) =>
      value.startsOn <= value.endsOn &&
      Date.parse(value.endsOn) - Date.parse(value.startsOn) <= 731 * 86400000 &&
      (!value.minStayNights || !value.maxStayNights || value.minStayNights <= value.maxStayNights),
  );

export const stayRestrictionReplacement = z.strictObject({
  roomTypeId: z.uuid(),
  ratePlanId: z.uuid().nullable(),
  rules: z.array(rule).max(100),
});
export type StayRestrictionReplacement = z.infer<typeof stayRestrictionReplacement>;
type Client = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export async function replaceStayRestrictions(
  client: Client,
  propertyId: string,
  input: StayRestrictionReplacement,
): Promise<void> {
  await lockPmsInventoryMutationScope(client, propertyId);
  // Serialize replacements against other edits to this room's rule aggregate.
  const room = await client.query(
    `SELECT id FROM pms.room_types WHERE property_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
    [propertyId, input.roomTypeId],
  );
  if (!room.rows.length) throw new Error("stay_restriction_scope_not_found");
  if (input.ratePlanId) {
    const plan = await client.query(
      `SELECT id FROM pms.rate_plans WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND id=$3::uuid`,
      [propertyId, input.roomTypeId, input.ratePlanId],
    );
    if (!plan.rows.length) throw new Error("stay_restriction_scope_not_found");
  }
  const removed = await client.query<{ startsOn: string; endsOn: string }>(
    `DELETE FROM pms.rate_rules WHERE property_id=$1::uuid AND room_type_id=$2::uuid
       AND rate_plan_id IS NOT DISTINCT FROM $3::uuid AND rule_type='stay_restriction'
       RETURNING starts_on::text AS "startsOn", ends_on::text AS "endsOn"`,
    [propertyId, input.roomTypeId, input.ratePlanId],
  );
  await client.query(
    `INSERT INTO pms.rate_rules(property_id,room_type_id,rate_plan_id,rule_type,starts_on,ends_on,
       days_of_week,min_stay_nights,max_stay_nights,closed_to_arrival,closed_to_departure,stop_sell,enabled)
     SELECT $1::uuid,$2::uuid,$3::uuid,'stay_restriction',r."startsOn",r."endsOn",r."daysOfWeek",
       r."minStayNights",r."maxStayNights",r."closedToArrival",r."closedToDeparture",r."stopSell",r.enabled
     FROM jsonb_to_recordset($4::jsonb) AS r("startsOn" date,"endsOn" date,"daysOfWeek" integer[],
       "minStayNights" integer,"maxStayNights" integer,"closedToArrival" boolean,
       "closedToDeparture" boolean,"stopSell" boolean,enabled boolean)`,
    [propertyId, input.roomTypeId, input.ratePlanId, JSON.stringify(input.rules)],
  );
  // Evaluate every changed date and affected plan before committing conflicting rules.
  for (const rule of [...removed.rows, ...input.rules.filter((rule) => rule.enabled)]) {
    await client.query(
      `SELECT effective.* FROM pms.rate_plans plan
       CROSS JOIN generate_series($4::date,$5::date,interval '1 day') day
       CROSS JOIN LATERAL pms.effective_stay_restrictions($1::uuid,$2::uuid,plan.id,day::date) effective
       WHERE plan.property_id=$1::uuid AND plan.room_type_id=$2::uuid
         AND ($3::uuid IS NULL OR plan.id=$3::uuid)`,
      [propertyId, input.roomTypeId, input.ratePlanId, rule.startsOn, rule.endsOn],
    );
  }
}
