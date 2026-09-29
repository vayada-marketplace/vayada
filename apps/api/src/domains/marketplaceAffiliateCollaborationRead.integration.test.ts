import { beforeEach, describe, expect, it } from "vitest";
import {
  assentCommandFixture,
  assentInput,
  installAffiliateAgreementLifecycleFixture,
} from "./affiliateAssentCommandTestFixture.js";
import { databaseUrl, id } from "./affiliatePublicationTestFixture.js";
import { recordAffiliateAssent } from "./marketplaceAffiliateAssentCommand.js";
import type { AffiliateAgreementActivationReadiness } from "./marketplaceAffiliateAgreementActivation.js";
import {
  changeCollaborationAffiliateLifecycle,
  diagnoseCollaborationAffiliateLink,
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
    await installAffiliateAgreementLifecycleFixture(fixture.pool());
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
  const activate = async () => {
    const hotel = await seed();
    const creator = await recordAffiliateAssent(fixture.pool(), {
      ...assentInput(false),
      expectedRevision: 1,
    });
    if (!hotel.ok || !creator.ok) throw new Error("Could not seed matched assent");
    await fixture.pool().query(
      `INSERT INTO marketplace.affiliate_agreements
       (id,participation_id,program_id,offer_id,property_id,hotel_organization_id,
        creator_profile_id,creator_organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id(130), hotel.participationId, id(50), id(2), id(3), id(4), id(82), id(80)],
    );
    await fixture.pool().query(
      `INSERT INTO marketplace.affiliate_agreement_activations
       (id,agreement_id,participation_id,program_id,attempt_id,terms_id,hotel_approval_id,
        creator_acceptance_id,contract_version,readiness_evidence,actor_user_id,
        actor_organization_id,request_id,effective_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
        'marketplace-affiliate-agreement-activation.v1','["synthetic"]',$9,$10,'activate-test',now())`,
      [
        id(131),
        id(130),
        hotel.participationId,
        id(50),
        id(100),
        id(51),
        hotel.decisionId,
        creator.decisionId,
        id(1),
        id(4),
      ],
    );
    return hotel.participationId;
  };
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
  it("keeps an activated attempt findable and manageable when a later attempt exists", async () => {
    const participationId = await activate();
    await fixture.pool().query(
      `INSERT INTO marketplace.affiliate_participation_attempts
      (id,participation_id,program_id,terms_id,attempt_number,origin,actor_user_id,actor_organization_id,request_id)
      VALUES ($1,$2,$3,$4,2,'invitation',$5,$6,'synthetic-later')`,
      [id(101), participationId, id(50), id(52), id(1), id(4)],
    );
    expect(await read()).toMatchObject({
      attemptId: id(100),
      assentState: "matched",
      terms: { id: id(51) },
      lifecycle: { status: "active", revision: 0 },
    });
    expect(
      await changeCollaborationAffiliateLifecycle(fixture.pool(), assentInput().context, key, {
        action: "pause",
        reason: "Pause retained agreement",
        expectedRevision: 0,
        idempotencyKey: "pause-retained",
      }),
    ).toMatchObject({ ok: true, revision: 1 });
  });
  it("previews the exact safe destination without recording a live or synthetic click", async () => {
    const participationId = await activate();
    await fixture.pool().query(`
      CREATE SCHEMA IF NOT EXISTS booking;
      ALTER TABLE hotel_catalog.properties ADD COLUMN lifecycle_status TEXT DEFAULT 'active';
      CREATE TABLE hotel_catalog.property_slugs(property_id UUID,slug TEXT,purpose TEXT,status TEXT);
      CREATE TABLE hotel_catalog.property_domains(property_id UUID,verification_status TEXT,
        canonical_when_verified BOOLEAN);
      CREATE TABLE booking.affiliate_destination_versions(id UUID PRIMARY KEY,property_id UUID,
        created_by_organization_id UUID,booking_url TEXT);
      CREATE TABLE marketplace.affiliate_links(id UUID PRIMARY KEY,agreement_id UUID,
        activation_id UUID,participation_id UUID,program_id UUID,property_id UUID,public_token TEXT);
      INSERT INTO hotel_catalog.property_slugs VALUES
        ('${id(3)}','hotel-alpenrose','canonical','active');
      INSERT INTO booking.affiliate_destination_versions VALUES
        ('${id(30)}','${id(3)}','${id(4)}','https://hotel-alpenrose.next-booking.vayada.com/');
      INSERT INTO marketplace.affiliate_links VALUES
        ('${id(140)}','${id(130)}','${id(131)}','${participationId}','${id(50)}','${id(3)}',
         'va_abcdefghijklmnopqrstuv');
    `);
    expect(
      await diagnoseCollaborationAffiliateLink(
        fixture.pool(),
        context(false),
        key,
        "instagram.reel-1",
      ),
    ).toEqual({
      ok: true,
      contractVersion: "marketplace-affiliate-link-diagnostic.v1",
      status: "ready",
      association: "verified",
      programStatus: "active",
      destinationUrl: "https://hotel-alpenrose.next-booking.vayada.com/",
      campaignLabel: "instagram.reel-1",
      normalMetricsExcluded: true,
      externalPurchaseVerified: false,
    });
  });
  it("fails closed when retained lifecycle history is invalid", async () => {
    await activate();
    await fixture.pool().query(
      `INSERT INTO marketplace.affiliate_agreement_lifecycle_events
       (id,agreement_id,revision,action,actor_side,actor_user_id,actor_organization_id,reason,request_id)
       VALUES ($1,$2,1,'resume','hotel',$3,$4,'invalid first event','invalid-history')`,
      [id(132), id(130), id(1), id(4)],
    );
    await expect(read()).rejects.toThrow("Invalid affiliate lifecycle history");
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
    const ready: AffiliateAgreementActivationReadiness = async (_client, activationScope) => ({
      status: "ready",
      scope: activationScope,
      enrollmentOpen: true,
      evidenceReferences: ["fresh-finance-and-booking-proof"],
    });
    expect(
      await recordCollaborationAffiliateAssent(
        fixture.pool(),
        creator,
        key,
        "creator-decision",
        ready,
      ),
    ).toMatchObject({ ok: true, revision: 1, state: "pending", replayed: false });
    expect(
      await recordCollaborationAffiliateAssent(
        fixture.pool(),
        creator,
        key,
        "creator-decision",
        ready,
      ),
    ).toMatchObject({ ok: true, revision: 1, replayed: true });
    expect(
      await recordCollaborationAffiliateAssent(fixture.pool(), hotel, key, "hotel-decision", ready),
    ).toMatchObject({ ok: true, revision: 2, state: "matched" });

    const retained = await readCollaborationAffiliateAssent(fixture.pool(), context(), key);
    expect(retained).toMatchObject({
      assentState: "matched",
      terms: { id: id(52) },
      propertyId: id(3),
      programId: id(50),
      creatorProfileId: id(82),
      lifecycle: { status: "active", revision: 0, pausedBy: [] },
    });
    expect(
      await fixture
        .pool()
        .query("SELECT count(*)::int AS count FROM marketplace.affiliate_agreement_activations"),
    ).toMatchObject({ rows: [{ count: 1 }] });
  });
  it("returns activation blockage and activates on an exact-key retry once ready", async () => {
    const creator = assentInput(false).context;
    const hotel = assentInput().context;
    const blocked: AffiliateAgreementActivationReadiness = async () => ({
      status: "blocked",
      reasons: ["destination_unavailable"],
    });
    const ready: AffiliateAgreementActivationReadiness = async (_client, activationScope) => ({
      status: "ready",
      scope: activationScope,
      enrollmentOpen: true,
      evidenceReferences: ["fresh-proof"],
    });
    await recordCollaborationAffiliateAssent(
      fixture.pool(),
      creator,
      key,
      "creator-decision",
      ready,
    );
    expect(
      await recordCollaborationAffiliateAssent(
        fixture.pool(),
        hotel,
        key,
        "hotel-decision",
        blocked,
      ),
    ).toEqual({ ok: false, code: "activation_blocked" });
    expect(
      await recordCollaborationAffiliateAssent(fixture.pool(), hotel, key, "hotel-decision", ready),
    ).toMatchObject({ ok: true, state: "matched", replayed: true });
    expect(
      await fixture
        .pool()
        .query("SELECT count(*)::int AS count FROM marketplace.affiliate_agreement_activations"),
    ).toMatchObject({ rows: [{ count: 1 }] });
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
  it("authorizes before revealing a closed collaboration", async () => {
    await fixture.pool().query("UPDATE marketplace.collaborations SET lifecycle_status='declined'");
    const unauthorized = assentInput(false).context;
    unauthorized.linkedResources = [];
    await expect(
      recordCollaborationAffiliateAssent(fixture.pool(), unauthorized, key, "unauthorized-closed"),
    ).rejects.toThrow();
  });
  it("does not record new assent after the collaboration is declined", async () => {
    await fixture.pool().query("UPDATE marketplace.collaborations SET lifecycle_status='declined'");
    expect(
      await recordCollaborationAffiliateAssent(
        fixture.pool(),
        assentInput(false).context,
        key,
        "declined",
      ),
    ).toEqual({ ok: false, code: "transition_unavailable" });
  });
  it("replays a committed assent after the collaboration later closes", async () => {
    const first = await recordCollaborationAffiliateAssent(
      fixture.pool(),
      assentInput(false).context,
      key,
      "creator-before-close",
    );
    expect(first).toMatchObject({ ok: true, revision: 1, replayed: false });
    await fixture.pool().query("UPDATE marketplace.collaborations SET lifecycle_status='declined'");
    expect(
      await recordCollaborationAffiliateAssent(
        fixture.pool(),
        assentInput(false).context,
        key,
        "creator-before-close",
      ),
    ).toMatchObject({ ok: true, revision: 1, replayed: true });
  });
});
