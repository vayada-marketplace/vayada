import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import {
  databaseUrl,
  id,
  publicationCommandFixture,
} from "./affiliatePublicationCommandTestFixture.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = async (name: string) => readFile(new URL(name, migrations), "utf8");
const connection = "source-capability-sandbox";
const adapter = "generic-pms-v1";
const capabilities = [
  ["reservation_lifecycle", "synthetic_reservation_lifecycle_observed"],
  ["stay_completion", "synthetic_stay_completion_observed"],
  ["accommodation_revenue", "synthetic_accommodation_revenue_observed"],
] as const;
const preflightAssertions = {
  reservation_lifecycle: "authenticated_reservation_lifecycle_read",
  stay_completion: "authenticated_stay_completion_read",
  accommodation_revenue: "authenticated_accommodation_revenue_read",
} as const;
type Capability = (typeof capabilities)[number][0];
type CertificationOverrides = Partial<{
  capability: string;
  connection: string;
}>;
type PreflightOverrides = Partial<{
  capability: string;
  destination: string;
  fingerprint: string;
}>;

describe.skipIf(!databaseUrl)("affiliate source capability evidence storage", () => {
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
      "0220_booking_affiliate_source_capability_evidence.sql",
    ])
      await fixture.pool().query(await migration(name));
    await fixture.pool().query("INSERT INTO identity.organizations VALUES ($1)", [id(7)]);
  });

  async function seedProbe(n: number) {
    const probe = id(100 + n);
    const booking = id(200 + n);
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_probes
      (id,property_id,destination_version_id,organization_id,actor_id,environment,
       connection_reference,adapter_version,request_id,key_hash,fingerprint,expires_at)
      VALUES($1,$2,$3,$4,$5,'sandbox',$6,$7,$8,$9,$10,clock_timestamp()+interval '1 hour')`,
      [
        probe,
        id(3),
        id(30),
        id(4),
        id(1),
        connection,
        adapter,
        `probe-${n}`,
        n.toString(16).padStart(64, "a"),
        n.toString(16).padStart(64, "b"),
      ],
    );
    await fixture
      .pool()
      .query("INSERT INTO booking.guest_bookings VALUES($1,$2)", [booking, id(3)]);
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_booking_bindings
      (booking_id,property_id,probe_id,request_id) VALUES($1,$2,$3,$4)`,
      [booking, id(3), probe, `binding-${n}`],
    );
    return { probe, booking };
  }

  async function certify(
    n: number,
    capability: Capability,
    assertion: string,
    overrides: CertificationOverrides = {},
  ) {
    const binding = await seedProbe(n);
    const value = {
      id: id(300 + n),
      ...binding,
      property: id(3),
      destination: id(30),
      organization: id(4),
      environment: "sandbox",
      connection,
      adapter,
      capability,
      assertion,
      ...overrides,
    };
    return fixture.pool().query(
      `INSERT INTO booking.affiliate_source_capability_certifications
      (id,probe_id,booking_id,property_id,destination_version_id,organization_id,environment,
       connection_reference,adapter_version,capability,validation_kind,evidence_scope,
       validation_method,assertion,contract_version,evidence_references,actor_id,request_id,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'adapter_certification',
       'capability_validation','isolated_synthetic_fixture',$11,
       'booking-affiliate-source-capability-certification.v1',$12,$13,'certify','infinity')`,
      [
        value.id,
        value.probe,
        value.booking,
        value.property,
        value.destination,
        value.organization,
        value.environment,
        value.connection,
        value.adapter,
        value.capability,
        value.assertion,
        JSON.stringify([`synthetic:${capability}`]),
        id(1),
      ],
    );
  }

  async function preflight(
    n: number,
    capability: keyof typeof preflightAssertions,
    assertion: string,
    overrides: PreflightOverrides = {},
  ) {
    const value = {
      id: id(400 + n),
      property: id(3),
      destination: id(30),
      organization: id(4),
      environment: "production",
      connection: "source-capability-production",
      adapter,
      capability,
      assertion,
      fingerprint: "c".repeat(63) + n.toString(16),
      ...overrides,
    };
    return fixture.pool().query(
      `INSERT INTO booking.affiliate_source_capability_production_preflights
      (id,property_id,destination_version_id,organization_id,environment,connection_reference,
       adapter_version,capability,validation_kind,evidence_scope,preflight_method,assertion,
       evidence_fingerprint_hash,contract_version,evidence_references,actor_id,request_id,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'production_preflight','capability_validation',
       'documented_authenticated_read',$9,$10,
       'booking-affiliate-source-capability-production-preflight.v1',$11,$12,'preflight','infinity')`,
      [
        value.id,
        value.property,
        value.destination,
        value.organization,
        value.environment,
        value.connection,
        value.adapter,
        value.capability,
        value.assertion,
        value.fingerprint,
        JSON.stringify([`production:${capability}`]),
        id(1),
      ],
    );
  }

  it("stores all three diagnostic capabilities with fixed assertions and server time", async () => {
    for (const [index, [capability, assertion]] of capabilities.entries())
      await certify(index + 1, capability, assertion);
    const rows = (
      await fixture.pool().query(
        `SELECT capability,assertion,validation_method,completed_at::text AS completed_at
        FROM booking.affiliate_source_capability_certifications ORDER BY capability`,
      )
    ).rows;
    expect(
      rows.map(({ capability, assertion, validation_method }) => ({
        capability,
        assertion,
        validation_method,
      })),
    ).toEqual(
      capabilities
        .map(([capability, assertion]) => ({
          capability,
          assertion,
          validation_method: "isolated_synthetic_fixture",
        }))
        .sort((a, b) => a.capability.localeCompare(b.capability)),
    );
    expect(rows.every((row) => row.completed_at !== "infinity")).toBe(true);
  });

  it("rejects substituted diagnostic scope, purpose and assertions", async () => {
    await expect(
      certify(1, "reservation_lifecycle", "synthetic_reservation_lifecycle_observed", {
        connection: "other",
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      certify(2, "reservation_lifecycle", "synthetic_stay_completion_observed"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      certify(3, "reservation_lifecycle", "synthetic_reservation_lifecycle_observed", {
        capability: "referral_round_trip",
      }),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await fixture
          .pool()
          .query(
            "SELECT count(*)::int AS n FROM booking.affiliate_source_capability_certifications",
          )
      ).rows[0].n,
    ).toBe(0);
  });

  it("blocks certification after probe revocation and keeps accepted evidence immutable", async () => {
    const accepted = await certify(
      1,
      "reservation_lifecycle",
      "synthetic_reservation_lifecycle_observed",
    );
    expect(accepted.rowCount).toBe(1);
    const binding = await seedProbe(2);
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_probe_revocations
      (probe_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoke')`,
      [binding.probe, id(1), id(4)],
    );
    await expect(
      fixture.pool().query(
        `INSERT INTO booking.affiliate_source_capability_certifications
        (id,probe_id,booking_id,property_id,destination_version_id,organization_id,environment,
         connection_reference,adapter_version,capability,assertion,contract_version,
         evidence_references,actor_id,request_id,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,'sandbox',$7,$8,'stay_completion',
         'synthetic_stay_completion_observed','booking-affiliate-source-capability-certification.v1',
         '["synthetic"]',$9,'certify','infinity')`,
        [id(302), binding.probe, binding.booking, id(3), id(30), id(4), connection, adapter, id(1)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    for (const sql of [
      "UPDATE booking.affiliate_source_capability_certifications SET request_id='changed'",
      "DELETE FROM booking.affiliate_source_capability_certifications",
      "TRUNCATE booking.affiliate_source_capability_certifications",
    ])
      await expect(fixture.pool().query(sql)).rejects.toThrow();
  });

  it("stores exact production read preflights for all three capabilities", async () => {
    for (const [index, capability] of Object.keys(preflightAssertions).entries())
      await preflight(
        index + 1,
        capability as keyof typeof preflightAssertions,
        preflightAssertions[capability as keyof typeof preflightAssertions],
      );
    const rows = (
      await fixture.pool().query(
        `SELECT capability,assertion,preflight_method,completed_at::text AS completed_at
        FROM booking.affiliate_source_capability_production_preflights ORDER BY capability`,
      )
    ).rows;
    expect(
      rows.map(({ capability, assertion, preflight_method }) => ({
        capability,
        assertion,
        preflight_method,
      })),
    ).toEqual(
      Object.entries(preflightAssertions)
        .map(([capability, assertion]) => ({
          capability,
          assertion,
          preflight_method: "documented_authenticated_read",
        }))
        .sort((a, b) => a.capability.localeCompare(b.capability)),
    );
    expect(rows.every((row) => row.completed_at !== "infinity")).toBe(true);
  });

  it("rejects production assertion, capability, scope and evidence substitution", async () => {
    await expect(
      preflight(1, "reservation_lifecycle", "authenticated_stay_completion_read"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      preflight(2, "reservation_lifecycle", "authenticated_reservation_lifecycle_read", {
        capability: "referral_round_trip",
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      preflight(3, "reservation_lifecycle", "authenticated_reservation_lifecycle_read", {
        destination: id(31),
      }),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      preflight(4, "reservation_lifecycle", "authenticated_reservation_lifecycle_read", {
        fingerprint: "forged",
      }),
    ).rejects.toMatchObject({ code: "23514" });
    const fingerprint = "d".repeat(64);
    await preflight(5, "reservation_lifecycle", "authenticated_reservation_lifecycle_read", {
      fingerprint,
    });
    await expect(
      preflight(6, "stay_completion", "authenticated_stay_completion_read", { fingerprint }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("permanently revokes only the exact organization's preflight", async () => {
    await preflight(1, "stay_completion", "authenticated_stay_completion_read");
    await expect(
      fixture.pool().query(
        `INSERT INTO booking.affiliate_source_capability_preflight_revocations
        (preflight_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'wrong-scope')`,
        [id(401), id(1), id(7)],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_source_capability_preflight_revocations
      (preflight_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoke')`,
      [id(401), id(1), id(4)],
    );
    await expect(
      fixture.pool().query(
        `INSERT INTO booking.affiliate_source_capability_preflight_revocations
        (preflight_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'again')`,
        [id(401), id(1), id(4)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    for (const sql of [
      "UPDATE booking.affiliate_source_capability_production_preflights SET request_id='changed'",
      "DELETE FROM booking.affiliate_source_capability_preflight_revocations",
      "TRUNCATE booking.affiliate_source_capability_preflight_revocations",
    ])
      await expect(fixture.pool().query(sql)).rejects.toThrow();
  });
});
