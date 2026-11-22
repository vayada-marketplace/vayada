/**
 * One email a month when vayada's total AI spend passes the threshold (VAY-2504; Flamur,
 * 2026-11-20: $100 a month, to him). The month's audit row is the "already sent" mark, so a
 * redeploy does not send it again; the email provider's idempotency key covers two tasks that
 * overlap during a deploy. Each check also looks at last month, so spend that passed the
 * threshold in a month's last hour still gets its email.
 */
import { createHash } from "node:crypto";

import type pg from "pg";

import { monthStart } from "./budgetGate.js";

export type AiSpendAlertDelivery = {
  send(input: {
    to: string;
    subject: string;
    text: string;
    idempotencyKey: string;
    emailProduct?: "platform";
  }): Promise<void>;
};

/** This month's state; "sent" also when last month's email went out on this check. */
export type AiSpendAlertResult = "below" | "already_sent" | "sent";

const TOP_ACCOUNTS = 5;

export function createAiSpendAlert(config: {
  pool: pg.Pool;
  to: string;
  thresholdMicroUsd: number;
  delivery: AiSpendAlertDelivery;
  now?: () => Date;
}): () => Promise<AiSpendAlertResult> {
  const now = config.now ?? (() => new Date());

  return async () => {
    const at = now();
    const current = monthStart(at);
    const previous = monthStart(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1)));
    const late = await checkMonth(previous, at);
    const result = await checkMonth(current, at);
    return late === "sent" ? "sent" : result;
  };

  async function checkMonth(month: string, at: Date): Promise<AiSpendAlertResult> {
    const auditKey = `ai-spend-alert:${month}`;
    const { rows } = await config.pool.query<{ total: string; sent: boolean }>(
      `SELECT
         (SELECT COALESCE(SUM(COALESCE(cost_micro_usd, reserved_micro_usd)), 0)
          FROM platform.ai_usage_ledger WHERE budget_month = $1::date)::text AS total,
         EXISTS (SELECT 1 FROM platform.product_audit_events
                 WHERE product = 'platform' AND audit_key = $2) AS sent`,
      [month, auditKey],
    );
    const total = Number(rows[0]!.total);
    if (total <= config.thresholdMicroUsd) return "below";
    if (rows[0]!.sent) return "already_sent";

    const top = await config.pool.query<{ name: string | null; used: string }>(
      `SELECT account.name, SUM(COALESCE(cost_micro_usd, reserved_micro_usd))::text AS used
       FROM platform.ai_usage_ledger ledger
       LEFT JOIN identity.organizations account ON account.id = ledger.organization_id
       WHERE ledger.budget_month = $1::date
       GROUP BY ledger.organization_id, account.name
       ORDER BY SUM(COALESCE(cost_micro_usd, reserved_micro_usd)) DESC
       LIMIT ${TOP_ACCOUNTS}`,
      [month],
    );
    const monthName = new Date(`${month}T00:00:00Z`).toLocaleString("en-GB", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    const text = [
      `vayada's AI spend for ${monthName} has passed ${usd(config.thresholdMicroUsd)}: ${usd(total)} so far, all hotels together.`,
      "",
      "Biggest accounts this month:",
      ...top.rows.map((row) => `- ${row.name ?? "(deleted account)"}: ${usd(Number(row.used))}`),
      "",
      "Each hotel account stops at its own monthly AI budget; vayada staff can change budgets in vayada admin.",
      "Calls still running count at their highest possible cost until they finish.",
      "This email is sent once a month.",
    ].join("\n");
    await config.delivery.send({
      to: config.to,
      subject: `vayada: AI spend for ${monthName} passed ${usd(config.thresholdMicroUsd)}`,
      text,
      // With the text's hash: a retry whose total changed is a new email, not a refused reuse of
      // the key (it only repeats when a sent email's mark could not be written).
      idempotencyKey: `${auditKey}:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`,
      // VAY-2293: the Resend webhook acknowledges platform events instead of retrying them.
      emailProduct: "platform",
    });
    // Written after the send: a failed send is retried on the next check.
    await config.pool.query(
      `INSERT INTO platform.product_audit_events (
         audit_key, product, action, occurred_at, tenant_scope, actor_type,
         target_resource_product, target_resource_type, target_resource_id, redacted_payload
       ) VALUES ($1, 'platform', 'platform.ai.spend_alert.send', $2, 'platform', 'system',
         'platform', 'platform', 'vayada', $3::jsonb)
       ON CONFLICT (product, audit_key) DO NOTHING`,
      [
        auditKey,
        at,
        JSON.stringify({
          month,
          totalMicroUsd: total,
          thresholdMicroUsd: config.thresholdMicroUsd,
        }),
      ],
    );
    return "sent";
  }
}

function usd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}
