import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";

export type ChannelDatePriceScope = {
  propertyId: string;
  roomTypeId: string;
  ratePlanId: string;
  stayDate: string;
};
export type ChannelDatePrice = { amountDecimal: string | null; currency: string; revision: number };
export type ChannelDatePriceCommand = ChannelDatePriceScope & {
  amountDecimal: string | null;
  currency: string;
  expectedRevision: number;
  commandId: string;
};
export type ChannelDatePricesPort = {
  get(scope: ChannelDatePriceScope): Promise<ChannelDatePrice | null>;
  put(context: RequestContext, command: ChannelDatePriceCommand): Promise<ChannelDatePrice | null>;
  close(): Promise<void>;
};

export function createPgChannelDatePrices(connectionString: string): ChannelDatePricesPort {
  const pool = new pg.Pool({ connectionString, max: 3 });
  const select = `SELECT amount::text AS "amountDecimal", currency::text AS currency, revision,
    command_id::text AS "commandId" FROM pms.channel_date_prices
    WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND rate_plan_id=$3::uuid AND stay_date=$4::date`;
  const params = (scope: ChannelDatePriceScope) => [
    scope.propertyId,
    scope.roomTypeId,
    scope.ratePlanId,
    scope.stayDate,
  ];
  return {
    async get(scope) {
      return (await pool.query<ChannelDatePrice>(select, params(scope))).rows[0] ?? null;
    },
    async put(context, command) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `channel-date-price:${command.ratePlanId}:${command.stayDate}`,
        ]);
        const current = (
          await client.query<ChannelDatePrice & { commandId: string }>(select, params(command))
        ).rows[0];
        if (
          current?.commandId === command.commandId &&
          current.revision === command.expectedRevision + 1 &&
          current.amountDecimal === command.amountDecimal &&
          current.currency === command.currency
        ) {
          await client.query("COMMIT");
          return current;
        }
        if (
          (current?.revision ?? 0) !== command.expectedRevision ||
          current?.commandId === command.commandId
        ) {
          await client.query("ROLLBACK");
          return null;
        }
        // Lock the canonical currency and plan against concurrent changes while saving.
        const plan = await client.query(
          `SELECT plan.id FROM pms.rate_plans plan
          JOIN pms.room_types room ON room.id=plan.room_type_id AND room.property_id=plan.property_id
          JOIN pms.property_pricing_settings settings ON settings.property_id=plan.property_id
          WHERE plan.property_id=$1::uuid AND plan.room_type_id=$2::uuid AND plan.id=$3::uuid
            AND plan.active AND room.active AND plan.pricing_contract_version='pms-pricing.v1'
            AND plan.source_room_facts_revision=room.room_facts_revision
            AND plan.currency=$4 AND settings.currency=$4 FOR SHARE OF plan, room, settings`,
          [command.propertyId, command.roomTypeId, command.ratePlanId, command.currency],
        );
        if (!plan.rows.length) {
          await client.query("ROLLBACK");
          return null;
        }
        const result = await client.query<ChannelDatePrice>(
          `INSERT INTO pms.channel_date_prices
          (property_id,room_type_id,rate_plan_id,stay_date,amount,currency,revision,command_id)
          VALUES ($1::uuid,$2::uuid,$3::uuid,$4::date,$5::numeric,$6,$7,$8::uuid)
          ON CONFLICT (rate_plan_id,stay_date) DO UPDATE SET amount=EXCLUDED.amount,
            currency=EXCLUDED.currency,revision=EXCLUDED.revision,command_id=EXCLUDED.command_id,updated_at=now()
          RETURNING amount::text AS "amountDecimal",currency::text AS currency,revision`,
          [
            ...params(command),
            command.amountDecimal,
            command.currency,
            command.expectedRevision + 1,
            command.commandId,
          ],
        );
        await client.query(
          `INSERT INTO platform.product_audit_events
          (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,
           target_resource_product,target_resource_type,target_resource_id,redacted_payload)
          VALUES ($1,'pms','pms.channel_date_price.changed',now(),'property',$2::uuid,'user',$3::uuid,
            'pms','rate_plan',$4,$5::jsonb)`,
          [
            `channel-date-price:${command.ratePlanId}:${command.stayDate}:${command.expectedRevision + 1}`,
            command.propertyId,
            context.actor.internalUserId,
            command.ratePlanId,
            JSON.stringify({
              stayDate: command.stayDate,
              revision: command.expectedRevision + 1,
              removed: command.amountDecimal === null,
            }),
          ],
        );
        await client.query("COMMIT");
        return result.rows[0]!;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
