import { readFile } from "node:fs/promises";
import type pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import {
  databaseUrl,
  id,
  publicationCommandFixture,
} from "./affiliatePublicationCommandTestFixture.js";
import {
  AFFILIATE_REFERRAL_READINESS_MAX_AGE_SECONDS,
  readAffiliateReferralRuntimeConfiguration,
  readAffiliateReferralRoundTripReadiness,
} from "./bookingAffiliateReferralReadiness.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = async (name: string) => readFile(new URL(name, migrations), "utf8");
const certificationConnectionReference = "current-sandbox-connection";
const productionConnectionReference = "current-live-connection";
const adapterVersion = "native-v1";

describe.skipIf(!databaseUrl)("affiliate referral round-trip readiness", () => {
  const fixture = publicationCommandFixture();

  beforeEach(async () => {
    await fixture.pool().query(`CREATE TABLE booking.guest_bookings(
      id UUID PRIMARY KEY,
      property_id UUID NOT NULL,
      UNIQUE(id,property_id)
    )`);
    for (const name of [
      "0212_booking_affiliate_validation_probes.sql",
      "0213_booking_affiliate_probe_bindings.sql",
      "0215_booking_affiliate_referral_transport_certifications.sql",
      "0218_booking_affiliate_referral_production_preflights.sql",
    ])
      await fixture.pool().query(await migration(name));
  });

  type ReadinessScope = Parameters<typeof readAffiliateReferralRoundTripReadiness>[1];
  const scope = (overrides: Partial<ReadinessScope> = {}): ReadinessScope => ({
    propertyId: id(3),
    destinationVersionId: id(30),
    organizationId: id(4),
    certificationEnvironment: "sandbox" as const,
    certificationConnectionReference,
    productionConnectionReference,
    adapterVersion,
    ...overrides,
  });

  async function insertCertification(
    probeLifetime = "1 hour",
    identifiers = { probe: id(40), booking: id(41), certification: id(50) },
    configuration = { connectionReference: certificationConnectionReference, adapterVersion },
    database: Pick<pg.Pool, "query"> = fixture.pool(),
  ) {
    await database.query(
      `INSERT INTO booking.affiliate_validation_probes
      (id,property_id,destination_version_id,organization_id,actor_id,environment,
       connection_reference,adapter_version,request_id,key_hash,fingerprint,expires_at)
      VALUES($1,$2,$3,$4,$5,'sandbox',$6,$7,'probe',$8,$9,clock_timestamp()+$10::interval)`,
      [
        identifiers.probe,
        id(3),
        id(30),
        id(4),
        id(1),
        configuration.connectionReference,
        configuration.adapterVersion,
        identifiers.probe.replaceAll("-", "").padEnd(64, "a").slice(0, 64),
        identifiers.certification.replaceAll("-", "").padEnd(64, "b").slice(0, 64),
        probeLifetime,
      ],
    );
    await database.query("INSERT INTO booking.guest_bookings VALUES($1,$2)", [
      identifiers.booking,
      id(3),
    ]);
    await database.query(
      `INSERT INTO booking.affiliate_validation_booking_bindings
      (booking_id,property_id,probe_id,request_id) VALUES($1,$2,$3,'binding')`,
      [identifiers.booking, id(3), identifiers.probe],
    );
    await database.query(
      `INSERT INTO booking.affiliate_referral_transport_certifications
      (id,probe_id,booking_id,property_id,destination_version_id,organization_id,environment,
       connection_reference,adapter_version,contract_version,evidence_references,actor_id,
       request_id,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,'sandbox',$7,$8,
       'booking-affiliate-referral-transport-certification.v1','["diagnostic"]',$9,
       'certification','infinity')`,
      [
        identifiers.certification,
        identifiers.probe,
        identifiers.booking,
        id(3),
        id(30),
        id(4),
        configuration.connectionReference,
        configuration.adapterVersion,
        id(1),
      ],
    );
  }

  async function insertPreflight(
    completedAt: Date | "infinity" = "infinity",
    preflightId = id(60),
    configuration = { connectionReference: productionConnectionReference, adapterVersion },
    database: Pick<pg.Pool, "query"> = fixture.pool(),
  ) {
    if (completedAt !== "infinity")
      await database.query(
        "ALTER TABLE booking.affiliate_referral_production_preflights DISABLE TRIGGER affiliate_referral_production_preflight_complete",
      );
    await database.query(
      `INSERT INTO booking.affiliate_referral_production_preflights
      (id,property_id,destination_version_id,organization_id,connection_reference,adapter_version,
       correlation_hash,contract_version,evidence_references,actor_id,request_id,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'booking-affiliate-referral-production-preflight.v1',
       '["production"]',$8,'preflight',$9)`,
      [
        preflightId,
        id(3),
        id(30),
        id(4),
        configuration.connectionReference,
        configuration.adapterVersion,
        preflightId.replaceAll("-", "").padEnd(64, "c").slice(0, 64),
        id(1),
        completedAt,
      ],
    );
    if (completedAt !== "infinity")
      await database.query(
        "ALTER TABLE booking.affiliate_referral_production_preflights ENABLE TRIGGER affiliate_referral_production_preflight_complete",
      );
  }

  async function read(input = scope()) {
    const client = await fixture.pool().connect();
    try {
      await client.query("BEGIN");
      const result = await readAffiliateReferralRoundTripReadiness(client, input);
      await client.query("ROLLBACK");
      return result;
    } finally {
      client.release();
    }
  }

  async function readConfiguration(input = scope()) {
    const client = await fixture.pool().connect();
    try {
      await client.query("BEGIN");
      const result = await readAffiliateReferralRuntimeConfiguration(client, input);
      await client.query("ROLLBACK");
      return result;
    } finally {
      client.release();
    }
  }

  it("requires a caller-owned transaction", async () => {
    const client = await fixture.pool().connect();
    try {
      await expect(readAffiliateReferralRoundTripReadiness(client, scope())).rejects.toThrow();
      await expect(
        readAffiliateReferralRoundTripReadiness(client, scope({ propertyId: "invalid" })),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });

  it("requires both exact current proofs and returns opaque evidence references", async () => {
    await insertCertification();
    await insertPreflight();
    await expect(read()).resolves.toEqual({
      status: "ready",
      capability: "referral_round_trip",
      policyVersion: "booking-affiliate-referral-readiness.v1",
      evidenceReferences: [
        `booking:affiliate-referral-transport-certification:${id(50)}`,
        `booking:affiliate-referral-production-preflight:${id(60)}`,
      ],
      validatedAt: expect.any(String),
    });
    await expect(
      read(scope({ certificationConnectionReference: "changed-sandbox-connection" })),
    ).resolves.toEqual({
      status: "blocked",
      reasons: ["diagnostic_certification_unavailable"],
    });
    await expect(
      read(scope({ productionConnectionReference: "changed-live-connection" })),
    ).resolves.toEqual({
      status: "blocked",
      reasons: ["production_preflight_unavailable"],
    });
  });

  it("selects one current runtime configuration and rejects ambiguous evidence", async () => {
    await expect(readConfiguration()).resolves.toBeUndefined();
    await insertCertification();
    await insertPreflight();
    await expect(readConfiguration()).resolves.toEqual({
      certificationEnvironment: "sandbox",
      certificationConnectionReference,
      productionConnectionReference,
      adapterVersion,
    });

    await insertCertification(
      "1 hour",
      { probe: id(42), booking: id(43), certification: id(51) },
      { connectionReference: "next-sandbox-connection", adapterVersion: "native-v2" },
    );
    await insertPreflight("infinity", id(61), {
      connectionReference: "next-live-connection",
      adapterVersion: "native-v2",
    });
    await expect(readConfiguration()).resolves.toBeUndefined();

    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_probe_revocations
       (probe_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'retire-ambiguous')`,
      [id(42), id(1), id(4)],
    );
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_referral_production_preflight_revocations
       (preflight_id,actor_id,organization_id,request_id)
       VALUES($1,$2,$3,'retire-ambiguous')`,
      [id(61), id(1), id(4)],
    );
    await expect(readConfiguration()).resolves.toEqual({
      certificationEnvironment: "sandbox",
      certificationConnectionReference,
      productionConnectionReference,
      adapterVersion,
    });
  });

  it("holds the shared property scope against a competing configuration command", async () => {
    await insertCertification();
    await insertPreflight();
    const reader = await fixture.pool().connect();
    const writer = await fixture.pool().connect();
    let competingWrite: Promise<unknown> | undefined;
    try {
      await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await expect(readAffiliateReferralRuntimeConfiguration(reader, scope())).resolves.toEqual({
        certificationEnvironment: "sandbox",
        certificationConnectionReference,
        productionConnectionReference,
        adapterVersion,
      });

      await writer.query("BEGIN");
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      competingWrite = (async () => {
        await writer.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR UPDATE", [
          id(3),
        ]);
        await insertCertification(
          "1 hour",
          { probe: id(42), booking: id(43), certification: id(51) },
          { connectionReference: "next-sandbox-connection", adapterVersion: "native-v2" },
          writer,
        );
        await insertPreflight(
          "infinity",
          id(61),
          { connectionReference: "next-live-connection", adapterVersion: "native-v2" },
          writer,
        );
      })();
      await expect
        .poll(async () => {
          const result = await fixture
            .pool()
            .query("SELECT cardinality(pg_blocking_pids($1)) AS blocked", [pid]);
          return result.rows[0].blocked;
        })
        .toBeGreaterThan(0);

      await reader.query("COMMIT");
      await competingWrite;
      await writer.query("COMMIT");
      await expect(readConfiguration()).resolves.toBeUndefined();
    } finally {
      await reader.query("ROLLBACK").catch(() => undefined);
      await writer.query("ROLLBACK").catch(() => undefined);
      await competingWrite?.catch(() => undefined);
      reader.release();
      writer.release();
    }
  });

  it("reports each missing half without treating configuration as readiness", async () => {
    await expect(read()).resolves.toEqual({
      status: "blocked",
      reasons: ["diagnostic_certification_unavailable", "production_preflight_unavailable"],
    });
    await insertCertification();
    await expect(read()).resolves.toEqual({
      status: "blocked",
      reasons: ["production_preflight_unavailable"],
    });
  });

  it("uses the evidence policy instead of the diagnostic probe lifetime", async () => {
    await insertCertification("1 second");
    await insertPreflight();
    await fixture.pool().query("SELECT pg_sleep(1.1)");
    await expect(read()).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects production evidence outside the explicit freshness window", async () => {
    await insertCertification();
    await insertPreflight(
      new Date(Date.now() - (AFFILIATE_REFERRAL_READINESS_MAX_AGE_SECONDS + 1) * 1000),
    );
    await expect(read()).resolves.toEqual({
      status: "blocked",
      reasons: ["production_preflight_unavailable"],
    });
  });

  it("rejects diagnostic evidence outside the explicit freshness window", async () => {
    await insertCertification();
    await insertPreflight();
    await fixture
      .pool()
      .query(
        "ALTER TABLE booking.affiliate_referral_transport_certifications DISABLE TRIGGER affiliate_referral_transport_certification_immutable",
      );
    await fixture
      .pool()
      .query(
        "UPDATE booking.affiliate_referral_transport_certifications SET completed_at=$1 WHERE id=$2",
        [new Date(Date.now() - (AFFILIATE_REFERRAL_READINESS_MAX_AGE_SECONDS + 1) * 1000), id(50)],
      );
    await fixture
      .pool()
      .query(
        "ALTER TABLE booking.affiliate_referral_transport_certifications ENABLE TRIGGER affiliate_referral_transport_certification_immutable",
      );
    await expect(read()).resolves.toEqual({
      status: "blocked",
      reasons: ["diagnostic_certification_unavailable"],
    });
  });

  it("uses older current proofs when newer proof records were revoked", async () => {
    await insertCertification();
    await insertPreflight();
    await insertCertification("1 hour", {
      probe: id(42),
      booking: id(43),
      certification: id(51),
    });
    await insertPreflight("infinity", id(61));
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_probe_revocations
      (probe_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoke-newest')`,
      [id(42), id(1), id(4)],
    );
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_referral_production_preflight_revocations
      (preflight_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoke-newest')`,
      [id(61), id(1), id(4)],
    );

    await expect(read()).resolves.toMatchObject({
      status: "ready",
      evidenceReferences: [
        `booking:affiliate-referral-transport-certification:${id(50)}`,
        `booking:affiliate-referral-production-preflight:${id(60)}`,
      ],
    });
  });

  it.each(["probe", "preflight"] as const)(
    "falls back after a newer %s proof is concurrently revoked first",
    async (target) => {
      await insertCertification();
      await insertPreflight();
      if (target === "probe")
        await insertCertification("1 hour", {
          probe: id(42),
          booking: id(43),
          certification: id(51),
        });
      else await insertPreflight("infinity", id(61));
      const revoker = await fixture.pool().connect();
      const reader = await fixture.pool().connect();
      let readiness: Promise<unknown> | undefined;
      try {
        await revoker.query("BEGIN");
        await revoker.query(
          target === "probe"
            ? `INSERT INTO booking.affiliate_validation_probe_revocations
              (probe_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoke-first')`
            : `INSERT INTO booking.affiliate_referral_production_preflight_revocations
              (preflight_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoke-first')`,
          [target === "probe" ? id(42) : id(61), id(1), id(4)],
        );
        await reader.query("BEGIN");
        const pid = (await reader.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
        readiness = readAffiliateReferralRoundTripReadiness(reader, scope());
        await expect
          .poll(async () => {
            const result = await fixture
              .pool()
              .query("SELECT cardinality(pg_blocking_pids($1)) AS blocked", [pid]);
            return result.rows[0].blocked;
          })
          .toBeGreaterThan(0);
        await revoker.query("COMMIT");
        await expect(readiness).resolves.toMatchObject({
          status: "ready",
          evidenceReferences: [
            `booking:affiliate-referral-transport-certification:${id(50)}`,
            `booking:affiliate-referral-production-preflight:${id(60)}`,
          ],
        });
      } finally {
        await revoker.query("ROLLBACK").catch(() => undefined);
        await reader.query("ROLLBACK").catch(() => undefined);
        await readiness?.catch(() => undefined);
        revoker.release();
        reader.release();
      }
    },
  );

  it.each(["probe", "preflight"] as const)(
    "serializes a concurrent %s revocation with the readiness transaction",
    async (target) => {
      await insertCertification();
      await insertPreflight();
      const reader = await fixture.pool().connect();
      const revoker = await fixture.pool().connect();
      let revocation: Promise<unknown> | undefined;
      try {
        await reader.query("BEGIN");
        await expect(
          readAffiliateReferralRoundTripReadiness(reader, scope()),
        ).resolves.toMatchObject({ status: "ready" });
        const pid = (await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
        revocation = revoker.query(
          target === "probe"
            ? `INSERT INTO booking.affiliate_validation_probe_revocations
              (probe_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'race')`
            : `INSERT INTO booking.affiliate_referral_production_preflight_revocations
              (preflight_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'race')`,
          [target === "probe" ? id(40) : id(60), id(1), id(4)],
        );
        await expect
          .poll(async () => {
            const result = await fixture
              .pool()
              .query("SELECT cardinality(pg_blocking_pids($1)) AS blocked", [pid]);
            return result.rows[0].blocked;
          })
          .toBeGreaterThan(0);
        await reader.query("COMMIT");
        await revocation;
        await expect(read()).resolves.toEqual({
          status: "blocked",
          reasons: [
            target === "probe"
              ? "diagnostic_certification_unavailable"
              : "production_preflight_unavailable",
          ],
        });
      } finally {
        await reader.query("ROLLBACK").catch(() => undefined);
        await revocation?.catch(() => undefined);
        reader.release();
        revoker.release();
      }
    },
  );

  it("rejects a stale repeatable-read snapshot after revocation commits", async () => {
    await insertCertification();
    await insertPreflight();
    const reader = await fixture.pool().connect();
    try {
      await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await reader.query("SELECT id FROM booking.affiliate_destination_versions WHERE id=$1", [
        id(30),
      ]);
      await fixture.pool().query(
        `INSERT INTO booking.affiliate_referral_production_preflight_revocations
        (preflight_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'before-read')`,
        [id(60), id(1), id(4)],
      );
      await expect(readAffiliateReferralRoundTripReadiness(reader, scope())).rejects.toThrow(
        "Affiliate referral readiness requires a READ COMMITTED transaction",
      );
    } finally {
      await reader.query("ROLLBACK");
      reader.release();
    }
  });
});
