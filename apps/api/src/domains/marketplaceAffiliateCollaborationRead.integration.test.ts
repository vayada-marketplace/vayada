import { beforeEach, describe, expect, it } from "vitest";
import { assentCommandFixture, assentInput } from "./affiliateAssentCommandTestFixture.js";
import { databaseUrl, id } from "./affiliatePublicationTestFixture.js";
import { recordAffiliateAssent } from "./marketplaceAffiliateAssentCommand.js";
import {
  recordCollaborationAffiliateAssent,
  readAffiliateAssent,
  readCollaborationAffiliateAssent,
} from "./marketplaceAffiliateAssentRepository.js";
const key = "Existing-Collaboration:QA";
const context = (hotel = true) => {
  const c = assentInput(hotel).context;
  c.membership.permissions = ["marketplace.collaboration.read"];
  return c;
};
describe.skipIf(!databaseUrl)("Affiliate assent through existing collaboration", () => {
  const fixture = assentCommandFixture();
  beforeEach(async () => {
    await fixture.pool().query(`CREATE TABLE marketplace.collaborations (
      id UUID PRIMARY KEY, source_system TEXT NOT NULL, source_collaboration_id TEXT,
      property_id UUID NOT NULL, offer_id UUID, hotel_organization_id UUID NOT NULL,
      creator_profile_id UUID NOT NULL, creator_organization_id UUID NOT NULL,
      lifecycle_status TEXT NOT NULL, UNIQUE(source_system,source_collaboration_id));`);
    await fixture.pool().query(
      `INSERT INTO marketplace.collaborations VALUES
      ($1,'marketplace',$2,$3,$4,$5,$6,$7,'accepted')`,
      [id(120), key, id(3), id(2), id(4), id(82), id(80)],
    );
  });
  const read = (c = context(), source = key) =>
    readCollaborationAffiliateAssent(fixture.pool(), c, source);
  const seed = () => recordAffiliateAssent(fixture.pool(), assentInput());
  it("resolves each party's compatibility key to the exact retained attempt", async () => {
    await seed();
    const expected = await readAffiliateAssent(fixture.pool(), context(), id(100));
    expect(await read()).toEqual(expected);
    expect(await read(context(false))).toEqual(expected);
    expect(await read(context(), id(120))).toBeNull();
    expect(await read(context(), key.toLowerCase())).toBeNull();
  });
  it("keeps the same history after collaboration completion or cancellation", async () => {
    await seed();
    const expected = await read();
    for (const status of ["completed", "cancelled"]) {
      await fixture
        .pool()
        .query("UPDATE marketplace.collaborations SET lifecycle_status=$1", [status]);
      expect(await read()).toEqual(expected);
      expect(await read(context(false))).toEqual(expected);
    }
  });
  it("shows current terms before first assent and rejects absent or ambiguous collaborations", async () => {
    expect(await read()).toMatchObject({
      participationId: null,
      attemptId: null,
      revision: 0,
      assentState: "pending",
      terms: { id: id(52) },
    });
    await seed();
    expect(await read(context(), "missing")).toBeNull();
    await fixture.pool().query(
      `INSERT INTO marketplace.collaborations
      SELECT $1,'migration',source_collaboration_id,property_id,offer_id,hotel_organization_id,
        creator_profile_id,creator_organization_id,lifecycle_status FROM marketplace.collaborations`,
      [id(121)],
    );
    expect(await read()).toBeNull();
    expect(await read(context(false))).toBeNull();
  });
  it("does not substitute any canonical scope field", async () => {
    await seed();
    for (const [column, original] of [
      ["property_id", id(3)],
      ["offer_id", id(2)],
      ["hotel_organization_id", id(4)],
      ["creator_profile_id", id(82)],
      ["creator_organization_id", id(80)],
    ]) {
      await fixture.pool().query(`UPDATE marketplace.collaborations SET ${column}=$1`, [id(999)]);
      expect(await read()).toBeNull();
      expect(await read(context(false))).toBeNull();
      await fixture.pool().query(`UPDATE marketplace.collaborations SET ${column}=$1`, [original]);
    }
    for (const hotel of [true, false]) {
      const c = context(hotel);
      c.selectedOrganization.organizationId = id(999);
      expect(await read(c)).toBeNull();
    }
    const c = context(false);
    c.actor.internalUserId = id(1);
    expect(await read(c)).toBeNull();
  });
  it("returns the latest attempt even when an earlier attempt is matched", async () => {
    await seed();
    await recordAffiliateAssent(fixture.pool(), { ...assentInput(false), expectedRevision: 1 });
    const matched = await read();
    expect(matched?.assentState).toBe("matched");
    await fixture.pool().query(
      `INSERT INTO marketplace.affiliate_participation_attempts
      (id,participation_id,program_id,terms_id,attempt_number,origin,actor_user_id,actor_organization_id,request_id)
      VALUES ($1,$2,$3,$4,2,'invitation',$5,$6,'synthetic-later')`,
      [id(101), matched!.participationId, id(50), id(52), id(1), id(4)],
    );
    expect(await read()).toMatchObject({
      attemptId: id(101),
      revision: 0,
      assentState: "pending",
      terms: { id: id(52) },
    });
  });
  it("reuses persisted-link, entitlement, identity and assigned-property denials", async () => {
    await seed();
    for (const change of [
      (c: ReturnType<typeof context>) => {
        c.entitlements = [];
      },
      (c: ReturnType<typeof context>) => {
        c.membership.propertyAccess!.assignedPropertyIds = [id(6)];
      },
      (c: ReturnType<typeof context>) => {
        c.actor.status = "suspended";
      },
      (c: ReturnType<typeof context>) => {
        c.membership.status = "inactive";
      },
      (c: ReturnType<typeof context>) => {
        c.linkedResources = [];
      },
    ]) {
      const c = context();
      change(c);
      expect(await read(c)).toBeNull();
    }
    const c = context();
    c.membership.permissions = [];
    await expect(read(c)).rejects.toThrow();
    for (const [link, hotel] of [
      [90, true],
      [92, true],
      [91, false],
    ] as const) {
      await fixture
        .pool()
        .query("UPDATE identity.organization_resource_links SET status='suspended' WHERE id=$1", [
          id(link),
        ]);
      expect(await read(context(hotel))).toBeNull();
      await fixture
        .pool()
        .query("UPDATE identity.organization_resource_links SET status='active' WHERE id=$1", [
          id(link),
        ]);
    }
  });
  it("records each side against the collaboration's current pinned terms", async () => {
    const creator = assentInput(false).context;
    const hotel = assentInput().context;
    expect(
      await recordCollaborationAffiliateAssent(fixture.pool(), creator, key, "creator-decision"),
    ).toMatchObject({ ok: true, revision: 1, state: "pending", replayed: false });
    expect(
      await recordCollaborationAffiliateAssent(fixture.pool(), creator, key, "creator-decision"),
    ).toMatchObject({ ok: true, revision: 1, replayed: true });
    expect(
      await recordCollaborationAffiliateAssent(fixture.pool(), hotel, key, "hotel-decision"),
    ).toMatchObject({ ok: true, revision: 2, state: "matched" });

    const retained = await readCollaborationAffiliateAssent(fixture.pool(), context(), key);
    expect(retained).toMatchObject({
      assentState: "matched",
      terms: { id: id(52) },
      propertyId: id(3),
      programId: id(50),
      creatorProfileId: id(82),
    });
  });
  it("does not create assent for an ambiguous or cross-tenant collaboration", async () => {
    const creator = assentInput(false).context;
    creator.selectedOrganization.organizationId = id(999);
    expect(
      await recordCollaborationAffiliateAssent(fixture.pool(), creator, key, "wrong-tenant"),
    ).toEqual({ ok: false, code: "scope_unavailable" });

    await fixture.pool().query(
      `INSERT INTO marketplace.collaborations
      SELECT $1,'migration',source_collaboration_id,property_id,offer_id,hotel_organization_id,
        creator_profile_id,creator_organization_id,lifecycle_status FROM marketplace.collaborations`,
      [id(121)],
    );
    expect(
      await recordCollaborationAffiliateAssent(
        fixture.pool(),
        assentInput().context,
        key,
        "ambiguous",
      ),
    ).toEqual({ ok: false, code: "scope_unavailable" });
  });
});
