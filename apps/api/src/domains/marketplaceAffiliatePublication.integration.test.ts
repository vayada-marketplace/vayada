import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  context,
  databaseUrl,
  id,
  publicationFixture,
  terms,
} from "./affiliatePublicationTestFixture.js";
import { saveMarketplaceAffiliateDraft } from "./marketplaceAffiliateDraftCommand.js";
import {
  publishMarketplaceAffiliateTerms as publish,
  type AffiliatePublicationPrerequisites,
} from "./marketplaceAffiliatePublication.js";

// Synthetic owner-domain proof only; not a live adapter or real provider validation.
const ready: AffiliatePublicationPrerequisites = async (_client, scope) => ({
  status: "ready",
  scope,
  conditionsText: "Synthetic complete commercial conditions",
  attributionPolicyVersion: "test-policy.v1",
  evidenceReferences: ["test-evidence"],
});
describe.skipIf(!databaseUrl)("affiliate publication command", () => {
  const fixture = publicationFixture();
  let draftId: string;
  const input = () => ({
    context: context(),
    propertyId: id(3),
    offerId: id(2),
    draftId,
    expectedRevision: 1,
    idempotencyKey: "publish",
  });
  beforeEach(async () => {
    const draft = await saveMarketplaceAffiliateDraft(fixture.pool(), {
      ...input(),
      expectedRevision: 0,
      idempotencyKey: "draft",
      terms,
    });
    if (!draft.ok) throw new Error(draft.code);
    draftId = draft.draftId;
  });
  async function noPublication() {
    for (const table of ["affiliate_programs", "affiliate_published_terms"])
      expect(
        (await fixture.pool().query(`SELECT count(*) FROM marketplace.${table}`)).rows[0].count,
      ).toBe("0");
    expect(
      (
        await fixture
          .pool()
          .query(
            "SELECT count(*) FROM platform.idempotency_keys WHERE operation='marketplace.affiliate_terms.publish'",
          )
      ).rows[0].count,
    ).toBe("0");
  }
  it("blocks current prerequisites with no writes and permits a later trusted retry", async () => {
    await expect(publish(fixture.pool(), input())).resolves.toMatchObject({
      code: "publication_blocked",
      reasons: ["commercial_conditions_unresolved", "tracking_evidence_adapter_missing"],
    });
    await noPublication();
    await expect(publish(fixture.pool(), input(), ready)).resolves.toMatchObject({
      ok: true,
      replayed: false,
    });
  });
  it("persists exact disclosure, scope, proof and audit and replays without rechecking proof", async () => {
    const first = await publish(fixture.pool(), input(), ready);
    expect(first).toMatchObject({ ok: true });
    const row = (await fixture.pool().query("SELECT * FROM marketplace.affiliate_published_terms"))
      .rows[0];
    expect(JSON.parse(row.disclosure)).toMatchObject({
      terms,
      commission: { policyVersionId: terms.financePolicyVersionId },
      conditionsText: "Synthetic complete commercial conditions",
    });
    expect(row.disclosure_hash).toBe(createHash("sha256").update(row.disclosure).digest("hex"));
    expect(row.source_draft_id).toBe(draftId);
    expect(row.actor_user_id).toBe(id(1));
    expect(row.evidence_references).toEqual(["test-evidence"]);
    await expect(publish(fixture.pool(), input())).resolves.toEqual({ ...first, replayed: true });
    await expect(
      publish(fixture.pool(), { ...input(), expectedRevision: 2 }, ready),
    ).resolves.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      publish(fixture.pool(), { ...input(), idempotencyKey: "different" }, ready),
    ).resolves.toMatchObject({ code: "draft_already_published" });
  });
  it("serializes concurrent retries and keeps one program across new terms versions", async () => {
    const results = await Promise.all([
      publish(fixture.pool(), input(), ready),
      publish(fixture.pool(), input(), ready),
    ]);
    expect(results.map((r) => r.ok && r.replayed).sort()).toEqual([false, true]);
    const next = await saveMarketplaceAffiliateDraft(fixture.pool(), {
      ...input(),
      idempotencyKey: "new-draft",
      terms: { ...terms, attributionWindowDays: 30 },
    });
    if (!next.ok) throw new Error(next.code);
    await expect(
      publish(fixture.pool(), { ...input(), idempotencyKey: "stale" }, ready),
    ).resolves.toMatchObject({ code: "revision_conflict" });
    const second = await publish(
      fixture.pool(),
      { ...input(), draftId: next.draftId, expectedRevision: 2, idempotencyKey: "new-publication" },
      ready,
    );
    expect(second.ok && second.programId).toBe(results[0]!.ok && results[0]!.programId);
    expect(
      (await fixture.pool().query("SELECT count(*) FROM marketplace.affiliate_published_terms"))
        .rows[0].count,
    ).toBe("2");
    await expect(publish(fixture.pool(), input())).resolves.toMatchObject({
      ok: true,
      replayed: true,
    });
  });
  it("denies permission, entitlement, scope and inactive actors before writes or replay", async () => {
    await publish(fixture.pool(), input(), ready);
    for (const mutate of [
      (c: ReturnType<typeof context>) => {
        c.membership.permissions = [];
      },
      (c: ReturnType<typeof context>) => {
        c.entitlements = [];
      },
      (c: ReturnType<typeof context>) => {
        c.entitlements[0]!.status = "suspended";
      },
      (c: ReturnType<typeof context>) => {
        c.linkedResources = c.linkedResources.slice(0, 1);
      },
      (c: ReturnType<typeof context>) => {
        c.linkedResources = c.linkedResources.slice(1);
      },
    ]) {
      const request = input();
      mutate(request.context);
      await expect(publish(fixture.pool(), request, ready)).rejects.toThrow();
    }
    const request = input();
    request.context.actor.status = "suspended";
    await expect(publish(fixture.pool(), request, ready)).resolves.toMatchObject({
      code: "scope_unavailable",
    });
    const other = input();
    other.context.selectedOrganization.organizationId = id(99);
    await expect(publish(fixture.pool(), other, ready)).resolves.toMatchObject({
      code: "scope_unavailable",
    });
    await fixture.pool().query("UPDATE identity.organization_resource_links SET status='revoked'");
    await expect(publish(fixture.pool(), input(), ready)).resolves.toMatchObject({
      code: "scope_unavailable",
    });
  });
  it("rechecks persisted offer links before new publication and authorized replay", async () => {
    await fixture
      .pool()
      .query(
        "UPDATE identity.organization_resource_links SET status='suspended' WHERE resource_type='marketplace_offer'",
      );
    await expect(publish(fixture.pool(), input(), ready)).resolves.toMatchObject({
      code: "scope_unavailable",
    });
    await noPublication();
    await fixture.pool().query("UPDATE identity.organization_resource_links SET status='active'");
    await publish(fixture.pool(), input(), ready);
    await fixture
      .pool()
      .query(
        "DELETE FROM identity.organization_resource_links WHERE resource_type='marketplace_offer'",
      );
    await expect(publish(fixture.pool(), input(), ready)).resolves.toMatchObject({
      code: "scope_unavailable",
    });
  });
  it.each(["policy", "destination"])(
    "rejects a missing %s reference without publication",
    async (kind) => {
      await fixture.pool().query(
        `INSERT INTO marketplace.affiliate_offer_terms_drafts
      SELECT $1,offer_id,property_id,organization_id,revision+1,contract_version,
        CASE WHEN $2='destination' THEN $3 ELSE booking_destination_id END,
        CASE WHEN $2='policy' THEN $3 ELSE finance_policy_version_id END,
        attribution_window_days,actor_user_id,request_id,recorded_at
      FROM marketplace.affiliate_offer_terms_drafts`,
        [id(55), kind, id(99)],
      );
      await expect(
        publish(fixture.pool(), { ...input(), draftId: id(55), expectedRevision: 2 }, ready),
      ).resolves.toMatchObject({
        code: kind === "policy" ? "policy_unavailable" : "destination_unavailable",
      });
      await noPublication();
    },
  );
  it("requires verified moderation and rejects malformed requests", async () => {
    for (const expectedRevision of [0, -1, 1.5, 2147483648])
      await expect(
        publish(fixture.pool(), { ...input(), expectedRevision }, ready),
      ).resolves.toMatchObject({ code: "invalid_request" });
    await fixture.pool().query("UPDATE marketplace.marketplace_offers SET offer_status='pending'");
    await expect(publish(fixture.pool(), input(), ready)).resolves.toMatchObject({
      code: "offer_not_verified",
    });
    await noPublication();
  });
  it("rolls back mismatched proof, resolver failures and idempotency persistence failures", async () => {
    const mismatch: AffiliatePublicationPrerequisites = async (client, scope) => {
      const result = await ready(client, scope);
      if (result.status === "ready") result.scope.propertyId = id(6);
      return result;
    };
    await expect(publish(fixture.pool(), input(), mismatch)).rejects.toThrow(
      "Invalid publication prerequisite proof",
    );
    await expect(
      publish(fixture.pool(), input(), async () => {
        throw new Error("adapter unavailable");
      }),
    ).rejects.toThrow("adapter unavailable");
    await noPublication();
    await fixture.pool()
      .query(`CREATE FUNCTION platform.fail_publication_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
      CREATE TRIGGER fail_publication_test BEFORE INSERT ON platform.idempotency_keys FOR EACH ROW EXECUTE FUNCTION platform.fail_publication_test()`);
    await expect(publish(fixture.pool(), input(), ready)).rejects.toThrow("test failure");
    await noPublication();
  });
});
