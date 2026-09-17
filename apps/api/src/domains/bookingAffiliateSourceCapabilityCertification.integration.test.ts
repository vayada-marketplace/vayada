import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import {
  context,
  databaseUrl,
  id,
  publicationCommandFixture,
} from "./affiliatePublicationCommandTestFixture.js";
import {
  certifyAffiliateSourceCapability,
  type AffiliateSourceCapabilityCertificationVerifier,
} from "./bookingAffiliateSourceCapabilityCertification.js";
import {
  affiliateSourceCapabilities,
  type AffiliateSourceCapability,
} from "./bookingAffiliateSourceCapabilityProductionPreflight.js";
import { manageAffiliateValidationProbe } from "./bookingAffiliateValidationProbe.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = async (name: string) => readFile(new URL(name, migrations), "utf8");

describe.skipIf(!databaseUrl)("authorized source-capability certification", () => {
  const fixture = publicationCommandFixture();
  const bookingId = id(40);
  let probe: string;
  let verifyCalls = 0;
  let verifier: AffiliateSourceCapabilityCertificationVerifier;

  beforeEach(async () => {
    verifyCalls = 0;
    verifier = {
      environment: "sandbox",
      connectionReference: "source-certifier",
      adapterVersion: "generic-pms-v1",
      timeoutMilliseconds: 1_000,
      async verifySyntheticCapability(input) {
        verifyCalls++;
        return {
          ok: true,
          connectionReference: this.connectionReference,
          adapterVersion: this.adapterVersion,
          verifiedCapability: input.capability,
          verifiedBookingId: input.bookingId,
          evidenceReferences: [`synthetic:${input.capability}:observed`],
        };
      },
    };
    await fixture.pool().query(`CREATE TABLE booking.guest_bookings(
      id UUID PRIMARY KEY,
      property_id UUID NOT NULL,
      lifecycle_status TEXT NOT NULL,
      total_amount NUMERIC(15,2) NOT NULL,
      balance_amount NUMERIC(15,2) NOT NULL,
      booking_metadata JSONB NOT NULL,
      UNIQUE(id,property_id)
    )`);
    for (const name of [
      "0195_finance_affiliate_earning_journal.sql",
      "0212_booking_affiliate_validation_probes.sql",
      "0213_booking_affiliate_probe_bindings.sql",
      "0215_booking_affiliate_referral_transport_certifications.sql",
      "0217_affiliate_validation_finance_exclusion.sql",
      "0220_booking_affiliate_source_capability_evidence.sql",
    ])
      await fixture.pool().query(await migration(name));
    probe = await issueProbe("source-certifier", 3600);
    await bindFixture(probe, bookingId);
  });

  const input = (capability: AffiliateSourceCapability) => ({
    context: context(),
    propertyId: id(3),
    destinationVersionId: id(30),
    probe,
    capability,
  });

  async function issueProbe(key: string, lifetimeSeconds: number) {
    const issued = await manageAffiliateValidationProbe(
      fixture.pool(),
      {
        context: context(),
        propertyId: id(3),
        destinationVersionId: id(30),
        action: "create",
        idempotencyKey: key,
        lifetimeSeconds,
      },
      verifier,
    );
    if (!issued.ok || !("probe" in issued)) throw new Error("Probe creation failed");
    return issued.probe;
  }

  async function bindFixture(targetProbe: string, targetBooking: string) {
    await fixture.pool().query(
      `INSERT INTO booking.guest_bookings
      (id,property_id,lifecycle_status,total_amount,balance_amount,booking_metadata)
      VALUES($1,$2,'completed',100,0,$3)`,
      [targetBooking, id(3), { isTestBooking: true, purpose: "affiliate_validation" }],
    );
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_booking_bindings
      (booking_id,property_id,probe_id,request_id) VALUES($1,$2,$3,'source-fixture')`,
      [targetBooking, id(3), targetProbe.slice(4)],
    );
  }

  async function certificationCount() {
    return (
      await fixture
        .pool()
        .query("SELECT count(*)::int AS n FROM booking.affiliate_source_capability_certifications")
    ).rows[0].n as number;
  }

  it("certifies every capability against the exact synthetic fixture and safely replays", async () => {
    for (const capability of affiliateSourceCapabilities) {
      const created = await certifyAffiliateSourceCapability(
        fixture.pool(),
        input(capability),
        verifier,
      );
      expect(created).toMatchObject({ ok: true, bookingId, replayed: false });
      expect(
        await certifyAffiliateSourceCapability(fixture.pool(), input(capability), verifier),
      ).toEqual({ ...created, replayed: true });
    }
    expect(verifyCalls).toBe(3);
    expect(await certificationCount()).toBe(3);
    expect(
      (
        await fixture.pool().query(
          `SELECT capability,property_id,destination_version_id,organization_id,environment,
            connection_reference,adapter_version,validation_method,evidence_references
          FROM booking.affiliate_source_capability_certifications ORDER BY capability`,
        )
      ).rows,
    ).toEqual(
      [...affiliateSourceCapabilities].sort().map((capability) => ({
        capability,
        property_id: id(3),
        destination_version_id: id(30),
        organization_id: id(4),
        environment: "sandbox",
        connection_reference: verifier.connectionReference,
        adapter_version: verifier.adapterVersion,
        validation_method: "isolated_synthetic_fixture",
        evidence_references: [`synthetic:${capability}:observed`],
      })),
    );
    expect(
      (
        await fixture
          .pool()
          .query("SELECT count(*)::int AS n FROM finance.affiliate_earning_journal")
      ).rows[0].n,
    ).toBe(0);
  });

  it("reauthorizes exact scope and current deployment before verification or replay", async () => {
    const unauthorized = input("stay_completion");
    unauthorized.context.linkedResources = [];
    await expect(
      certifyAffiliateSourceCapability(fixture.pool(), unauthorized, verifier),
    ).rejects.toThrow();
    for (const configured of [
      { ...verifier, environment: "local" as const },
      { ...verifier, connectionReference: "other" },
      { ...verifier, adapterVersion: "generic-pms-v2" },
    ])
      expect(
        await certifyAffiliateSourceCapability(
          fixture.pool(),
          input("stay_completion"),
          configured,
        ),
      ).toEqual({ ok: false, code: "probe_unavailable" });
    expect(verifyCalls).toBe(0);
  });

  it("rejects revoked probes and bookings outside the diagnostic fixture boundary", async () => {
    await fixture
      .pool()
      .query("UPDATE booking.guest_bookings SET booking_metadata='{}'::jsonb WHERE id=$1", [
        bookingId,
      ]);
    expect(
      await certifyAffiliateSourceCapability(
        fixture.pool(),
        input("reservation_lifecycle"),
        verifier,
      ),
    ).toEqual({ ok: false, code: "fixture_unavailable" });
    await fixture
      .pool()
      .query("UPDATE booking.guest_bookings SET booking_metadata=$2 WHERE id=$1", [
        bookingId,
        { isTestBooking: true, purpose: "affiliate_validation" },
      ]);
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_probe_revocations
      (probe_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoked')`,
      [probe.slice(4), id(1), id(4)],
    );
    expect(
      await certifyAffiliateSourceCapability(fixture.pool(), input("stay_completion"), verifier),
    ).toEqual({ ok: false, code: "probe_unavailable" });
    expect(verifyCalls).toBe(0);
  });

  it("rejects unavailable, mismatched and malformed verifier evidence", async () => {
    expect(
      await certifyAffiliateSourceCapability(fixture.pool(), input("reservation_lifecycle"), {
        ...verifier,
        async verifySyntheticCapability() {
          throw new Error("provider unavailable");
        },
      }),
    ).toEqual({ ok: false, code: "verification_unavailable" });

    const cases: AffiliateSourceCapabilityCertificationVerifier[] = [
      {
        ...verifier,
        async verifySyntheticCapability() {
          return { ok: false, code: "capability_unavailable" };
        },
      },
      {
        ...verifier,
        async verifySyntheticCapability(value) {
          return {
            ok: true,
            connectionReference: this.connectionReference,
            adapterVersion: this.adapterVersion,
            verifiedCapability: "stay_completion",
            verifiedBookingId: value.bookingId,
            evidenceReferences: ["synthetic:mismatch"],
          };
        },
      },
      {
        ...verifier,
        async verifySyntheticCapability(value) {
          return {
            ok: true,
            connectionReference: this.connectionReference,
            adapterVersion: this.adapterVersion,
            verifiedCapability: value.capability,
            verifiedBookingId: id(41),
            evidenceReferences: ["synthetic:wrong-booking"],
          };
        },
      },
      {
        ...verifier,
        async verifySyntheticCapability(value) {
          return {
            ok: true,
            connectionReference: "another-connection",
            adapterVersion: this.adapterVersion,
            verifiedCapability: value.capability,
            verifiedBookingId: value.bookingId,
            evidenceReferences: [],
          };
        },
      },
    ];
    for (const configured of cases)
      expect(
        await certifyAffiliateSourceCapability(
          fixture.pool(),
          input("reservation_lifecycle"),
          configured,
        ),
      ).toEqual({
        ok: false,
        code: configured === cases[0] ? "verification_unavailable" : "evidence_conflict",
      });
    expect(await certificationCount()).toBe(0);
  });

  it("bounds verifier calls and serializes concurrent retries", async () => {
    let release!: () => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const concurrent: AffiliateSourceCapabilityCertificationVerifier = {
      ...verifier,
      async verifySyntheticCapability(value) {
        verifyCalls++;
        started();
        await gate;
        return {
          ok: true,
          connectionReference: this.connectionReference,
          adapterVersion: this.adapterVersion,
          verifiedCapability: value.capability,
          verifiedBookingId: value.bookingId,
          evidenceReferences: ["synthetic:concurrent"],
        };
      },
    };
    const first = certifyAffiliateSourceCapability(
      fixture.pool(),
      input("accommodation_revenue"),
      concurrent,
    );
    await start;
    const second = certifyAffiliateSourceCapability(
      fixture.pool(),
      input("accommodation_revenue"),
      concurrent,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(verifyCalls).toBe(1);
    release();
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ ok: true, replayed: false }),
      expect.objectContaining({ ok: true, replayed: true }),
    ]);

    let lateVerifierSettled = false;
    expect(
      await certifyAffiliateSourceCapability(fixture.pool(), input("stay_completion"), {
        ...verifier,
        timeoutMilliseconds: 5,
        async verifySyntheticCapability(value) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          lateVerifierSettled = true;
          return {
            ok: true,
            connectionReference: this.connectionReference,
            adapterVersion: this.adapterVersion,
            verifiedCapability: value.capability,
            verifiedBookingId: value.bookingId,
            evidenceReferences: ["synthetic:late"],
          };
        },
      }),
    ).toEqual({ ok: false, code: "verification_unavailable" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(lateVerifierSettled).toBe(true);
    expect(await certificationCount()).toBe(1);
  });

  it("rejects a probe that expires during verification", async () => {
    const expiringProbe = await issueProbe("expiring-source", 1);
    await bindFixture(expiringProbe, id(41));
    expect(
      await certifyAffiliateSourceCapability(
        fixture.pool(),
        { ...input("stay_completion"), probe: expiringProbe },
        {
          ...verifier,
          timeoutMilliseconds: 2_000,
          async verifySyntheticCapability(value) {
            await new Promise((resolve) => setTimeout(resolve, 1_100));
            return {
              ok: true,
              connectionReference: this.connectionReference,
              adapterVersion: this.adapterVersion,
              verifiedCapability: value.capability,
              verifiedBookingId: value.bookingId,
              evidenceReferences: ["synthetic:expired"],
            };
          },
        },
      ),
    ).toEqual({ ok: false, code: "probe_unavailable" });
  });
});
