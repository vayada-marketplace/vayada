import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { databaseUrl, id, publicationFixture } from "./affiliatePublicationTestFixture.js";
const migration = await readFile(
  new URL(
    "../../../../packages/backend-migration/migrations/0183_booking_affiliate_validation_probes.sql",
    import.meta.url,
  ),
  "utf8",
);
describe.skipIf(!databaseUrl)("non-earning validation probe storage", () => {
  const fixture = publicationFixture();
  beforeEach(async () => {
    await fixture.pool().query(migration);
  });
  const insert = (
    property = id(3),
    environment = "local",
    expiry = "1 hour",
    probeId = id(50),
    purpose = "validation",
    organizationId = id(4),
  ) =>
    fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_probes
     (id,property_id,destination_version_id,organization_id,actor_id,environment,connection_reference,adapter_version,request_id,key_hash,fingerprint,expires_at,purpose)
     VALUES($1,$2,$3,$4,$5,$6,'isolated-test','native-v1','test',$7,$8,clock_timestamp()+$9::interval,$10)`,
      [
        probeId,
        property,
        id(30),
        organizationId,
        id(1),
        environment,
        "a".repeat(64),
        "b".repeat(64),
        expiry,
        purpose,
      ],
    );
  it("enforces destination scope, bounded expiry, purpose and environment", async () => {
    await expect(insert(id(6))).rejects.toMatchObject({ code: "23503" });
    await expect(insert(id(3), "production")).rejects.toMatchObject({ code: "23514" });
    await expect(insert(id(3), "local", "-1 hour")).rejects.toMatchObject({ code: "23514" });
    await expect(insert(id(3), "local", "25 hours")).rejects.toMatchObject({ code: "23514" });
    await expect(insert(id(3), "local", "1 hour", id(50), "earning")).rejects.toMatchObject({
      code: "23514",
    });
    await fixture.pool().query("INSERT INTO identity.organizations VALUES($1)", [id(7)]);
    await expect(
      insert(id(3), "local", "1 hour", id(50), "validation", id(7)),
    ).rejects.toMatchObject({ code: "23503" });
    await insert();
    await expect(insert(id(3), "local", "1 hour", id(51))).rejects.toMatchObject({ code: "23505" });
    expect(
      (await fixture.pool().query("SELECT purpose FROM booking.affiliate_validation_probes")).rows,
    ).toEqual([{ purpose: "validation" }]);
  });
  it("preserves issuance and revocation audit against mutation", async () => {
    await insert();
    await fixture
      .pool()
      .query(
        `INSERT INTO booking.affiliate_validation_probe_revocations(probe_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoke')`,
        [id(50), id(1), id(4)],
      );
    for (const table of ["affiliate_validation_probes", "affiliate_validation_probe_revocations"]) {
      for (const sql of [
        `UPDATE booking.${table} SET request_id='changed'`,
        `DELETE FROM booking.${table}`,
        `TRUNCATE booking.${table} CASCADE`,
      ])
        await expect(fixture.pool().query(sql)).rejects.toThrow();
      expect(
        (await fixture.pool().query(`SELECT count(*)::int AS n FROM booking.${table}`)).rows[0].n,
      ).toBe(1);
    }
  });
});
