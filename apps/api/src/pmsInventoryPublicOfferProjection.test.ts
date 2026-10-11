import type { QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  CLOSE_UNPRICED_PUBLIC_OFFERS,
  createTargetPmsInventoryPublicOfferProjection,
  projectPmsInventoryToPublicOffers,
  UPSERT_PRICED_PUBLIC_OFFERS,
  type TargetPmsInventoryPublicOfferProjectionOptions,
} from "./domains/pmsInventoryPublicOfferProjection.js";

const propertyId = "f6853000-0000-0000-0000-000000000001";

describe("PMS inventory public offer projection", () => {
  it("keeps PMS-first inventory events pending until a public profile exists", async () => {
    const target = projectionPool({ profileAvailable: false });
    const projector = createTargetPmsInventoryPublicOfferProjection({
      connectionString: "postgresql://unused",
      pool: target.pool,
      now: () => new Date("2026-08-14T17:00:00.000Z"),
    });

    await expect(projector.projectPending({ propertyId })).resolves.toEqual({
      profileAvailable: false,
      pendingEvents: 1,
      projectedOfferDays: 0,
    });
    expect(target.queries.some((query) => query.includes("public_room_offer_snapshots"))).toBe(
      false,
    );
    expect(target.queries.some((query) => query.includes("SET status = 'published'"))).toBe(false);
  });

  it("closes unpriced offers once then publishes the durable event", async () => {
    const target = projectionPool({ profileAvailable: true, projectedOfferDays: 366 });
    const projector = createTargetPmsInventoryPublicOfferProjection({
      connectionString: "postgresql://unused",
      pool: target.pool,
      now: () => new Date("2026-08-14T17:00:00.000Z"),
    });

    await expect(projector.projectPending({ propertyId })).resolves.toEqual({
      profileAvailable: true,
      pendingEvents: 1,
      projectedOfferDays: 366,
    });
    expect(target.publishedEventIds).toEqual(["f6855f00-0000-0000-0000-000000000001"]);
    const claim = target.queries.find((query) => query.includes("WITH candidate_event AS"));
    expect(claim).toContain("outbox.destination = 'distribution.inventory-projection'");
    expect(claim).toContain("outbox.event_type = 'pms.inventory.projection_refresh_requested'");
    expect(CLOSE_UNPRICED_PUBLIC_OFFERS).toContain("freshness_status = 'fresh'");
    expect(CLOSE_UNPRICED_PUBLIC_OFFERS).toContain("offer.public_offer_key <> ALL($3::text[])");
    expect(UPSERT_PRICED_PUBLIC_OFFERS).toContain("WHERE NOT EXISTS");
    expect(UPSERT_PRICED_PUBLIC_OFFERS).toContain("IS NOT DISTINCT FROM");
    expect(UPSERT_PRICED_PUBLIC_OFFERS).not.toContain("base_rate_amount");
  });

  it("does not duplicate stock or offers after the event has already been published", async () => {
    const target = projectionPool({ profileAvailable: true, projectedOfferDays: 366 });
    const projector = createTargetPmsInventoryPublicOfferProjection({
      connectionString: "postgresql://unused",
      pool: target.pool,
      now: () => new Date("2026-08-14T17:00:00.000Z"),
    });

    const first = await projector.projectPending({ propertyId });
    const replay = await projector.projectPending({ propertyId });

    expect(first.projectedOfferDays).toBe(366);
    expect(replay).toEqual({
      profileAvailable: false,
      pendingEvents: 0,
      projectedOfferDays: 0,
    });
    expect(
      target.queries.filter((query) =>
        query.includes("UPDATE distribution.public_room_offer_snapshots offer SET"),
      ),
    ).toHaveLength(1);
  });

  it("backs off a failed public-bookability refresh and publishes it on a later retry", async () => {
    let currentTime = new Date("2026-08-14T17:00:00.000Z");
    const target = projectionPool({ profileAvailable: true, projectedOfferDays: 2 });
    const refreshPublicBookability = vi
      .fn<(command: { propertyId: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("publication unavailable"))
      .mockResolvedValue(undefined);
    const projector = createTargetPmsInventoryPublicOfferProjection({
      connectionString: "postgresql://unused",
      pool: target.pool,
      now: () => currentTime,
      random: () => 0,
      refreshPublicBookability,
    });

    await expect(projector.runRetryBatch()).resolves.toMatchObject({
      processedProperties: 1,
      failedEvents: 1,
      exhaustedEvents: 0,
      publishedEvents: 0,
    });
    expect(target.state).toMatchObject({
      status: "failed",
      attemptsCount: 1,
      availableAt: "2026-08-14T17:00:15.000Z",
    });
    expect(target.publishedEventIds).toEqual([]);

    currentTime = new Date("2026-08-14T17:00:10.000Z");
    await expect(projector.runRetryBatch()).resolves.toMatchObject({
      processedProperties: 0,
      failedEvents: 0,
    });

    currentTime = new Date("2026-08-14T17:00:16.000Z");
    await expect(projector.runRetryBatch()).resolves.toMatchObject({
      processedProperties: 1,
      publishedEvents: 1,
      failedEvents: 0,
    });
    expect(target.state).toMatchObject({ status: "published", attemptsCount: 2 });
    expect(refreshPublicBookability).toHaveBeenCalledTimes(2);
  });

  it("dead-letters a final failed attempt exactly once", async () => {
    const target = projectionPool({
      profileAvailable: true,
      projectionError: new Error("database unavailable"),
      maxAttempts: 1,
    });
    const projector = createTargetPmsInventoryPublicOfferProjection({
      connectionString: "postgresql://unused",
      pool: target.pool,
      now: () => new Date("2026-08-14T17:00:00.000Z"),
    });

    await expect(projector.runRetryBatch()).resolves.toMatchObject({
      failedEvents: 1,
      exhaustedEvents: 1,
    });
    await expect(projector.runRetryBatch()).resolves.toMatchObject({
      processedProperties: 0,
      exhaustedEvents: 0,
    });
    expect(target.state).toMatchObject({ status: "failed", attemptsCount: 1 });
    expect(target.deadLetterEventIds).toEqual(["f6855f00-0000-0000-0000-000000000001"]);
  });

  it("recovers and dead-letters an expired final-attempt lease", async () => {
    const target = projectionPool({
      profileAvailable: true,
      status: "leased",
      attemptsCount: 1,
      maxAttempts: 1,
      leasedUntil: "2026-08-14T16:59:00.000Z",
    });
    const projector = createTargetPmsInventoryPublicOfferProjection({
      connectionString: "postgresql://unused",
      pool: target.pool,
      now: () => new Date("2026-08-14T17:00:00.000Z"),
    });

    await expect(projector.runRetryBatch()).resolves.toMatchObject({
      processedProperties: 0,
      failedEvents: 1,
      exhaustedEvents: 1,
    });
    expect(target.state).toMatchObject({ status: "failed", attemptsCount: 1 });
    expect(target.deadLetterEventIds).toEqual(["f6855f00-0000-0000-0000-000000000001"]);
  });
});

describe("pricing-v2 public offer days", () => {
  const roomTypeId = "f6853000-0000-0000-0000-000000000002";
  const rules = {
    minArrivalNights: 2,
    maxStayNights: null,
    closedToArrival: false,
    closedToDeparture: false,
    stopSell: false,
  };
  const configuration = {
    version: "pricing.v2",
    propertyId,
    roomTypeId,
    revision: 1,
    currency: "EUR",
    capacity: { total: 3, adults: 3, children: 1 },
    children: {
      adultFromAge: 12,
      bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "2000", countsTowardCapacity: true }],
    },
    offers: [
      {
        id: "flex",
        termsRevision: "terms-1",
        meal: {
          kind: "half_board",
          charge: { kind: "person", adultMinor: "1500", childBandAmountsMinor: ["500"] },
        },
        price: {
          kind: "independent",
          calendar: {
            base: { mode: "occupancy", amountsMinor: ["10000", "13000", "15500"] },
            months: [],
            seasons: [],
            weekdays: [],
            dates: [],
          },
        },
        restrictions: {
          kind: "own",
          rules,
          seasons: [],
          dates: [{ date: "2026-08-19", rules: { ...rules, stopSell: true } }],
        },
      },
    ],
  };
  const day = (stayDate: string, availableCount: number, open = true) => ({
    roomTypeId,
    stayDate,
    availableCount,
    totalCount: 2,
    open,
  });

  function client(priced: boolean | "unreadable") {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const query = async <T extends QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ) => {
      calls.push({ text, values });
      if (text.includes("FROM pms.pricing_v2_heads"))
        return rows(
          (priced
            ? [
                {
                  head_revision: 1,
                  revision: 1,
                  currency: "EUR",
                  source_revisions: priced === "unreadable" ? {} : { room: "1" },
                  owner_references: { terms: "terms-1" },
                  room_count: 1,
                },
              ]
            : []) as unknown as T[],
        );
      if (text.includes("FROM pms.pricing_v2_rooms"))
        return rows([{ room_type_id: roomTypeId, configuration }] as unknown as T[]);
      if (text.includes('AS "stayDate"'))
        return rows([
          day("2026-08-15", 2),
          day("2026-08-16", 1),
          day("2026-08-17", 0),
          day("2026-08-18", 2, false),
          day("2026-08-19", 2),
        ] as unknown as T[]);
      if (text === UPSERT_PRICED_PUBLIC_OFFERS)
        return rows(
          (values[3] as string[]).map(() => ({ snapshotId: "changed" })) as unknown as T[],
        );
      return rows([] as T[]);
    };
    return { query, calls };
  }

  it("projects each priced night with its one-adult price, stock and stop-sell", async () => {
    const target = client(true);
    await expect(
      projectPmsInventoryToPublicOffers(target, propertyId, new Date("2026-08-14T17:00:00Z")),
    ).resolves.toBe(5);
    const upsert = target.calls.find((call) => call.text === UPSERT_PRICED_PUBLIC_OFFERS)!;
    expect(upsert.values.slice(0, 3)).toEqual([propertyId, "EUR", "2026-08-14T17:00:00.000Z"]);
    const key = `pricing-v2:${roomTypeId}:flex`;
    expect(upsert.values.slice(3)).toEqual([
      Array(5).fill(roomTypeId),
      ["2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18", "2026-08-19"],
      Array(5).fill(key),
      ["available", "limited", "sold_out", "closed", "closed"],
      [2, 1, 0, 0, 2],
      Array(5).fill("115.00"),
      Array(5).fill(3),
      Array(5).fill(1),
      Array(5).fill(3),
      Array(5).fill("half_board"),
      Array(5).fill(2),
      Array(5).fill(null),
    ]);
    const close = target.calls.find((call) => call.text === CLOSE_UNPRICED_PUBLIC_OFFERS)!;
    expect(close.values).toEqual([propertyId, "2026-08-14T17:00:00.000Z", [key]]);
  });

  it.each([false, "unreadable"] as const)(
    "closes every offer day without readable prices (%s)",
    async (priced) => {
      const target = client(priced);
      await expect(
        projectPmsInventoryToPublicOffers(target, propertyId, new Date("2026-08-14T17:00:00Z")),
      ).resolves.toBe(0);
      expect(target.calls.map((call) => call.text)).not.toContain(UPSERT_PRICED_PUBLIC_OFFERS);
      expect(target.calls.some((call) => call.text.includes('AS "stayDate"'))).toBe(false);
      expect(target.calls.at(-1)).toEqual({
        text: CLOSE_UNPRICED_PUBLIC_OFFERS,
        values: [propertyId, "2026-08-14T17:00:00.000Z", []],
      });
    },
  );
});

function projectionPool(options: {
  profileAvailable: boolean;
  projectedOfferDays?: number;
  projectionError?: Error;
  status?: "pending" | "leased" | "failed" | "published";
  attemptsCount?: number;
  maxAttempts?: number;
  leasedUntil?: string | null;
}) {
  const outboxEventId = "f6855f00-0000-0000-0000-000000000001";
  const state = {
    status: options.status ?? ("pending" as "pending" | "leased" | "failed" | "published"),
    attemptsCount: options.attemptsCount ?? 0,
    maxAttempts: options.maxAttempts ?? 5,
    availableAt: "2026-08-14T00:00:00.000Z",
    leasedUntil: options.leasedUntil ?? null,
    leaseToken: options.status === "leased" ? "expired-lease-token" : null,
  };
  const queries: string[] = [];
  const publishedEventIds: string[] = [];
  const deadLetterEventIds: string[] = [];
  const release = vi.fn();
  const query = async <T extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
    queries.push(text);
    if (text.includes("outbox.leased_until <= $1::timestamptz")) {
      const recoveredAt = String(values?.[0]);
      if (
        state.status === "leased" &&
        state.leasedUntil &&
        new Date(state.leasedUntil) <= new Date(recoveredAt)
      ) {
        state.status = "failed";
        state.leasedUntil = null;
        state.leaseToken = null;
        if (state.attemptsCount < state.maxAttempts) state.availableAt = recoveredAt;
        return rows([
          { outboxEventId, attemptsCount: state.attemptsCount, maxAttempts: state.maxAttempts },
        ] as unknown as T[]);
      }
      return rows([] as T[]);
    }
    if (text.includes("WITH candidate_event AS")) {
      const claimedAt = String(values?.[0]);
      const includeNotDue = values?.[5] === true;
      const due = new Date(state.availableAt) <= new Date(claimedAt);
      const claimable =
        state.attemptsCount < state.maxAttempts &&
        ((state.status === "pending" && (includeNotDue || due)) ||
          (state.status === "failed" && due));
      if (!claimable) return rows([] as T[]);
      state.status = "leased";
      state.attemptsCount += 1;
      state.leasedUntil = String(values?.[2]);
      state.leaseToken = String(values?.[4]);
      return rows([
        {
          outboxEventId,
          propertyId,
          attemptsCount: state.attemptsCount,
          maxAttempts: state.maxAttempts,
        },
      ] as unknown as T[]);
    }
    if (
      text.includes("FROM platform.outbox_events outbox") &&
      text.includes("publicOfferProjection,leaseToken") &&
      text.includes("FOR UPDATE")
    ) {
      return rows(
        state.status === "leased" && state.leaseToken === values?.[2]
          ? ([
              {
                outboxEventId,
                propertyId,
                attemptsCount: state.attemptsCount,
                maxAttempts: state.maxAttempts,
              },
            ] as unknown as T[])
          : ([] as T[]),
      );
    }
    if (
      text.includes("FROM distribution.public_hotel_bookability_profiles") &&
      !text.includes("UPDATE distribution.public_room_offer_snapshots offer SET")
    ) {
      return rows(options.profileAvailable ? ([{ exists: 1 }] as unknown as T[]) : ([] as T[]));
    }
    if (text.includes("UPDATE distribution.public_room_offer_snapshots offer SET")) {
      if (options.projectionError) throw options.projectionError;
      return rows(
        Array.from({ length: options.projectedOfferDays ?? 0 }, (_, index) => ({
          snapshotId: `snapshot-${index}`,
        })) as unknown as T[],
      );
    }
    if (text.includes("SET status = 'pending'")) {
      if (state.status === "leased" && state.leaseToken === values?.[5]) {
        state.status = "pending";
        state.attemptsCount = Math.max(0, state.attemptsCount - 1);
        state.availableAt = String(values?.[3]);
        state.leasedUntil = null;
        state.leaseToken = null;
      }
      return rows([] as T[]);
    }
    if (text.includes("SET status = 'published'")) {
      if (state.status === "leased" && state.leaseToken === values?.[4]) {
        state.status = "published";
        state.leasedUntil = null;
        state.leaseToken = null;
        publishedEventIds.push(...((values?.[1] as string[]) ?? []));
        return rows([{ acknowledged: true }] as unknown as T[]);
      }
      return rows([] as T[]);
    }
    if (text.includes("SET status = 'failed'")) {
      if (state.status === "leased" && state.leaseToken === values?.[7]) {
        state.status = "failed";
        if (state.attemptsCount < state.maxAttempts) state.availableAt = String(values?.[3]);
        state.leasedUntil = null;
        state.leaseToken = null;
        return rows([
          { outboxEventId, attemptsCount: state.attemptsCount, maxAttempts: state.maxAttempts },
        ] as unknown as T[]);
      }
      return rows([] as T[]);
    }
    if (text.includes("INSERT INTO platform.dead_letter_events")) {
      for (const eventId of (values?.[0] as string[]) ?? []) {
        if (!deadLetterEventIds.includes(eventId)) deadLetterEventIds.push(eventId);
      }
      return rows([] as T[]);
    }
    return rows([] as T[]);
  };
  const pool = {
    async connect() {
      return { query, release };
    },
    end: vi.fn(async () => undefined),
  } as unknown as NonNullable<TargetPmsInventoryPublicOfferProjectionOptions["pool"]>;
  return { pool, deadLetterEventIds, publishedEventIds, queries, state };
}

function rows<T extends QueryResultRow>(items: T[]) {
  return { rows: items, rowCount: items.length };
}
