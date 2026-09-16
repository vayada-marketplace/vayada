import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0400_marketplace_communication_preferences.sql", import.meta.url),
  ),
  "utf8",
);

describe("Marketplace communication preference migration", () => {
  it("creates only the approved organization-scoped preference stores", () => {
    expect(migration).toContain("CREATE TABLE marketplace.communication_preference_sets");
    expect(migration).toContain("CREATE TABLE marketplace.communication_channel_preferences");
    expect(migration).toContain("CREATE TABLE marketplace.communication_topic_preferences");
    expect(migration).toContain("REFERENCES identity.users(id)");
    expect(migration).toContain("REFERENCES identity.organizations(id)");
    expect(migration).not.toMatch(/newsletter_preferences/i);
  });

  it("constrains v1 values around one protected aggregate revision", () => {
    for (const value of [
      "marketplace-communications.v1",
      "collaboration_action_required",
      "signed_unsubscribe",
      "explicit_opt_in",
      "consent_classification",
    ])
      expect(migration).toContain(value);
    expect(migration).toContain("NEW.revision <> OLD.revision + 1");
    expect(migration).toContain("TG_OP = 'INSERT' AND NEW.revision <> 1");
    expect(migration).toContain("CHECK (revision BETWEEN 1 AND 2147483647)");
    expect(migration).toContain("NEW.effective_revision <= OLD.effective_revision");
    expect(migration).toContain(
      "current_revision_transaction_id IS DISTINCT FROM pg_current_xact_id()",
    );
    expect(migration).toContain("Communication preferences cannot be deleted");
    expect(migration).toContain("Communication preference scope cannot change");
    expect(migration.match(/BEFORE TRUNCATE ON marketplace\./g)).toHaveLength(3);
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("Communication preference revision requires a value change");
  });
});
