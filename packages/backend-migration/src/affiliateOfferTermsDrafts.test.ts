import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMarketplaceAffiliateOfferTerms } from "@vayada/domain-marketplace";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0173_marketplace_affiliate_offer_terms_drafts.sql"),
  "utf8",
);
const databaseUrl = process.env["TEST_DATABASE_URL"];
const id = (n: number) => `15010000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!databaseUrl)("affiliate offer draft storage (PostgreSQL)", () => {
  let client: pg.Client;
  beforeEach(async () => {
    assertSafeTestDatabase(databaseUrl!);
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    // Transaction-local minimal parent tables; rollback also removes the migration.
    await client.query(`BEGIN;
      CREATE SCHEMA identity;
      CREATE SCHEMA marketplace;
      CREATE TABLE identity.users (id UUID PRIMARY KEY);
      CREATE TABLE marketplace.marketplace_offers (
        id UUID PRIMARY KEY, property_id UUID NOT NULL, organization_id UUID NOT NULL,
        UNIQUE (id, property_id, organization_id)
      );`);
    await client.query("INSERT INTO identity.users VALUES ($1)", [id(1)]);
    await client.query("INSERT INTO marketplace.marketplace_offers VALUES ($1,$2,$3),($4,$5,$6)", [
      id(2),
      id(3),
      id(4),
      id(5),
      id(6),
      id(7),
    ]);
    await client.query(migration);
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  function insert(overrides: Record<string, unknown> = {}) {
    const row = {
      id: id(10),
      offer_id: id(2),
      property_id: id(3),
      organization_id: id(4),
      revision: 1,
      contract_version: "marketplace-affiliate-offer-terms.v1",
      booking_destination_id: "destination-1",
      finance_policy_version_id: "policy-1",
      attribution_window_days: 14,
      actor_user_id: id(1),
      request_id: "request-1",
      recorded_at: "2026-09-08T00:00:00Z",
      ...overrides,
    };
    return client.query(
      `INSERT INTO marketplace.affiliate_offer_terms_drafts (${Object.keys(row).join(",")})
       VALUES (${Object.keys(row)
         .map((_, n) => `$${n + 1}`)
         .join(",")}) RETURNING *`,
      Object.values(row),
    );
  }

  async function rejects(operation: () => Promise<unknown>, code: string) {
    await client.query("SAVEPOINT invalid_attempt");
    await expect(operation()).rejects.toMatchObject({ code });
    await client.query("ROLLBACK TO SAVEPOINT invalid_attempt");
  }

  it("keeps the first draft unchanged when revised and separates other offers", async () => {
    await insert();
    await insert({ id: id(11), revision: 2, attribution_window_days: 30 });
    await insert({ id: id(12), offer_id: id(5), property_id: id(6), organization_id: id(7) });
    const result = await client.query(
      `SELECT revision, attribution_window_days FROM marketplace.affiliate_offer_terms_drafts
       WHERE offer_id = $1 ORDER BY revision`,
      [id(2)],
    );
    expect(result.rows).toEqual([
      { revision: 1, attribution_window_days: 14 },
      { revision: 2, attribution_window_days: 30 },
    ]);
    await rejects(() => insert({ id: id(13) }), "23505");
  });

  it("rejects mismatched hotel scopes, missing offers and unknown authors", async () => {
    for (const override of [
      { property_id: id(6) },
      { organization_id: id(7) },
      { property_id: id(6), organization_id: id(7) },
      { offer_id: id(99) },
      { actor_user_id: id(99) },
    ])
      await rejects(() => insert(override), "23503");
  });

  it("rejects edits, deletes and truncation without losing history", async () => {
    await insert();
    for (const sql of [
      "UPDATE marketplace.affiliate_offer_terms_drafts SET attribution_window_days = 30",
      "DELETE FROM marketplace.affiliate_offer_terms_drafts",
      "TRUNCATE marketplace.affiliate_offer_terms_drafts",
    ])
      await rejects(() => client.query(sql), "23514");
    expect(
      (await client.query("SELECT count(*) FROM marketplace.affiliate_offer_terms_drafts")).rows[0]
        .count,
    ).toBe("1");
  });

  it("enforces required audit fields, revision and contract identity", async () => {
    for (const override of [
      { revision: 0 },
      { request_id: " " },
      { request_id: "x".repeat(201) },
      { recorded_at: "infinity" },
      { contract_version: "unapproved.v2" },
    ])
      await rejects(() => insert(override), "23514");
    for (const field of ["actor_user_id", "request_id", "recorded_at", "finance_policy_version_id"])
      await rejects(() => insert({ [field]: null }), "23502");
  });

  it("matches domain validation for reference and window boundaries", async () => {
    for (const window of [0, -1, 104249992]) {
      expect(
        parseMarketplaceAffiliateOfferTerms({
          bookingDestinationId: "destination-1",
          financePolicyVersionId: "policy-1",
          attributionWindowDays: window,
        }).ok,
      ).toBe(false);
      await rejects(() => insert({ attribution_window_days: window }), "23514");
    }
    for (const reference of ["", " ", "https://hotel.test", "x".repeat(257)]) {
      for (const field of ["booking_destination_id", "finance_policy_version_id"])
        await rejects(() => insert({ [field]: reference }), "23514");
    }
    const max = "x".repeat(256);
    expect(
      parseMarketplaceAffiliateOfferTerms({
        bookingDestinationId: max,
        financePolicyVersionId: max,
        attributionWindowDays: 104249991,
      }).ok,
    ).toBe(true);
    await insert({
      booking_destination_id: max,
      finance_policy_version_id: max,
      attribution_window_days: 104249991,
    });
  });
});
