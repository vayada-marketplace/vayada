import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runParityChecks } from "./parity.js";
import { rebuild } from "./rebuild.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures");
const MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

function assertSafeTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run destructive test cleanup against non-test database "${dbName}". ` +
        `TEST_DATABASE_URL must point to a database with "test" in its name.`,
    );
  }
}

describe.skipIf(!TEST_DATABASE_URL)("runParityChecks (integration)", () => {
  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    await rebuild({
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: MIGRATIONS_DIR,
      environment: "local",
      schemas: ["platform", "identity"],
      fixtureCase: "identity-organization-links",
      fixturesDir: FIXTURES_DIR,
    });
  });

  afterEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS platform CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS identity CASCADE`);
    } finally {
      await client.end();
    }
  });

  it("passes all checks for the identity-organization-links fixture", async () => {
    const report = await runParityChecks({
      connectionString: TEST_DATABASE_URL!,
      fixtureCase: "identity-organization-links",
      fixturesDir: FIXTURES_DIR,
      environment: "local",
    });

    expect(report.status).toBe("passed");
    expect(report.summary.failures).toBe(0);
    expect(report.findings.filter((f) => f.severity === "fail")).toHaveLength(0);
  });

  it("reports UNIQUENESS_VIOLATION when a duplicate provider_user_id is inserted", async () => {
    // Inject a duplicate external identity row directly
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`
        INSERT INTO identity.users (id, email, status)
        VALUES ('ffffffff-0000-0000-0000-000000000099', 'dup@example.com', 'active')
      `);
      // Same (provider, provider_user_id) as the fixture row — a duplicate
      await client.query(`
        INSERT INTO identity.external_identities
          (user_id, provider, provider_user_id, provider_email, provider_email_verified)
        VALUES
          ('ffffffff-0000-0000-0000-000000000099', 'workos', 'user_workos_hotel_owner', 'dup@example.com', FALSE)
      `);
    } finally {
      await client.end();
    }

    const report = await runParityChecks({
      connectionString: TEST_DATABASE_URL!,
      fixtureCase: "identity-organization-links",
      fixturesDir: FIXTURES_DIR,
      environment: "local",
    });

    expect(report.status).toBe("failed");
    const violations = report.findings.filter((f) => f.code === "UNIQUENESS_VIOLATION");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].targetObject).toBe("identity.external_identities");
  });

  it("reports ID_STABILITY_VIOLATION when a source user ID is not preserved", async () => {
    // Remove the expected user and replace with a different ID
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        `DELETE FROM identity.users WHERE id = 'a1b2c3d4-0000-0000-0000-000000000001'`,
      );
    } finally {
      await client.end();
    }

    const report = await runParityChecks({
      connectionString: TEST_DATABASE_URL!,
      fixtureCase: "identity-organization-links",
      fixturesDir: FIXTURES_DIR,
      environment: "local",
    });

    expect(report.status).toBe("failed");
    const violations = report.findings.filter((f) => f.code === "ID_STABILITY_VIOLATION");
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("rebuild with fixture loading (integration)", () => {
  let tmpMigrationsDir: string;

  beforeEach(async () => {
    tmpMigrationsDir = join(tmpdir(), `backend-migration-parity-${Date.now()}`);
    await mkdir(tmpMigrationsDir, { recursive: true });
    assertSafeTestDatabase(TEST_DATABASE_URL!);
  });

  afterEach(async () => {
    await rm(tmpMigrationsDir, { recursive: true, force: true });
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS platform CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS identity CASCADE`);
    } finally {
      await client.end();
    }
  });

  it("applies 0001_identity.sql and loads the fixture without error", async () => {
    const result = await rebuild({
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: MIGRATIONS_DIR,
      environment: "local",
      schemas: ["platform", "identity"],
      fixtureCase: "identity-organization-links",
      fixturesDir: FIXTURES_DIR,
    });

    expect(result.applied).toEqual(["0001"]);
    expect(result.failed).toBeNull();

    // Verify identity tables were created and seeded
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT count(*)::int AS count FROM identity.users`);
      expect(rows[0].count).toBe(1);

      const perms = await client.query(
        `SELECT count(*)::int AS count FROM identity.permission_catalog`,
      );
      expect(perms.rows[0].count).toBe(8);
    } finally {
      await client.end();
    }
  });
});
