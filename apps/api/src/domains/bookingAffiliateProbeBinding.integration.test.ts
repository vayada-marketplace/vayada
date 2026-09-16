import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import {
  context,
  databaseUrl,
  id,
  publicationCommandFixture,
} from "./affiliatePublicationCommandTestFixture.js";
import {
  bindCheckoutValidationProbe,
  resolveCheckoutValidationProbe,
  type AffiliateProbeCheckout,
} from "./bookingAffiliateProbeBinding.js";
import { manageAffiliateValidationProbe } from "./bookingAffiliateValidationProbe.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = async (name: string) => readFile(new URL(name, migrations), "utf8");
const deployment = {
  environment: "local" as const,
  connectionReference: "binding-test",
  adapterVersion: "native-v1",
};

describe.skipIf(!databaseUrl)("validation probe booking binding", () => {
  const fixture = publicationCommandFixture();

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
      .query("INSERT INTO booking.guest_bookings VALUES ($1,$2)", [id(40), id(3)]);
  });

  const createProbe = async (lifetimeSeconds = 3600) => {
    const result = await manageAffiliateValidationProbe(
      fixture.pool(),
      {
        context: context(),
        propertyId: id(3),
        destinationVersionId: id(30),
        action: "create",
        idempotencyKey: "binding-probe",
        lifetimeSeconds,
      },
      deployment,
    );
    if (!result.ok || !("probe" in result)) throw new Error("Probe creation failed");
    return result.probe;
  };

  const checkout = (probe: string): AffiliateProbeCheckout => ({
    ...deployment,
    probe,
    destinationVersionId: id(30),
    freshContext: async () => context(),
  });

  it("resolves with fresh authority and stores one immutable original binding", async () => {
    const probe = await createProbe();
    const client = await fixture.pool().connect();
    try {
      await client.query("BEGIN");
      const probeId = await resolveCheckoutValidationProbe(client, id(3), checkout(probe));
      await bindCheckoutValidationProbe(client, id(3), id(40), probeId, "binding-request");
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    expect(
      (
        await fixture
          .pool()
          .query(
            "SELECT booking_id,property_id,probe_id,request_id FROM booking.affiliate_validation_booking_bindings",
          )
      ).rows,
    ).toEqual([
      {
        booking_id: id(40),
        property_id: id(3),
        probe_id: probe.slice(4),
        request_id: "binding-request",
      },
    ]);
    await expect(
      fixture
        .pool()
        .query("UPDATE booking.affiliate_validation_booking_bindings SET request_id='changed'"),
    ).rejects.toThrow();
  });

  it("rechecks expiry immediately before binding and rolls the transaction back", async () => {
    const probe = await createProbe(1);
    const client = await fixture.pool().connect();
    try {
      await client.query("BEGIN");
      const probeId = await resolveCheckoutValidationProbe(client, id(3), checkout(probe));
      await client.query("SELECT pg_sleep(1.1)");
      await expect(
        bindCheckoutValidationProbe(client, id(3), id(40), probeId, "expired-binding"),
      ).rejects.toThrow("Validation probe expired before booking creation");
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(
      (
        await fixture
          .pool()
          .query("SELECT count(*)::int AS n FROM booking.affiliate_validation_booking_bindings")
      ).rows[0].n,
    ).toBe(0);
  });

  it("rejects stale authority, changed deployment and revoked probes", async () => {
    const probe = await createProbe();
    const client = await fixture.pool().connect();
    try {
      await client.query("BEGIN");
      const denied = checkout(probe);
      denied.freshContext = async () => ({ ...context(), entitlements: [] });
      await expect(resolveCheckoutValidationProbe(client, id(3), denied)).rejects.toThrow();
      await expect(
        resolveCheckoutValidationProbe(client, id(3), {
          ...checkout(probe),
          adapterVersion: "native-v2",
        }),
      ).rejects.toThrow("Validation probe is unavailable");
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    await manageAffiliateValidationProbe(
      fixture.pool(),
      {
        context: context(),
        propertyId: id(3),
        destinationVersionId: id(30),
        action: "revoke",
        probe,
      },
      deployment,
    );
    const retry = await fixture.pool().connect();
    try {
      await retry.query("BEGIN");
      await expect(resolveCheckoutValidationProbe(retry, id(3), checkout(probe))).rejects.toThrow(
        "Validation probe is unavailable",
      );
    } finally {
      await retry.query("ROLLBACK").catch(() => undefined);
      retry.release();
    }
  });
});
