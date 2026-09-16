import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { databaseUrl, id } from "./affiliatePublicationTestFixture.js";
import { assentFixture, disclosureHash } from "./affiliateAssentTestFixture.js";

describe.skipIf(!databaseUrl)("affiliate initial assent storage", () => {
  const fixture = assentFixture();
  const pool = () => fixture.pool();
  async function participation(program = id(50), creator = id(82), organization = id(80)) {
    const key = randomUUID();
    await pool().query("INSERT INTO marketplace.affiliate_participations VALUES ($1,$2,$3,$4)", [
      key,
      program,
      creator,
      organization,
    ]);
    return key;
  }
  async function attempt(participationId: string, terms = id(51), number = 1, program = id(50)) {
    const key = randomUUID();
    await pool().query(
      `INSERT INTO marketplace.affiliate_participation_attempts
      (id,participation_id,program_id,terms_id,attempt_number,origin,actor_user_id,actor_organization_id,request_id)
      VALUES ($1,$2,$3,$4,$5,'application',$6,$7,'fixture')`,
      [key, participationId, program, terms, number, id(81), id(80)],
    );
    return key;
  }
  async function decision(
    attemptId: string,
    terms = id(51),
    kind = "creator_acceptance",
    revision = 1,
    digest = disclosureHash,
  ) {
    return pool().query(
      `INSERT INTO marketplace.affiliate_assent_decisions
      (id,attempt_id,terms_id,decision,revision,disclosure_hash,actor_user_id,actor_organization_id,request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'fixture')`,
      [randomUUID(), attemptId, terms, kind, revision, digest, id(81), id(80)],
    );
  }
  it("keeps stable participation independent from version-pinned attempts and matching decisions", async () => {
    const stable = await participation(),
      first = await attempt(stable);
    await decision(first);
    await decision(first, id(51), "hotel_approval", 2);
    const history = (
      await pool().query("SELECT * FROM marketplace.affiliate_assent_decisions ORDER BY revision")
    ).rows;
    const next = await attempt(stable, id(52), 2);
    await decision(next, id(52));
    expect(
      (
        await pool().query(
          "SELECT * FROM marketplace.affiliate_assent_decisions WHERE attempt_id=$1 ORDER BY revision",
          [first],
        )
      ).rows,
    ).toEqual(history);
    expect(
      (await pool().query("SELECT count(*) FROM marketplace.affiliate_participations")).rows[0]
        .count,
    ).toBe("1");
    expect(history.map((row) => row.terms_id)).toEqual([id(51), id(51)]);
  });
  it("rejects duplicate identities, attempt numbers, roles and revisions", async () => {
    const stable = await participation(),
      first = await attempt(stable);
    await expect(participation()).rejects.toMatchObject({ code: "23505" });
    await expect(attempt(stable)).rejects.toMatchObject({ code: "23505" });
    await decision(first);
    await expect(decision(first, id(51), "creator_acceptance", 2)).rejects.toMatchObject({
      code: "23505",
    });
    await expect(decision(first, id(51), "hotel_approval", 1)).rejects.toMatchObject({
      code: "23505",
    });
  });
  it("rejects foreign creators, mismatched program/attempt/terms and disclosure digest", async () => {
    await expect(participation(id(50), randomUUID())).rejects.toMatchObject({ code: "23503" });
    await expect(participation(id(50), id(82), id(4))).rejects.toMatchObject({ code: "23503" });
    const stable = await participation(),
      first = await attempt(stable);
    await expect(
      pool().query("UPDATE marketplace.creator_profiles SET organization_id=$1 WHERE id=$2", [
        id(4),
        id(82),
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(attempt(stable, id(61), 2)).rejects.toMatchObject({ code: "23503" });
    await expect(attempt(stable, id(61), 2, id(60))).rejects.toMatchObject({ code: "23503" });
    await expect(decision(first, id(52))).rejects.toMatchObject({ code: "23503" });
    await expect(
      decision(first, id(51), "creator_acceptance", 1, "0".repeat(64)),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(decision(first, id(51), "activate")).rejects.toMatchObject({ code: "23514" });
    await expect(decision(first, id(51), "creator_acceptance", 3)).rejects.toMatchObject({
      code: "23514",
    });
  });
  it("preserves every identity, attempt and assent row against mutations", async () => {
    const stable = await participation(),
      first = await attempt(stable);
    await decision(first);
    for (const table of [
      "affiliate_participations",
      "affiliate_participation_attempts",
      "affiliate_assent_decisions",
    ]) {
      const before = (await pool().query(`SELECT * FROM marketplace.${table}`)).rows;
      for (const sql of [
        `UPDATE marketplace.${table} SET id=id`,
        `DELETE FROM marketplace.${table}`,
        `TRUNCATE marketplace.${table} CASCADE`,
      ])
        await expect(pool().query(sql)).rejects.toMatchObject({ code: "23514" });
      expect((await pool().query(`SELECT * FROM marketplace.${table}`)).rows).toEqual(before);
    }
  });
});
