import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import { SINGLE_HUMAN_DUAL_AUTHORITY_DECISION } from "./channexAdoptionConsumer.js";
import {
  hashLegacyOwnerApprovalEvidence,
  LEGACY_OWNER_APPROVAL_VERSION,
} from "./legacyOwnerApprovalEnvelope.js";
import {
  hashLegacyOwnerApprovalEnvelope,
  verifyLegacyOwnerApprovals,
} from "./legacyOwnerApprovalRegistry.js";
import type { LegacyOwnerEvidenceRequest } from "./legacyOwnerEvidenceSnapshot.js";

const url = process.env["VAY2017_APPROVAL_TEST_DATABASE_URL"];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
describe.skipIf(!url)("owner approval registry on fresh fully migrated local database", () => {
  let client: pg.Client;
  const keys = generateKeyPairSync("ed25519");
  // Signature/registry tests only: evidence semantic verification is a separate gate.
  const evidence: LegacyOwnerEvidenceRequest = {
    source: {
      sourceRunId: `vay1351-${"a".repeat(24)}`,
      sourceEnvironment: "preprod",
      sourceSchemaRevision: "b".repeat(40),
      sourceEvidenceSha256: "c".repeat(64),
      legacyHotelId: id(4),
      ownerUserId: id(1),
      hotelRowOrdinal: 1,
      userRowOrdinal: 1,
    },
    target: [],
    identity: {
      userId: id(1),
      organizationId: id(2),
      externalIdentityId: id(3),
      externalIdentitySha256: "d".repeat(64),
      workosUserId: "user_fixture",
      workosOrgId: "org_fixture",
    },
  };
  const envelope = {
    contractVersion: LEGACY_OWNER_APPROVAL_VERSION,
    commandId: id(10),
    environment: "local" as const,
    issuedAt: "2026-09-14T00:00:00.000Z",
    expiresAt: "2026-09-14T02:00:00.000Z",
    evidenceSha256: hashLegacyOwnerApprovalEvidence(evidence),
    migrationApprovalRecordId: id(11),
    securityApprovalRecordId: id(12),
    signingKeyId: "fixture",
  };
  const canonicalPayload = canonicalizeJson(envelope);
  const input = {
    canonicalPayload,
    detachedSignature: sign(
      null,
      Buffer.from(`vayada:legacy-pms-owner-evidence:v1\0envelope\0${canonicalPayload}`),
      keys.privateKey,
    ).toString("base64url"),
    verificationKeys: new Map([["fixture", keys.publicKey]]),
    environment: "local" as const,
    evidence,
  };
  const clock = () => new Date("2026-09-14T01:00:00.000Z");
  const policy = () => ({
    executionPrincipal: "machine:executor",
    signingPrincipals: new Map([["fixture", "machine:signer"]]),
    actors: new Map([
      [
        id(1),
        { principal: "human:fixture", authorities: ["migration_owner", "security_owner"] as const },
      ],
    ]),
    singleHumanDualAuthority: {
      actorUserId: id(1),
      principal: "human:fixture",
      decisionId: SINGLE_HUMAN_DUAL_AUTHORITY_DECISION,
    },
  });
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/vay2017_approval_fixture" ||
      parsed.search
    )
      throw new Error("Only dedicated loopback fixture database allowed");
    client = new pg.Client({ connectionString: url });
    await client.connect();
    // Fail on existing schema; runner never deletes or reuses someone else's fixture.
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname='identity'")).rowCount,
    ).toBe(0);
    const result = await runMigrations({
      connectionString: url!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(result.failed).toBeNull();
    expect(result.applied).toContain("0211");
    await client.query(
      "INSERT INTO identity.users(id,email) VALUES ($1,'owner-approval@example.test')",
      [id(1)],
    );
    for (const [record, authority] of [
      [id(11), "migration_owner"],
      [id(12), "security_owner"],
    ])
      await client.query(
        `INSERT INTO platform.legacy_owner_approval_records
        (approval_record_id,command_id,contract_version,environment,envelope_sha256,authority,actor_user_id,approved_at,expires_at)
        VALUES($1,$2,$3,'local',$4,$5,$6,'2026-09-14T00:30:00Z',$7)`,
        [
          record,
          id(10),
          LEGACY_OWNER_APPROVAL_VERSION,
          hashLegacyOwnerApprovalEnvelope(canonicalPayload),
          authority,
          id(1),
          envelope.expiresAt,
        ],
      );
  }, 120000);
  beforeEach(async () => {
    await client.query("BEGIN");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });
  afterAll(async () => {
    await client?.end();
  });
  const revoke = () =>
    client.query(
      `INSERT INTO platform.legacy_owner_approval_revocations
    VALUES($1,$2,'2026-09-14T00:45:00Z',$3,now())`,
      [id(11), id(1), "f".repeat(64)],
    );
  it("accepts two distinct immutable records for the explicitly permitted single human", async () => {
    expect(await verifyLegacyOwnerApprovals(client, input, policy(), clock)).toEqual({
      outcome: "approvals_match_requires_eligibility",
    });
  });
  it("rejects revoked approval without deleting history", async () => {
    await revoke();
    await expect(verifyLegacyOwnerApprovals(client, input, policy(), clock)).rejects.toThrow(
      "registry mismatch",
    );
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM platform.legacy_owner_approval_records",
        )
      ).rows[0].count,
    ).toBe(2);
  });
  it.each(["UPDATE", "DELETE", "TRUNCATE"])("rejects %s on approval records", async (action) => {
    const sql =
      action === "UPDATE"
        ? "UPDATE platform.legacy_owner_approval_records SET authority=authority"
        : `${action === "DELETE" ? "DELETE FROM" : "TRUNCATE"} platform.legacy_owner_approval_records`;
    await expect(
      client.query(sql + (action === "TRUNCATE" ? " CASCADE" : "")),
    ).rejects.toMatchObject({ code: "55000" });
  });
  it.each(["UPDATE", "DELETE", "TRUNCATE"])("rejects %s on revocation records", async (action) => {
    await revoke();
    const sql =
      action === "UPDATE"
        ? "UPDATE platform.legacy_owner_approval_revocations SET revoked_at=revoked_at"
        : `${action === "DELETE" ? "DELETE FROM" : "TRUNCATE"} platform.legacy_owner_approval_revocations`;
    await expect(client.query(sql)).rejects.toMatchObject({ code: "55000" });
  });
  it("rejects duplicate authority for a command", async () => {
    await expect(
      client.query(
        `INSERT INTO platform.legacy_owner_approval_records SELECT $1,command_id,contract_version,environment,envelope_sha256,authority,actor_user_id,approved_at,expires_at,recorded_at FROM platform.legacy_owner_approval_records WHERE approval_record_id=$2`,
        [id(99), id(11)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
  it.each([
    "missing dual policy",
    "wrong dual decision",
    "wrong dual principal",
    "machine signer",
    "machine actor",
    "unapproved actor",
    "wrong role",
  ])("rejects %s", async (change) => {
    const config = policy();
    if (change === "missing dual policy") config.singleHumanDualAuthority = undefined as never;
    if (change === "wrong dual decision")
      config.singleHumanDualAuthority.decisionId = "VAY-1320@wrong" as never;
    if (change === "wrong dual principal")
      config.singleHumanDualAuthority.principal = "human:someone-else";
    if (change === "machine signer") config.executionPrincipal = "machine:signer";
    if (change === "machine actor") config.actors.get(id(1))!.principal = "machine:executor";
    if (change === "unapproved actor") config.actors.clear();
    if (change === "wrong role") config.actors.get(id(1))!.authorities = [] as never;
    await expect(verifyLegacyOwnerApprovals(client, input, config, clock)).rejects.toThrow(
      "registry mismatch",
    );
  });
  it.each([
    ["commandId", id(99)],
    ["securityApprovalRecordId", id(99)],
    ["expiresAt", "2026-09-14T03:00:00.000Z"],
    ["issuedAt", "2026-09-14T00:10:00.000Z"],
  ])("rejects signed %s differing from stored approval", async (field, value) => {
    const payload = canonicalizeJson({ ...envelope, [field!]: value });
    const detachedSignature = sign(
      null,
      Buffer.from(`vayada:legacy-pms-owner-evidence:v1\0envelope\0${payload}`),
      keys.privateKey,
    ).toString("base64url");
    await expect(
      verifyLegacyOwnerApprovals(
        client,
        { ...input, canonicalPayload: payload, detachedSignature },
        policy(),
        clock,
      ),
    ).rejects.toThrow("registry mismatch");
  });
  it("rechecks expiry after registry reads", async () => {
    let reads = 0;
    await expect(
      verifyLegacyOwnerApprovals(client, input, policy(), () =>
        ++reads === 1 ? clock() : new Date(envelope.expiresAt),
      ),
    ).rejects.toThrow("registry mismatch");
  });
  it("revokes PUBLIC access", async () => {
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM pg_class c, LATERAL aclexplode(c.relacl) a WHERE c.oid IN ('platform.legacy_owner_approval_records'::regclass,'platform.legacy_owner_approval_revocations'::regclass) AND a.grantee=0`,
        )
      ).rows[0].count,
    ).toBe(0);
  });
});
