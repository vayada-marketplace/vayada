import { describe, expect, it } from "vitest";

import {
  buildAffiliatePayoutDispatchJobKey,
  buildPropertyPayoutDispatchJobKey,
  runFinanceAffiliatePayoutDispatcher,
  runFinancePropertyPayoutDispatcher,
  type FinanceAffiliatePayoutDispatchCandidate,
  type FinanceAffiliatePayoutDispatchContext,
  type FinanceAffiliatePayoutDispatchMutationResult,
  type FinanceAffiliatePayoutDispatcherStore,
  type FinanceAffiliatePayoutProviderClient,
  type FinancePayoutProvider,
  type FinancePayoutProviderAttemptRecord,
  type FinancePayoutProviderResult,
  type FinancePropertyPayoutDispatchCandidate,
  type FinancePropertyPayoutDispatchContext,
  type FinancePropertyPayoutDispatchMutationResult,
  type FinancePropertyPayoutDispatcherStore,
} from "./financePayoutDispatcher.js";

const fixedNow = new Date("2026-06-13T10:00:00.000Z");

describe("Finance property payout dispatcher", () => {
  it("does not dispatch without reconciliation readiness and legacy scheduler freeze", async () => {
    const ready = payoutCandidate({ payoutId: "payout_ready" });
    const store = new MemoryFinancePayoutDispatcherStore([
      payoutCandidate({ payoutId: "payout_unreconciled", reconciliationReady: false }),
      payoutCandidate({ payoutId: "payout_legacy_active", legacySchedulerFrozen: false }),
      payoutCandidate({ payoutId: "payout_legacy_window", activeLegacyTransferWindow: true }),
      payoutCandidate({
        payoutId: "payout_provider_exists",
        providerPayoutId: "tr_legacy_or_target_existing",
      }),
      ready,
    ]);
    const provider = createSequenceProvider([
      {
        ok: true,
        providerPayoutId: "tr_target_ready",
        providerRequestId: "req_ready",
        status: "processing",
      },
    ]);

    const result = await runFinancePropertyPayoutDispatcher(store, provider, {
      now: fixedNow,
      workerId: "worker_finance",
    });

    expect(provider.calls.map((candidate) => candidate.payoutId)).toEqual(["payout_ready"]);
    expect(result).toMatchObject({
      scanned: 5,
      dispatched: 1,
      retryScheduled: 0,
      failed: 0,
      skipped: [
        { payoutId: "payout_unreconciled", reason: "reconciliation_not_ready" },
        { payoutId: "payout_legacy_active", reason: "legacy_scheduler_not_frozen" },
        { payoutId: "payout_legacy_window", reason: "active_legacy_transfer_window" },
        { payoutId: "payout_provider_exists", reason: "payout_already_dispatched" },
      ],
    });
    expect(store.payout("payout_ready")?.providerPayoutId).toBe("tr_target_ready");
    expect(store.providerAttempts).toHaveLength(1);
    expect(store.providerAttempts[0]).toMatchObject({
      payoutId: "payout_ready",
      provider: "stripe",
      attemptNumber: 1,
      status: "succeeded",
      providerPayoutId: "tr_target_ready",
      workerId: "worker_finance",
    });
    expect(store.providerAttempts[0]?.requestPayloadHash).toMatch(/^sha256:/);
  });

  it("does not double-dispatch when rerun after target success and rolls back retryable failures", async () => {
    const store = new MemoryFinancePayoutDispatcherStore([
      payoutCandidate({ payoutId: "payout_success" }),
      payoutCandidate({ payoutId: "payout_retry", provider: "xendit" }),
    ]);
    const provider = createSequenceProvider([
      {
        ok: true,
        providerPayoutId: "xpd_success",
        providerRequestId: "req_success",
        status: "processing",
      },
      {
        ok: false,
        providerRequestId: "req_retry",
        retryable: true,
        errorCategory: "provider_5xx",
        message: "Provider returned 503.",
      },
    ]);

    const firstRun = await runFinancePropertyPayoutDispatcher(store, provider, {
      now: fixedNow,
      workerId: "worker_finance",
    });
    const rerun = await runFinancePropertyPayoutDispatcher(store, provider, {
      now: new Date(fixedNow.getTime() + 60_000),
      workerId: "worker_finance",
    });

    expect(firstRun).toMatchObject({
      scanned: 2,
      dispatched: 1,
      retryScheduled: 1,
      failed: 0,
    });
    expect(rerun).toMatchObject({
      scanned: 1,
      dispatched: 0,
      retryScheduled: 0,
      failed: 1,
    });
    expect(provider.calls.map((candidate) => candidate.payoutId)).toEqual([
      "payout_success",
      "payout_retry",
      "payout_retry",
    ]);
    expect(store.payout("payout_success")?.providerPayoutId).toBe("xpd_success");
    expect(store.payout("payout_retry")?.providerPayoutId).toBeNull();
    expect(store.payout("payout_retry")?.retryCount).toBe(2);
    expect(store.providerAttempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 1, 2]);
    expect(store.providerAttempts.map((attempt) => attempt.status)).toEqual([
      "succeeded",
      "failed",
      "failed",
    ]);
  });

  it("skips provider dispatch when the target payout claim is already taken", async () => {
    const store = new MemoryFinancePayoutDispatcherStore([
      payoutCandidate({ payoutId: "payout_claimed" }),
    ]);
    store.claimConflicts.add("payout_claimed");
    const provider = createSequenceProvider([
      {
        ok: true,
        providerPayoutId: "should_not_send",
        providerRequestId: "should_not_send",
        status: "processing",
      },
    ]);

    const result = await runFinancePropertyPayoutDispatcher(store, provider, {
      now: fixedNow,
      workerId: "worker_finance",
    });

    expect(provider.calls).toEqual([]);
    expect(result).toMatchObject({
      scanned: 1,
      dispatched: 0,
      skipped: [{ payoutId: "payout_claimed", reason: "dispatch_claim_conflict" }],
    });
    expect(store.providerAttempts).toEqual([]);
  });

  it("uses the finance property payout dispatch job key format", () => {
    expect(
      buildPropertyPayoutDispatchJobKey({
        propertyId: "f3000000-0000-0000-0000-000000000686",
        payoutId: "payout_2026_abcd",
      }),
    ).toBe(
      "finance.dispatch-property-payout:property:f3000000-0000-0000-0000-000000000686:payout:payout_2026_abcd:v1",
    );
  });
});

describe("Finance affiliate payout dispatcher", () => {
  it("dispatches only monthly affiliate payouts after resource, legacy, and notification gates", async () => {
    const ready = affiliatePayoutCandidate({ payoutId: "affiliate_payout_ready" });
    const store = new MemoryFinanceAffiliatePayoutDispatcherStore([
      affiliatePayoutCandidate({
        payoutId: "affiliate_payout_unlinked",
        affiliateResourceLinked: false,
      }),
      affiliatePayoutCandidate({
        payoutId: "affiliate_payout_manual",
        payoutSchedule: "manual",
      }),
      affiliatePayoutCandidate({
        payoutId: "affiliate_payout_legacy_active",
        legacySchedulerFrozen: false,
      }),
      affiliatePayoutCandidate({
        payoutId: "affiliate_payout_notification_pending",
        notificationAuditReady: false,
      }),
      affiliatePayoutCandidate({
        payoutId: "affiliate_payout_provider_exists",
        providerPayoutId: "po_existing_affiliate",
      }),
      ready,
    ]);
    const provider = createAffiliateSequenceProvider([
      {
        ok: true,
        providerPayoutId: "po_affiliate_ready",
        providerRequestId: "req_affiliate_ready",
        status: "processing",
      },
    ]);

    const result = await runFinanceAffiliatePayoutDispatcher(store, provider, {
      now: fixedNow,
      workerId: "worker_affiliate_finance",
    });

    expect(provider.calls.map((candidate) => candidate.payoutId)).toEqual([
      "affiliate_payout_ready",
    ]);
    expect(result).toMatchObject({
      scanned: 6,
      dispatched: 1,
      retryScheduled: 0,
      failed: 0,
      skipped: [
        { payoutId: "affiliate_payout_unlinked", reason: "affiliate_resource_not_linked" },
        { payoutId: "affiliate_payout_manual", reason: "non_monthly_schedule" },
        { payoutId: "affiliate_payout_legacy_active", reason: "legacy_scheduler_not_frozen" },
        {
          payoutId: "affiliate_payout_notification_pending",
          reason: "notification_audit_not_ready",
        },
        { payoutId: "affiliate_payout_provider_exists", reason: "payout_already_dispatched" },
      ],
    });
    expect(store.payout("affiliate_payout_ready")?.providerPayoutId).toBe("po_affiliate_ready");
    expect(store.providerAttempts).toHaveLength(1);
    expect(store.providerAttempts[0]).toMatchObject({
      payoutId: "affiliate_payout_ready",
      propertyId: null,
      affiliateId: "affiliate_finance_partner_686",
      organizationId: "a6000000-0000-0000-0000-000000000686",
      provider: "stripe",
      queueName: "finance-affiliate-payout-dispatch",
      status: "succeeded",
    });
    expect(store.pmsWrites).toEqual([]);
    expect(store.affiliateIdentityWrites).toEqual([]);
    expect(store.notificationAudit).toEqual([
      {
        affiliateId: "affiliate_finance_partner_686",
        payoutId: "affiliate_payout_ready",
        providerPayoutId: "po_affiliate_ready",
      },
    ]);
  });

  it("uses the finance affiliate payout dispatch job key format", () => {
    expect(
      buildAffiliatePayoutDispatchJobKey({
        affiliateId: "affiliate_finance_partner_686",
        payoutId: "affiliate_payout_2026_06",
      }),
    ).toBe(
      "finance.dispatch-affiliate-payout:affiliate:affiliate_finance_partner_686:payout:affiliate_payout_2026_06:v1",
    );
  });
});

class MemoryFinancePayoutDispatcherStore implements FinancePropertyPayoutDispatcherStore {
  readonly providerAttempts: FinancePayoutProviderAttemptRecord[] = [];
  readonly claimConflicts = new Set<string>();

  constructor(private readonly payouts: FinancePropertyPayoutDispatchCandidate[]) {}

  payout(payoutId: string): FinancePropertyPayoutDispatchCandidate | undefined {
    return this.payouts.find((payout) => payout.payoutId === payoutId);
  }

  async findDuePropertyPayoutDispatchCandidates(
    now: Date,
    limit: number,
  ): Promise<FinancePropertyPayoutDispatchCandidate[]> {
    return this.payouts
      .filter(
        (payout) =>
          !payout.providerPayoutId &&
          (payout.retryCount === 0 || payout.retryCount < payout.maxAttempts) &&
          new Date(payout.scheduledAt) <= now,
      )
      .concat(
        this.payouts.filter(
          (payout) =>
            Boolean(payout.providerPayoutId) &&
            payout.payoutId === "payout_provider_exists" &&
            new Date(payout.scheduledAt) <= now,
        ),
      )
      .slice(0, limit);
  }

  async claimPropertyPayoutDispatch(
    candidate: FinancePropertyPayoutDispatchCandidate,
  ): Promise<boolean> {
    return !candidate.providerPayoutId && !this.claimConflicts.has(candidate.payoutId);
  }

  async recordProviderAttempt(attempt: FinancePayoutProviderAttemptRecord): Promise<void> {
    this.providerAttempts.push(attempt);
  }

  async markPropertyPayoutDispatched(
    candidate: FinancePropertyPayoutDispatchCandidate,
    result: { providerPayoutId: string },
  ): Promise<FinancePropertyPayoutDispatchMutationResult> {
    candidate.providerPayoutId = result.providerPayoutId;
    return {
      payoutId: candidate.payoutId,
      propertyId: candidate.propertyId,
      status: "dispatched",
      providerPayoutId: result.providerPayoutId,
    };
  }

  async markPropertyPayoutDispatchFailed(
    candidate: FinancePropertyPayoutDispatchCandidate,
    result: { retryable: boolean },
    _attempt: FinancePayoutProviderAttemptRecord,
    _context: FinancePropertyPayoutDispatchContext,
  ): Promise<FinancePropertyPayoutDispatchMutationResult> {
    candidate.retryCount += 1;
    return {
      payoutId: candidate.payoutId,
      propertyId: candidate.propertyId,
      status:
        result.retryable && candidate.retryCount < candidate.maxAttempts
          ? "retry_scheduled"
          : "failed",
      providerPayoutId: null,
    };
  }
}

class MemoryFinanceAffiliatePayoutDispatcherStore implements FinanceAffiliatePayoutDispatcherStore {
  readonly providerAttempts: FinancePayoutProviderAttemptRecord[] = [];
  readonly claimConflicts = new Set<string>();
  readonly pmsWrites: string[] = [];
  readonly affiliateIdentityWrites: string[] = [];
  readonly notificationAudit: Array<{
    affiliateId: string;
    payoutId: string;
    providerPayoutId: string;
  }> = [];

  constructor(private readonly payouts: FinanceAffiliatePayoutDispatchCandidate[]) {}

  payout(payoutId: string): FinanceAffiliatePayoutDispatchCandidate | undefined {
    return this.payouts.find((payout) => payout.payoutId === payoutId);
  }

  async findDueAffiliatePayoutDispatchCandidates(
    now: Date,
    limit: number,
  ): Promise<FinanceAffiliatePayoutDispatchCandidate[]> {
    return this.payouts.filter((payout) => new Date(payout.scheduledAt) <= now).slice(0, limit);
  }

  async claimAffiliatePayoutDispatch(
    candidate: FinanceAffiliatePayoutDispatchCandidate,
  ): Promise<boolean> {
    return !candidate.providerPayoutId && !this.claimConflicts.has(candidate.payoutId);
  }

  async recordProviderAttempt(attempt: FinancePayoutProviderAttemptRecord): Promise<void> {
    this.providerAttempts.push(attempt);
  }

  async markAffiliatePayoutDispatched(
    candidate: FinanceAffiliatePayoutDispatchCandidate,
    result: { providerPayoutId: string },
  ): Promise<FinanceAffiliatePayoutDispatchMutationResult> {
    candidate.providerPayoutId = result.providerPayoutId;
    this.notificationAudit.push({
      affiliateId: candidate.affiliateId,
      payoutId: candidate.payoutId,
      providerPayoutId: result.providerPayoutId,
    });
    return {
      payoutId: candidate.payoutId,
      affiliateId: candidate.affiliateId,
      organizationId: candidate.organizationId,
      status: "dispatched",
      providerPayoutId: result.providerPayoutId,
    };
  }

  async markAffiliatePayoutDispatchFailed(
    candidate: FinanceAffiliatePayoutDispatchCandidate,
    result: { retryable: boolean },
    _attempt: FinancePayoutProviderAttemptRecord,
    _context: FinanceAffiliatePayoutDispatchContext,
  ): Promise<FinanceAffiliatePayoutDispatchMutationResult> {
    candidate.retryCount += 1;
    return {
      payoutId: candidate.payoutId,
      affiliateId: candidate.affiliateId,
      organizationId: candidate.organizationId,
      status:
        result.retryable && candidate.retryCount < candidate.maxAttempts
          ? "retry_scheduled"
          : "failed",
      providerPayoutId: null,
    };
  }
}

function payoutCandidate(
  overrides: Partial<FinancePropertyPayoutDispatchCandidate> = {},
): FinancePropertyPayoutDispatchCandidate {
  return {
    payoutId: "payout_ready",
    propertyId: "f3000000-0000-0000-0000-000000000686",
    amount: "1400.00",
    currency: "EUR",
    provider: "stripe",
    providerAccountId: "acct_target_alpenrose",
    retryCount: 0,
    maxAttempts: 2,
    scheduledAt: "2026-06-13T09:00:00.000Z",
    reconciliationReady: true,
    legacySchedulerFrozen: true,
    activeLegacyTransferWindow: false,
    providerPayoutId: null,
    ...overrides,
  };
}

function affiliatePayoutCandidate(
  overrides: Partial<FinanceAffiliatePayoutDispatchCandidate> = {},
): FinanceAffiliatePayoutDispatchCandidate {
  return {
    payoutId: "affiliate_payout_ready",
    affiliateId: "affiliate_finance_partner_686",
    organizationId: "a6000000-0000-0000-0000-000000000686",
    amount: "350.00",
    currency: "EUR",
    provider: "stripe",
    providerAccountId: "acct_affiliate_target",
    retryCount: 0,
    maxAttempts: 2,
    scheduledAt: "2026-06-01T09:00:00.000Z",
    payoutSchedule: "monthly",
    affiliateResourceLinked: true,
    legacySchedulerFrozen: true,
    notificationAuditReady: true,
    providerPayoutId: null,
    ...overrides,
  };
}

function createSequenceProvider(results: FinancePayoutProviderResult[]): FinancePayoutProvider & {
  calls: FinancePropertyPayoutDispatchCandidate[];
} {
  const calls: FinancePropertyPayoutDispatchCandidate[] = [];
  return {
    calls,
    async dispatchPropertyPayout(candidate) {
      calls.push(candidate);
      const next = results.shift();
      if (!next) {
        return {
          ok: false,
          retryable: false,
          errorCategory: "provider_rejected",
          message: "No provider fixture result configured.",
        };
      }
      return next;
    },
  };
}

function createAffiliateSequenceProvider(
  results: FinancePayoutProviderResult[],
): FinanceAffiliatePayoutProviderClient & {
  calls: FinanceAffiliatePayoutDispatchCandidate[];
} {
  const calls: FinanceAffiliatePayoutDispatchCandidate[] = [];
  return {
    calls,
    async dispatchAffiliatePayout(candidate) {
      calls.push(candidate);
      const next = results.shift();
      if (!next) {
        return {
          ok: false,
          retryable: false,
          errorCategory: "provider_rejected",
          message: "No affiliate provider fixture result configured.",
        };
      }
      return next;
    },
  };
}
