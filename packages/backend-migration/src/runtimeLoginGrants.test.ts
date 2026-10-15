import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// VAY-2211: the API login gets ordinary DML on the product schemas from the migration owner's
// default privileges, and the platform runtime preflight checks its protected list on every
// release (VAY-2054, engineering/api-runtime-database-role.md). A migration that grants the login
// anything directly skips that review, so each one is listed here with the reason it was accepted.
const REVIEWED: Record<string, string> = {
  "0431_channex_alert_resolution_runtime_grant.sql": "column grant to resolve Channex alerts",
  "0477_booking_pricing_acceptance_amendments.sql":
    "the default-privilege DML, explicit because a trigger reads the table as the writing role",
};
const GRANT_TO_API_LOGIN = /\b(?:GRANT\b[^;]*?\bTO|OWNER\s+TO)\b[^;]*?\bvayada_next_api_runtime\b/i;
const directory = new URL("../migrations/", import.meta.url);
const sql = (file: string) =>
  readFileSync(new URL(file, directory), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");

describe("migrations and the API login", () => {
  it("grant the API login nothing outside the reviewed migrations", () => {
    const granting = readdirSync(directory)
      .filter((file) => file.endsWith(".sql") && GRANT_TO_API_LOGIN.test(sql(file)))
      .sort();
    // New entry? Get it reviewed against the platform grant set and protected list first.
    expect(granting).toEqual(Object.keys(REVIEWED).sort());
  });

  it("recognises table, role, dynamic and ownership grants, but not revokes", () => {
    for (const statement of [
      "GRANT SELECT ON booking.x TO vayada_next_api_runtime;",
      "GRANT pms_writer TO vayada_next_api_runtime;",
      "EXECUTE format('GRANT UPDATE ON %s TO %I', t, 'vayada_next_api_runtime');",
      "ALTER DEFAULT PRIVILEGES IN SCHEMA pms GRANT ALL ON TABLES TO vayada_next_api_runtime;",
      'ALTER TABLE booking.x OWNER TO "vayada_next_api_runtime";',
    ])
      expect(GRANT_TO_API_LOGIN.test(statement)).toBe(true);
    expect(GRANT_TO_API_LOGIN.test("REVOKE ALL ON booking.x FROM vayada_next_api_runtime;")).toBe(
      false,
    );
  });
});
