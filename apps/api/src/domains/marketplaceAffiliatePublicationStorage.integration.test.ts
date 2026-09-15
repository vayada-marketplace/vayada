import { randomUUID, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { databaseUrl, id, publicationFixture } from "./affiliatePublicationTestFixture.js";

// Deliberately retain whitespace/key order: signed disclosure bytes must survive JSON storage.
const disclosure = '{ "version": 1, "terms": {"window":14,"commission":"12.50%"} }';
const hash = createHash("sha256").update(disclosure).digest("hex");
const effectiveAt = "2026-09-15T00:00:00.000Z";

describe.skipIf(!databaseUrl)("published affiliate terms storage", () => {
  const fixture = publicationFixture();
  async function insert(overrides: Record<string, unknown> = {}) {
    const row = {
      id: randomUUID(),
      program_id: id(50),
      offer_id: id(2),
      property_id: id(3),
      organization_id: id(4),
      source_draft_id: id(20),
      disclosure,
      disclosure_hash: hash,
      attribution_policy_version: "test-policy-v1",
      evidence_references: '["synthetic-evidence-v1"]',
      actor_user_id: id(1),
      request_id: "storage-test",
      effective_at: effectiveAt,
      ...overrides,
    };
    return fixture.pool().query(
      `INSERT INTO marketplace.affiliate_published_terms
      (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
        .map((_, i) => `$${i + 1}`)
        .join(",")}) RETURNING *`,
      Object.values(row),
    );
  }
  it("preserves exact disclosure, reference and audit history after a later revision", async () => {
    const original = (await insert()).rows[0];
    await fixture.draft(id(21), 2);
    await insert({
      source_draft_id: id(21),
      disclosure: '{"new":true}',
      disclosure_hash: createHash("sha256").update('{"new":true}').digest("hex"),
    });
    const stored = (
      await fixture
        .pool()
        .query("SELECT * FROM marketplace.affiliate_published_terms WHERE id=$1", [original.id])
    ).rows[0];
    expect(stored).toEqual(original);
    expect(stored).toMatchObject({
      disclosure,
      disclosure_hash: hash,
      source_draft_id: id(20),
      program_id: id(50),
      offer_id: id(2),
      property_id: id(3),
      organization_id: id(4),
      attribution_policy_version: "test-policy-v1",
      evidence_references: ["synthetic-evidence-v1"],
      actor_user_id: id(1),
      request_id: "storage-test",
      effective_at: new Date(effectiveAt),
    });
    expect(stored.recorded_at).toBeInstanceOf(Date);
  });
  it("rejects updates, deletes and truncation using append-only guards", async () => {
    await insert();
    for (const table of [
      "affiliate_programs",
      "affiliate_published_terms",
      "affiliate_offer_terms_drafts",
    ]) {
      const before = (await fixture.pool().query(`SELECT * FROM marketplace.${table} ORDER BY id`))
        .rows;
      for (const sql of [
        `UPDATE marketplace.${table} SET id=id`,
        `DELETE FROM marketplace.${table}`,
        `TRUNCATE marketplace.${table} CASCADE`,
      ])
        await expect(fixture.pool().query(sql)).rejects.toMatchObject({ code: "23514" });
      expect(
        (await fixture.pool().query(`SELECT * FROM marketplace.${table} ORDER BY id`)).rows,
      ).toEqual(before);
    }
  });
  it("rejects independently mismatched program and draft scopes", async () => {
    await fixture.draft(id(22), 1, id(5), id(6), id(7));
    for (const mismatch of [
      { program_id: id(60) },
      { offer_id: id(5) },
      { property_id: id(6) },
      { organization_id: id(7) },
      { source_draft_id: id(22) },
      { program_id: id(60), offer_id: id(5), property_id: id(6), organization_id: id(7) },
    ])
      await expect(insert(mismatch)).rejects.toMatchObject({ code: "23503" });
    // A second correctly scoped offer still succeeds.
    await insert({
      program_id: id(60),
      offer_id: id(5),
      property_id: id(6),
      organization_id: id(7),
      source_draft_id: id(22),
    });
    await insert();
  });
  it("allows one program per offer and one publication per source draft", async () => {
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
    await expect(
      fixture
        .pool()
        .query("INSERT INTO marketplace.affiliate_programs VALUES ($1,$2,$3,$4)", [
          randomUUID(),
          id(2),
          id(3),
          id(4),
        ]),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      fixture
        .pool()
        .query("INSERT INTO marketplace.affiliate_programs VALUES ($1,$2,$3,$4)", [
          randomUUID(),
          randomUUID(),
          id(3),
          id(4),
        ]),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects malformed snapshots, empty evidence and invalid audit metadata", async () => {
    for (const invalid of [
      { disclosure: "{}" },
      { disclosure: "[]" },
      { disclosure_hash: "bad" },
      { evidence_references: "[]" },
      { evidence_references: "{}" },
      { attribution_policy_version: " " },
      { request_id: " " },
      { effective_at: "infinity" },
      { recorded_at: "-infinity" },
    ])
      await expect(insert(invalid)).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ disclosure: "invalid-json" })).rejects.toMatchObject({ code: "22P02" });
    await expect(insert({ actor_user_id: randomUUID() })).rejects.toMatchObject({ code: "23503" });
    expect(
      (await fixture.pool().query("SELECT count(*) FROM marketplace.affiliate_published_terms"))
        .rows[0].count,
    ).toBe("0");
  });
});
