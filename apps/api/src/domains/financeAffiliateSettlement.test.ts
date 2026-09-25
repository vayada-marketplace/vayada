import { describe, expect, it, vi } from "vitest";

import {
  allocateAffiliateSettlementEntry,
  normalizeAffiliateSettlementEntry,
  type AffiliateSettlementEntryV1,
} from "./financeAffiliateSettlement.js";

const payoutId = "50000000-0000-4000-8000-000000000001";
const entry = (change: Partial<AffiliateSettlementEntryV1> = {}): AffiliateSettlementEntryV1 => ({
  contractVersion: "finance-affiliate-settlement-entry.v1",
  earningEntryId: "10000000-0000-4000-8000-000000000001",
  recordedAt: "2026-09-25T08:00:00.000Z",
  beneficiary: {
    creatorProfileId: "creator_1",
    affiliateId: "affiliate_1",
    organizationId: "20000000-0000-4000-8000-000000000001",
  },
  source: {
    propertyId: "30000000-0000-4000-8000-000000000001",
    bookingId: "booking_1",
    stayItemId: "stay_1",
    agreementId: "agreement_1",
    policyVersionId: "policy_1",
    sourceRevision: 1,
  },
  money: {
    currency: "EUR",
    currencyMinorUnit: 2,
    commissionMinor: "3625",
    adjustmentMinor: "3625",
  },
  status: "eligible",
  ...change,
});

function database(
  options: {
    replay?: "same" | "conflict";
    settings?: Partial<Record<string, unknown>> | null;
    ambiguousSettings?: boolean;
    correctionPayouts?: Array<{ payoutId: string; amount: string }>;
  } = {},
) {
  const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let digest = "";
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    statements.push({ sql, values });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO finance.affiliate_earning_allocations")) {
      digest = String(values?.[1]);
      return {
        rows: options.replay ? [] : [{ earningEntryId: values?.[0] }],
        rowCount: options.replay ? 0 : 1,
      };
    }
    if (sql.includes('entry_digest AS "entryDigest"'))
      return {
        rows: [
          {
            entryDigest: options.replay === "conflict" ? "0".repeat(64) : digest,
            status: "allocated",
          },
        ],
        rowCount: 1,
      };
    if (sql.includes("FROM identity.organization_resource_links"))
      return options.settings === null
        ? { rows: [], rowCount: 0 }
        : (() => {
            const row = {
              payoutSettingId: "40000000-0000-4000-8000-000000000001",
              payoutMethod: "stripe",
              payoutCurrency: "EUR",
              scheduleType: "monthly",
              thresholdAmount: null,
              providerAccountId: "60000000-0000-4000-8000-000000000001",
              providerStatus: "active",
              providerPayoutsEnabled: true,
              destinationReady: true,
              ...options.settings,
            };
            const rows = options.ambiguousSettings ? [row, { ...row }] : [row];
            return { rows, rowCount: rows.length };
          })();
    if (sql.includes("INSERT INTO finance.payouts")) return { rows: [{ payoutId }], rowCount: 1 };
    if (sql.includes("payout_metadata->>'thresholdPending'='true'") && sql.includes("FOR UPDATE"))
      return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT id::text AS "payoutId",amount::text FROM finance.payouts'))
      return {
        rows: options.correctionPayouts ?? [],
        rowCount: options.correctionPayouts?.length ?? 0,
      };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  return {
    pool: { connect: async () => ({ query, release }) },
    statements,
    release,
  };
}

describe("affiliate earning settlement allocation", () => {
  it("validates the shared v1 handoff without inferring evidence or identity", () => {
    expect(normalizeAffiliateSettlementEntry(entry())).toEqual(entry());
    expect(
      normalizeAffiliateSettlementEntry(entry({ status: "pending" as "eligible" })),
    ).toBeNull();
    expect(
      normalizeAffiliateSettlementEntry(
        entry({ money: { ...entry().money, adjustmentMinor: "3.5" } }),
      ),
    ).toBeNull();
  });

  it("creates one scheduled Finance payout and shared retry job from a positive revision", async () => {
    const db = database();
    const result = await allocateAffiliateSettlementEntry(
      db.pool as never,
      entry(),
      new Date("2026-09-25T09:00:00.000Z"),
    );

    expect(result).toEqual({ ok: true, status: "allocated" });
    const payout = db.statements.find(({ sql }) => sql.includes("INSERT INTO finance.payouts"));
    expect(payout?.values).toEqual(
      expect.arrayContaining(["affiliate-earning:10000000-0000-4000-8000-000000000001", "36.25"]),
    );
    expect(payout?.values).toContain("2026-10-15T00:00:00.000Z");
    expect(db.statements.some(({ sql }) => sql.includes("finance-affiliate-payout-dispatch"))).toBe(
      true,
    );
    expect(db.statements.at(-1)?.sql).toBe("COMMIT");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("deduplicates the earning id and rejects a changed replay before payout creation", async () => {
    for (const replay of ["same", "conflict"] as const) {
      const db = database({ replay });
      const result = await allocateAffiliateSettlementEntry(db.pool as never, entry());
      expect(result).toEqual(
        replay === "same"
          ? { ok: true, status: "idempotent_replay" }
          : { ok: false, code: "earning_entry_conflict" },
      );
      expect(db.statements.some(({ sql }) => sql.includes("INSERT INTO finance.payouts"))).toBe(
        false,
      );
      expect(db.statements.at(-1)?.sql).toBe("ROLLBACK");
    }
  });

  it("keeps missing or incompatible payout readiness blocked and retryable", async () => {
    const db = database({ settings: { payoutCurrency: "USD" } });
    const result = await allocateAffiliateSettlementEntry(db.pool as never, entry());

    expect(result).toEqual({ ok: true, status: "blocked" });
    expect(db.statements.some(({ sql }) => sql.includes("INSERT INTO finance.payouts"))).toBe(
      false,
    );
    const finish = db.statements.find(({ sql }) => sql.includes("SET status=$2"));
    expect(finish?.values).toContain("currency_mismatch");
  });

  it("rejects automatic Stripe with a manual schedule", async () => {
    const db = database({ settings: { payoutMethod: "stripe", scheduleType: "manual" } });

    expect(await allocateAffiliateSettlementEntry(db.pool as never, entry())).toEqual({
      ok: true,
      status: "blocked",
    });
    expect(db.statements.find(({ sql }) => sql.includes("SET status=$2"))?.values).toContain(
      "unsupported_provider_schedule",
    );
  });

  it("records an immutable manual method without carrying a stale provider account", async () => {
    const db = database({ settings: { payoutMethod: "manual", scheduleType: "manual" } });

    expect(await allocateAffiliateSettlementEntry(db.pool as never, entry())).toEqual({
      ok: true,
      status: "allocated",
    });
    const payout = db.statements.find(({ sql }) => sql.includes("INSERT INTO finance.payouts"));
    expect(payout?.values?.[1]).toBeNull();
    expect(
      payout?.values?.some((value) => String(value).includes('"affiliatePayoutMethod":"manual"')),
    ).toBe(true);
  });

  it("blocks ambiguous settings and amounts that exceed Finance payout capacity", async () => {
    const cases = [
      {
        db: database({ ambiguousSettings: true }),
        input: entry(),
        blocker: "payout_readiness_missing",
      },
      {
        db: database(),
        input: entry({
          money: { ...entry().money, adjustmentMinor: "1000000000000000" },
        }),
        blocker: "payout_amount_exceeds_finance_capacity",
      },
    ];
    for (const testCase of cases) {
      expect(
        await allocateAffiliateSettlementEntry(testCase.db.pool as never, testCase.input),
      ).toEqual({ ok: true, status: "blocked" });
      expect(
        testCase.db.statements.find(({ sql }) => sql.includes("SET status=$2"))?.values,
      ).toContain(testCase.blocker);
    }
  });

  it("keeps a below-threshold payout pending without an execution job", async () => {
    const db = database({
      settings: { scheduleType: "threshold", thresholdAmount: "50.00", payoutMethod: "stripe" },
    });
    const result = await allocateAffiliateSettlementEntry(db.pool as never, entry());

    expect(result).toEqual({ ok: true, status: "allocated" });
    const payout = db.statements.find(({ sql }) => sql.includes("INSERT INTO finance.payouts"));
    expect(payout?.values).toContain("pending");
    expect(payout?.values?.some((value) => String(value).includes('"thresholdPending":true'))).toBe(
      true,
    );
    const migration = db.statements.find(({ sql }) => sql.includes("jsonb_set(payout_metadata"));
    expect(migration?.sql).toContain("job.attempts_count > 0 OR attempt.job_id IS NOT NULL");
    expect(migration?.values).toEqual(
      expect.arrayContaining(["60000000-0000-4000-8000-000000000001", JSON.stringify("stripe")]),
    );
    const thresholdBucket = db.statements.find(
      ({ sql }) => sql.includes("FOR UPDATE") && sql.includes("affiliatePayoutMethod"),
    );
    expect(thresholdBucket?.sql).toContain("organization_provider_account_id IS NOT DISTINCT FROM");
    expect(
      db.statements.some(
        ({ sql }) =>
          sql.includes("INSERT INTO platform.jobs") &&
          sql.includes("finance-affiliate-payout-dispatch"),
      ),
    ).toBe(false);
  });

  it("blocks an invalid threshold configuration for a retry after settings are repaired", async () => {
    for (const thresholdAmount of [null, "0.00", "invalid"]) {
      const db = database({ settings: { scheduleType: "threshold", thresholdAmount } });
      const result = await allocateAffiliateSettlementEntry(db.pool as never, entry());

      expect(result).toEqual({ ok: true, status: "blocked" });
      expect(db.statements.some(({ sql }) => sql.includes("INSERT INTO finance.payouts"))).toBe(
        false,
      );
      expect(db.statements.find(({ sql }) => sql.includes("SET status=$2"))?.values).toContain(
        "threshold_not_configured",
      );
    }
  });

  it("applies a negative revision only to unpaid history and leaves the remainder for review", async () => {
    const db = database({ correctionPayouts: [{ payoutId, amount: "5.00" }] });
    const correction = entry({
      earningEntryId: "10000000-0000-4000-8000-000000000002",
      money: { ...entry().money, commissionMinor: "2625", adjustmentMinor: "-1000" },
    });
    const result = await allocateAffiliateSettlementEntry(db.pool as never, correction);

    expect(result).toEqual({ ok: true, status: "correction_review" });
    const item = db.statements.find(({ sql }) =>
      sql.includes("INSERT INTO finance.affiliate_earning_allocation_items"),
    );
    expect(item?.values).toContain("-500");
    const finish = db.statements.find(({ sql }) => sql.includes("SET status=$2"));
    expect(finish?.values).toContain("-500");
    const correctionSelection = db.statements.find(({ sql }) =>
      sql.includes('SELECT id::text AS "payoutId",amount::text FROM finance.payouts'),
    );
    expect(correctionSelection?.sql).toContain("payout_metadata->>'creatorProfileId'=$5");
    expect(correctionSelection?.sql).toContain("job.attempts_count=0");
    expect(correctionSelection?.values).toContain("creator_1");
    expect(
      db.statements.some(
        ({ sql }) => sql.includes("finance-affiliate-payout-dispatch") && sql.includes("canceled"),
      ),
    ).toBe(true);
  });
});
