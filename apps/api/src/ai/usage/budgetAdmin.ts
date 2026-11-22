/**
 * vayada staff see every hotel account's AI use this month and set its monthly AI budget
 * (VAY-2504; plan: only vayada staff raise a hotel's AI budget). Hotel owners can not change it,
 * and no AI can: /api/platform/admin is on the never-list (src/ai/neverList.ts).
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { monthStart } from "./budgetGate.js";

export type AiAccountBudget = {
  organizationId: string;
  name: string;
  status: string;
  monthlyLimitMicroUsd: number;
  /** False while the default applies. */
  custom: boolean;
  usedMicroUsd: number;
  calls: number;
  updatedAt: string | null;
};

export type AiBudgetOverview = {
  /** First day of the UTC month, YYYY-MM-DD. */
  month: string;
  defaultMonthlyLimitMicroUsd: number;
  /** vayada's whole AI spend this month, every account (also vayada's own model tests). */
  totalUsedMicroUsd: number;
  /** Every hotel account, the biggest spender first. */
  accounts: AiAccountBudget[];
};

export type AiBudgetChange = {
  organizationId: string;
  /** Null puts the account back on the default. */
  monthlyLimitMicroUsd: number | null;
  reason: string;
  /** requestedAt: ISO time the request arrived. */
  audit: { actorUserId: string; requestId: string; correlationId: string; requestedAt: string };
};

export type AiBudgetAdmin = {
  overview(): Promise<AiBudgetOverview>;
  /** Null when the id is not a hotel account. */
  setBudget(change: AiBudgetChange): Promise<AiAccountBudget | null>;
};

/** The highest budget staff can set: $100,000 a month, far above any hotel's use. */
export const MAX_MONTHLY_LIMIT_MICRO_USD = 100_000_000_000;

type AccountRow = {
  id: string;
  name: string;
  status: string;
  limit: string | null;
  updated_at: Date | null;
  used: string;
  calls: number;
};

export function createPgAiBudgetAdmin(config: {
  pool: pg.Pool;
  defaultMonthlyLimitMicroUsd: number;
  now?: () => Date;
}): AiBudgetAdmin {
  const now = config.now ?? (() => new Date());

  async function readAccounts(
    client: pg.Pool | pg.PoolClient,
    month: string,
    organizationId: string | null,
  ): Promise<AiAccountBudget[]> {
    const { rows } = await client.query<AccountRow>(
      `WITH used AS (
         SELECT organization_id,
                SUM(COALESCE(cost_micro_usd, reserved_micro_usd)) AS used,
                COUNT(*)::int AS calls
         FROM platform.ai_usage_ledger
         WHERE budget_month = $1::date
         GROUP BY organization_id
       )
       SELECT account.id::text AS id, account.name, account.status,
              budget.monthly_limit_micro_usd::text AS limit, budget.updated_at,
              COALESCE(used.used, 0)::text AS used, COALESCE(used.calls, 0) AS calls
       FROM identity.organizations account
       LEFT JOIN platform.ai_budgets budget ON budget.organization_id = account.id
       LEFT JOIN used ON used.organization_id = account.id
       WHERE account.kind = 'hotel_group' AND ($2::uuid IS NULL OR account.id = $2::uuid)
       ORDER BY COALESCE(used.used, 0) DESC, account.name, account.id`,
      [month, organizationId],
    );
    return rows.map((row) => ({
      organizationId: row.id,
      name: row.name,
      status: row.status,
      monthlyLimitMicroUsd:
        row.limit === null ? config.defaultMonthlyLimitMicroUsd : Number(row.limit),
      custom: row.limit !== null,
      usedMicroUsd: Number(row.used),
      calls: row.calls,
      updatedAt: row.updated_at?.toISOString() ?? null,
    }));
  }

  return {
    async overview() {
      const month = monthStart(now());
      const [accounts, total] = await Promise.all([
        readAccounts(config.pool, month, null),
        config.pool.query<{ total: string }>(
          `SELECT COALESCE(SUM(COALESCE(cost_micro_usd, reserved_micro_usd)), 0)::text AS total
           FROM platform.ai_usage_ledger WHERE budget_month = $1::date`,
          [month],
        ),
      ]);
      return {
        month,
        defaultMonthlyLimitMicroUsd: config.defaultMonthlyLimitMicroUsd,
        totalUsedMicroUsd: Number(total.rows[0]!.total),
        accounts,
      };
    },

    async setBudget(change) {
      const limit = change.monthlyLimitMicroUsd;
      if (limit !== null && !(Number.isSafeInteger(limit) && limit >= 0))
        throw new Error("monthlyLimitMicroUsd must be a whole number of micro-dollars");
      const client = await config.pool.connect();
      try {
        await client.query("BEGIN");
        // The budget gate's lock: two changes, or a change and a call's reservation, take turns.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('platform.ai_budget'), hashtext($1::uuid::text))",
          [change.organizationId],
        );
        const account = await client.query(
          "SELECT 1 FROM identity.organizations WHERE id = $1::uuid AND kind = 'hotel_group'",
          [change.organizationId],
        );
        if (!account.rowCount) {
          await client.query("ROLLBACK");
          return null;
        }
        const before = await client.query<{ limit: string }>(
          `SELECT monthly_limit_micro_usd::text AS limit FROM platform.ai_budgets
           WHERE organization_id = $1::uuid FOR UPDATE`,
          [change.organizationId],
        );
        if (limit === null) {
          await client.query("DELETE FROM platform.ai_budgets WHERE organization_id = $1::uuid", [
            change.organizationId,
          ]);
        } else {
          await client.query(
            `INSERT INTO platform.ai_budgets
               (organization_id, monthly_limit_micro_usd, updated_by_user_id, updated_at)
             VALUES ($1::uuid, $2, $3::uuid, $4)
             ON CONFLICT (organization_id) DO UPDATE
             SET monthly_limit_micro_usd = EXCLUDED.monthly_limit_micro_usd,
                 updated_by_user_id = EXCLUDED.updated_by_user_id,
                 updated_at = EXCLUDED.updated_at`,
            [change.organizationId, limit, change.audit.actorUserId, change.audit.requestedAt],
          );
        }
        const from = before.rows[0] ? Number(before.rows[0].limit) : null;
        await client.query(
          `INSERT INTO platform.product_audit_events (
             audit_key, product, action, occurred_at, tenant_scope, organization_id,
             actor_type, actor_user_id, target_resource_product, target_resource_type,
             target_resource_id, correlation_id, causation_id,
             redacted_payload, private_payload, privacy_scope
           ) VALUES ($1, 'platform', 'platform.ai.budget.set', $2, 'organization', $3::uuid,
             'user', $4::uuid, 'platform', 'ai_budget', $3, $5, $6, $7::jsonb, $8::jsonb,
             'confidential')`,
          [
            `platform-ai-budget-set:${randomUUID()}`,
            change.audit.requestedAt,
            change.organizationId,
            change.audit.actorUserId,
            change.audit.correlationId,
            change.audit.requestId,
            JSON.stringify({
              fromMonthlyLimitMicroUsd: from,
              toMonthlyLimitMicroUsd: limit,
              defaultMonthlyLimitMicroUsd: config.defaultMonthlyLimitMicroUsd,
            }),
            JSON.stringify({ reason: change.reason }),
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      const [account] = await readAccounts(config.pool, monthStart(now()), change.organizationId);
      return account ?? null;
    },
  };
}
