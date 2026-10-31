import { describe, expect, it } from "vitest";

import {
  createPmsCalendarAutoOpenSource,
  fingerprintPmsCalendarAutoOpenSource,
} from "@vayada/domain-pms";

import {
  buildCalendarAutoOpenEventKey,
  buildCalendarAutoOpenJobKey,
  runPmsCalendarAutoOpenScheduler,
  type PmsCalendarAutoOpenCandidate,
  type PmsCalendarAutoOpenResult,
  type PmsCalendarAutoOpenSchedulerStore,
  type PmsChannexSchedulerContext,
} from "./pmsChannexScheduler.js";

const fixedNow = new Date("2026-09-01T10:00:00.000Z");

describe("PMS calendar auto-open scheduler jobs", () => {
  it("enqueues calendar windows once per property, horizon, and source", async () => {
    const candidate = calendarCandidate();
    const store = new MemoryCalendarAutoOpenStore({ calendarAutoOpen: [candidate] });

    const firstRun = await runPmsCalendarAutoOpenScheduler(store, {
      now: fixedNow,
      workerId: "worker_calendar",
    });
    const rerun = await runPmsCalendarAutoOpenScheduler(store, {
      now: fixedNow,
      workerId: "worker_calendar",
    });

    expect(firstRun).toEqual({
      name: "calendarAutoOpen",
      scanned: 1,
      enqueued: 1,
      reused: 0,
      autoOpenEnqueued: 1,
      autoOpenFailures: [],
    });
    expect(rerun).toMatchObject({
      scanned: 1,
      enqueued: 0,
      reused: 1,
      autoOpenEnqueued: 0,
    });
    expect(store.calendarOpenResults).toEqual([
      {
        candidate,
        createdNewJob: true,
        eventKey: `pms.calendar-auto-open:prop_alpenrose:2028-03-31:source-${candidate.sourceFingerprint}:v2`,
        jobKey: `pms.calendar-auto-open:property:prop_alpenrose:open-through-2028-03-31:source-${candidate.sourceFingerprint}:v2`,
      },
    ]);
    expect(store.domainEvents.map((event) => event.eventKey)).toContain(
      `pms.calendar-auto-open:prop_alpenrose:2028-03-31:source-${candidate.sourceFingerprint}:v2`,
    );
    expect(store.idempotencyKeys).toEqual([
      `pms.calendar-auto-open:property:prop_alpenrose:open-through-2028-03-31:source-${candidate.sourceFingerprint}:v2`,
    ]);
  });

  it("reports one calendar enqueue failure without stopping later properties", async () => {
    const failed = calendarCandidate({ propertyId: "prop_failed" });
    const later = calendarCandidate({ propertyId: "prop_later" });
    const store = new MemoryCalendarAutoOpenStore({
      calendarAutoOpen: [failed, later],
      calendarEnqueueFailures: [failed.propertyId],
    });

    const result = await runPmsCalendarAutoOpenScheduler(store, { now: fixedNow });

    expect(result.autoOpenEnqueued).toBe(1);
    expect(result.autoOpenFailures).toEqual([
      { propertyId: failed.propertyId, stage: "enqueue", message: "enqueue failed" },
    ]);
    expect(store.calendarOpenResults[0]?.candidate.propertyId).toBe(later.propertyId);
  });

  it("uses cutover-plan key formats for calendar windows", () => {
    expect(
      buildCalendarAutoOpenEventKey({
        propertyId: "prop_alpenrose",
        openThrough: "2028-03-31",
        sourceFingerprint: "a".repeat(64),
      }),
    ).toBe(`pms.calendar-auto-open:prop_alpenrose:2028-03-31:source-${"a".repeat(64)}:v2`);
    expect(
      buildCalendarAutoOpenJobKey({
        propertyId: "prop_alpenrose",
        openThrough: "2028-03-31",
        sourceFingerprint: "a".repeat(64),
      }),
    ).toBe(
      `pms.calendar-auto-open:property:prop_alpenrose:open-through-2028-03-31:source-${"a".repeat(64)}:v2`,
    );
  });
});

type MemoryStoreOptions = {
  calendarAutoOpen?: PmsCalendarAutoOpenCandidate[];
  calendarEnqueueFailures?: string[];
};

class MemoryCalendarAutoOpenStore implements PmsCalendarAutoOpenSchedulerStore {
  readonly domainEvents: Array<{ eventKey: string; payload: Record<string, unknown> }> = [];
  readonly idempotencyKeys: string[] = [];
  readonly calendarOpenResults: PmsCalendarAutoOpenResult[] = [];

  private readonly calendarAutoOpen: PmsCalendarAutoOpenCandidate[];
  private readonly calendarEnqueueFailures: Set<string>;

  constructor(options: MemoryStoreOptions = {}) {
    this.calendarAutoOpen = options.calendarAutoOpen ?? [];
    this.calendarEnqueueFailures = new Set(options.calendarEnqueueFailures);
  }

  async findCalendarAutoOpenCandidates(_now: Date, limit: number) {
    return { candidates: this.calendarAutoOpen.slice(0, limit), failures: [] };
  }

  async enqueueCalendarAutoOpenJob(
    candidate: PmsCalendarAutoOpenCandidate,
    _context: PmsChannexSchedulerContext,
  ): Promise<PmsCalendarAutoOpenResult> {
    if (this.calendarEnqueueFailures.has(candidate.propertyId)) throw new Error("enqueue failed");
    const eventKey = buildCalendarAutoOpenEventKey(candidate);
    const jobKey = buildCalendarAutoOpenJobKey(candidate);
    const existing = this.calendarOpenResults.find((result) => result.eventKey === eventKey);
    if (existing) return { ...existing, createdNewJob: false };

    const result = { candidate, createdNewJob: true, eventKey, jobKey };
    this.calendarOpenResults.push(result);
    this.domainEvents.push({
      eventKey,
      payload: {
        propertyId: candidate.propertyId,
        openThrough: candidate.openThrough,
        roomTypeIds: candidate.roomTypeIds,
      },
    });
    this.idempotencyKeys.push(jobKey);
    return result;
  }
}

function calendarCandidate(
  overrides: Partial<PmsCalendarAutoOpenCandidate> = {},
): PmsCalendarAutoOpenCandidate {
  const source = createPmsCalendarAutoOpenSource({
    settingRevision: 6,
    propertyProfileRevision: 4,
    propertyTimeZone: "Europe/Berlin",
    operatingCalendarRevision: 9,
    rooms: [
      { roomTypeId: "rt_deluxe", roomFactsRevision: 2, roomUnitsRevision: 3 },
      { roomTypeId: "rt_suite", roomFactsRevision: 4, roomUnitsRevision: 5 },
    ],
    pricing: {
      pricingCurrencyRevision: 2,
      flexibleRatePlans: [{ roomTypeId: "rt_deluxe", flexibleRatePlanRevision: 5 }],
      optionalPricingAggregateRevision: 7,
    },
  });
  return {
    propertyId: "prop_alpenrose",
    organizationId: "org_alpenrose",
    openFrom: "2027-09-01",
    openThrough: "2028-03-31",
    roomTypeIds: ["rt_deluxe", "rt_suite"],
    generatedCoverageThrough: "2027-08-31",
    source,
    sourceFingerprint: fingerprintPmsCalendarAutoOpenSource(source),
    correlationId: "corr_calendar_001",
    ...overrides,
  };
}
