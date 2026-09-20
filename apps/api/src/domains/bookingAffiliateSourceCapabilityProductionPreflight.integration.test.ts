import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import {
  context,
  databaseUrl,
  id,
  publicationCommandFixture,
} from "./affiliatePublicationCommandTestFixture.js";
import {
  type AffiliateSourceCapability,
  type AffiliateSourceCapabilityProductionPreflightVerifier,
  affiliateSourceCapabilities,
  verifyAffiliateSourceCapabilityProductionPreflight,
} from "./bookingAffiliateSourceCapabilityProductionPreflight.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = async (name: string) => readFile(new URL(name, migrations), "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!databaseUrl)("authorized source-capability production preflight", () => {
  const fixture = publicationCommandFixture();
  let verifyCalls = 0;
  let verifier: AffiliateSourceCapabilityProductionPreflightVerifier;

  beforeEach(async () => {
    verifyCalls = 0;
    verifier = {
      connectionReference: "hotel-live-source",
      adapterVersion: "generic-pms-v1",
      timeoutMilliseconds: 1_000,
      async verifyAuthenticatedRead(input) {
        verifyCalls++;
        return {
          ok: true,
          connectionReference: this.connectionReference,
          adapterVersion: this.adapterVersion,
          verifiedCapability: input.capability,
          sourceEvidenceIdentity: `source-snapshot:${input.capability}:42`,
          evidenceReferences: [`provider:${input.capability}:42`],
        };
      },
    };
    await fixture.pool().query(`CREATE TABLE booking.guest_bookings(
      id UUID PRIMARY KEY, property_id UUID NOT NULL, UNIQUE(id,property_id)
    )`);
    for (const name of [
      "0212_booking_affiliate_validation_probes.sql",
      "0213_booking_affiliate_probe_bindings.sql",
      "0215_booking_affiliate_referral_transport_certifications.sql",
      "0220_booking_affiliate_source_capability_evidence.sql",
      "0221_booking_affiliate_source_capability_preflight_commands.sql",
    ])
      await fixture.pool().query(await migration(name));
  });

  const input = (
    capability: AffiliateSourceCapability,
    idempotencyKey = `check-${capability}`,
  ) => ({
    context: context(),
    propertyId: id(3),
    destinationVersionId: id(30),
    capability,
    idempotencyKey,
  });

  async function preflightCount() {
    return (
      await fixture
        .pool()
        .query(
          "SELECT count(*)::int AS n FROM booking.affiliate_source_capability_production_preflights",
        )
    ).rows[0].n as number;
  }

  it("records exact authenticated evidence for every capability and safely replays", async () => {
    for (const capability of affiliateSourceCapabilities) {
      const created = await verifyAffiliateSourceCapabilityProductionPreflight(
        fixture.pool(),
        input(capability),
        verifier,
      );
      expect(created).toMatchObject({ ok: true, replayed: false });
      expect(
        await verifyAffiliateSourceCapabilityProductionPreflight(
          fixture.pool(),
          input(capability),
          verifier,
        ),
      ).toEqual({ ...created, replayed: true });
    }
    expect(verifyCalls).toBe(3);
    expect(await preflightCount()).toBe(3);
    expect(
      (
        await fixture.pool().query(
          `SELECT capability,connection_reference,adapter_version,evidence_fingerprint_hash,
            command_key_hash,request_fingerprint_hash
          FROM booking.affiliate_source_capability_production_preflights ORDER BY capability`,
        )
      ).rows,
    ).toEqual(
      [...affiliateSourceCapabilities].sort().map((capability) => ({
        capability,
        connection_reference: verifier.connectionReference,
        adapter_version: verifier.adapterVersion,
        evidence_fingerprint_hash: hash(`source-snapshot:${capability}:42`),
        command_key_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        request_fingerprint_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      })),
    );
    expect(
      (await fixture.pool().query("SELECT count(*)::int AS n FROM booking.guest_bookings")).rows[0]
        .n,
    ).toBe(0);
  });

  it("reauthorizes exact hotel scope before invoking the adapter", async () => {
    const unauthorized = input("stay_completion");
    unauthorized.context.linkedResources = [];
    await expect(
      verifyAffiliateSourceCapabilityProductionPreflight(fixture.pool(), unauthorized, verifier),
    ).rejects.toThrow();
    expect(
      await verifyAffiliateSourceCapabilityProductionPreflight(
        fixture.pool(),
        { ...input("stay_completion"), destinationVersionId: id(31) },
        verifier,
      ),
    ).toEqual({ ok: false, code: "scope_unavailable" });
    expect(verifyCalls).toBe(0);
  });

  it("binds a retry to the exact capability and provider configuration", async () => {
    await verifyAffiliateSourceCapabilityProductionPreflight(
      fixture.pool(),
      input("reservation_lifecycle", "same-key"),
      verifier,
    );
    expect(
      await verifyAffiliateSourceCapabilityProductionPreflight(
        fixture.pool(),
        input("stay_completion", "same-key"),
        verifier,
      ),
    ).toEqual({ ok: false, code: "idempotency_conflict" });
    expect(
      await verifyAffiliateSourceCapabilityProductionPreflight(
        fixture.pool(),
        input("reservation_lifecycle", "same-key"),
        { ...verifier, adapterVersion: "generic-pms-v2" },
      ),
    ).toEqual({ ok: false, code: "idempotency_conflict" });
    expect(verifyCalls).toBe(1);
  });

  it("rejects unavailable, mismatched and malformed adapter evidence", async () => {
    const cases: AffiliateSourceCapabilityProductionPreflightVerifier[] = [
      {
        ...verifier,
        async verifyAuthenticatedRead() {
          return { ok: false, code: "capability_unavailable" };
        },
      },
      {
        ...verifier,
        async verifyAuthenticatedRead(input) {
          return {
            ok: true,
            connectionReference: this.connectionReference,
            adapterVersion: this.adapterVersion,
            verifiedCapability: "stay_completion",
            sourceEvidenceIdentity: `source:${input.capability}`,
            evidenceReferences: ["provider:evidence"],
          };
        },
      },
      {
        ...verifier,
        async verifyAuthenticatedRead(input) {
          return {
            ok: true,
            connectionReference: "another-connection",
            adapterVersion: this.adapterVersion,
            verifiedCapability: input.capability,
            sourceEvidenceIdentity: "source:evidence",
            evidenceReferences: ["provider:evidence"],
          };
        },
      },
      {
        ...verifier,
        async verifyAuthenticatedRead(input) {
          return {
            ok: true,
            connectionReference: this.connectionReference,
            adapterVersion: this.adapterVersion,
            verifiedCapability: input.capability,
            sourceEvidenceIdentity: " ",
            evidenceReferences: [],
          };
        },
      },
    ];
    for (const [index, configured] of cases.entries())
      expect(
        await verifyAffiliateSourceCapabilityProductionPreflight(
          fixture.pool(),
          input("reservation_lifecycle", `case-${index}`),
          configured,
        ),
      ).toEqual({
        ok: false,
        code: index === 0 ? "verification_unavailable" : "evidence_conflict",
      });
    expect(await preflightCount()).toBe(0);
  });

  it("prevents one source snapshot from proving another capability", async () => {
    const shared: AffiliateSourceCapabilityProductionPreflightVerifier = {
      ...verifier,
      async verifyAuthenticatedRead(input) {
        return {
          ok: true,
          connectionReference: this.connectionReference,
          adapterVersion: this.adapterVersion,
          verifiedCapability: input.capability,
          sourceEvidenceIdentity: "one-provider-snapshot",
          evidenceReferences: ["provider:snapshot:shared"],
        };
      },
    };
    expect(
      await verifyAffiliateSourceCapabilityProductionPreflight(
        fixture.pool(),
        input("reservation_lifecycle"),
        shared,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await verifyAffiliateSourceCapabilityProductionPreflight(
        fixture.pool(),
        input("stay_completion"),
        shared,
      ),
    ).toEqual({ ok: false, code: "evidence_conflict" });
    expect(await preflightCount()).toBe(1);
  });

  it("bounds and serializes adapter calls", async () => {
    let release!: () => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const concurrent: AffiliateSourceCapabilityProductionPreflightVerifier = {
      ...verifier,
      async verifyAuthenticatedRead(input) {
        verifyCalls++;
        started();
        await gate;
        return {
          ok: true,
          connectionReference: this.connectionReference,
          adapterVersion: this.adapterVersion,
          verifiedCapability: input.capability,
          sourceEvidenceIdentity: "concurrent-source-snapshot",
          evidenceReferences: ["provider:concurrent"],
        };
      },
    };
    const first = verifyAffiliateSourceCapabilityProductionPreflight(
      fixture.pool(),
      input("accommodation_revenue"),
      concurrent,
    );
    await start;
    const second = verifyAffiliateSourceCapabilityProductionPreflight(
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

    expect(
      await verifyAffiliateSourceCapabilityProductionPreflight(
        fixture.pool(),
        { ...input("stay_completion"), idempotencyKey: "timeout" },
        {
          ...verifier,
          timeoutMilliseconds: 5,
          verifyAuthenticatedRead: ({ signal }) =>
            new Promise((resolve) =>
              signal.addEventListener(
                "abort",
                () => resolve({ ok: false, code: "connection_unavailable" }),
                { once: true },
              ),
            ),
        },
      ),
    ).toEqual({ ok: false, code: "verification_unavailable" });
  });
});

describe.skipIf(!databaseUrl)("source-capability preflight command identity upgrade", () => {
  const fixture = publicationCommandFixture();

  beforeEach(async () => {
    await fixture.pool().query(`CREATE TABLE booking.guest_bookings(
      id UUID PRIMARY KEY, property_id UUID NOT NULL, UNIQUE(id,property_id)
    )`);
    for (const name of [
      "0212_booking_affiliate_validation_probes.sql",
      "0213_booking_affiliate_probe_bindings.sql",
      "0215_booking_affiliate_referral_transport_certifications.sql",
      "0220_booking_affiliate_source_capability_evidence.sql",
    ])
      await fixture.pool().query(await migration(name));
  });

  it("preserves storage-only history and rejects partial command identity", async () => {
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_source_capability_production_preflights
      (id,property_id,destination_version_id,organization_id,connection_reference,
       adapter_version,capability,assertion,evidence_fingerprint_hash,contract_version,
       evidence_references,actor_id,request_id,completed_at)
      VALUES($1,$2,$3,$4,'legacy-live','generic-pms-v1','stay_completion',
       'authenticated_stay_completion_read',$5,
       'booking-affiliate-source-capability-production-preflight.v1',$6,$7,'legacy','infinity')`,
      [id(60), id(3), id(30), id(4), "a".repeat(64), JSON.stringify(["legacy"]), id(1)],
    );
    await fixture
      .pool()
      .query(await migration("0221_booking_affiliate_source_capability_preflight_commands.sql"));
    expect(
      (
        await fixture.pool().query(
          `SELECT command_key_hash,request_fingerprint_hash
          FROM booking.affiliate_source_capability_production_preflights WHERE id=$1`,
          [id(60)],
        )
      ).rows[0],
    ).toEqual({ command_key_hash: null, request_fingerprint_hash: null });
    await expect(
      fixture.pool().query(
        `INSERT INTO booking.affiliate_source_capability_production_preflights
        (id,property_id,destination_version_id,organization_id,connection_reference,
         adapter_version,capability,assertion,evidence_fingerprint_hash,contract_version,
         evidence_references,actor_id,request_id,completed_at,command_key_hash)
        VALUES($1,$2,$3,$4,'live','generic-pms-v1','stay_completion',
         'authenticated_stay_completion_read',$5,
         'booking-affiliate-source-capability-production-preflight.v1',$6,$7,'partial',
         'infinity',$8)`,
        [
          id(61),
          id(3),
          id(30),
          id(4),
          "b".repeat(64),
          JSON.stringify(["provider:evidence"]),
          id(1),
          "c".repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
