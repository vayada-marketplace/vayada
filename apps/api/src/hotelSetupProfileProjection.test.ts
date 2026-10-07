import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../packages/backend-migration/migrations/${name}`, import.meta.url),
    ),
    "utf8",
  );
const body = (sql: string) =>
  sql.slice(
    sql.indexOf(
      "  SELECT property.id, property.public_id, property.display_name INTO property_row",
    ),
    sql.lastIndexOf("  END LOOP;"),
  );

describe("native profile canonical projection", () => {
  it("captures the reviewed logo projection exactly, without its assignment preamble or grants", () => {
    const logo = migration("0469_hotel_setup_logo_projection.sql");
    const profile = migration("0471_hotel_setup_profile_read_models.sql");
    expect(body(logo).length).toBeGreaterThan(10_000);
    expect(body(profile)).toBe(body(logo).replaceAll("hotel setup logo ", "hotel setup profile "));
    expect(profile).not.toContain("hotel_setup_property_scopes");
    expect(profile).not.toMatch(/\bGRANT\b/);
    expect(profile).toContain(
      "REVOKE ALL ON FUNCTION platform.hotel_setup_sync_property_read_models(UUID) FROM PUBLIC",
    );
  });
});
