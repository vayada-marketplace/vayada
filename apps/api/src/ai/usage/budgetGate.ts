/**
 * Each hotel account's monthly AI budget and the usage ledger (VAY-2504, plan 3.9, design note
 * §8.2). Before every model call the call's highest possible cost is reserved under a per-account
 * lock, so two calls can never both pass a budget that has room for one; afterwards the real cost
 * replaces the reservation. At 100% no further call starts until vayada staff raise the budget or
 * the month ends. At most two calls run at once per account.
 */
import type pg from "pg";

import type { AiBudget, AiReservationRequest, AiSettlement } from "../provider/aiProvider.js";

export type AiBudgetMonth = {
  /** First day of the UTC month, YYYY-MM-DD. */
  month: string;
  usedMicroUsd: number;
  limitMicroUsd: number;
};

export type PgAiBudget = AiBudget & {
  monthStatus(organizationId: string): Promise<AiBudgetMonth>;
};

/** Reads `AI_DEFAULT_MONTHLY_BUDGET_USD` (e.g. "5" or "2.50"). Unset means 0: no AI until staff set one. */
export function defaultMonthlyBudgetFromEnv(env: NodeJS.ProcessEnv): number {
  const value = env.AI_DEFAULT_MONTHLY_BUDGET_USD?.trim();
  if (!value) return 0;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(value))
    throw new Error("AI_DEFAULT_MONTHLY_BUDGET_USD must be dollars, e.g. 5 or 2.50");
  const [dollars, cents = ""] = value.split(".");
  return Number(dollars) * 1_000_000 + Number(cents.padEnd(2, "0")) * 10_000;
}

export function createPgAiBudget(config: {
  pool: pg.Pool;
  /** For accounts without a budget row; vayada staff set the rest. */
  defaultMonthlyLimitMicroUsd: number;
  maxRunningCallsPerAccount?: number;
  now?: () => Date;
}): PgAiBudget {
  const maxRunning = config.maxRunningCallsPerAccount ?? 2;
  const now = config.now ?? (() => new Date());

  async function readMonth(client: pg.PoolClient | pg.Pool, organizationId: string, at: Date) {
    const month = monthStart(at);
    const { rows } = await client.query<{ limit: string; used: string; running: number }>(
      `SELECT
         COALESCE(
           (SELECT monthly_limit_micro_usd FROM platform.ai_budgets WHERE organization_id = $1::uuid),
           $3::bigint
         )::text AS limit,
         COALESCE(SUM(COALESCE(cost_micro_usd, reserved_micro_usd)), 0)::text AS used,
         (COUNT(*) FILTER (WHERE status = 'reserved' AND hold_until > $4::timestamptz))::int AS running
       FROM platform.ai_usage_ledger
       WHERE organization_id = $1::uuid AND budget_month = $2::date`,
      [organizationId, month, config.defaultMonthlyLimitMicroUsd, at],
    );
    const row = rows[0]!;
    return { month, limit: Number(row.limit), used: Number(row.used), running: row.running };
  }

  return {
    async reserve(request: AiReservationRequest) {
      const { context, route } = request;
      const at = now();
      const client = await config.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('platform.ai_budget'), hashtext($1::uuid::text))",
          [context.organizationId],
        );
        const state = await readMonth(client, context.organizationId, at);
        if (state.used + request.reservedMicroUsd > state.limit) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "allowance_used_up" } as const;
        }
        if (state.running >= maxRunning) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "busy" } as const;
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO platform.ai_usage_ledger (
             organization_id, property_id, user_id, surface, task, request_id,
             provider, region, model, price_table_version, budget_month,
             reserved_micro_usd, reserved_at, hold_until
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, $14
           ) RETURNING id`,
          [
            context.organizationId,
            context.propertyId,
            context.userId,
            context.surface,
            request.task,
            context.requestId,
            route.provider,
            route.region,
            route.model,
            request.priceTableVersion,
            state.month,
            request.reservedMicroUsd,
            at,
            new Date(at.getTime() + request.holdMs),
          ],
        );
        await client.query("COMMIT");
        return { ok: true, reservationId: rows[0]!.id } as const;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async settle(reservationId: string, settlement: AiSettlement) {
      const usage = settlement.status === "completed" ? settlement.usage : null;
      await config.pool.query(
        `UPDATE platform.ai_usage_ledger
         SET status = $2, cost_micro_usd = $3, input_tokens = $4, cache_read_tokens = $5,
             cache_write_tokens = $6, output_tokens = $7, settled_at = $8
         WHERE id = $1::uuid AND status = 'reserved'`,
        [
          reservationId,
          settlement.status,
          settlement.costMicroUsd,
          usage?.inputTokens ?? null,
          usage?.cacheReadTokens ?? null,
          usage?.cacheWriteTokens ?? null,
          usage?.outputTokens ?? null,
          now(),
        ],
      );
    },

    async monthStatus(organizationId: string) {
      const state = await readMonth(config.pool, organizationId, now());
      return { month: state.month, usedMicroUsd: state.used, limitMicroUsd: state.limit };
    },
  };
}

function monthStart(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
