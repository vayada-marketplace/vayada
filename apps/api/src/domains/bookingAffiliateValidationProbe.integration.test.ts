import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { context, databaseUrl, id, publicationFixture } from "./affiliatePublicationTestFixture.js";
import { manageAffiliateValidationProbe as manage } from "./bookingAffiliateValidationProbe.js";
const migration = await readFile(
  new URL(
    "../../../../packages/backend-migration/migrations/0183_booking_affiliate_validation_probes.sql",
    import.meta.url,
  ),
  "utf8",
);
const deployment = {
  environment: "local" as const,
  connectionReference: "isolated-test",
  adapterVersion: "native-v1",
};
const create = () => ({
  context: context(),
  propertyId: id(3),
  destinationVersionId: id(30),
  action: "create" as const,
  idempotencyKey: "probe-1",
  lifetimeSeconds: 3600,
});
describe.skipIf(!databaseUrl)("authorized non-earning validation probes", () => {
  const fixture = publicationFixture();
  beforeEach(async () => {
    await fixture.pool().query(migration);
  });
  const run = (input: Parameters<typeof manage>[1], config = deployment) =>
    manage(fixture.pool(), input, config);
  const issued = async () => {
    const result = await run(create());
    if (!result.ok || !("probe" in result)) throw new Error("Probe creation failed");
    return result;
  };
  const scoped = (probe: string, action: "resolve" | "revoke" = "resolve") => ({
    context: context(),
    propertyId: id(3),
    destinationVersionId: id(30),
    action,
    probe,
  });
  it("serializes duplicate creation, preserves audit and rejects changed retry input", async () => {
    const results = await Promise.all([run(create()), run(create())]);
    expect(results.map((r) => r.ok && "replayed" in r && r.replayed).sort()).toEqual([false, true]);
    const first = await issued();
    expect(first).toMatchObject({ purpose: "validation", replayed: true });
    await expect(run({ ...create(), lifetimeSeconds: 1800 })).resolves.toMatchObject({
      code: "idempotency_conflict",
    });
    await expect(run(scoped(first.probe))).resolves.toMatchObject({
      probe: first.probe,
      expiresAt: first.expiresAt,
    });
    const rows = (
      await fixture
        .pool()
        .query(
          "SELECT actor_id,organization_id,request_id,purpose FROM booking.affiliate_validation_probes",
        )
    ).rows;
    expect(rows).toEqual([
      { actor_id: id(1), organization_id: id(4), request_id: "request-1", purpose: "validation" },
    ]);
  });
  it("rechecks fresh permission and entitlement on retries", async () => {
    const first = await issued();
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
      const c = context();
      mutate(c);
      for (const input of [create(), scoped(first.probe), scoped(first.probe, "revoke")])
        await expect(run({ ...input, context: c })).rejects.toThrow();
    }
    const c = context();
    c.actor.status = "suspended";
    await expect(run({ ...create(), context: c })).resolves.toMatchObject({
      code: "scope_unavailable",
    });
    await fixture.pool().query("UPDATE identity.organization_resource_links SET status='inactive'");
    for (const input of [create(), scoped(first.probe), scoped(first.probe, "revoke")])
      await expect(run(input)).resolves.toMatchObject({ code: "scope_unavailable" });
  });
  it("rejects cross-destination scope, expired, revoked, forged and changed-configuration probes", async () => {
    const first = await issued();
    await expect(run({ ...create(), destinationVersionId: id(99) })).resolves.toMatchObject({
      code: "scope_unavailable",
    });
    await expect(run({ ...create(), propertyId: id(6) })).rejects.toThrow();
    await expect(run(scoped(id(50)))).resolves.toMatchObject({ code: "invalid_request" });
    await expect(run(scoped(`avp_${id(50)}`))).resolves.toMatchObject({
      code: "probe_unavailable",
    });
    await expect(
      run(scoped(first.probe), { ...deployment, adapterVersion: "native-v2" }),
    ).resolves.toMatchObject({ code: "probe_unavailable" });
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_probes
      SELECT $1,property_id,destination_version_id,organization_id,actor_id,purpose,environment,connection_reference,adapter_version,request_id,$2,fingerprint,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour'
      FROM booking.affiliate_validation_probes WHERE id=$3`,
      [id(51), "c".repeat(64), first.probe.slice(4)],
    );
    await expect(run(scoped(`avp_${id(51)}`))).resolves.toMatchObject({
      code: "probe_unavailable",
    });
    await expect(run(scoped(first.probe, "revoke"))).resolves.toEqual({ ok: true, revoked: true });
    await expect(run(scoped(first.probe, "revoke"))).resolves.toEqual({ ok: true, revoked: true });
    await expect(run(scoped(first.probe))).resolves.toMatchObject({ code: "probe_unavailable" });
    await expect(run(create())).resolves.toMatchObject({ code: "probe_unavailable" });
    expect(
      (
        await fixture
          .pool()
          .query("SELECT count(*)::int AS n FROM booking.affiliate_validation_probe_revocations")
      ).rows[0].n,
    ).toBe(1);
  });
  it("blocks production and invalid lifetimes without inserting a run", async () => {
    for (const lifetimeSeconds of [0, 1.5, 86401])
      await expect(run({ ...create(), lifetimeSeconds })).resolves.toMatchObject({
        code: "invalid_request",
      });
    await expect(
      manage(fixture.pool(), create(), { ...deployment, environment: "production" as "local" }),
    ).resolves.toMatchObject({ code: "invalid_request" });
    expect(
      (
        await fixture
          .pool()
          .query("SELECT count(*)::int AS n FROM booking.affiliate_validation_probes")
      ).rows[0].n,
    ).toBe(0);
  });
});
