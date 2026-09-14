import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  createBookingGuestChoiceStore,
  lockCurrentGuestChoiceRevision,
} from "./bookingGuestChoiceStore.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("confirmed guest rules without pricing", () => {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  afterAll(() => pool.end());
  async function fixture() {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const scope = {
      propertyId: randomUUID(),
      organizationId: randomUUID(),
      actorUserId: randomUUID(),
    };
    await pool.query(
      "INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Guest choices test')",
      [scope.actorUserId, `${scope.actorUserId}@example.test`],
    );
    await pool.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Guest choices test',$2)",
      [scope.organizationId, scope.organizationId],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Guest choices test')",
      [scope.propertyId],
    );
    let allowed = true;
    const store = createBookingGuestChoiceStore(pool, {
      async authorizeGuestPolicyScope(input) {
        expect(input).toMatchObject({
          ...scope,
          permission: "booking.settings.manage",
          entitlement: { product: "booking", key: "booking-engine" },
          resource: {
            product: "booking",
            resourceType: "booking_hotel",
            allowedRelationships: ["owner", "operator"],
          },
        });
        return allowed;
      },
    });
    const command = {
      requestId: "rules-1",
      expectedRevision: null as string | null,
      confirmed: true,
      choices: {
        defaultGuestLanguage: "en",
        childrenEnabled: true,
        adultAgeThreshold: 18,
        phoneRequired: true,
        arrivalTimeEnabled: false,
        specialRequestsEnabled: true,
        checkInTime: "15:00",
        checkOutTime: "11:00",
        checkInUntil: "23:00",
      },
    };
    return {
      scope,
      store,
      command,
      deny: () => {
        allowed = false;
      },
    };
  }
  it("creates without rates, edits with revision checks and replays the original confirmed revision", async () => {
    const f = await fixture();
    const first = await f.store.save(f.scope, f.command);
    expect(first.replayed).toBe(false);
    const edit = {
      ...f.command,
      requestId: "rules-2",
      expectedRevision: first.revision,
      choices: { ...f.command.choices, phoneRequired: false },
    };
    const second = await f.store.save(f.scope, edit);
    expect(second.revision).not.toBe(first.revision);
    expect(await f.store.save(f.scope, f.command)).toEqual({ ...first, replayed: true });
    expect(
      await f.store.save(f.scope, {
        ...f.command,
        choices: Object.fromEntries(Object.entries(f.command.choices).reverse()),
      }),
    ).toEqual({ ...first, replayed: true });
    await expect(f.store.save(f.scope, { ...edit, requestId: "stale" })).rejects.toThrow(
      "guest_choices_stale",
    );
    await expect(f.store.save(f.scope, { ...f.command, choices: edit.choices })).rejects.toThrow(
      "guest_choices_idempotency_conflict",
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(
        await lockCurrentGuestChoiceRevision(client, f.scope.propertyId, f.scope.organizationId),
      ).toEqual({
        propertyId: f.scope.propertyId,
        sourceRevision: `guest-choices:${second.revision}`,
        choices: edit.choices,
      });
      expect(
        await lockCurrentGuestChoiceRevision(client, f.scope.propertyId, randomUUID()),
      ).toBeNull();
      const probe = await pool.query(
        "SELECT pg_try_advisory_xact_lock(hashtext('booking.guest_policy'),hashtext($1::uuid::text)) AS acquired",
        [f.scope.propertyId],
      );
      expect(probe.rows[0].acquired).toBe(false);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    f.deny();
    await expect(f.store.save(f.scope, f.command)).rejects.toThrow("guest_choices_denied");
    const rows = await pool.query(
      "SELECT actor_user_id,confirmed_at FROM booking.guest_choice_revisions WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(
      rows.rows.every(
        (r) => r.actor_user_id === f.scope.actorUserId && r.confirmed_at instanceof Date,
      ),
    ).toBe(true);
    await expect(
      pool.query("UPDATE booking.guest_choice_revisions SET choices='{}' WHERE property_id=$1", [
        f.scope.propertyId,
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query("DELETE FROM booking.guest_choice_revisions WHERE property_id=$1", [
        f.scope.propertyId,
      ]),
    ).rejects.toThrow();
  });
  it("serializes competing first saves and rejects unconfirmed or malformed choices", async () => {
    const f = await fixture();
    for (const change of [{ confirmed: false }, { choices: {} }, { amount: "100" }])
      await expect(f.store.save(f.scope, { ...f.command, ...change })).rejects.toThrow(
        "invalid_guest_choices",
      );
    const results = await Promise.allSettled([
      f.store.save(f.scope, f.command),
      f.store.save(f.scope, { ...f.command, requestId: "competitor" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const rows = await pool.query(
      "SELECT revision FROM booking.guest_choice_revisions WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(rows.rows).toHaveLength(1);
  });
});
