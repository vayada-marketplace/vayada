import { randomUUID } from "node:crypto";

import pg from "pg";
import { describe, expect, it } from "vitest";

import { createPgHotelAccountAgreementsRepository } from "./domains/hotelAccountAgreementsRepository.js";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";

const url = process.env["TEST_DATABASE_URL"];
const current = { termsVersion: "2026-10-24", dpaVersion: "2026-10-24" };

/**
 * VAY-2246: a hotel account's acceptance of the hotel terms and the DPA (migration 0511), recorded and
 * read by the ordinary API login, as in production (sign-up included: the identity login can't write
 * hotel_catalog). Fixture rows are written by the test's own login.
 */
describe.skipIf(!url)("hotel account agreements on the real database (VAY-2246)", () => {
  it("records the account admin's acceptance once per version and refuses everyone else", async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    const pool = new pg.Pool({ connectionString: fixture.connectionString, max: 2 });
    const repository = createPgHotelAccountAgreementsRepository(pool);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const [hotelAccount, otherAccount, archivedAccount] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const [owner, manager, otherOwner, suspendedOwner] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    try {
      for (const [id, status] of [
        [hotelAccount, "active"],
        [otherAccount, "active"],
        [archivedAccount, "archived"],
      ])
        await admin.query(
          "INSERT INTO identity.organizations(id,kind,name,slug,status) VALUES($1,'hotel_group','Agreements fixture',$2,$3)",
          [id, `a${id.slice(0, 8)}${suffix}`, status],
        );
      for (const [id, name] of [
        [owner, "Anna Keller"],
        [manager, "Max Weber"],
        [otherOwner, "Other Owner"],
        [suspendedOwner, "Paused Owner"],
      ])
        await admin.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,$3)", [
          id,
          `${id.slice(0, 8)}-${suffix}@example.test`,
          name,
        ]);
      for (const [organization, user, role, status] of [
        [hotelAccount, owner, "hotel_owner", "active"],
        [hotelAccount, manager, "hotel_manager", "active"],
        [otherAccount, otherOwner, "hotel_owner", "active"],
        [otherAccount, suspendedOwner, "hotel_owner", "suspended"],
        [archivedAccount, owner, "hotel_owner", "active"],
      ])
        await admin.query(
          `INSERT INTO identity.organization_memberships
             (organization_id,user_id,role_key,status,access_origin,property_access_mode)
           VALUES($1,$2,$3,$4,'agency','all')`,
          [organization, user, role, status],
        );

      expect(await repository.findAcceptance(hotelAccount, current)).toBeNull();

      // Staff, an admin of another account, a suspended admin and an archived account are refused.
      for (const [organizationId, userId] of [
        [hotelAccount, manager],
        [hotelAccount, otherOwner],
        [otherAccount, suspendedOwner],
        [archivedAccount, owner],
      ])
        expect(
          await repository.accept({
            organizationId,
            userId,
            source: "account_admin",
            versions: current,
          }),
        ).toBeNull();
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM hotel_catalog.account_agreement_acceptances WHERE organization_id = ANY($1::uuid[])",
            [[hotelAccount, otherAccount, archivedAccount]],
          )
        ).rows[0].n,
      ).toBe(0);

      // The account admin accepts at sign-up; a later accept keeps the first record.
      const signup = await repository.accept({
        organizationId: hotelAccount,
        userId: owner,
        source: "signup",
        versions: current,
      });
      expect(signup).toEqual({
        ...current,
        acceptedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        acceptedBy: { name: "Anna Keller", email: `${owner.slice(0, 8)}-${suffix}@example.test` },
        source: "signup",
      });
      const again = await repository.accept({
        organizationId: hotelAccount,
        userId: owner,
        source: "account_admin",
        versions: current,
      });
      expect(again).toEqual(signup);
      expect(await repository.findAcceptance(hotelAccount, current)).toEqual(signup);
      expect(await repository.findAcceptance(otherAccount, current)).toBeNull();

      // A new version of the DPA needs a new acceptance; the old one stays on record.
      const newer = { termsVersion: "2026-10-24", dpaVersion: "2027-01-01" };
      expect(await repository.findAcceptance(hotelAccount, newer)).toBeNull();
      expect(
        await repository.accept({
          organizationId: hotelAccount,
          userId: owner,
          source: "account_admin",
          versions: newer,
        }),
      ).toMatchObject({ ...newer, source: "account_admin" });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM hotel_catalog.account_agreement_acceptances WHERE organization_id=$1",
            [hotelAccount],
          )
        ).rows[0].n,
      ).toBe(2);

      // The table only takes known sources and date-shaped versions.
      await expect(
        admin.query(
          `INSERT INTO hotel_catalog.account_agreement_acceptances
             (organization_id,terms_version,dpa_version,accepted_by_user_id,source)
           VALUES($1,'2026-10-24','latest',$2,'signup')`,
          [otherAccount, otherOwner],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        admin.query(
          `INSERT INTO hotel_catalog.account_agreement_acceptances
             (organization_id,terms_version,dpa_version,accepted_by_user_id,source)
           VALUES($1,'2026-10-24','2026-10-24',$2,'email')`,
          [otherAccount, otherOwner],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await pool.end();
      await fixture.drop();
      await admin.end();
    }
  }, 30_000);
});
