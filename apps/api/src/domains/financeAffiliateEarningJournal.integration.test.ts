import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { parseFinanceAffiliatePercentagePolicy } from "@vayada/domain-finance";
import { context, databaseUrl, id, publicationFixture } from "./affiliatePublicationTestFixture.js";
import {
  recordAffiliateEarningCalculation as record,
  type AffiliateEarningEvidenceResolver,
} from "./financeAffiliateEarningJournal.js";
const migration = await readFile(
  new URL(
    "../../../../packages/backend-migration/migrations/0182_finance_affiliate_earning_journal.sql",
    import.meta.url,
  ),
  "utf8",
);
const calculation = () => ({
  scope: {
    propertyId: id(3),
    creatorProfileId: id(21),
    agreementId: id(22),
    policyVersionId: id(10),
    bookingId: id(23),
    stayItemId: id(24),
    currency: "EUR",
    currencyMinorUnit: 2,
    rounding: "half_up" as const,
  },
  policy: {
    policyVersionId: id(10),
    propertyId: id(3),
    approvalStatus: "approved" as const,
    policy: parseFinanceAffiliatePercentagePolicy({ percentageRate: "10" })!,
  },
  evidence: {
    status: "verified" as const,
    stay: "completed" as const,
    netAccommodationMinor: "50000",
    references: ["synthetic-evidence"],
  },
});
// Synthetic resolver only; this is not authenticated booking/provider evidence.
const resolver =
  (value = calculation()): AffiliateEarningEvidenceResolver =>
  async (_client, request) => ({ sourceRevision: request.sourceRevision, calculation: value });
describe.skipIf(!databaseUrl)("affiliate earning journal command", () => {
  const fixture = publicationFixture();
  beforeEach(async () => {
    await fixture.pool().query(migration);
  });
  const input = (sourceRevision = 1) => ({
    context: context(),
    propertyId: id(3),
    bookingId: id(23),
    stayItemId: id(24),
    sourceRevision,
  });
  const count = async () =>
    Number(
      (await fixture.pool().query("SELECT count(*) FROM finance.affiliate_earning_journal")).rows[0]
        .count,
    );
  it("replays original revisions, rejects altered facts and stores corrections once", async () => {
    const first = await record(fixture.pool(), input(), resolver());
    expect(first).toMatchObject({
      ok: true,
      revision: 1,
      outcome: { snapshot: { commissionMinor: "5000" }, adjustmentMinor: "5000" },
    });
    const changed = calculation();
    changed.evidence.netAccommodationMinor = "40000";
    await expect(record(fixture.pool(), input(), resolver(changed))).resolves.toMatchObject({
      code: "evidence_revision_conflict",
    });
    await expect(record(fixture.pool(), input(3), resolver(changed))).resolves.toMatchObject({
      revision: 2,
      outcome: { snapshot: { commissionMinor: "4000" }, adjustmentMinor: "-1000" },
    });
    await expect(record(fixture.pool(), input(), resolver())).resolves.toEqual({
      ...first,
      replayed: true,
    });
    await expect(record(fixture.pool(), input(2), resolver())).resolves.toMatchObject({
      code: "stale_evidence_revision",
    });
    expect(await count()).toBe(2);
  });
  it("serializes concurrent duplicates and computes the next correction from stored totals", async () => {
    const duplicates = await Promise.all([
      record(fixture.pool(), input(), resolver()),
      record(fixture.pool(), input(), resolver()),
    ]);
    expect(duplicates.map((r) => r.ok && r.replayed).sort()).toEqual([false, true]);
    const changed = calculation();
    changed.evidence.netAccommodationMinor = "30000";
    await Promise.all([
      record(fixture.pool(), input(2), resolver(changed)),
      record(fixture.pool(), input(2), resolver(changed)),
    ]);
    expect(await count()).toBe(2);
    expect(
      (
        await fixture
          .pool()
          .query(
            "SELECT sum((outcome->>'adjustmentMinor')::numeric)::text AS total FROM finance.affiliate_earning_journal",
          )
      ).rows[0].total,
    ).toBe("3000");
  });
  it("persists pending evidence then recovers relative to the last calculated total", async () => {
    await record(fixture.pool(), input(), resolver());
    const pending: AffiliateEarningEvidenceResolver = async (_client, request) => ({
      sourceRevision: request.sourceRevision,
      calculation: {
        ...calculation(),
        evidence: { ...calculation().evidence, status: "incomplete" },
      },
    });
    await expect(record(fixture.pool(), input(2), pending)).resolves.toMatchObject({
      outcome: { status: "pending" },
    });
    const changed = calculation();
    changed.evidence.netAccommodationMinor = "40000";
    await expect(record(fixture.pool(), input(3), resolver(changed))).resolves.toMatchObject({
      outcome: { adjustmentMinor: "-1000" },
    });
    expect(await count()).toBe(3);
  });
  it("does not open a second earning stream when the creator or accepted scope changes", async () => {
    await record(fixture.pool(), input(), resolver());
    const changed = calculation();
    changed.scope.creatorProfileId = id(99);
    await expect(record(fixture.pool(), input(2), resolver(changed))).resolves.toMatchObject({
      outcome: { status: "needs_review", reason: "previous_scope_mismatch" },
    });
    await expect(record(fixture.pool(), input(3), resolver())).resolves.toMatchObject({
      outcome: { adjustmentMinor: "0" },
    });
    expect(await count()).toBe(3);
  });
  it("denies permission and persisted scope loss before replay", async () => {
    await record(fixture.pool(), input(), resolver());
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
        c.linkedResources = [];
      },
    ]) {
      const request = input();
      mutate(request.context);
      await expect(record(fixture.pool(), request, resolver())).rejects.toThrow();
    }
    const other = input();
    other.context.selectedOrganization.organizationId = id(99);
    await expect(record(fixture.pool(), other, resolver())).resolves.toMatchObject({
      code: "scope_unavailable",
    });
    await fixture.pool().query("UPDATE identity.organization_resource_links SET status='revoked'");
    await expect(record(fixture.pool(), input(), resolver())).resolves.toMatchObject({
      code: "scope_unavailable",
    });
    expect(await count()).toBe(1);
  });
  it("rejects unavailable, mismatched or malformed evidence and rolls back storage failure", async () => {
    await expect(record(fixture.pool(), input(), async () => null)).resolves.toMatchObject({
      code: "evidence_unavailable",
    });
    const wrong = calculation();
    wrong.scope.propertyId = id(99);
    await expect(record(fixture.pool(), input(), resolver(wrong))).resolves.toMatchObject({
      code: "evidence_scope_mismatch",
    });
    await expect(
      record(fixture.pool(), input(), async () => ({
        sourceRevision: 2,
        calculation: calculation(),
      })),
    ).resolves.toMatchObject({ code: "evidence_scope_mismatch" });
    const invalid = calculation();
    invalid.evidence.netAccommodationMinor = "-1";
    await expect(record(fixture.pool(), input(), resolver(invalid))).resolves.toMatchObject({
      code: "invalid_evidence",
    });
    expect(await count()).toBe(0);
    await fixture.pool()
      .query(`CREATE FUNCTION finance.fail_journal_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
      CREATE TRIGGER fail_journal_test BEFORE INSERT ON finance.affiliate_earning_journal FOR EACH ROW EXECUTE FUNCTION finance.fail_journal_test()`);
    await expect(record(fixture.pool(), input(), resolver())).rejects.toThrow("test failure");
    expect(await count()).toBe(0);
  });
});
