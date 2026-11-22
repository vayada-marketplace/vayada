import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "../../hotelSetupOrdinaryLogin.fixture.js";
import type { ModelRoute } from "../provider/catalog.js";
import { createPgAiBudgetAdmin } from "./budgetAdmin.js";
import { createPgAiBudget } from "./budgetGate.js";
import { createAiSpendAlert, type AiSpendAlertDelivery } from "./spendAlert.js";

/**
 * VAY-2504: vayada staff set each hotel account's monthly AI budget, and one email a month says
 * when vayada's AI spend passed $100. Real PostgreSQL, the ordinary API login as in production.
 * Each test uses a month far from now, so only its own calls count.
 */
const url = process.env["TEST_DATABASE_URL"];
const HAIKU: ModelRoute = {
  provider: "bedrock",
  region: "eu-west-1",
  model: "eu.anthropic.claude-haiku-5-5",
};

describe.skipIf(!url)("AI budgets set by vayada staff and the spend alert (VAY-2504)", () => {
  let admin: pg.Client;
  let fixture: HotelSetupOrdinaryLoginFixture;
  let pool: pg.Pool;
  const accounts: string[] = [];
  const staff = randomUUID();
  const alertKeys: string[] = [];

  async function newOrganization(kind = "hotel_group", name = "AI budget hotel"): Promise<string> {
    const id = randomUUID();
    accounts.push(id);
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, workos_org_id)
       VALUES ($1::uuid, $2, $3, $1::text, 'wk-org-' || $1::text)`,
      [id, kind, name],
    );
    return id;
  }

  /** One finished call of the account in that month, costing `cost` micro-dollars. */
  async function spend(organizationId: string, at: Date, cost: number) {
    const budget = createPgAiBudget({
      pool,
      defaultMonthlyLimitMicroUsd: 1_000_000_000,
      now: () => at,
    });
    const reserved = await budget.reserve({
      task: "inbox_draft",
      context: {
        organizationId,
        propertyId: null,
        userId: null,
        surface: "inbox",
        requestId: randomUUID(),
      },
      route: HAIKU,
      priceTableVersion: "2026-11-20",
      reservedMicroUsd: cost,
      holdMs: 60_000,
    });
    if (!reserved.ok) throw new Error(`reservation refused: ${reserved.reason}`);
    await budget.settle(reserved.reservationId, {
      status: "completed",
      costMicroUsd: cost,
      usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 },
    });
  }

  const audit = (requestId: string = randomUUID()) => ({
    actorUserId: staff,
    requestId,
    correlationId: requestId,
    requestedAt: "2031-04-15T10:00:00.000Z",
  });

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(
      "INSERT INTO identity.users (id, email, name, status) VALUES ($1::uuid, $2, 'VAY-2504 staff', 'active')",
      [staff, `vay2504-${staff}@example.test`],
    );
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    pool = new pg.Pool({ connectionString: fixture.connectionString, max: 4 });
  });

  afterAll(async () => {
    await pool?.end();
    await fixture?.drop();
    // The audit table is append-only; only a replica session may clear test rows.
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query(
      `DELETE FROM platform.product_audit_events
       WHERE organization_id = ANY($1::uuid[]) OR (product = 'platform' AND audit_key = ANY($2))`,
      [accounts, alertKeys],
    );
    await admin.query("COMMIT");
    if (accounts.length)
      await admin.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
        accounts,
      ]);
    await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [staff]);
    await admin?.end();
  });

  it("shows every hotel account's use this month, its budget and vayada's total", async () => {
    const april = new Date("2031-04-15T10:00:00Z");
    const busy = await newOrganization("hotel_group", "Busy hotel");
    const quiet = await newOrganization("hotel_group", "Quiet hotel");
    const creator = await newOrganization("creator_workspace", "Not a hotel");
    await spend(busy, april, 300_000);
    await spend(busy, april, 200_000);
    await spend(creator, april, 1_000);
    await spend(busy, new Date("2031-03-31T23:00:00Z"), 9_000_000); // last month
    const budgetAdmin = createPgAiBudgetAdmin({
      pool,
      defaultMonthlyLimitMicroUsd: 5_000_000,
      now: () => april,
    });
    await budgetAdmin.setBudget({
      organizationId: quiet,
      monthlyLimitMicroUsd: 20_000_000,
      reason: "Pilot hotel",
      audit: audit(),
    });

    const overview = await budgetAdmin.overview();

    expect(overview).toMatchObject({
      month: "2031-04-01",
      defaultMonthlyLimitMicroUsd: 5_000_000,
      totalUsedMicroUsd: 501_000,
    });
    const mine = overview.accounts.filter((account) => accounts.includes(account.organizationId));
    expect(mine).toEqual([
      {
        organizationId: busy,
        name: "Busy hotel",
        status: "active",
        monthlyLimitMicroUsd: 5_000_000,
        custom: false,
        usedMicroUsd: 500_000,
        calls: 2,
        updatedAt: null,
      },
      {
        organizationId: quiet,
        name: "Quiet hotel",
        status: "active",
        monthlyLimitMicroUsd: 20_000_000,
        custom: true,
        usedMicroUsd: 0,
        calls: 0,
        updatedAt: "2031-04-15T10:00:00.000Z",
      },
    ]);
  });

  it("sets and resets a budget with an audit row, and only for hotel accounts", async () => {
    const hotel = await newOrganization();
    const creator = await newOrganization("creator_workspace");
    const budgetAdmin = createPgAiBudgetAdmin({
      pool,
      defaultMonthlyLimitMicroUsd: 5_000_000,
      now: () => new Date("2031-04-15T10:00:00Z"),
    });

    expect(
      await budgetAdmin.setBudget({
        organizationId: hotel,
        monthlyLimitMicroUsd: 25_000_000,
        reason: "Busy season",
        audit: audit("req-raise"),
      }),
    ).toMatchObject({ monthlyLimitMicroUsd: 25_000_000, custom: true });
    expect(
      await budgetAdmin.setBudget({
        organizationId: hotel,
        monthlyLimitMicroUsd: null,
        reason: "Season over",
        audit: audit("req-reset"),
      }),
    ).toMatchObject({ monthlyLimitMicroUsd: 5_000_000, custom: false });
    expect(
      await budgetAdmin.setBudget({
        organizationId: creator,
        monthlyLimitMicroUsd: 1,
        reason: "Not a hotel",
        audit: audit(),
      }),
    ).toBeNull();
    expect(
      await budgetAdmin.setBudget({
        organizationId: randomUUID(),
        monthlyLimitMicroUsd: 1,
        reason: "No such account",
        audit: audit(),
      }),
    ).toBeNull();

    const budgets = await admin.query(
      "SELECT 1 FROM platform.ai_budgets WHERE organization_id = ANY($1::uuid[])",
      [[hotel, creator]],
    );
    expect(budgets.rowCount).toBe(0);
    const { rows } = await admin.query(
      `SELECT action, tenant_scope, actor_type, actor_user_id::text AS actor, causation_id,
              target_resource_type, target_resource_id, redacted_payload, private_payload,
              privacy_scope
       FROM platform.product_audit_events
       WHERE organization_id = $1::uuid ORDER BY recorded_at, causation_id`,
      [hotel],
    );
    expect(rows).toEqual([
      {
        action: "platform.ai.budget.set",
        tenant_scope: "organization",
        actor_type: "user",
        actor: staff,
        causation_id: "req-raise",
        target_resource_type: "ai_budget",
        target_resource_id: hotel,
        redacted_payload: {
          fromMonthlyLimitMicroUsd: null,
          toMonthlyLimitMicroUsd: 25_000_000,
          defaultMonthlyLimitMicroUsd: 5_000_000,
        },
        private_payload: { reason: "Busy season" },
        privacy_scope: "confidential",
      },
      {
        action: "platform.ai.budget.set",
        tenant_scope: "organization",
        actor_type: "user",
        actor: staff,
        causation_id: "req-reset",
        target_resource_type: "ai_budget",
        target_resource_id: hotel,
        redacted_payload: {
          fromMonthlyLimitMicroUsd: 25_000_000,
          toMonthlyLimitMicroUsd: null,
          defaultMonthlyLimitMicroUsd: 5_000_000,
        },
        private_payload: { reason: "Season over" },
        privacy_scope: "confidential",
      },
    ]);
  });

  it("emails once a month when vayada's AI spend passes the threshold, and retries a failed send", async () => {
    const may = new Date("2031-05-20T08:00:00Z");
    alertKeys.push("ai-spend-alert:2031-05-01");
    const hotel = await newOrganization("hotel_group", "Alpine Lodge");
    const sent: Parameters<AiSpendAlertDelivery["send"]>[0][] = [];
    let failNext = false;
    const delivery: AiSpendAlertDelivery = {
      async send(input) {
        if (failNext) {
          failNext = false;
          throw new Error("provider down");
        }
        sent.push(input);
      },
    };
    const check = createAiSpendAlert({
      pool,
      to: "owner@example.test",
      thresholdMicroUsd: 100_000_000,
      delivery,
      now: () => may,
    });

    await spend(hotel, may, 100_000_000);
    expect(await check()).toBe("below"); // exactly $100 has not passed it

    await spend(hotel, may, 2_345_678);
    failNext = true;
    await expect(check()).rejects.toThrow("provider down");
    expect(await check()).toBe("sent");
    expect(await check()).toBe("already_sent");

    expect(sent).toEqual([
      {
        to: "owner@example.test",
        subject: "vayada: AI spend for May 2031 passed $100.00",
        text: expect.stringContaining(
          "vayada's AI spend for May 2031 has passed $100.00: $102.35 so far",
        ),
        idempotencyKey: expect.stringMatching(/^ai-spend-alert:2031-05-01:[0-9a-f]{32}$/),
        emailProduct: "platform",
      },
    ]);
    expect(sent[0]!.text).toContain("- Alpine Lodge: $102.35");
    const marks = await admin.query(
      `SELECT action, redacted_payload FROM platform.product_audit_events
       WHERE product = 'platform' AND audit_key = 'ai-spend-alert:2031-05-01'`,
    );
    expect(marks.rows).toEqual([
      {
        action: "platform.ai.spend_alert.send",
        redacted_payload: {
          month: "2031-05-01",
          totalMicroUsd: 102_345_678,
          thresholdMicroUsd: 100_000_000,
        },
      },
    ]);
  });

  it("still emails about a month that passed the threshold in its last hour", async () => {
    alertKeys.push("ai-spend-alert:2031-06-01", "ai-spend-alert:2031-07-01");
    const hotel = await newOrganization("hotel_group", "Late Hotel");
    await spend(hotel, new Date("2031-06-30T23:30:00Z"), 150_000_000);
    const sent: string[] = [];
    const check = createAiSpendAlert({
      pool,
      to: "owner@example.test",
      thresholdMicroUsd: 100_000_000,
      delivery: { send: async (input) => void sent.push(input.subject) },
      now: () => new Date("2031-07-01T00:30:00Z"),
    });

    expect(await check()).toBe("sent");
    expect(await check()).toBe("below");
    expect(sent).toEqual(["vayada: AI spend for June 2031 passed $100.00"]);
  });
});
