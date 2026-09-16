import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import {
  context,
  databaseUrl,
  id,
  publicationCommandFixture,
} from "./affiliatePublicationCommandTestFixture.js";
import { manageAffiliateValidationProbe } from "./bookingAffiliateValidationProbe.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = async (name: string) => readFile(new URL(name, migrations), "utf8");
const deployment = {
  environment: "sandbox" as const,
  connectionReference: "referral-certification-test",
  adapterVersion: "native-v1",
};

describe.skipIf(!databaseUrl)("affiliate referral transport certification storage", () => {
  const fixture = publicationCommandFixture();
  let probeId: string;
  const bookingId = id(40);

  beforeEach(async () => {
    await fixture.pool().query(`CREATE TABLE booking.guest_bookings(
      id UUID PRIMARY KEY,
      property_id UUID NOT NULL,
      UNIQUE(id,property_id)
    )`);
    await fixture.pool().query(await migration("0212_booking_affiliate_validation_probes.sql"));
    await fixture.pool().query(await migration("0213_booking_affiliate_probe_bindings.sql"));
    await fixture
      .pool()
      .query(await migration("0215_booking_affiliate_referral_transport_certifications.sql"));
    const probe = await manageAffiliateValidationProbe(
      fixture.pool(),
      {
        context: context(),
        propertyId: id(3),
        destinationVersionId: id(30),
        action: "create",
        idempotencyKey: "referral-certification",
        lifetimeSeconds: 3600,
      },
      deployment,
    );
    if (!probe.ok || !("probe" in probe)) throw new Error("Probe creation failed");
    probeId = probe.probe.slice(4);
    await fixture
      .pool()
      .query("INSERT INTO booking.guest_bookings VALUES ($1,$2)", [bookingId, id(3)]);
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_booking_bindings
      (booking_id,property_id,probe_id,request_id) VALUES($1,$2,$3,'transport-binding')`,
      [bookingId, id(3), probeId],
    );
  });

  const certify = (overrides: Record<string, unknown> = {}) => {
    const value = {
      certificationId: id(60),
      probeId,
      bookingId,
      propertyId: id(3),
      destinationVersionId: id(30),
      organizationId: id(4),
      environment: deployment.environment,
      connectionReference: deployment.connectionReference,
      adapterVersion: deployment.adapterVersion,
      capability: "referral_round_trip",
      validationKind: "adapter_certification",
      evidenceScope: "capability_validation",
      evidenceReferences: ["binding:transport-binding", "browser:no-storage"],
      completedAt: "infinity",
      ...overrides,
    };
    return fixture.pool().query(
      `INSERT INTO booking.affiliate_referral_transport_certifications
      (id,probe_id,booking_id,property_id,destination_version_id,organization_id,environment,
       connection_reference,adapter_version,capability,validation_kind,evidence_scope,
       contract_version,evidence_references,actor_id,request_id,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
       'booking-affiliate-referral-transport-certification.v1',$13,$14,'certify',$15)`,
      [
        value.certificationId,
        value.probeId,
        value.bookingId,
        value.propertyId,
        value.destinationVersionId,
        value.organizationId,
        value.environment,
        value.connectionReference,
        value.adapterVersion,
        value.capability,
        value.validationKind,
        value.evidenceScope,
        JSON.stringify(value.evidenceReferences),
        id(1),
        value.completedAt,
      ],
    );
  };

  it("pins successful diagnostic certification to the exact probe booking binding", async () => {
    await certify();
    expect(
      (
        await fixture.pool().query(
          `SELECT probe_id,booking_id,property_id,destination_version_id,organization_id,
            environment,connection_reference,adapter_version,capability,validation_kind,
            evidence_scope,evidence_references
          FROM booking.affiliate_referral_transport_certifications`,
        )
      ).rows,
    ).toEqual([
      {
        probe_id: probeId,
        booking_id: bookingId,
        property_id: id(3),
        destination_version_id: id(30),
        organization_id: id(4),
        environment: "sandbox",
        connection_reference: deployment.connectionReference,
        adapter_version: deployment.adapterVersion,
        capability: "referral_round_trip",
        validation_kind: "adapter_certification",
        evidence_scope: "capability_validation",
        evidence_references: ["binding:transport-binding", "browser:no-storage"],
      },
    ]);
  });

  it("rejects a substituted binding, destination, deployment or evidence scope", async () => {
    await expect(certify({ bookingId: id(41) })).rejects.toMatchObject({ code: "23503" });
    for (const overrides of [
      { propertyId: id(6) },
      { destinationVersionId: id(31) },
      { organizationId: id(7) },
      { connectionReference: "other" },
      { adapterVersion: "native-v2" },
    ])
      await expect(certify(overrides)).rejects.toMatchObject({ code: "23514" });
    for (const overrides of [
      { capability: "reservation_lifecycle" },
      { validationKind: "production_preflight" },
      { evidenceScope: "earning" },
      { environment: "production" },
      { evidenceReferences: [] },
      { evidenceReferences: [null] },
      { evidenceReferences: [{ forged: true }] },
      { evidenceReferences: ["x".repeat(257)] },
      { evidenceReferences: ["\t\n"] },
      { evidenceReferences: { forged: true } },
    ])
      await expect(certify(overrides)).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await fixture
          .pool()
          .query(
            "SELECT count(*)::int AS n FROM booking.affiliate_referral_transport_certifications",
          )
      ).rows[0].n,
    ).toBe(0);
  });

  it("allows one immutable certification per probe", async () => {
    await certify();
    await expect(certify({ certificationId: id(61) })).rejects.toMatchObject({ code: "23505" });
    for (const sql of [
      "UPDATE booking.affiliate_referral_transport_certifications SET request_id='changed'",
      "DELETE FROM booking.affiliate_referral_transport_certifications",
      "TRUNCATE booking.affiliate_referral_transport_certifications CASCADE",
    ])
      await expect(fixture.pool().query(sql)).rejects.toThrow();
    expect(
      (
        await fixture
          .pool()
          .query(
            "SELECT count(*)::int AS n FROM booking.affiliate_referral_transport_certifications",
          )
      ).rows[0].n,
    ).toBe(1);
  });

  it("prevents a second booking delivery after certification", async () => {
    await certify();
    await fixture
      .pool()
      .query("INSERT INTO booking.guest_bookings VALUES ($1,$2)", [id(41), id(3)]);
    await expect(
      fixture.pool().query(
        `INSERT INTO booking.affiliate_validation_booking_bindings
        (booking_id,property_id,probe_id,request_id) VALUES($1,$2,$3,'second-delivery')`,
        [id(41), id(3), probeId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await fixture.pool().query(
          `SELECT count(*)::int AS n
          FROM booking.affiliate_validation_booking_bindings WHERE probe_id=$1`,
          [probeId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await fixture.pool().query(
          `SELECT count(*)::int AS n
          FROM booking.affiliate_referral_transport_certifications WHERE probe_id=$1`,
          [probeId],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("prevents a second booking delivery before certification", async () => {
    await fixture
      .pool()
      .query("INSERT INTO booking.guest_bookings VALUES ($1,$2)", [id(41), id(3)]);
    await expect(
      fixture.pool().query(
        `INSERT INTO booking.affiliate_validation_booking_bindings
        (booking_id,property_id,probe_id,request_id) VALUES($1,$2,$3,'second-delivery')`,
        [id(41), id(3), probeId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await certify();
    expect(
      (
        await fixture.pool().query(
          `SELECT count(*)::int AS n
          FROM booking.affiliate_referral_transport_certifications WHERE probe_id=$1`,
          [probeId],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("uses server completion time", async () => {
    const before = Date.now();
    await certify();
    const completed = (
      await fixture
        .pool()
        .query("SELECT completed_at FROM booking.affiliate_referral_transport_certifications")
    ).rows[0].completed_at as Date;
    expect(Number.isFinite(completed.getTime())).toBe(true);
    expect(Math.abs(completed.getTime() - before)).toBeLessThan(5_000);
  });

  it("rejects revoked probes", async () => {
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_probe_revocations
      (probe_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoke-before-certify')`,
      [probeId, id(1), id(4)],
    );
    await expect(certify()).rejects.toMatchObject({ code: "23514" });
  });
});

describe.skipIf(!databaseUrl)("affiliate referral transport certification storage upgrade", () => {
  const fixture = publicationCommandFixture();

  it("migrates historical duplicate deliveries but refuses to certify them", async () => {
    await fixture.pool().query(`CREATE TABLE booking.guest_bookings(
      id UUID PRIMARY KEY,
      property_id UUID NOT NULL,
      UNIQUE(id,property_id)
    )`);
    await fixture.pool().query(await migration("0212_booking_affiliate_validation_probes.sql"));
    await fixture.pool().query(await migration("0213_booking_affiliate_probe_bindings.sql"));
    const probe = await manageAffiliateValidationProbe(
      fixture.pool(),
      {
        context: context(),
        propertyId: id(3),
        destinationVersionId: id(30),
        action: "create",
        idempotencyKey: "historical-duplicate",
        lifetimeSeconds: 3600,
      },
      deployment,
    );
    if (!probe.ok || !("probe" in probe)) throw new Error("Probe creation failed");
    const historicalProbeId = probe.probe.slice(4);
    await fixture
      .pool()
      .query("INSERT INTO booking.guest_bookings VALUES ($1,$2),($3,$2)", [id(40), id(3), id(41)]);
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_booking_bindings
      (booking_id,property_id,probe_id,request_id)
      VALUES($1,$2,$3,'historical-one'),($4,$2,$3,'historical-two')`,
      [id(40), id(3), historicalProbeId, id(41)],
    );

    await expect(
      fixture
        .pool()
        .query(await migration("0215_booking_affiliate_referral_transport_certifications.sql")),
    ).resolves.toBeDefined();
    await expect(
      fixture.pool().query(
        `INSERT INTO booking.affiliate_referral_transport_certifications
        (id,probe_id,booking_id,property_id,destination_version_id,organization_id,environment,
         connection_reference,adapter_version,contract_version,evidence_references,actor_id,
         request_id,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
         'booking-affiliate-referral-transport-certification.v1',$10,$11,'certify-history','infinity')`,
        [
          id(60),
          historicalProbeId,
          id(40),
          id(3),
          id(30),
          id(4),
          deployment.environment,
          deployment.connectionReference,
          deployment.adapterVersion,
          JSON.stringify(["binding:historical-one"]),
          id(1),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
