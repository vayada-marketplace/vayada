import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import {
  databaseUrl,
  id,
  publicationCommandFixture,
} from "./affiliatePublicationCommandTestFixture.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = async (name: string) => readFile(new URL(name, migrations), "utf8");

describe.skipIf(!databaseUrl)("referral production preflight storage", () => {
  const fixture = publicationCommandFixture();

  beforeEach(async () => {
    await fixture.pool().query(`CREATE TABLE booking.guest_bookings(
      id UUID PRIMARY KEY, property_id UUID NOT NULL, UNIQUE(id,property_id)
    )`);
    for (const name of [
      "0212_booking_affiliate_validation_probes.sql",
      "0213_booking_affiliate_probe_bindings.sql",
      "0215_booking_affiliate_referral_transport_certifications.sql",
      "0218_booking_affiliate_referral_production_preflights.sql",
    ])
      await fixture.pool().query(await migration(name));
  });

  const insert = (overrides: Record<string, unknown> = {}) => {
    const value = {
      preflightId: id(60),
      propertyId: id(3),
      destinationVersionId: id(30),
      organizationId: id(4),
      environment: "production",
      connectionReference: "hotel-live-connection",
      adapterVersion: "native-v1",
      capability: "referral_round_trip",
      validationKind: "production_preflight",
      evidenceScope: "capability_validation",
      preflightMethod: "documented_non_mutating_round_trip",
      assertion: "opaque_correlation_returned_without_booking",
      correlationHash: "a".repeat(64),
      evidenceReferences: ["provider:preflight:42", "transport:no-booking-created"],
      completedAt: "infinity",
      ...overrides,
    };
    return fixture.pool().query(
      `INSERT INTO booking.affiliate_referral_production_preflights
      (id,property_id,destination_version_id,organization_id,environment,connection_reference,
       adapter_version,capability,validation_kind,evidence_scope,preflight_method,assertion,
       correlation_hash,contract_version,evidence_references,actor_id,request_id,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
       'booking-affiliate-referral-production-preflight.v1',$14,$15,'preflight',$16)`,
      [
        value.preflightId,
        value.propertyId,
        value.destinationVersionId,
        value.organizationId,
        value.environment,
        value.connectionReference,
        value.adapterVersion,
        value.capability,
        value.validationKind,
        value.evidenceScope,
        value.preflightMethod,
        value.assertion,
        value.correlationHash,
        JSON.stringify(value.evidenceReferences),
        id(1),
        value.completedAt,
      ],
    );
  };

  it("stores exact production-only non-mutating referral evidence", async () => {
    const before = Date.now();
    await insert();
    const row = (
      await fixture.pool().query(
        `SELECT property_id,destination_version_id,organization_id,environment,
          connection_reference,adapter_version,capability,validation_kind,evidence_scope,
          preflight_method,assertion,correlation_hash,evidence_references,completed_at
        FROM booking.affiliate_referral_production_preflights`,
      )
    ).rows[0];
    expect(row).toMatchObject({
      property_id: id(3),
      destination_version_id: id(30),
      organization_id: id(4),
      environment: "production",
      connection_reference: "hotel-live-connection",
      adapter_version: "native-v1",
      capability: "referral_round_trip",
      validation_kind: "production_preflight",
      evidence_scope: "capability_validation",
      preflight_method: "documented_non_mutating_round_trip",
      assertion: "opaque_correlation_returned_without_booking",
      correlation_hash: "a".repeat(64),
      evidence_references: ["provider:preflight:42", "transport:no-booking-created"],
    });
    expect(Number.isFinite(row.completed_at.getTime())).toBe(true);
    expect(Math.abs(row.completed_at.getTime() - before)).toBeLessThan(5_000);
  });

  it("rejects relabeling as certification, earning or a booking-producing check", async () => {
    for (const overrides of [
      { environment: "sandbox" },
      { capability: "reservation_lifecycle" },
      { validationKind: "adapter_certification" },
      { evidenceScope: "earning" },
      { preflightMethod: "synthetic_booking" },
      { assertion: "booking_created" },
      { correlationHash: "invalid" },
      { evidenceReferences: [] },
      { evidenceReferences: ["\t"] },
      { evidenceReferences: [{ forged: true }] },
    ])
      await expect(insert(overrides)).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await fixture
          .pool()
          .query("SELECT count(*)::int AS n FROM booking.affiliate_referral_production_preflights")
      ).rows[0].n,
    ).toBe(0);
  });

  it("pins property, destination and author organization scope", async () => {
    for (const overrides of [
      { propertyId: id(6) },
      { destinationVersionId: id(31) },
      { organizationId: id(7) },
    ])
      await expect(insert(overrides)).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps immutable history and prevents correlation replay", async () => {
    await insert();
    await expect(
      insert({
        preflightId: id(61),
        connectionReference: "another-live-connection",
        adapterVersion: "native-v2",
      }),
    ).rejects.toMatchObject({ code: "23505" });
    await insert({ preflightId: id(61), correlationHash: "b".repeat(64) });
    for (const sql of [
      "UPDATE booking.affiliate_referral_production_preflights SET request_id='changed'",
      "DELETE FROM booking.affiliate_referral_production_preflights",
      "TRUNCATE booking.affiliate_referral_production_preflights CASCADE",
    ])
      await expect(fixture.pool().query(sql)).rejects.toThrow();
    expect(
      (
        await fixture
          .pool()
          .query("SELECT count(*)::int AS n FROM booking.affiliate_referral_production_preflights")
      ).rows[0].n,
    ).toBe(2);
  });

  it("permanently revokes one preflight without mutating its evidence", async () => {
    await insert();
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_referral_production_preflight_revocations
      (preflight_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoke')`,
      [id(60), id(1), id(4)],
    );
    await expect(
      fixture.pool().query(
        `INSERT INTO booking.affiliate_referral_production_preflight_revocations
        (preflight_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'again')`,
        [id(60), id(1), id(4)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    for (const sql of [
      "UPDATE booking.affiliate_referral_production_preflight_revocations SET request_id='changed'",
      "DELETE FROM booking.affiliate_referral_production_preflight_revocations",
      "TRUNCATE booking.affiliate_referral_production_preflight_revocations",
    ])
      await expect(fixture.pool().query(sql)).rejects.toThrow();
  });
});
