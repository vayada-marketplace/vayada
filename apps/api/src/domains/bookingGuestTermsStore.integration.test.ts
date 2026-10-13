import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createBookingGuestTermsStore } from "./bookingGuestTermsStore.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("guest terms and conditions (VAY-2176)", () => {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
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
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Guest terms test')",
      [scope.propertyId],
    );
    let allowed = true;
    const store = createBookingGuestTermsStore(pool, () => ({
      async authorizeGuestPolicyScope(input) {
        expect(input).toMatchObject({
          ...scope,
          permission: "booking.settings.manage",
          entitlement: { product: "booking", key: "booking-engine" },
        });
        return allowed;
      },
    }));
    const facts = async () =>
      (
        await pool.query(
          `SELECT p.profile_revision::int AS "profileRevision",
                  s.terms_and_conditions AS "terms",
                  s.check_in_time::text AS "checkIn",
                  r.revision::int AS "policyRevision"
             FROM hotel_catalog.properties p
             LEFT JOIN hotel_catalog.property_policy_summaries s ON s.property_id=p.id
             LEFT JOIN hotel_catalog.property_owner_revisions r
               ON r.property_id=p.id AND r.owner_key='hotel_catalog.policy'
            WHERE p.id=$1`,
          [scope.propertyId],
        )
      ).rows[0];
    return { scope, store, facts, deny: () => (allowed = false) };
  }

  it("saves only the terms, keeps other policy fields and leaves the hotel profile revision alone", async () => {
    const f = await fixture();
    const before = await f.facts();
    expect(await f.store.read(f.scope)).toEqual({ termsText: null });
    expect(await f.store.save(f.scope, "  Our terms.  ", null)).toEqual({
      termsText: "Our terms.",
    });
    expect(await f.store.read(f.scope)).toEqual({ termsText: "Our terms." });
    const saved = await f.facts();
    expect(saved).toMatchObject({ terms: "Our terms.", profileRevision: before.profileRevision });
    expect(saved.policyRevision).toBeGreaterThan(before.policyRevision ?? 0);

    await pool.query(
      "UPDATE hotel_catalog.property_policy_summaries SET check_in_time='15:00' WHERE property_id=$1",
      [f.scope.propertyId],
    );
    const withCheckIn = await f.facts();
    await f.store.save(f.scope, "Our terms.", "Our terms.");
    expect(await f.facts()).toEqual(withCheckIn);

    await f.store.save(f.scope, "   ", " Our terms. ");
    expect(await f.facts()).toMatchObject({
      terms: null,
      checkIn: "15:00:00",
      profileRevision: before.profileRevision,
    });
  });

  it("refuses to overwrite terms changed elsewhere", async () => {
    const f = await fixture();
    await expect(f.store.save(f.scope, "Setup terms.", "Loaded terms.")).rejects.toThrow(
      "guest_terms_stale",
    );
    await pool.query(
      "INSERT INTO hotel_catalog.property_policy_summaries(property_id,terms_and_conditions) VALUES($1,'Settings terms.')",
      [f.scope.propertyId],
    );
    // Setup loaded no terms, then the hotel saved its own in booking settings.
    await expect(f.store.save(f.scope, "Setup terms.", null)).rejects.toThrow("guest_terms_stale");
    expect(await f.facts()).toMatchObject({ terms: "Settings terms." });
    expect(await f.store.save(f.scope, "Setup terms.", "Settings terms.")).toEqual({
      termsText: "Setup terms.",
    });
  });

  it("does not create an empty policy row when no terms are saved", async () => {
    const f = await fixture();
    expect(await f.store.save(f.scope, "  ", null)).toEqual({ termsText: null });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM hotel_catalog.property_policy_summaries WHERE property_id=$1",
          [f.scope.propertyId],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("rejects invalid text and denied scopes without writing", async () => {
    const f = await fixture();
    for (const text of [undefined, 3, { text: "x" }, "x".repeat(20_001)])
      await expect(f.store.save(f.scope, text, null)).rejects.toThrow("invalid_guest_terms");
    await expect(f.store.save(f.scope, "x", 3)).rejects.toThrow("invalid_guest_terms");
    f.deny();
    await expect(f.store.save(f.scope, "Our terms.", null)).rejects.toThrow("guest_terms_denied");
    await expect(f.store.read(f.scope)).rejects.toThrow("guest_terms_denied");
    expect(await f.facts()).toMatchObject({ terms: null });
  });
});
