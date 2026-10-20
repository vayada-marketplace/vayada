import type { RequestContext } from "@vayada/backend-auth";
import { describe, expect, it, vi } from "vitest";

import {
  HOTEL_FIRST_RUN_LOCK_NAMESPACE,
  createHotelFirstRunLocality,
  createHotelFirstRunLock,
} from "./hotelFirstRunRuntime.js";
import type { HotelFirstRunActor } from "./hotelFirstRunSteps.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const actor = {
  organizationId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d",
  propertyId,
} as HotelFirstRunActor;

function lockPool(locked: boolean) {
  const queries: Array<[string, unknown[]]> = [];
  const release = vi.fn();
  return {
    queries,
    release,
    pool: {
      connect: async () => ({
        query: async (sql: string, values: unknown[]) => {
          queries.push([sql, values]);
          return { rows: [{ locked }] };
        },
        release,
      }),
    } as never,
  };
}

describe("first-run property lock (VAY-2247)", () => {
  it("runs the work while holding the property's advisory lock, then unlocks and releases", async () => {
    const fake = lockPool(true);
    expect(
      await createHotelFirstRunLock(fake.pool).withPropertyLock(propertyId, async () => "ran"),
    ).toBe("ran");
    expect(fake.queries).toEqual([
      [
        "SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS locked",
        [HOTEL_FIRST_RUN_LOCK_NAMESPACE, propertyId],
      ],
      [
        "SELECT pg_advisory_unlock($1::int, hashtext($2))",
        [HOTEL_FIRST_RUN_LOCK_NAMESPACE, propertyId],
      ],
    ]);
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("answers busy without running when another run holds the lock", async () => {
    const fake = lockPool(false);
    const work = vi.fn();
    expect(await createHotelFirstRunLock(fake.pool).withPropertyLock(propertyId, work)).toBe(
      "busy",
    );
    expect(work).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("unlocks and releases when the work throws", async () => {
    const fake = lockPool(true);
    await expect(
      createHotelFirstRunLock(fake.pool).withPropertyLock(propertyId, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fake.queries.map(([sql]) => sql)).toContain(
      "SELECT pg_advisory_unlock($1::int, hashtext($2))",
    );
    expect(fake.release).toHaveBeenCalledOnce();
  });
});

describe("first-run 'show city and country' (VAY-2247)", () => {
  const location = { city: "Munich", countryCode: "DE", localityPublic: false, geoPublic: false };
  const profiles = (localityPublic = false) => ({
    getPropertyProfile: async () =>
      ({
        propertyId,
        profileRevision: 4,
        profile: { displayName: "Hotel Alpenrose", location: { ...location, localityPublic } },
      }) as never,
  });

  it("turns it on through the owner's profile writer, keeping the rest of the profile", async () => {
    const update = vi.fn(async () => ({ status: "updated" as const, profile: {} as never }));
    const context = { actor: {} } as RequestContext;
    expect(
      await createHotelFirstRunLocality(context, profiles(), update).showCityAndCountry(actor),
    ).toEqual({ ok: true });
    const [sentContext, sentProperty, command] = update.mock.calls[0] as unknown as [
      unknown,
      string,
      { idempotencyKey: string; fingerprint: string; merge(existing: unknown): unknown },
    ];
    expect(sentContext).toBe(context);
    expect(sentProperty).toBe(propertyId);
    expect(command.idempotencyKey).toMatch(/^first-run:v1:locality:/);
    expect(command.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(command.merge({ displayName: "Hotel Alpenrose", location })).toEqual({
      expectedProfileRevision: 4,
      profile: { displayName: "Hotel Alpenrose", location: { ...location, localityPublic: true } },
    });
  });

  it("does nothing when the city is already shown, and reports a refused write", async () => {
    const update = vi.fn(async () => ({ status: "conflict" as const, currentRevision: 5 }));
    expect(
      await createHotelFirstRunLocality(
        {} as RequestContext,
        profiles(true),
        update,
      ).showCityAndCountry(actor),
    ).toEqual({
      ok: true,
    });
    expect(update).not.toHaveBeenCalled();
    expect(
      await createHotelFirstRunLocality(
        {} as RequestContext,
        profiles(),
        update,
      ).showCityAndCountry(actor),
    ).toEqual({
      ok: false,
      code: "first_run_locality_conflict",
    });
  });
});
