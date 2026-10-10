import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
const url = process.env["TEST_DATABASE_URL"];
// VAY-2079 R2 (0475): the direct-booking pricing authority is gone; its neighbours stay.
describe.skipIf(!url)("pricing authority drop", () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());
  it("drops the authority tables and view and keeps the property scope objects", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const present = async (names: string[]) =>
      (
        await pool.query(
          "SELECT name, to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) name",
          [names],
        )
      ).rows.map((row) => [row.name, row.present]);
    expect(
      await present([
        "booking.pricing_authority_heads",
        "booking.pricing_authority_revisions",
        "booking.pricing_runtime_effective_authority_scopes",
      ]),
    ).toEqual([
      ["booking.pricing_authority_heads", false],
      ["booking.pricing_authority_revisions", false],
      ["booking.pricing_runtime_effective_authority_scopes", false],
    ]);
    expect(
      await present([
        "platform.pricing_runtime_property_scopes",
        "booking.pricing_runtime_effective_property_scopes",
      ]),
    ).toEqual([
      ["platform.pricing_runtime_property_scopes", true],
      ["booking.pricing_runtime_effective_property_scopes", true],
    ]);
    expect(
      (
        await pool.query(
          "SELECT to_regprocedure('platform.prevent_append_only_mutation()') IS NOT NULL AS kept",
        )
      ).rows[0].kept,
    ).toBe(true);
  });
});
