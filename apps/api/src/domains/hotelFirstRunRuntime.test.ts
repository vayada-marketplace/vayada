import type { RequestContext } from "@vayada/backend-auth";
import { describe, expect, it, vi } from "vitest";

import {
  HOTEL_FIRST_RUN_LOCK_NAMESPACE,
  createDedicatedLockConnections,
  createHotelFirstRunActivation,
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

describe("first-run lock connections (VAY-2247 incident)", () => {
  function fakeClients() {
    const clients: { ended: boolean }[] = [];
    let failNext = false;
    return {
      clients,
      failNextConnect: () => {
        failNext = true;
      },
      createClient: () => {
        const client = {
          ended: false,
          on: () => client,
          connect: async () => {
            if (!failNext) return;
            failNext = false;
            throw new Error("connect failed");
          },
          query: async () => ({ rows: [{ locked: true }] }),
          end: async () => {
            client.ended = true;
          },
        };
        clients.push(client);
        return client as never;
      },
    };
  }

  it("opens at most max at once; the next run waits for one to close", async () => {
    const fake = fakeClients();
    const pool = createDedicatedLockConnections("postgresql://test", {
      max: 2,
      waitMs: 1_000,
      createClient: fake.createClient,
    });
    const first = await pool.connect();
    const second = await pool.connect();
    let third: Awaited<ReturnType<typeof pool.connect>> | undefined;
    const waiting = pool.connect().then((client) => (third = client));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.clients).toHaveLength(2);
    expect(third).toBeUndefined();
    first.release();
    await waiting;
    expect(fake.clients).toHaveLength(3);
    expect(fake.clients[0]!.ended).toBe(true);
    second.release();
    third!.release();
  });

  it("answers busy when every lock connection stays in use past the wait", async () => {
    const fake = fakeClients();
    const pool = createDedicatedLockConnections("postgresql://test", {
      max: 1,
      waitMs: 20,
      createClient: fake.createClient,
    });
    const held = await pool.connect();
    const work = vi.fn();
    expect(await createHotelFirstRunLock(pool).withPropertyLock(propertyId, work)).toBe("busy");
    expect(work).not.toHaveBeenCalled();
    held.release();
    expect(
      await createHotelFirstRunLock(pool).withPropertyLock(propertyId, async () => "ran"),
    ).toBe("ran");
    expect(fake.clients.map((client) => client.ended)).toEqual([true, true]);
  });

  it("frees the slot when a connection fails to open", async () => {
    const fake = fakeClients();
    const pool = createDedicatedLockConnections("postgresql://test", {
      max: 1,
      waitMs: 20,
      createClient: fake.createClient,
    });
    fake.failNextConnect();
    await expect(pool.connect()).rejects.toThrow("connect failed");
    (await pool.connect()).release();
    expect(fake.clients).toHaveLength(2);
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

describe("first-run activation (VAY-2247 1.5)", () => {
  it("makes the hotel live through the owner's activation and tells a live one apart", async () => {
    const context = {} as RequestContext;
    const activate = vi.fn(async () => ({ status: "activated" as const }));
    const port = createHotelFirstRunActivation(context, activate);
    expect(await port.activateWhenComplete(actor)).toEqual({ ok: true, activated: true });
    expect(activate).toHaveBeenCalledWith(context, propertyId);
    activate.mockResolvedValueOnce({ status: "already_active" } as never);
    expect(await port.activateWhenComplete(actor)).toEqual({ ok: true, activated: false });
  });

  it("refuses an incomplete hotel and one that is suspended or retired", async () => {
    const incomplete = createHotelFirstRunActivation({} as RequestContext, async () => ({
      status: "incomplete",
      reasons: ["missing_phone_contact"],
    }));
    expect(await incomplete.activateWhenComplete(actor)).toEqual({
      ok: false,
      code: "first_run_profile_incomplete",
    });
    const suspended = createHotelFirstRunActivation({} as RequestContext, async () => ({
      status: "not_provisioning",
      lifecycleStatus: "suspended",
    }));
    expect(await suspended.activateWhenComplete(actor)).toEqual({
      ok: false,
      code: "first_run_hotel_not_provisioning",
    });
  });
});
