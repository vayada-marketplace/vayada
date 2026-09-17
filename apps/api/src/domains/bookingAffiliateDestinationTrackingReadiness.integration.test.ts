import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { AFFILIATE_TRACKING_PURPOSES, type AffiliateTrackingPurpose } from "@vayada/domain-booking";
import {
  databaseUrl,
  id,
  publicationCommandFixture,
} from "./affiliatePublicationCommandTestFixture.js";
import {
  AFFILIATE_DESTINATION_TRACKING_READINESS_POLICY_VERSION,
  readAffiliateDestinationTrackingReadiness,
} from "./bookingAffiliateDestinationTrackingReadiness.js";
import { AFFILIATE_REFERRAL_READINESS_MAX_AGE_SECONDS } from "./bookingAffiliateReferralReadiness.js";
import {
  affiliateSourceCapabilities,
  type AffiliateSourceCapability,
} from "./bookingAffiliateSourceCapabilityProductionPreflight.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = async (name: string) => readFile(new URL(name, migrations), "utf8");
const assertions: Record<AffiliateSourceCapability, string> = {
  reservation_lifecycle: "synthetic_reservation_lifecycle_observed",
  stay_completion: "synthetic_stay_completion_observed",
  accommodation_revenue: "synthetic_accommodation_revenue_observed",
};
const preflightAssertions: Record<AffiliateSourceCapability, string> = {
  reservation_lifecycle: "authenticated_reservation_lifecycle_read",
  stay_completion: "authenticated_stay_completion_read",
  accommodation_revenue: "authenticated_accommodation_revenue_read",
};

describe.skipIf(!databaseUrl)("aggregate affiliate destination tracking readiness", () => {
  const fixture = publicationCommandFixture();
  const configuration = (purpose: AffiliateTrackingPurpose) => ({
    certificationConnectionReference:
      purpose === "referral_round_trip" ? "referral-sandbox" : "source-sandbox",
    productionConnectionReference:
      purpose === "referral_round_trip" ? "referral-live" : "source-live",
    adapterVersion: purpose === "referral_round_trip" ? "referral-v1" : "source-v1",
  });
  const scope = () => ({
    propertyId: id(3),
    destinationVersionId: id(30),
    organizationId: id(4),
    certificationEnvironment: "sandbox" as const,
    purposes: Object.fromEntries(
      AFFILIATE_TRACKING_PURPOSES.map((purpose) => [purpose, configuration(purpose)]),
    ) as Record<AffiliateTrackingPurpose, ReturnType<typeof configuration>>,
  });

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
      "0220_booking_affiliate_source_capability_evidence.sql",
    ])
      await fixture.pool().query(await migration(name));
  });

  const digest = (value: string, fill: string) =>
    value.replaceAll("-", "").padEnd(64, fill).slice(0, 64);

  async function insertProbe(probe: string, booking: string, connection: string, adapter: string) {
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_probes
      (id,property_id,destination_version_id,organization_id,actor_id,environment,
       connection_reference,adapter_version,request_id,key_hash,fingerprint,expires_at)
      VALUES($1,$2,$3,$4,$5,'sandbox',$6,$7,'probe',$8,$9,clock_timestamp()+interval '1 hour')`,
      [
        probe,
        id(3),
        id(30),
        id(4),
        id(1),
        connection,
        adapter,
        digest(probe, "a"),
        digest(booking, "b"),
      ],
    );
    await fixture
      .pool()
      .query("INSERT INTO booking.guest_bookings VALUES($1,$2)", [booking, id(3)]);
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_booking_bindings
      (booking_id,property_id,probe_id,request_id) VALUES($1,$2,$3,'binding')`,
      [booking, id(3), probe],
    );
  }

  async function insertReferralEvidence() {
    const configured = configuration("referral_round_trip");
    await insertProbe(
      id(40),
      id(41),
      configured.certificationConnectionReference,
      configured.adapterVersion,
    );
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_referral_transport_certifications
      (id,probe_id,booking_id,property_id,destination_version_id,organization_id,environment,
       connection_reference,adapter_version,contract_version,evidence_references,actor_id,
       request_id,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,'sandbox',$7,$8,
       'booking-affiliate-referral-transport-certification.v1','["diagnostic"]',$9,
       'certification','infinity')`,
      [
        id(50),
        id(40),
        id(41),
        id(3),
        id(30),
        id(4),
        configured.certificationConnectionReference,
        configured.adapterVersion,
        id(1),
      ],
    );
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_referral_production_preflights
      (id,property_id,destination_version_id,organization_id,connection_reference,adapter_version,
       correlation_hash,contract_version,evidence_references,actor_id,request_id,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'booking-affiliate-referral-production-preflight.v1',
       '["production"]',$8,'preflight','infinity')`,
      [
        id(60),
        id(3),
        id(30),
        id(4),
        configured.productionConnectionReference,
        configured.adapterVersion,
        digest(id(60), "c"),
        id(1),
      ],
    );
  }

  async function insertSourceCertifications(probe = id(42), booking = id(43), start = 51) {
    const configured = configuration("reservation_lifecycle");
    await insertProbe(
      probe,
      booking,
      configured.certificationConnectionReference,
      configured.adapterVersion,
    );
    for (const [index, capability] of affiliateSourceCapabilities.entries())
      await fixture.pool().query(
        `INSERT INTO booking.affiliate_source_capability_certifications
        (id,probe_id,booking_id,property_id,destination_version_id,organization_id,environment,
         connection_reference,adapter_version,capability,assertion,contract_version,
         evidence_references,actor_id,request_id,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,'sandbox',$7,$8,$9,$10,
         'booking-affiliate-source-capability-certification.v1','["diagnostic"]',$11,
         'certification','infinity')`,
        [
          id(start + index),
          probe,
          booking,
          id(3),
          id(30),
          id(4),
          configuration(capability).certificationConnectionReference,
          configuration(capability).adapterVersion,
          capability,
          assertions[capability],
          id(1),
        ],
      );
  }

  async function insertSourcePreflights(start = 61) {
    for (const [index, capability] of affiliateSourceCapabilities.entries())
      await fixture.pool().query(
        `INSERT INTO booking.affiliate_source_capability_production_preflights
        (id,property_id,destination_version_id,organization_id,connection_reference,adapter_version,
         capability,assertion,evidence_fingerprint_hash,contract_version,evidence_references,
         actor_id,request_id,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
         'booking-affiliate-source-capability-production-preflight.v1','["production"]',$10,
         'preflight','infinity')`,
        [
          id(start + index),
          id(3),
          id(30),
          id(4),
          configuration(capability).productionConnectionReference,
          configuration(capability).adapterVersion,
          capability,
          preflightAssertions[capability],
          digest(id(start + index), "d"),
          id(1),
        ],
      );
  }

  async function insertAllEvidence() {
    await insertReferralEvidence();
    await insertSourceCertifications();
    await insertSourcePreflights();
  }

  async function read(input = scope()) {
    const client = await fixture.pool().connect();
    try {
      await client.query("BEGIN");
      const result = await readAffiliateDestinationTrackingReadiness(client, input);
      await client.query("ROLLBACK");
      return result;
    } finally {
      client.release();
    }
  }

  it("requires one current certification and preflight for every purpose", async () => {
    await insertAllEvidence();
    const result = await read();
    expect(result).toMatchObject({
      status: "verified",
      missing: [],
      policyVersion: AFFILIATE_DESTINATION_TRACKING_READINESS_POLICY_VERSION,
    });
    expect(result.evidence.map(({ purpose }) => purpose)).toEqual(AFFILIATE_TRACKING_PURPOSES);
    expect(result.evidence).toEqual(
      expect.arrayContaining(
        AFFILIATE_TRACKING_PURPOSES.map((purpose) =>
          expect.objectContaining({
            purpose,
            evidenceReference: expect.stringMatching(
              new RegExp(`^booking:affiliate-destination-capability-readiness:${purpose}:`),
            ),
            validatedAt: expect.any(String),
          }),
        ),
      ),
    );
  });

  it("reports purposes independently and does not treat configuration as proof", async () => {
    await insertReferralEvidence();
    await insertSourceCertifications();
    await expect(read()).resolves.toMatchObject({
      status: "pending",
      missing: [...affiliateSourceCapabilities],
    });
    await insertSourcePreflights();
    for (const changedConfiguration of [
      { certificationConnectionReference: "changed-sandbox" },
      { productionConnectionReference: "changed-live" },
      { adapterVersion: "changed-v2" },
    ]) {
      const changed = scope();
      Object.assign(changed.purposes.stay_completion, changedConfiguration);
      await expect(read(changed)).resolves.toMatchObject({
        status: "pending",
        missing: ["stay_completion"],
      });
    }
  });

  it.each(["certification", "preflight"] as const)(
    "rejects stale source %s evidence",
    async (kind) => {
      await insertAllEvidence();
      const table =
        kind === "certification"
          ? "booking.affiliate_source_capability_certifications"
          : "booking.affiliate_source_capability_production_preflights";
      const trigger =
        kind === "certification"
          ? "affiliate_source_capability_certification_immutable"
          : "affiliate_source_capability_preflight_immutable";
      const target = kind === "certification" ? id(51) : id(61);
      await fixture.pool().query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      await fixture
        .pool()
        .query(`UPDATE ${table} SET completed_at=$1 WHERE id=$2`, [
          new Date(Date.now() - (AFFILIATE_REFERRAL_READINESS_MAX_AGE_SECONDS + 1) * 1000),
          target,
        ]);
      await fixture.pool().query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
      await expect(read()).resolves.toMatchObject({
        status: "pending",
        missing: ["reservation_lifecycle"],
      });
    },
  );

  it("falls back to older current source proofs after newer proofs are revoked", async () => {
    await insertAllEvidence();
    await insertSourceCertifications(id(44), id(45), 71);
    await insertSourcePreflights(81);
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_probe_revocations
      (probe_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoke-new')`,
      [id(44), id(1), id(4)],
    );
    for (const preflight of [id(81), id(82), id(83)])
      await fixture.pool().query(
        `INSERT INTO booking.affiliate_source_capability_preflight_revocations
        (preflight_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoke-new')`,
        [preflight, id(1), id(4)],
      );
    await expect(read()).resolves.toMatchObject({ status: "verified", missing: [] });
  });

  it.each(["probe", "preflight"] as const)(
    "falls back when a newer source %s proof is concurrently revoked first",
    async (target) => {
      await insertAllEvidence();
      if (target === "probe") await insertSourceCertifications(id(44), id(45), 71);
      else await insertSourcePreflights(81);
      const revoker = await fixture.pool().connect();
      const reader = await fixture.pool().connect();
      let readiness: Promise<unknown> | undefined;
      try {
        await revoker.query("BEGIN");
        await revoker.query(
          target === "probe"
            ? `INSERT INTO booking.affiliate_validation_probe_revocations
              (probe_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoke-first')`
            : `INSERT INTO booking.affiliate_source_capability_preflight_revocations
              (preflight_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoke-first')`,
          [target === "probe" ? id(44) : id(81), id(1), id(4)],
        );
        await reader.query("BEGIN");
        const pid = (await reader.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
        readiness = readAffiliateDestinationTrackingReadiness(reader, scope());
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
          status: "verified",
          missing: [],
          evidence: expect.arrayContaining([
            expect.objectContaining({
              purpose: "reservation_lifecycle",
              evidenceReference: expect.stringMatching(new RegExp(`${id(51)}:${id(61)}$`)),
            }),
          ]),
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
    "serializes a concurrent source %s revocation with the readiness transaction",
    async (target) => {
      await insertAllEvidence();
      const reader = await fixture.pool().connect();
      const revoker = await fixture.pool().connect();
      let revocation: Promise<unknown> | undefined;
      try {
        await reader.query("BEGIN");
        await expect(
          readAffiliateDestinationTrackingReadiness(reader, scope()),
        ).resolves.toMatchObject({ status: "verified" });
        const pid = (await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
        revocation = revoker.query(
          target === "probe"
            ? `INSERT INTO booking.affiliate_validation_probe_revocations
              (probe_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'race')`
            : `INSERT INTO booking.affiliate_source_capability_preflight_revocations
              (preflight_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'race')`,
          [target === "probe" ? id(42) : id(61), id(1), id(4)],
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
        await expect(read()).resolves.toMatchObject({
          status: "pending",
          missing:
            target === "probe" ? [...affiliateSourceCapabilities] : ["reservation_lifecycle"],
        });
      } finally {
        await reader.query("ROLLBACK").catch(() => undefined);
        await revocation?.catch(() => undefined);
        reader.release();
        revoker.release();
      }
    },
  );

  it("requires a caller-owned READ COMMITTED transaction", async () => {
    const client = await fixture.pool().connect();
    try {
      await expect(readAffiliateDestinationTrackingReadiness(client, scope())).rejects.toThrow();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await expect(readAffiliateDestinationTrackingReadiness(client, scope())).rejects.toThrow(
        "Affiliate referral readiness requires a READ COMMITTED transaction",
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
