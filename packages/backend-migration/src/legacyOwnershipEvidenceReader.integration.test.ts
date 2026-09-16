import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readLegacyOwnershipTargetRow } from "./channexAdoptionTargetRows.js";
import { readLegacyOwnershipDrift } from "./legacyOwnershipEvidenceReader.js";
import { readLegacyOwnershipTargetEvidence } from "./legacyOwnershipRelationships.js";
import {
  verifyLegacyCurrentOwnerIdentity,
  type LegacyOwnerIdentityEvidence,
} from "./legacyCurrentOwnerIdentity.js";
import {
  LEGACY_OWNERSHIP_ROW_TABLES,
  type LegacyOwnershipFingerprint,
} from "./legacyOwnershipBeforeState.js";

const url = process.env["VAY2017_EVIDENCE_TEST_DATABASE_URL"];
describe.skipIf(!url)("ownership reader on disposable local PostgreSQL", () => {
  let client: pg.Client;
  const fingerprints: LegacyOwnershipFingerprint[] = [];
  async function refreshFingerprints(): Promise<LegacyOwnershipFingerprint[]> {
    const rows: LegacyOwnershipFingerprint[] = [];
    for (const item of fingerprints)
      rows.push({
        kind: item.kind,
        table: item.table,
        ...(await readLegacyOwnershipTargetRow(
          client,
          LEGACY_OWNERSHIP_ROW_TABLES[item.kind],
          item.id,
        )),
      });
    return rows;
  }
  const legacyHotelId = "00000000-0000-4000-8000-000000000099";
  let identityProof: LegacyOwnerIdentityEvidence;
  const verifiedSession = () => ({
    workosUserId: "user_synthetic",
    workosOrgId: "org_synthetic",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/vay2017_evidence_fixture" ||
      parsed.search
    )
      throw new Error("Only the dedicated loopback fixture database is allowed");
    client = new pg.Client({ connectionString: url });
    await client.connect();
    // Fail rather than reusing any pre-existing schemas or fixture data.
    await client.query("CREATE SCHEMA identity; CREATE SCHEMA hotel_catalog");
    for (const table of new Set(Object.values(LEGACY_OWNERSHIP_ROW_TABLES))) {
      await client.query(`CREATE TABLE ${table} (id uuid PRIMARY KEY, status text NOT NULL,
        updated_at timestamptz NOT NULL, revision bigint NOT NULL, metadata jsonb NOT NULL)`);
    }
    for (const [index, [kind, table]] of Object.entries(LEGACY_OWNERSHIP_ROW_TABLES).entries()) {
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      await client.query(
        `INSERT INTO ${table} VALUES ($1, 'pending', '2026-09-14T00:00:00.123456Z', 9007199254740993, '{"proof":"synthetic"}')`,
        [id],
      );
      fingerprints.push({
        kind: kind as LegacyOwnershipFingerprint["kind"],
        table,
        ...(await readLegacyOwnershipTargetRow(client, table, id)),
      });
    }
    const id = (kind: LegacyOwnershipFingerprint["kind"]) =>
      fingerprints.find((row) => row.kind === kind)!.id;
    await client.query(`ALTER TABLE identity.organizations ADD COLUMN kind text;
      ALTER TABLE identity.organization_memberships ADD COLUMN user_id uuid, ADD COLUMN organization_id uuid,
        ADD COLUMN role_key text, ADD COLUMN access_origin text;
      ALTER TABLE identity.organization_resource_links ADD COLUMN organization_id uuid, ADD COLUMN product text,
        ADD COLUMN resource_type text, ADD COLUMN resource_id text, ADD COLUMN relationship text;
      ALTER TABLE hotel_catalog.property_source_links ADD COLUMN property_id uuid, ADD COLUMN source_id text,
        ADD COLUMN source_system text, ADD COLUMN source_table text, ADD COLUMN relationship text`);
    await client.query("ALTER TABLE identity.organizations ADD COLUMN workos_org_id text");
    await client.query(
      "UPDATE identity.organizations SET kind = 'hotel_group', status = 'suspended', workos_org_id = 'org_synthetic'",
    );
    await client.query(`CREATE TABLE identity.external_identities (id uuid PRIMARY KEY, user_id uuid NOT NULL,
      provider text NOT NULL, provider_user_id text, raw_profile jsonb NOT NULL);
      INSERT INTO identity.external_identities VALUES ('00000000-0000-4000-8000-000000000096',
      '00000000-0000-4000-8000-000000000001', 'workos', 'user_synthetic', '{}')`);
    const externalIdentity = await readLegacyOwnershipTargetRow(
      client,
      "identity.external_identities",
      "00000000-0000-4000-8000-000000000096",
    );
    identityProof = {
      userId: id("user"),
      organizationId: id("organization"),
      externalIdentityId: externalIdentity.id,
      externalIdentitySha256: externalIdentity.rowStateSha256,
      workosUserId: "user_synthetic",
      workosOrgId: "org_synthetic",
    };
    await client.query(
      "UPDATE identity.organization_memberships SET user_id = $1, organization_id = $2, role_key = 'hotel_owner', access_origin = 'agency'",
      [id("user"), id("organization")],
    );
    await client.query(
      "UPDATE hotel_catalog.property_source_links SET property_id = $1, source_id = $2, source_system = 'pms', source_table = 'hotels', relationship = 'operational_input'",
      [id("property"), legacyHotelId],
    );
    await client.query("UPDATE hotel_catalog.property_source_links SET status = 'active'");
    await client.query("UPDATE identity.organization_resource_links SET status = 'suspended'");
    for (const [kind, product, type, resource] of [
      ["legacyLink", "pms", "pms_hotel", legacyHotelId],
      ["canonicalLink", "hotel_catalog", "property", id("property")],
      ["pmsLink", "pms", "pms_property", id("property")],
    ] as const) {
      await client.query(
        "UPDATE identity.organization_resource_links SET organization_id = $1, product = $2, resource_type = $3, resource_id = $4, relationship = 'operator' WHERE id = $5",
        [id("organization"), product, type, resource, id(kind)],
      );
    }
    for (const row of fingerprints) {
      Object.assign(
        row,
        await readLegacyOwnershipTargetRow(client, LEGACY_OWNERSHIP_ROW_TABLES[row.kind], row.id),
      );
    }
  });
  afterAll(async () => {
    await client?.end();
  });

  it("compares real full-row fingerprints within a read-only transaction", async () => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      expect(await readLegacyOwnershipDrift(client, fingerprints)).toEqual({
        outcome: "unchanged",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it("detects microsecond timestamp drift that JavaScript Date would lose", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        "UPDATE identity.users SET updated_at = updated_at + interval '1 microsecond'",
      );
      expect(await readLegacyOwnershipDrift(client, fingerprints)).toEqual({
        outcome: "blocked",
        reason: "target_drift",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it("rejects missing ownership records", async () => {
    await client.query("BEGIN");
    try {
      await client.query("DELETE FROM identity.organization_memberships");
      await expect(readLegacyOwnershipDrift(client, fingerprints)).rejects.toMatchObject({
        code: "TARGET_ROW_MISMATCH",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it("matches the exact pending owner target chain without granting access", async () => {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY");
    try {
      expect(await readLegacyOwnershipTargetEvidence(client, fingerprints, legacyHotelId)).toEqual({
        outcome: "target_matches",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it.each([
    [
      "wrong owner",
      "UPDATE identity.organization_memberships SET user_id = '00000000-0000-4000-8000-000000000098'",
      "membership_conflict",
    ],
    [
      "wrong organization kind",
      "UPDATE identity.organizations SET kind = 'platform'",
      "membership_conflict",
    ],
    [
      "wrong legacy mapping",
      "UPDATE hotel_catalog.property_source_links SET source_id = 'other'",
      "source_link_conflict",
    ],
    [
      "wrong resource owner",
      "UPDATE identity.organization_resource_links SET organization_id = '00000000-0000-4000-8000-000000000098'",
      "ownership_link_conflict",
    ],
    [
      "wrong relationship",
      "UPDATE identity.organization_resource_links SET relationship = 'front_desk'",
      "ownership_link_conflict",
    ],
    ["newer restriction", "UPDATE identity.users SET status = 'suspended'", "target_drift"],
    [
      "archived competing owner",
      `INSERT INTO identity.organization_resource_links SELECT '00000000-0000-4000-8000-000000000098', 'archived', updated_at, revision, metadata,
      '00000000-0000-4000-8000-000000000097', product, resource_type, resource_id, relationship FROM identity.organization_resource_links LIMIT 1`,
      "ownership_link_conflict",
    ],
    [
      "second membership",
      `INSERT INTO identity.organization_memberships SELECT '00000000-0000-4000-8000-000000000098', 'inactive', updated_at, revision, metadata,
      '00000000-0000-4000-8000-000000000097', organization_id, role_key, access_origin FROM identity.organization_memberships`,
      "membership_conflict",
    ],
  ])("rejects %s", async (_name, sql, reason) => {
    await client.query("BEGIN");
    try {
      await client.query(sql!);
      expect(await readLegacyOwnershipTargetEvidence(client, fingerprints, legacyHotelId)).toEqual({
        outcome: "blocked",
        reason,
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it.each(["pms_hotel", "property", "pms_property"])(
    "rejects archived competing %s ownership",
    async (resourceType) => {
      await client.query("BEGIN");
      try {
        await client.query(
          `INSERT INTO identity.organization_resource_links
        SELECT '00000000-0000-4000-8000-000000000098', 'archived', updated_at, revision, metadata,
        '00000000-0000-4000-8000-000000000097', product, resource_type, resource_id, relationship
        FROM identity.organization_resource_links WHERE resource_type = $1`,
          [resourceType],
        );
        expect(
          await readLegacyOwnershipTargetEvidence(client, fingerprints, legacyHotelId),
        ).toEqual({ outcome: "blocked", reason: "ownership_link_conflict" });
      } finally {
        await client.query("ROLLBACK");
      }
    },
  );
  it("rejects an additional historical PMS mapping for the same canonical hotel", async () => {
    await client.query("BEGIN");
    try {
      await client.query(`INSERT INTO hotel_catalog.property_source_links
        SELECT '00000000-0000-4000-8000-000000000098', 'superseded', updated_at, revision, metadata,
        property_id, '00000000-0000-4000-8000-000000000097', source_system, source_table, relationship
        FROM hotel_catalog.property_source_links`);
      expect(await readLegacyOwnershipTargetEvidence(client, fingerprints, legacyHotelId)).toEqual({
        outcome: "blocked",
        reason: "source_link_conflict",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it.each([
    ["sourceLink", "superseded", "source_link_restricted"],
    ["sourceLink", "ignored", "source_link_restricted"],
    ["sourceLink", "unknown", "source_link_restricted"],
    ["membership", "inactive", "membership_restricted"],
    ["membership", "suspended", "membership_restricted"],
    ["membership", "unknown", "membership_restricted"],
    ["legacyLink", "archived", "ownership_link_restricted"],
    ["canonicalLink", "archived", "ownership_link_restricted"],
    ["pmsLink", "archived", "ownership_link_restricted"],
    ["pmsLink", "unknown", "ownership_link_restricted"],
  ] as const)(
    "rejects %s %s even with freshly matching fingerprints",
    async (kind, status, reason) => {
      await client.query("BEGIN");
      try {
        const row = fingerprints.find((item) => item.kind === kind)!;
        // Table comes only from the checked-in fixture allowlist, never external input.
        await client.query(
          `UPDATE ${LEGACY_OWNERSHIP_ROW_TABLES[kind]} SET status = $1 WHERE id = $2`,
          [status, row.id],
        );
        const refreshed = await refreshFingerprints();
        expect(await readLegacyOwnershipTargetEvidence(client, refreshed, legacyHotelId)).toEqual({
          outcome: "blocked",
          reason,
        });
      } finally {
        await client.query("ROLLBACK");
      }
    },
  );
  it("keeps ordinary active membership and links eligible for evidence matching only", async () => {
    await client.query("BEGIN");
    try {
      await client.query("UPDATE identity.organization_memberships SET status = 'active'");
      await client.query("UPDATE identity.organization_resource_links SET status = 'active'");
      const refreshed = await refreshFingerprints();
      expect(await readLegacyOwnershipTargetEvidence(client, refreshed, legacyHotelId)).toEqual({
        outcome: "target_matches",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it("matches verified session IDs against current database bindings, not email", async () => {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY");
    try {
      expect(
        await verifyLegacyCurrentOwnerIdentity(client, identityProof, verifiedSession()),
      ).toEqual({
        outcome: "identity_matches",
        userStatus: "pending",
        organizationStatus: "suspended",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it.each([
    [
      "suspended user",
      "UPDATE identity.users SET status = 'suspended'",
      "current_identity_conflict",
    ],
    [
      "competing WorkOS identity",
      `INSERT INTO identity.external_identities SELECT '00000000-0000-4000-8000-000000000095', user_id, provider, 'user_other', raw_profile FROM identity.external_identities`,
      "current_identity_conflict",
    ],
    [
      "changed identity metadata",
      "UPDATE identity.external_identities SET raw_profile = '{\"changed\":true}'",
      "current_identity_drift",
    ],
  ])("rejects %s in current identity bindings", async (_name, sql, reason) => {
    await client.query("BEGIN");
    try {
      await client.query(sql!);
      expect(
        await verifyLegacyCurrentOwnerIdentity(client, identityProof, verifiedSession()),
      ).toEqual({ outcome: "blocked", reason });
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
