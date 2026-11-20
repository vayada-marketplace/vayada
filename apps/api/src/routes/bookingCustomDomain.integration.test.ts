import pg, { type QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTargetBookingCustomDomainRepository,
  type BookingCustomDomainPool,
} from "./bookingCustomDomain.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const propertyId = "25680000-0000-4000-8000-000000000001";
const hostname = "booking.vay2568.example";

describe.skipIf(!TEST_DATABASE_URL)("booking custom-domain checks in PostgreSQL (VAY-2568)", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const pool: BookingCustomDomainPool = {
    async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
      return (await admin.query(text, values as unknown[])) as { rows: T[] };
    },
    async end() {},
  };
  const repository = createTargetBookingCustomDomainRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    pool,
  });
  const domainRow = async () =>
    (
      await admin.query(
        `SELECT hostname, verification_status, canonical_when_verified, verified_at
         FROM hotel_catalog.property_domains WHERE property_id = $1::uuid`,
        [propertyId],
      )
    ).rows;
  const readModelDomain = async () =>
    (
      await admin.query(
        `SELECT verified_custom_domain FROM hotel_catalog.property_public_profile_read_model
         WHERE property_id = $1::uuid`,
        [propertyId],
      )
    ).rows[0]?.verified_custom_domain ?? null;

  beforeAll(async () => {
    if (!new URL(TEST_DATABASE_URL!).pathname.toLowerCase().includes("test")) {
      throw new Error("Custom-domain integration tests require a test database");
    }
    await admin.connect();
    await admin.query("BEGIN");
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay2568-hotel', 'VAY-2568 Hotel')`,
      [propertyId],
    );
  });

  beforeEach(async () => {
    await admin.query("SAVEPOINT custom_domain_test");
    await repository.upsertForPropertyId(propertyId, hostname);
  });
  afterEach(async () => admin.query("ROLLBACK TO SAVEPOINT custom_domain_test"));

  afterAll(async () => {
    await admin.query("ROLLBACK");
    await admin.end();
  });

  it("stores a failed check without making the domain canonical", async () => {
    await expect(
      repository.recordCheckResult(propertyId, hostname, "failed"),
    ).resolves.toMatchObject({ domain: hostname, verificationStatus: "failed", verifiedAt: null });
    expect(await domainRow()).toEqual([
      {
        hostname,
        verification_status: "failed",
        canonical_when_verified: false,
        verified_at: null,
      },
    ]);
    await expect(repository.findByPropertyId(propertyId)).resolves.toMatchObject({
      verificationStatus: "failed",
    });
  });

  it("verifies the domain, makes it canonical and projects it into the public profile", async () => {
    const recorded = await repository.recordCheckResult(propertyId, hostname, "verified");
    await repository.projectPublicProfile(propertyId);

    expect(recorded).toMatchObject({ domain: hostname, verificationStatus: "verified" });
    expect(recorded?.verifiedAt).toBeTruthy();
    expect(await domainRow()).toEqual([
      expect.objectContaining({
        verification_status: "verified",
        canonical_when_verified: true,
        verified_at: expect.any(Date),
      }),
    ]);
    expect(await readModelDomain()).toBe(hostname);

    // Connecting the domain again starts over, and the public profile loses it until verified.
    await repository.upsertForPropertyId(propertyId, hostname);
    expect(await domainRow()).toEqual([
      expect.objectContaining({ verification_status: "pending", canonical_when_verified: false }),
    ]);
    expect(await readModelDomain()).toBeNull();
  });

  it("ignores a check for a hostname the hotel has replaced meanwhile", async () => {
    await repository.upsertForPropertyId(propertyId, "www.vay2568.example");

    await expect(
      repository.recordCheckResult(propertyId, hostname, "verified"),
    ).resolves.toBeNull();
    expect(await domainRow()).toEqual([
      expect.objectContaining({ hostname: "www.vay2568.example", verification_status: "pending" }),
    ]);
  });
});
