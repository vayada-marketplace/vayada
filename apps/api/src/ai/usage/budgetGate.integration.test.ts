import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "../../hotelSetupOrdinaryLogin.fixture.js";
import type { AiReservationRequest } from "../provider/aiProvider.js";
import type { ModelRoute } from "../provider/catalog.js";
import { createPgAiBudget, defaultMonthlyBudgetFromEnv } from "./budgetGate.js";

/**
 * VAY-2504: each hotel account's monthly AI budget, reserved before every model call. Real
 * PostgreSQL; the ledger is written by the ordinary API login, as in production.
 */
const url = process.env["TEST_DATABASE_URL"];
const HAIKU: ModelRoute = {
  provider: "bedrock",
  region: "eu-west-1",
  model: "eu.anthropic.claude-haiku-5-5",
};
const NOVEMBER = new Date("2026-11-20T10:00:00Z");

describe.skipIf(!url)("AI budgets and the usage ledger (VAY-2504)", () => {
  let admin: pg.Client;
  let fixture: HotelSetupOrdinaryLoginFixture;
  let pool: pg.Pool;
  const accounts: string[] = [];

  async function newAccount(monthlyLimitMicroUsd?: number): Promise<string> {
    const id = randomUUID();
    accounts.push(id);
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, workos_org_id)
       VALUES ($1::uuid, 'hotel_group', 'AI budget hotel', $1::text, 'wk-org-' || $1::text)`,
      [id],
    );
    if (monthlyLimitMicroUsd !== undefined)
      await admin.query(
        "INSERT INTO platform.ai_budgets (organization_id, monthly_limit_micro_usd) VALUES ($1, $2)",
        [id, monthlyLimitMicroUsd],
      );
    return id;
  }

  const request = (
    organizationId: string,
    reservedMicroUsd: number,
    holdMs = 60_000,
  ): AiReservationRequest => ({
    context: {
      organizationId,
      propertyId: null,
      userId: null,
      surface: "inbox",
      requestId: randomUUID(),
    },
    task: "inbox_translate",
    route: HAIKU,
    reservedMicroUsd,
    priceTableVersion: "2026-11-20",
    holdMs,
  });

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    pool = new pg.Pool({ connectionString: fixture.connectionString, max: 4 });
  });

  afterAll(async () => {
    await pool?.end();
    await fixture?.drop();
    if (accounts.length)
      await admin.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
        accounts,
      ]);
    await admin?.end();
  });

  it("refuses every call while an account has neither its own budget nor a default", async () => {
    const budget = createPgAiBudget({ pool, defaultMonthlyLimitMicroUsd: 0, now: () => NOVEMBER });
    const account = await newAccount();

    expect(await budget.reserve(request(account, 1))).toEqual({
      ok: false,
      reason: "allowance_used_up",
    });
    expect(await budget.monthStatus(account)).toEqual({
      month: "2026-11-01",
      usedMicroUsd: 0,
      limitMicroUsd: 0,
    });
  });

  it("lets only one of two simultaneous calls through a budget with room for one", async () => {
    const budget = createPgAiBudget({ pool, defaultMonthlyLimitMicroUsd: 0, now: () => NOVEMBER });
    const account = await newAccount(1_000);

    // Hold the account's lock so both calls are waiting for it at the same moment.
    await admin.query("BEGIN");
    await admin.query(
      "SELECT pg_advisory_xact_lock(hashtext('platform.ai_budget'), hashtext($1::uuid::text))",
      [account],
    );
    const both = Promise.all([
      budget.reserve(request(account, 600)),
      budget.reserve(request(account, 600)),
    ]);
    try {
      await vi.waitFor(
        async () => {
          const { rows } = await admin.query<{ waiting: number }>(
            "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
          );
          expect(rows[0]!.waiting).toBe(2);
        },
        { timeout: 5_000 },
      );
    } finally {
      await admin.query("COMMIT");
    }
    const results = await both;

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, reason: "allowance_used_up" });
    const rows = await admin.query(
      "SELECT 1 FROM platform.ai_usage_ledger WHERE organization_id = $1",
      [account],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("runs at most two calls at once per account and frees a place when one settles", async () => {
    const budget = createPgAiBudget({
      pool,
      defaultMonthlyLimitMicroUsd: 1_000_000,
      now: () => NOVEMBER,
    });
    const account = await newAccount();
    const first = await budget.reserve(request(account, 100));
    await budget.reserve(request(account, 100));

    expect(await budget.reserve(request(account, 100))).toEqual({ ok: false, reason: "busy" });
    if (!first.ok) throw new Error("first reservation failed");
    await budget.settle(first.reservationId, { status: "failed", costMicroUsd: 0 });
    expect(await budget.reserve(request(account, 100))).toMatchObject({ ok: true });
  });

  it("keeps counting a call that never settled at its reserved amount, but not as running", async () => {
    let at = NOVEMBER;
    const budget = createPgAiBudget({ pool, defaultMonthlyLimitMicroUsd: 1_000, now: () => at });
    const account = await newAccount();
    await budget.reserve(request(account, 300, 1_000));
    await budget.reserve(request(account, 300, 1_000));

    at = new Date(NOVEMBER.getTime() + 2_000);

    expect(await budget.monthStatus(account)).toMatchObject({ usedMicroUsd: 600 });
    expect(await budget.reserve(request(account, 400))).toMatchObject({ ok: true });
    expect(await budget.reserve(request(account, 1))).toEqual({
      ok: false,
      reason: "allowance_used_up",
    });
  });

  it("replaces a reservation with the real cost and tokens, once", async () => {
    const budget = createPgAiBudget({
      pool,
      defaultMonthlyLimitMicroUsd: 10_000,
      now: () => NOVEMBER,
    });
    const account = await newAccount();
    const reserved = await budget.reserve({
      ...request(account, 5_000),
      context: {
        organizationId: account,
        propertyId: null,
        userId: null,
        surface: "model_test",
        requestId: "run-7",
      },
    });
    if (!reserved.ok) throw new Error("reservation failed");
    const usage = {
      inputTokens: 1_000,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 500,
      outputTokens: 300,
    };

    await budget.settle(reserved.reservationId, { status: "completed", usage, costMicroUsd: 407 });
    await budget.settle(reserved.reservationId, { status: "failed", costMicroUsd: 5_000 });

    expect(await budget.monthStatus(account)).toMatchObject({
      usedMicroUsd: 407,
      limitMicroUsd: 10_000,
    });
    const { rows } = await admin.query(
      `SELECT status, cost_micro_usd::int AS cost, reserved_micro_usd::int AS reserved, input_tokens,
              cache_read_tokens, cache_write_tokens, output_tokens, surface, task, request_id, provider,
              region, model, price_table_version, budget_month::text AS month, settled_at IS NOT NULL AS settled
       FROM platform.ai_usage_ledger WHERE organization_id = $1`,
      [account],
    );
    expect(rows).toEqual([
      {
        status: "completed",
        cost: 407,
        reserved: 5_000,
        input_tokens: 1_000,
        cache_read_tokens: 2_000,
        cache_write_tokens: 500,
        output_tokens: 300,
        surface: "model_test",
        task: "inbox_translate",
        request_id: "run-7",
        provider: "bedrock",
        region: "eu-west-1",
        model: "eu.anthropic.claude-haiku-5-5",
        price_table_version: "2026-11-20",
        month: "2026-11-01",
        settled: true,
      },
    ]);
  });

  it("starts every account afresh each month", async () => {
    let at = new Date("2026-11-30T23:59:00Z");
    const budget = createPgAiBudget({ pool, defaultMonthlyLimitMicroUsd: 0, now: () => at });
    const account = await newAccount(1_000);
    expect(await budget.reserve(request(account, 1_000))).toMatchObject({ ok: true });
    expect(await budget.reserve(request(account, 1))).toEqual({
      ok: false,
      reason: "allowance_used_up",
    });

    at = new Date("2026-12-01T00:00:00Z");

    expect(await budget.reserve(request(account, 1_000))).toMatchObject({ ok: true });
    expect(await budget.monthStatus(account)).toEqual({
      month: "2026-12-01",
      usedMicroUsd: 1_000,
      limitMicroUsd: 1_000,
    });
  });

  it("counts a call reserved just before midnight as running in the new month", async () => {
    let at = new Date("2026-11-30T23:59:50Z");
    const budget = createPgAiBudget({
      pool,
      defaultMonthlyLimitMicroUsd: 1_000_000,
      now: () => at,
    });
    const account = await newAccount();
    await budget.reserve(request(account, 100));
    await budget.reserve(request(account, 100));

    at = new Date("2026-12-01T00:00:05Z");

    expect(await budget.reserve(request(account, 100))).toEqual({ ok: false, reason: "busy" });
    expect(await budget.monthStatus(account)).toMatchObject({ usedMicroUsd: 0 });
  });
});

describe("defaultMonthlyBudgetFromEnv", () => {
  it("reads dollars and cents and is 0 when unset", () => {
    expect(defaultMonthlyBudgetFromEnv({})).toBe(0);
    expect(defaultMonthlyBudgetFromEnv({ AI_DEFAULT_MONTHLY_BUDGET_USD: "5" })).toBe(5_000_000);
    expect(defaultMonthlyBudgetFromEnv({ AI_DEFAULT_MONTHLY_BUDGET_USD: "2.5" })).toBe(2_500_000);
    expect(defaultMonthlyBudgetFromEnv({ AI_DEFAULT_MONTHLY_BUDGET_USD: "0.07" })).toBe(70_000);
    expect(() => defaultMonthlyBudgetFromEnv({ AI_DEFAULT_MONTHLY_BUDGET_USD: "-1" })).toThrow();
    expect(() => defaultMonthlyBudgetFromEnv({ AI_DEFAULT_MONTHLY_BUDGET_USD: "1e6" })).toThrow();
  });
});
