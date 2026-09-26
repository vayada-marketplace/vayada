import { beforeEach, describe, expect, it } from "vitest";
import {
  assentCommandFixture,
  assentInput,
  installAffiliateAgreementLifecycleFixture,
} from "./affiliateAssentCommandTestFixture.js";
import { databaseUrl, id } from "./affiliatePublicationTestFixture.js";
import { disclosure, disclosureHash } from "./affiliateAssentTestFixture.js";
import { recordAffiliateAssent } from "./marketplaceAffiliateAssentCommand.js";
import { readAffiliateAssent } from "./marketplaceAffiliateAssentRepository.js";

const context = (hotel = true) => {
  const c = assentInput(hotel).context;
  c.membership.permissions = ["marketplace.collaboration.read"];
  return c;
};
describe.skipIf(!databaseUrl)("Affiliate assent historical read", () => {
  const fixture = assentCommandFixture();
  beforeEach(() => installAffiliateAgreementLifecycleFixture(fixture.pool()));
  const read = (c = context(), attemptId = id(100)) =>
    readAffiliateAssent(fixture.pool(), c, attemptId);
  const seed = () => recordAffiliateAssent(fixture.pool(), assentInput());
  it("shows the exact pinned terms to each party and updates only this attempt's assent", async () => {
    await seed();
    const pending = await read();
    expect(pending).toEqual({
      participationId: expect.any(String),
      attemptId: id(100),
      programId: id(50),
      propertyId: id(3),
      offerId: id(2),
      creatorProfileId: id(82),
      origin: "invitation",
      revision: 1,
      assentState: "pending",
      terms: { id: id(51), disclosure, disclosureHash },
      hotelApprovedAt: expect.any(String),
      creatorAcceptedAt: null,
      lifecycle: null,
    });
    expect(await read(context(false))).toEqual(pending);
    await recordAffiliateAssent(fixture.pool(), { ...assentInput(false), expectedRevision: 1 });
    expect(await read()).toMatchObject({
      revision: 2,
      assentState: "matched",
      creatorAcceptedAt: expect.any(String),
    });
    expect(await read(context(false))).toEqual(await read());
  });
  it("reads creator-first applications and isolates a later undecided attempt", async () => {
    await recordAffiliateAssent(fixture.pool(), assentInput(false));
    const original = await read();
    expect(original).toMatchObject({
      origin: "application",
      revision: 1,
      hotelApprovedAt: null,
      creatorAcceptedAt: expect.any(String),
    });
    await fixture.pool().query(
      `INSERT INTO marketplace.affiliate_participation_attempts
      (id,participation_id,program_id,terms_id,attempt_number,origin,actor_user_id,actor_organization_id,request_id)
      VALUES ($1,$2,$3,$4,2,'invitation',$5,$6,'synthetic-later-attempt')`,
      [id(101), original!.participationId, id(50), id(52), id(1), id(4)],
    );
    expect(await read(context(), id(101))).toMatchObject({
      revision: 0,
      assentState: "pending",
      terms: { id: id(52) },
      hotelApprovedAt: null,
      creatorAcceptedAt: null,
    });
    expect(await read()).toEqual(original);
  });
  it("retains history after offer archival and profile deactivation, with no activation claim", async () => {
    await seed();
    await fixture.pool().query("UPDATE marketplace.marketplace_offers SET offer_status='archived'");
    await fixture.pool().query("UPDATE marketplace.creator_profiles SET profile_status='inactive'");
    const result = await read();
    expect(result?.terms.id).toBe(id(51)); // newer published version 52 already exists
    expect(result).not.toHaveProperty("active");
    expect(await read(context(false))).toEqual(result);
  });
  it("hides absent attempts, foreign organizations and changed creator ownership", async () => {
    await seed();
    expect(await read(context(), id(999))).toBeNull();
    for (const hotel of [true, false]) {
      const c = context(hotel);
      c.selectedOrganization.organizationId = id(7);
      expect(await read(c)).toBeNull();
    }
    const c = context(false);
    c.actor.internalUserId = id(1);
    expect(await read(c)).toBeNull();
    await fixture.pool().query("UPDATE marketplace.creator_profiles SET owner_user_id=$1", [id(1)]);
    expect(await read(context(false))).toBeNull();
  });
  it("denies revoked persisted hotel, offer and creator links despite stale context", async () => {
    await seed();
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
  it("requires current scope and hotel entitlement; creator reads are free", async () => {
    await seed();
    for (const change of [
      (c: ReturnType<typeof context>) => {
        c.entitlements = [];
      },
      (c: ReturnType<typeof context>) => {
        c.entitlements[0]!.status = "suspended";
      },
      (c: ReturnType<typeof context>) => {
        c.membership.propertyAccess!.assignedPropertyIds = [id(6)];
      },
      (c: ReturnType<typeof context>) => {
        delete c.membership.propertyAccess;
      },
      (c: ReturnType<typeof context>) => {
        c.linkedResources = c.linkedResources.filter((r) => r.resourceType !== "marketplace_offer");
      },
    ]) {
      const c = context();
      change(c);
      expect(await read(c)).toBeNull();
    }
    const c = context(false);
    c.linkedResources.push({ ...c.linkedResources[0]!, resourceId: id(999) });
    expect(await read(c)).toBeNull();
    expect(await read(context(false))).not.toBeNull();
    for (const hotel of [true, false]) {
      const c = context(hotel);
      c.linkedResources = [];
      expect(await read(c)).toBeNull();
      c.membership.permissions = [];
      await expect(read(c)).rejects.toThrow();
    }
  });
  it("fails closed on corrupted disclosure bytes", async () => {
    await seed();
    // Simulate a privileged storage corruption; normal application updates are prohibited.
    await fixture
      .pool()
      .query(
        "ALTER TABLE marketplace.affiliate_published_terms DISABLE TRIGGER affiliate_published_terms_immutable",
      );
    await fixture
      .pool()
      .query(
        "UPDATE marketplace.affiliate_published_terms SET disclosure=disclosure || ' ' WHERE id=$1",
        [id(51)],
      );
    await expect(read()).rejects.toThrow("Stored affiliate disclosure is invalid");
  });
});
