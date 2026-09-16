import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  context,
  databaseUrl,
  id,
  publicationCommandFixture,
} from "./affiliatePublicationCommandTestFixture.js";
import {
  type AffiliateReferralProductionPreflightVerifier,
  verifyAffiliateReferralProductionPreflight,
} from "./bookingAffiliateReferralProductionPreflight.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = async (name: string) => readFile(new URL(name, migrations), "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!databaseUrl)("authorized referral production preflight", () => {
  const fixture = publicationCommandFixture();
  let returnedCorrelation = "";
  let verifyCalls = 0;
  let verifier: AffiliateReferralProductionPreflightVerifier;

  beforeEach(async () => {
    returnedCorrelation = "";
    verifyCalls = 0;
    verifier = {
      connectionReference: "hotel-live-connection",
      adapterVersion: "native-v1",
      timeoutMilliseconds: 1_000,
      async verifyNonMutatingReferralRoundTrip(input) {
        verifyCalls++;
        returnedCorrelation = input.correlationReference;
        return {
          ok: true,
          connectionReference: this.connectionReference,
          adapterVersion: this.adapterVersion,
          returnedCorrelationReference: input.correlationReference,
          evidenceReferences: ["provider:preflight:42", "transport:no-booking-created"],
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
      "0218_booking_affiliate_referral_production_preflights.sql",
      "0219_booking_affiliate_referral_production_preflight_commands.sql",
    ])
      await fixture.pool().query(await migration(name));
  });

  const input = () => ({
    context: context(),
    propertyId: id(3),
    destinationVersionId: id(30),
    idempotencyKey: "preflight-command",
  });

  async function preflightCount() {
    return (
      await fixture
        .pool()
        .query("SELECT count(*)::int AS n FROM booking.affiliate_referral_production_preflights")
    ).rows[0].n as number;
  }

  it("records exact server-generated non-mutating production evidence and safely replays", async () => {
    const created = await verifyAffiliateReferralProductionPreflight(
      fixture.pool(),
      input(),
      verifier,
    );
    expect(created).toMatchObject({ ok: true, replayed: false });
    expect(returnedCorrelation).toMatch(/^arp_[0-9a-f-]{36}$/);
    expect(
      await verifyAffiliateReferralProductionPreflight(fixture.pool(), input(), verifier),
    ).toEqual({ ...created, replayed: true });
    expect(verifyCalls).toBe(1);
    expect(await preflightCount()).toBe(1);
    expect(
      (
        await fixture.pool().query(
          `SELECT property_id,destination_version_id,organization_id,environment,
            connection_reference,adapter_version,capability,validation_kind,evidence_scope,
            preflight_method,assertion,correlation_hash,evidence_references,actor_id,request_id,
            command_key_hash,request_fingerprint_hash
          FROM booking.affiliate_referral_production_preflights`,
        )
      ).rows[0],
    ).toEqual({
      property_id: id(3),
      destination_version_id: id(30),
      organization_id: id(4),
      environment: "production",
      connection_reference: verifier.connectionReference,
      adapter_version: verifier.adapterVersion,
      capability: "referral_round_trip",
      validation_kind: "production_preflight",
      evidence_scope: "capability_validation",
      preflight_method: "documented_non_mutating_round_trip",
      assertion: "opaque_correlation_returned_without_booking",
      correlation_hash: hash(returnedCorrelation),
      evidence_references: ["provider:preflight:42", "transport:no-booking-created"],
      actor_id: id(1),
      request_id: "request-1",
      command_key_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      request_fingerprint_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      (await fixture.pool().query("SELECT count(*)::int AS n FROM booking.guest_bookings")).rows[0]
        .n,
    ).toBe(0);
  });

  it("reauthorizes hotel scope before invoking the provider", async () => {
    const unauthorized = input();
    unauthorized.context.linkedResources = [];
    await expect(
      verifyAffiliateReferralProductionPreflight(fixture.pool(), unauthorized, verifier),
    ).rejects.toThrow();
    expect(verifyCalls).toBe(0);

    expect(
      await verifyAffiliateReferralProductionPreflight(
        fixture.pool(),
        { ...input(), destinationVersionId: id(31) },
        verifier,
      ),
    ).toEqual({ ok: false, code: "scope_unavailable" });
    expect(verifyCalls).toBe(0);
    expect(await preflightCount()).toBe(0);
  });

  it("rejects retry reuse for changed exact provider configuration", async () => {
    await verifyAffiliateReferralProductionPreflight(fixture.pool(), input(), verifier);
    const changed = {
      ...verifier,
      adapterVersion: "native-v2",
      verifyNonMutatingReferralRoundTrip: vi.fn(verifier.verifyNonMutatingReferralRoundTrip),
    };
    expect(
      await verifyAffiliateReferralProductionPreflight(fixture.pool(), input(), changed),
    ).toEqual({ ok: false, code: "idempotency_conflict" });
    expect(changed.verifyNonMutatingReferralRoundTrip).not.toHaveBeenCalled();
    expect(await preflightCount()).toBe(1);
  });

  it("rejects unavailable, conflicting or malformed provider evidence", async () => {
    const cases: AffiliateReferralProductionPreflightVerifier[] = [
      {
        ...verifier,
        async verifyNonMutatingReferralRoundTrip() {
          return { ok: false, code: "capability_unavailable" };
        },
      },
      {
        ...verifier,
        async verifyNonMutatingReferralRoundTrip(input) {
          return {
            ok: true,
            connectionReference: this.connectionReference,
            adapterVersion: this.adapterVersion,
            returnedCorrelationReference: `${input.correlationReference}-changed`,
            evidenceReferences: ["provider:preflight:42"],
          };
        },
      },
      {
        ...verifier,
        async verifyNonMutatingReferralRoundTrip(input) {
          return {
            ok: true,
            connectionReference: "another-connection",
            adapterVersion: this.adapterVersion,
            returnedCorrelationReference: input.correlationReference,
            evidenceReferences: ["provider:preflight:42"],
          };
        },
      },
      {
        ...verifier,
        async verifyNonMutatingReferralRoundTrip(input) {
          return {
            ok: true,
            connectionReference: this.connectionReference,
            adapterVersion: this.adapterVersion,
            returnedCorrelationReference: input.correlationReference,
            evidenceReferences: [],
          };
        },
      },
    ];
    for (const [index, configured] of cases.entries()) {
      const result = await verifyAffiliateReferralProductionPreflight(
        fixture.pool(),
        { ...input(), idempotencyKey: `case-${index}` },
        configured,
      );
      expect(result).toEqual({
        ok: false,
        code: index === 0 ? "verification_unavailable" : "evidence_conflict",
      });
    }
    expect(await preflightCount()).toBe(0);
  });

  it("bounds the provider call and records nothing after timeout or failure", async () => {
    let aborted = false;
    const timeoutVerifier: AffiliateReferralProductionPreflightVerifier = {
      ...verifier,
      timeoutMilliseconds: 10,
      verifyNonMutatingReferralRoundTrip: ({ signal, correlationReference }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve({
                ok: true,
                connectionReference: "hotel-live-connection",
                adapterVersion: "native-v1",
                returnedCorrelationReference: correlationReference,
                evidenceReferences: ["late:success-must-not-win"],
              });
            },
            { once: true },
          );
        }),
    };
    expect(
      await verifyAffiliateReferralProductionPreflight(fixture.pool(), input(), timeoutVerifier),
    ).toEqual({ ok: false, code: "verification_unavailable" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborted).toBe(true);
    await expect(
      verifyAffiliateReferralProductionPreflight(fixture.pool(), input(), {
        ...verifier,
        async verifyNonMutatingReferralRoundTrip() {
          throw new Error("provider failed");
        },
      }),
    ).rejects.toThrow("provider failed");
    expect(await preflightCount()).toBe(0);
  });

  it("snapshots exact provider configuration across the in-flight check", async () => {
    let release!: () => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const mutable: AffiliateReferralProductionPreflightVerifier = {
      ...verifier,
      async verifyNonMutatingReferralRoundTrip(verification) {
        const connectionReference = this.connectionReference;
        const adapterVersion = this.adapterVersion;
        started();
        await gate;
        return {
          ok: true,
          connectionReference,
          adapterVersion,
          returnedCorrelationReference: verification.correlationReference,
          evidenceReferences: ["provider:snapshotted-configuration"],
        };
      },
    };
    const checking = verifyAffiliateReferralProductionPreflight(fixture.pool(), input(), mutable);
    await start;
    mutable.connectionReference = "changed-live-connection";
    mutable.adapterVersion = "native-v2";
    release();
    expect(await checking).toMatchObject({ ok: true, replayed: false });
    expect(
      (
        await fixture.pool().query(
          `SELECT connection_reference,adapter_version
          FROM booking.affiliate_referral_production_preflights`,
        )
      ).rows[0],
    ).toEqual({
      connection_reference: "hotel-live-connection",
      adapter_version: "native-v1",
    });
  });

  it("serializes concurrent retries so only one provider check runs", async () => {
    let release!: () => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const concurrent: AffiliateReferralProductionPreflightVerifier = {
      ...verifier,
      async verifyNonMutatingReferralRoundTrip(verification) {
        verifyCalls++;
        started();
        await gate;
        return {
          ok: true,
          connectionReference: this.connectionReference,
          adapterVersion: this.adapterVersion,
          returnedCorrelationReference: verification.correlationReference,
          evidenceReferences: ["provider:preflight:concurrent"],
        };
      },
    };
    const first = verifyAffiliateReferralProductionPreflight(fixture.pool(), input(), concurrent);
    await start;
    const second = verifyAffiliateReferralProductionPreflight(fixture.pool(), input(), concurrent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(verifyCalls).toBe(1);
    release();
    const results = await Promise.all([first, second]);
    expect(results).toEqual([
      expect.objectContaining({ ok: true, replayed: false }),
      expect.objectContaining({ ok: true, replayed: true }),
    ]);
    expect(verifyCalls).toBe(1);
    expect(await preflightCount()).toBe(1);
  });
});

describe.skipIf(!databaseUrl)("referral production preflight command identity upgrade", () => {
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

  it("preserves storage-only history while requiring complete command identity", async () => {
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_referral_production_preflights
      (id,property_id,destination_version_id,organization_id,connection_reference,
       adapter_version,correlation_hash,contract_version,evidence_references,actor_id,
       request_id,completed_at)
      VALUES($1,$2,$3,$4,'legacy-live','native-v1',$5,
       'booking-affiliate-referral-production-preflight.v1',$6,$7,'legacy','infinity')`,
      [id(60), id(3), id(30), id(4), "a".repeat(64), JSON.stringify(["legacy:evidence"]), id(1)],
    );
    await fixture
      .pool()
      .query(await migration("0219_booking_affiliate_referral_production_preflight_commands.sql"));
    expect(
      (
        await fixture.pool().query(
          `SELECT command_key_hash,request_fingerprint_hash
          FROM booking.affiliate_referral_production_preflights WHERE id=$1`,
          [id(60)],
        )
      ).rows[0],
    ).toEqual({ command_key_hash: null, request_fingerprint_hash: null });
    await expect(
      fixture.pool().query(
        `INSERT INTO booking.affiliate_referral_production_preflights
        (id,property_id,destination_version_id,organization_id,connection_reference,
         adapter_version,correlation_hash,contract_version,evidence_references,actor_id,
         request_id,completed_at,command_key_hash)
        VALUES($1,$2,$3,$4,'live','native-v1',$5,
         'booking-affiliate-referral-production-preflight.v1',$6,$7,'partial','infinity',$8)`,
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
