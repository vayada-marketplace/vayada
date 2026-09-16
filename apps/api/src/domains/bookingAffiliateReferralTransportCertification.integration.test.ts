import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import {
  context,
  databaseUrl,
  id,
  publicationCommandFixture,
} from "./affiliatePublicationCommandTestFixture.js";
import {
  certifyAffiliateReferralTransport,
  type AffiliateReferralTransportCertificationVerifier,
} from "./bookingAffiliateReferralTransportCertification.js";
import { manageAffiliateValidationProbe } from "./bookingAffiliateValidationProbe.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = async (name: string) => readFile(new URL(name, migrations), "utf8");
const verifier: AffiliateReferralTransportCertificationVerifier = {
  environment: "sandbox",
  connectionReference: "referral-certifier",
  adapterVersion: "native-v1",
  evidenceReferences: ["binding:verified", "browser:no-storage"],
};

describe.skipIf(!databaseUrl)("authorized referral transport certification", () => {
  const fixture = publicationCommandFixture();
  const bookingId = id(40);
  let probe: string;

  beforeEach(async () => {
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
    ])
      await fixture.pool().query(await migration(name));
    const issued = await manageAffiliateValidationProbe(
      fixture.pool(),
      {
        context: context(),
        propertyId: id(3),
        destinationVersionId: id(30),
        action: "create",
        idempotencyKey: "certifier",
        lifetimeSeconds: 3600,
      },
      verifier,
    );
    if (!issued.ok || !("probe" in issued)) throw new Error("Probe creation failed");
    probe = issued.probe;
    await fixture.pool().query(
      `INSERT INTO booking.guest_bookings
      (id,property_id,lifecycle_status,total_amount,balance_amount,booking_metadata)
      VALUES($1,$2,'draft',0,0,$3)`,
      [bookingId, id(3), { isTestBooking: true, purpose: "affiliate_validation" }],
    );
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_booking_bindings
      (booking_id,property_id,probe_id,request_id) VALUES($1,$2,$3,'transport')`,
      [bookingId, id(3), probe.slice(4)],
    );
  });

  const input = () => ({
    context: context(),
    propertyId: id(3),
    destinationVersionId: id(30),
    probe,
  });

  async function certificationCount() {
    return (
      await fixture
        .pool()
        .query("SELECT count(*)::int AS n FROM booking.affiliate_referral_transport_certifications")
    ).rows[0].n as number;
  }

  it("certifies the exact synthetic delivery once and safely replays", async () => {
    const created = await certifyAffiliateReferralTransport(fixture.pool(), input(), verifier);
    expect(created).toMatchObject({ ok: true, bookingId, replayed: false });
    expect(await certifyAffiliateReferralTransport(fixture.pool(), input(), verifier)).toEqual({
      ...created,
      replayed: true,
    });
    expect(await certificationCount()).toBe(1);
    expect(
      (
        await fixture.pool().query(
          `SELECT property_id,destination_version_id,organization_id,environment,
            connection_reference,adapter_version,capability,validation_kind,evidence_scope,
            evidence_references,actor_id,request_id
          FROM booking.affiliate_referral_transport_certifications`,
        )
      ).rows[0],
    ).toEqual({
      property_id: id(3),
      destination_version_id: id(30),
      organization_id: id(4),
      environment: "sandbox",
      connection_reference: verifier.connectionReference,
      adapter_version: verifier.adapterVersion,
      capability: "referral_round_trip",
      validation_kind: "adapter_certification",
      evidence_scope: "capability_validation",
      evidence_references: verifier.evidenceReferences,
      actor_id: id(1),
      request_id: "request-1",
    });
  });

  it("reauthorizes context and persisted hotel scope before every write or replay", async () => {
    const unauthorized = input();
    unauthorized.context.linkedResources = [];
    await expect(
      certifyAffiliateReferralTransport(fixture.pool(), unauthorized, verifier),
    ).rejects.toThrow();
    expect(await certificationCount()).toBe(0);

    await certifyAffiliateReferralTransport(fixture.pool(), input(), verifier);
    await fixture
      .pool()
      .query("UPDATE identity.organization_resource_links SET status='inactive' WHERE id=$1", [
        id(90),
      ]);
    expect(await certifyAffiliateReferralTransport(fixture.pool(), input(), verifier)).toEqual({
      ok: false,
      code: "scope_unavailable",
    });
    expect(await certificationCount()).toBe(1);
  });

  it("requires the current probe and server deployment configuration", async () => {
    for (const configured of [
      { ...verifier, environment: "local" as const },
      { ...verifier, connectionReference: "other" },
      { ...verifier, adapterVersion: "native-v2" },
    ])
      expect(await certifyAffiliateReferralTransport(fixture.pool(), input(), configured)).toEqual({
        ok: false,
        code: "probe_unavailable",
      });
    expect(
      await certifyAffiliateReferralTransport(
        fixture.pool(),
        { ...input(), probe: `avp_${id(41)}` },
        verifier,
      ),
    ).toEqual({ ok: false, code: "probe_unavailable" });
    expect(await certificationCount()).toBe(0);
  });

  it("rejects a revoked probe", async () => {
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_probe_revocations
      (probe_id,actor_id,organization_id,request_id) VALUES($1,$2,$3,'revoked')`,
      [probe.slice(4), id(1), id(4)],
    );
    expect(await certifyAffiliateReferralTransport(fixture.pool(), input(), verifier)).toEqual({
      ok: false,
      code: "probe_unavailable",
    });
    expect(await certificationCount()).toBe(0);
  });

  it("requires a zero-value isolated booking and permanently excludes Finance", async () => {
    for (const update of [
      "lifecycle_status='confirmed'",
      "total_amount=1",
      `booking_metadata='{"isTestBooking":true,"purpose":"other"}'::jsonb`,
    ]) {
      await fixture
        .pool()
        .query(`UPDATE booking.guest_bookings SET ${update} WHERE id=$1`, [bookingId]);
      expect(await certifyAffiliateReferralTransport(fixture.pool(), input(), verifier)).toEqual({
        ok: false,
        code: "transport_unavailable",
      });
      await fixture.pool().query(
        `UPDATE booking.guest_bookings SET lifecycle_status='draft',total_amount=0,
          booking_metadata=$2 WHERE id=$1`,
        [bookingId, { isTestBooking: true, purpose: "affiliate_validation" }],
      );
    }
    await certifyAffiliateReferralTransport(fixture.pool(), input(), verifier);
    await expect(insertEarning(id(61), bookingId)).rejects.toMatchObject({ code: "23514" });
    await expect(insertEarning(id(62), bookingId.replaceAll("-", ""))).rejects.toMatchObject({
      code: "23514",
    });
    expect(await certificationCount()).toBe(1);
  });

  it("rejects a binding when compact UUID Finance evidence already exists", async () => {
    const blockedProbe = await issueProbe("finance-first");
    const blockedBookingId = id(41);
    await fixture.pool().query(
      `INSERT INTO booking.guest_bookings
      (id,property_id,lifecycle_status,total_amount,balance_amount,booking_metadata)
      VALUES($1,$2,'draft',0,0,$3)`,
      [blockedBookingId, id(3), { isTestBooking: true, purpose: "affiliate_validation" }],
    );
    await insertEarning(id(62), blockedBookingId.replaceAll("-", ""));
    await expect(
      fixture.pool().query(
        `INSERT INTO booking.affiliate_validation_booking_bindings
        (booking_id,property_id,probe_id,request_id) VALUES($1,$2,$3,'blocked-binding')`,
        [blockedBookingId, id(3), blockedProbe.slice(4)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("serializes a concurrent binding ahead of Finance earning insertion", async () => {
    const racedProbe = await issueProbe("finance-race");
    const racedBookingId = id(41);
    await fixture.pool().query(
      `INSERT INTO booking.guest_bookings
      (id,property_id,lifecycle_status,total_amount,balance_amount,booking_metadata)
      VALUES($1,$2,'draft',0,0,$3)`,
      [racedBookingId, id(3), { isTestBooking: true, purpose: "affiliate_validation" }],
    );
    const bindingClient = await fixture.pool().connect();
    const financeClient = await fixture.pool().connect();
    try {
      const financePid = (await financeClient.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      await bindingClient.query("BEGIN");
      await bindingClient.query(
        `INSERT INTO booking.affiliate_validation_booking_bindings
        (booking_id,property_id,probe_id,request_id) VALUES($1,$2,$3,'race-binding')`,
        [racedBookingId, id(3), racedProbe.slice(4)],
      );
      const earning = financeClient
        .query(earningInsert, [
          id(62),
          id(3),
          racedBookingId.replaceAll("-", ""),
          "0".repeat(64),
          id(1),
          id(4),
        ])
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await fixture.pool().query(
          `SELECT 1 FROM pg_stat_activity
          WHERE pid=$1 AND wait_event_type='Lock'`,
          [financePid],
        );
        if (waiting.rowCount) break;
        if (attempt === 99) throw new Error("Finance insert did not wait for binding lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await bindingClient.query("COMMIT");
      const outcome = await earning;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Expected Finance exclusion");
      expect(outcome.error).toMatchObject({ code: "23514" });
    } finally {
      await bindingClient.query("ROLLBACK").catch(() => undefined);
      bindingClient.release();
      financeClient.release();
    }
  });

  it("maps final database expiry recheck to probe unavailable", async () => {
    const expiringProbe = await issueProbe("expiring", 3);
    const expiringBookingId = id(41);
    await fixture.pool().query(
      `INSERT INTO booking.guest_bookings
      (id,property_id,lifecycle_status,total_amount,balance_amount,booking_metadata)
      VALUES($1,$2,'draft',0,0,$3)`,
      [expiringBookingId, id(3), { isTestBooking: true, purpose: "affiliate_validation" }],
    );
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_booking_bindings
      (booking_id,property_id,probe_id,request_id) VALUES($1,$2,$3,'expiring-binding')`,
      [expiringBookingId, id(3), expiringProbe.slice(4)],
    );
    await fixture.pool().query(`CREATE SEQUENCE booking.certification_delay_seen;
      CREATE FUNCTION booking.delay_certification_test()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM nextval('booking.certification_delay_seen');
        PERFORM pg_sleep(3.1);
        RETURN NEW;
      END $$;
      CREATE TRIGGER aaa_delay_certification_test
      BEFORE INSERT ON booking.affiliate_referral_transport_certifications
      FOR EACH ROW EXECUTE FUNCTION booking.delay_certification_test()`);
    expect(
      await certifyAffiliateReferralTransport(
        fixture.pool(),
        { ...input(), probe: expiringProbe },
        verifier,
      ),
    ).toEqual({ ok: false, code: "probe_unavailable" });
    expect(
      (await fixture.pool().query("SELECT is_called FROM booking.certification_delay_seen")).rows[0]
        .is_called,
    ).toBe(true);
    expect(await certificationCount()).toBe(0);
  });

  it("does not replace prior server evidence on replay", async () => {
    await certifyAffiliateReferralTransport(fixture.pool(), input(), verifier);
    expect(
      await certifyAffiliateReferralTransport(fixture.pool(), input(), {
        ...verifier,
        evidenceReferences: ["binding:different"],
      }),
    ).toEqual({ ok: false, code: "certification_conflict" });
    expect(await certificationCount()).toBe(1);
  });

  it.each([
    { probe: "forged" },
    { destinationVersionId: "invalid" },
    { verifier: { ...verifier, evidenceReferences: [] } },
    { verifier: { ...verifier, evidenceReferences: ["\t"] } },
    { verifier: { ...verifier, connectionReference: " " } },
  ])("rejects malformed input %#", async (change) => {
    expect(
      await certifyAffiliateReferralTransport(
        fixture.pool(),
        { ...input(), ...change },
        change.verifier ?? verifier,
      ),
    ).toEqual({ ok: false, code: "invalid_request" });
    expect(await certificationCount()).toBe(0);
  });

  async function issueProbe(key: string, lifetimeSeconds = 3600) {
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

  const earningInsert = `INSERT INTO finance.affiliate_earning_journal
    (id,property_id,booking_id,stay_item_id,revision,source_revision,input_digest,
     calculation_input,outcome,actor_user_id,organization_id,request_id)
    VALUES($1,$2,$3,'synthetic',1,1,$4,'{}','{"status":"pending"}',$5,$6,'forged')`;
  const insertEarning = (earningId: string, earningBookingId: string) =>
    fixture
      .pool()
      .query(earningInsert, [earningId, id(3), earningBookingId, "0".repeat(64), id(1), id(4)]);
});

describe.skipIf(!databaseUrl)("referral transport certification Finance exclusion upgrade", () => {
  const fixture = publicationCommandFixture();

  it("sees historical compact-UUID Finance evidence after the exclusion migration", async () => {
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
    ])
      await fixture.pool().query(await migration(name));
    const issued = await manageAffiliateValidationProbe(
      fixture.pool(),
      {
        context: context(),
        propertyId: id(3),
        destinationVersionId: id(30),
        action: "create",
        idempotencyKey: "historical-finance-conflict",
        lifetimeSeconds: 3600,
      },
      verifier,
    );
    if (!issued.ok || !("probe" in issued)) throw new Error("Probe creation failed");
    const historicalBookingId = id(40);
    await fixture.pool().query(
      `INSERT INTO booking.guest_bookings
      (id,property_id,lifecycle_status,total_amount,balance_amount,booking_metadata)
      VALUES($1,$2,'draft',0,0,$3)`,
      [historicalBookingId, id(3), { isTestBooking: true, purpose: "affiliate_validation" }],
    );
    await fixture.pool().query(
      `INSERT INTO booking.affiliate_validation_booking_bindings
      (booking_id,property_id,probe_id,request_id) VALUES($1,$2,$3,'historical-binding')`,
      [historicalBookingId, id(3), issued.probe.slice(4)],
    );
    await fixture.pool().query(
      `INSERT INTO finance.affiliate_earning_journal
      (id,property_id,booking_id,stay_item_id,revision,source_revision,input_digest,
       calculation_input,outcome,actor_user_id,organization_id,request_id)
      VALUES($1,$2,$3,'synthetic',1,1,$4,'{}','{"status":"pending"}',$5,$6,'historical')`,
      [id(61), id(3), historicalBookingId.replaceAll("-", ""), "0".repeat(64), id(1), id(4)],
    );
    await fixture.pool().query(await migration("0217_affiliate_validation_finance_exclusion.sql"));

    expect(
      await certifyAffiliateReferralTransport(
        fixture.pool(),
        {
          context: context(),
          propertyId: id(3),
          destinationVersionId: id(30),
          probe: issued.probe,
        },
        verifier,
      ),
    ).toEqual({ ok: false, code: "transport_unavailable" });
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
});
