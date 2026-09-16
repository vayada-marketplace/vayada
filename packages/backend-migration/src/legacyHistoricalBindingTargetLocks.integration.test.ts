import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";
import { readLegacyHistoricalBindingTargetSnapshot } from "./legacyHistoricalBindingTargetReader.js";
import { lockLegacyHistoricalBindingTarget as lock } from "./legacyHistoricalBindingTargetLocks.js";
import { lockLegacyHistoricalBindingOwner } from "./legacyHistoricalBindingOwnerLocks.js";
import {
  LEGACY_OWNERSHIP_ROW_TABLES,
  type LegacyOwnershipFingerprint,
} from "./legacyOwnershipBeforeState.js";
import {
  readLegacyOwnershipTargetRow,
  readLegacyHistoricalBindingTargetRow,
} from "./channexAdoptionTargetRows.js";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import {
  hashLegacyHistoricalBindingApprovalEvidence,
  type LegacyHistoricalBindingApprovalEvidence,
} from "./legacyHistoricalBindingEnvelope.js";
import {
  hashLegacyHistoricalBindingEnvelope,
  lockAndVerifyLegacyHistoricalBindingApprovals as approve,
} from "./legacyHistoricalBindingApprovals.js";

const url = process.env["VAY2017_TARGET_LOCK_TEST_DATABASE_URL"];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const run = `vay1351-${"a".repeat(24)}`;
describe.skipIf(!url)("historical prepare target locks on disposable PostgreSQL", () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let other: pg.PoolClient;
  let expected: Parameters<typeof lock>[1];
  let signed: Parameters<typeof approve>[1];
  const clock = () => new Date("2026-09-16T01:30:00.000Z");
  const policy = {
    executionPrincipal: "machine:fixture-executor",
    signingPrincipals: new Map([["fixture", "machine:fixture-signer"]]),
    actors: new Map([
      [
        id(31),
        { principal: "human:fixture", authorities: ["migration_owner", "security_owner"] as const },
      ],
    ]),
    singleHumanDualAuthority: { actorUserId: id(31), decisionId: "synthetic-dual-authority" },
  };
  const session = () => ({
    workosUserId: "user_binding_fixture",
    workosOrgId: "org_binding_fixture",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  const prepareGuards = async (currentSession = session()) => {
    await approve(client, signed, policy, clock);
    await lock(client, {
      binding: signed.evidence.binding,
      sourceActive: signed.evidence.sourceActive,
    });
    return lockLegacyHistoricalBindingOwner(client, signed.evidence.owner, currentSession);
  };
  const revoke = () =>
    other.query(
      `INSERT INTO platform.legacy_owner_approval_revocations(approval_record_id,revoked_by_user_id,revoked_at,reason_sha256)
     VALUES($1,$2,$3,$4)`,
      [id(41), id(31), clock().toISOString(), "a".repeat(64)],
    );
  const begin = (db = client) =>
    db.query("BEGIN; SET LOCAL lock_timeout='150ms'; SET LOCAL statement_timeout='3s'");
  const insertConnection = (db: pg.PoolClient, n = 12) =>
    db.query(
      `INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,connection_metadata)
    VALUES($1,$2,'channex','disconnected',$3::jsonb)`,
      [
        id(n),
        id(n === 12 ? 2 : 1),
        JSON.stringify({ legacyExternalPropertyId: id(9), migrationRunId: run }),
      ],
    );
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      parsed.hostname !== "127.0.0.1" ||
      !["56636", "56637"].includes(parsed.port) ||
      parsed.pathname !== "/vay2017_target_lock_fixture" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Dedicated loopback historical target fixture required");
    pool = new pg.Pool({ connectionString: url });
    client = await pool.connect();
    other = await pool.connect();
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname='identity'")).rowCount,
    ).toBe(0);
    const result = await runMigrations({
      connectionString: url!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(result.failed).toBeNull();
    await client.query(
      `INSERT INTO hotel_catalog.properties(id,public_id,display_name)
      VALUES($1,'lock-one','Synthetic'),($2,'lock-two','Synthetic')`,
      [id(1), id(2)],
    );
    await client.query(
      `INSERT INTO pms.channel_binding_claims
      (id,property_id,provider,external_property_id,claim_state,claim_source)
      VALUES($1,$2,'channex',$3,'historical','migration')`,
      [id(10), id(1), id(9)],
    );
    await insertConnection(client, 11);
    const snapshot = await readLegacyHistoricalBindingTargetSnapshot(pool, {
      propertyId: id(1),
      externalPropertyId: id(9),
    });
    expected = {
      sourceActive: true,
      binding: {
        property: snapshot.property,
        bindingExpected: {
          sourceRunId: run,
          source: {
            id: id(20),
            hotelId: id(1),
            externalPropertyId: id(9),
            rowOrdinal: 1,
            rowChecksumSha256: "a".repeat(64),
          },
          propertyId: id(1),
          claim: snapshot.claims[0]!,
          connections: snapshot.connections,
        },
      },
    };
    // Real parent-migrated ownership schema; no simplified replacement tables.
    await client.query(
      "INSERT INTO identity.users(id,email,status) VALUES($1,'binding-owner@example.test','pending')",
      [id(31)],
    );
    await client.query(
      `INSERT INTO identity.organizations(id,kind,name,slug,status,workos_org_id)
      VALUES($1,'hotel_group','Synthetic','binding-owner','suspended','org_binding_fixture')`,
      [id(32)],
    );
    await client.query(
      `INSERT INTO identity.organization_memberships(id,user_id,organization_id,role_key,status,access_origin)
      VALUES($1,$2,$3,'hotel_owner','pending','agency')`,
      [id(33), id(31), id(32)],
    );
    await client.query(
      `INSERT INTO hotel_catalog.property_source_links(id,property_id,source_system,source_table,source_id,relationship)
      VALUES($1,$2,'pms','hotels',$3,'operational_input')`,
      [id(34), id(1), id(1)],
    );
    for (const [n, product, type] of [
      [35, "pms", "pms_hotel"],
      [36, "hotel_catalog", "property"],
      [37, "pms", "pms_property"],
    ] as const)
      await client.query(
        `INSERT INTO identity.organization_resource_links(id,organization_id,product,resource_type,resource_id,relationship,status)
        VALUES($1,$2,$3,$4,$5,'operator','suspended')`,
        [id(n), id(32), product, type, id(1)],
      );
    await client.query(
      `INSERT INTO identity.external_identities(id,user_id,provider,provider_user_id)
      VALUES($1,$2,'workos','user_binding_fixture')`,
      [id(38), id(31)],
    );
    const ownerIds = {
      user: 31,
      organization: 32,
      membership: 33,
      property: 1,
      sourceLink: 34,
      legacyLink: 35,
      canonicalLink: 36,
      pmsLink: 37,
    };
    const target: LegacyOwnershipFingerprint[] = [];
    for (const [kind, table] of Object.entries(LEGACY_OWNERSHIP_ROW_TABLES))
      target.push({
        kind: kind as keyof typeof ownerIds,
        table,
        ...(await readLegacyOwnershipTargetRow(
          client,
          table,
          id(ownerIds[kind as keyof typeof ownerIds]),
        )),
      });
    const proof = {
      sourceRunId: run,
      sourceEnvironment: "local" as const,
      sourceSchemaRevision: "synthetic-source-not-verified",
      sourceEvidenceSha256: "a".repeat(64),
    };
    const identity = await readLegacyOwnershipTargetRow(
      client,
      "identity.external_identities",
      id(38),
    );
    const evidence: LegacyHistoricalBindingApprovalEvidence = {
      owner: {
        source: {
          ...proof,
          legacyHotelId: id(1),
          ownerUserId: id(31),
          hotelRowOrdinal: 1,
          userRowOrdinal: 1,
        },
        target,
        identity: {
          userId: id(31),
          organizationId: id(32),
          externalIdentityId: id(38),
          externalIdentitySha256: identity.rowStateSha256,
          workosUserId: "user_binding_fixture",
          workosOrgId: "org_binding_fixture",
        },
      },
      binding: {
        ...expected.binding,
        sourceRequest: {
          ...proof,
          snapshotIdentifierSha256: "b".repeat(64),
          source: expected.binding.bindingExpected.source,
        },
      },
      sourceActive: true,
      targetBeforeSha256: "c".repeat(64),
      targetAfterSha256: "d".repeat(64),
    };
    const envelope = {
      contractVersion: "legacy-historical-binding-transition.v1",
      commandId: id(40),
      environment: "local",
      purpose: "prepare",
      originalPrepareCommandId: null,
      issuedAt: "2026-09-16T01:00:00.000Z",
      expiresAt: "2026-09-16T02:00:00.000Z",
      evidenceSha256: hashLegacyHistoricalBindingApprovalEvidence(evidence),
      migrationApprovalRecordId: id(41),
      securityApprovalRecordId: id(42),
      signingKeyId: "fixture",
    };
    const payload = canonicalizeJson(envelope),
      keys = generateKeyPairSync("ed25519");
    signed = {
      canonicalPayload: payload,
      detachedSignature: sign(
        null,
        Buffer.from(`vayada:legacy-historical-binding-transition:v1\0envelope\0${payload}`),
        keys.privateKey,
      ).toString("base64url"),
      verificationKeys: new Map([["fixture", keys.publicKey]]),
      environment: "local",
      evidence,
    };
    for (const [n, authority] of [
      [41, "migration_owner"],
      [42, "security_owner"],
    ] as const)
      await client.query(
        `INSERT INTO platform.legacy_owner_approval_records
        (approval_record_id,command_id,contract_version,environment,envelope_sha256,authority,actor_user_id,approved_at,expires_at)
        VALUES($1,$2,$3,'local',$4,$5,$6,$7,$8)`,
        [
          id(n),
          envelope.commandId,
          envelope.contractVersion,
          hashLegacyHistoricalBindingEnvelope(payload),
          authority,
          id(31),
          "2026-09-16T01:10:00.000Z",
          envelope.expiresAt,
        ],
      );
  }, 120000);
  beforeEach(() => begin());
  afterEach(async () => {
    await other.query("ROLLBACK");
    await client.query("ROLLBACK");
  });
  afterAll(async () => {
    client?.release();
    other?.release();
    await pool?.end();
  });
  it("composes signed approvals, binding and owner fences without granting access or changing rows", async () => {
    expect(await prepareGuards()).toEqual({
      outcome: "owner_locked_requires_source_and_disposition",
      executable: false,
      userStatus: "pending",
      organizationStatus: "suspended",
    });
    // Inspect the executing transaction before rollback, not just committed rows.
    for (const row of signed.evidence.owner.target)
      expect(
        await readLegacyOwnershipTargetRow(client, LEGACY_OWNERSHIP_ROW_TABLES[row.kind], row.id),
      ).toEqual({ id: row.id, rowStateSha256: row.rowStateSha256 });
    for (const [table, rows] of [
      ["pms.channel_binding_claims", [expected.binding.bindingExpected.claim]],
      ["pms.channel_connections", expected.binding.bindingExpected.connections],
    ] as const)
      for (const row of rows)
        expect(
          (await readLegacyHistoricalBindingTargetRow(client, table, row.id)).rowStateSha256,
        ).toBe(row.rowStateSha256);
    expect(
      (await client.query("SELECT 1 FROM platform.legacy_historical_binding_transitions")).rowCount,
    ).toBe(0);
    await client.query("ROLLBACK");
    const snapshot = await readLegacyHistoricalBindingTargetSnapshot(pool, {
      propertyId: id(1),
      externalPropertyId: id(9),
    });
    expect(snapshot.property).toEqual(expected.binding.property);
    expect(snapshot.claims).toEqual([expected.binding.bindingExpected.claim]);
    expect(snapshot.connections).toEqual(expected.binding.bindingExpected.connections);
    for (const row of signed.evidence.owner.target)
      expect(
        await readLegacyOwnershipTargetRow(client, LEGACY_OWNERSHIP_ROW_TABLES[row.kind], row.id),
      ).toEqual({ id: row.id, rowStateSha256: row.rowStateSha256 });
    expect(
      (await client.query("SELECT 1 FROM platform.legacy_historical_binding_transitions")).rowCount,
    ).toBe(0);
  });
  it.each(["revocation", "ownership", "connection"])(
    "combined guards retain %s fence until outer rollback",
    async (kind) => {
      await prepareGuards();
      await begin(other);
      const write = () =>
        kind === "revocation"
          ? revoke()
          : kind === "ownership"
            ? other.query(
                "UPDATE identity.organization_memberships SET status='suspended' WHERE id=$1",
                [id(33)],
              )
            : insertConnection(other);
      await expect(write()).rejects.toMatchObject({ code: "55P03" });
      await other.query("ROLLBACK");
      await client.query("ROLLBACK");
      await begin(other);
      await write();
    },
  );
  it("owner failure still requires outer rollback to release earlier approval and binding locks", async () => {
    await expect(prepareGuards({ ...session(), workosUserId: "wrong_owner" })).rejects.toThrow(
      "HISTORICAL_OWNER",
    );
    await begin(other);
    await expect(revoke()).rejects.toMatchObject({ code: "55P03" });
    await other.query("ROLLBACK");
    await begin(other);
    await expect(insertConnection(other)).rejects.toMatchObject({ code: "55P03" });
    await other.query("ROLLBACK");
    await client.query("ROLLBACK");
    await begin(other);
    await revoke();
    await insertConnection(other);
  });
  it("rechecks expiry after all guards rather than treating earlier approval as durable authority", async () => {
    await prepareGuards();
    await expect(
      approve(client, signed, policy, () => new Date("2026-09-16T02:00:00.000Z")),
    ).rejects.toThrow("APPROVALS_INVALID");
    expect(
      (await client.query("SELECT 1 FROM platform.legacy_historical_binding_transitions")).rowCount,
    ).toBe(0);
  });
  it.each([false, true])(
    "combined restricted-role visibility, withheld SELECT=%s",
    async (withheld) => {
      await client.query(`CREATE ROLE binding_combined_fixture_role;
      GRANT USAGE ON SCHEMA identity,hotel_catalog,pms,platform TO binding_combined_fixture_role;
      GRANT SELECT,UPDATE ON identity.users,identity.organizations,identity.organization_memberships,
        identity.organization_resource_links,identity.external_identities,hotel_catalog.properties,
        hotel_catalog.property_source_links,pms.channel_binding_claims,pms.channel_connections,
        platform.legacy_owner_approval_records TO binding_combined_fixture_role;
      GRANT SELECT ON platform.legacy_owner_approval_revocations TO binding_combined_fixture_role`);
      if (withheld)
        await client.query(
          "REVOKE SELECT ON identity.external_identities FROM binding_combined_fixture_role",
        );
      await client.query("SET LOCAL ROLE binding_combined_fixture_role");
      if (withheld) await expect(prepareGuards()).rejects.toThrow("HISTORICAL_OWNER");
      else expect((await prepareGuards()).executable).toBe(false);
    },
  );
  it("retains exact target locks without changing history or live connection", async () => {
    expect(await lock(client, expected)).toEqual({
      outcome: "target_locked_requires_owner_and_source",
      executable: false,
    });
    expect((await client.query("SELECT claim_state FROM pms.channel_binding_claims")).rows).toEqual(
      [{ claim_state: "historical" }],
    );
    expect(
      (
        await client.query(
          "SELECT connection_status,external_property_id FROM pms.channel_connections",
        )
      ).rows,
    ).toEqual([{ connection_status: "disconnected", external_property_id: null }]);
    expect(
      (await client.query("SELECT 1 FROM platform.legacy_historical_binding_transitions")).rowCount,
    ).toBe(0);
  });
  it.each(["property", "claim", "metadata", "phantom"])(
    "fences concurrent %s writes",
    async (kind) => {
      await lock(client, expected);
      await begin(other);
      const write =
        kind === "phantom"
          ? insertConnection(other)
          : other.query(
              {
                property: "UPDATE hotel_catalog.properties SET display_name='changed' WHERE id=$1",
                claim:
                  "UPDATE pms.channel_binding_claims SET claim_state='released' WHERE property_id=$1",
                metadata:
                  "UPDATE pms.channel_connections SET connection_metadata='{}'::jsonb WHERE property_id=$1",
              }[kind as "property" | "claim" | "metadata"],
              [id(1)],
            );
      await expect(write).rejects.toMatchObject({ code: "55P03" });
    },
  );
  it.each(["management", "external-property"])(
    "uses existing %s advisory namespace",
    async (kind) => {
      await begin(other);
      await other.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `channex.${kind}:${id(kind === "management" ? 1 : 9)}`,
      ]);
      await expect(lock(client, expected)).rejects.toThrow();
      await insertConnection(other);
      expect(
        (
          await other.query(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
            [`channex.external-property:${id(9)}`],
          )
        ).rows[0]?.acquired,
      ).toBe(true);
      expect((await client.query("SELECT 1 AS alive")).rows[0]?.alive).toBe(1);
    },
  );
  it("releases earlier property locks when a later claim lock fails", async () => {
    await begin(other);
    await other.query("SELECT 1 FROM pms.channel_binding_claims WHERE id=$1 FOR UPDATE", [id(10)]);
    await expect(lock(client, expected)).rejects.toThrow();
    await other.query(
      "UPDATE hotel_catalog.properties SET display_name='rollback-control' WHERE id=$1",
      [id(1)],
    );
    await insertConnection(other);
  });
  it.each(["hotel_catalog.properties", "pms.channel_binding_claims", "pms.channel_connections"])(
    "rejects RLS-enabled %s even for bypass role",
    async (table) => {
      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await expect(lock(client, expected)).rejects.toThrow();
    },
  );
  it("rejects an in-flight connection writer immediately and releases partial locks", async () => {
    await begin(other);
    await insertConnection(other);
    await expect(lock(client, expected)).rejects.toThrow();
    expect((await client.query("SELECT 1 AS alive")).rows[0]?.alive).toBe(1);
    const acquired = await other.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
      [`channex.management:${id(1)}`],
    );
    expect(acquired.rows[0]?.acquired).toBe(true);
  });
  it.each(["property", "claim", "connection", "extra", "cross-pair"])(
    "rejects stale or competing %s target",
    async (kind) => {
      if (kind === "property")
        await client.query("UPDATE hotel_catalog.properties SET display_name='newer' WHERE id=$1", [
          id(1),
        ]);
      if (kind === "claim")
        await client.query(
          "UPDATE pms.channel_binding_claims SET claim_state='verified_non_active' WHERE id=$1",
          [id(10)],
        );
      if (kind === "connection")
        await client.query(
          "UPDATE pms.channel_connections SET connection_metadata='{}' WHERE id=$1",
          [id(11)],
        );
      if (kind === "extra") await insertConnection(client);
      if (kind === "cross-pair")
        await client.query(
          "UPDATE pms.channel_binding_claims SET external_property_id=$1 WHERE id=$2",
          [id(8), id(10)],
        );
      await expect(lock(client, expected)).rejects.toThrow();
    },
  );
  it.each([false, null])("keeps source activity %s held", async (sourceActive) => {
    await expect(
      lock(client, { ...expected, sourceActive: sourceActive as boolean }),
    ).rejects.toThrow();
  });
  it.each([
    "17621565-40b5-4ebc-8727-3a301ac947a2",
    "46906724-72cb-4acf-a2eb-b740a3bdbcf7",
    "65f6b2fc-c783-4963-9d6b-a85f82319769",
    "8f4c1e47-3de1-4150-8bde-ad031a013842",
  ])("excludes protected key %s", async (key) => {
    const changed = structuredClone(expected);
    changed.binding.bindingExpected.source.externalPropertyId = key;
    await expect(lock(client, changed)).rejects.toThrow();
  });
  it("releases retained locks on outer rollback", async () => {
    await lock(client, expected);
    await client.query("ROLLBACK");
    await begin(other);
    await insertConnection(other);
  });
  it("refuses unbounded or missing transactions", async () => {
    await client.query("SET LOCAL lock_timeout='0'");
    await expect(lock(client, expected)).rejects.toThrow();
    await client.query("ROLLBACK");
    await expect(lock(client, expected)).rejects.toThrow();
  });
});
