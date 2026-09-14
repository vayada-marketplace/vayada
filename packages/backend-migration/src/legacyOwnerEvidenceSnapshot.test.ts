import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_OWNERSHIP_ROW_TABLES,
  type LegacyOwnershipFingerprint,
} from "./legacyOwnershipBeforeState.js";
import { verifyLegacyPmsSourceProof } from "./legacyPmsSourceProof.js";
import { readLegacyOwnershipTargetEvidence } from "./legacyOwnershipRelationships.js";
import { verifyLegacyCurrentOwnerIdentity } from "./legacyCurrentOwnerIdentity.js";
import {
  readLegacyOwnerEvidenceSnapshot,
  type LegacyOwnerEvidenceRequest,
} from "./legacyOwnerEvidenceSnapshot.js";
vi.mock("./legacyPmsSourceProof.js", () => ({ verifyLegacyPmsSourceProof: vi.fn() }));
vi.mock("./legacyOwnershipRelationships.js", () => ({
  readLegacyOwnershipTargetEvidence: vi.fn(),
}));
vi.mock("./legacyCurrentOwnerIdentity.js", () => ({ verifyLegacyCurrentOwnerIdentity: vi.fn() }));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const target = Object.entries(LEGACY_OWNERSHIP_ROW_TABLES).map(([kind, table], i) => ({
    kind,
    table,
    id: uuid(i + 1),
    rowStateSha256: "a".repeat(64),
  })) as LegacyOwnershipFingerprint[];
  const request: LegacyOwnerEvidenceRequest = {
    source: {
      sourceRunId: `vay1351-${"a".repeat(24)}`,
      sourceEnvironment: "preprod",
      sourceSchemaRevision: "b".repeat(40),
      sourceEvidenceSha256: "c".repeat(64),
      legacyHotelId: uuid(10),
      ownerUserId: uuid(1),
      hotelRowOrdinal: 1,
      userRowOrdinal: 1,
    },
    target,
    identity: {
      userId: uuid(1),
      organizationId: uuid(3),
      externalIdentityId: uuid(11),
      externalIdentitySha256: "d".repeat(64),
      workosUserId: "user_fixture",
      workosOrgId: "org_fixture",
    },
  };
  const session = {
    workosUserId: "user_fixture",
    workosOrgId: "org_fixture",
    expiresAt: 9999999999,
  };
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  return {
    request,
    session,
    client,
    pool,
    run: () => readLegacyOwnerEvidenceSnapshot(pool as never, request, session),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(verifyLegacyPmsSourceProof).mockResolvedValue({
    outcome: "source_matches",
    sourceUserStatus: "pending",
  });
  vi.mocked(readLegacyOwnershipTargetEvidence).mockResolvedValue({ outcome: "target_matches" });
  vi.mocked(verifyLegacyCurrentOwnerIdentity).mockResolvedValue({
    outcome: "identity_matches",
    userStatus: "pending",
    organizationStatus: "suspended",
  });
});

const url = process.env["VAY2017_SNAPSHOT_TEST_DATABASE_URL"];
describe.skipIf(!url)("real PostgreSQL transaction boundary, mocked evidence readers", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/vay2017_snapshot_fixture" ||
      parsed.search
    )
      throw new Error("Only the dedicated loopback fixture database is allowed");
    pool = new pg.Pool({ connectionString: url, max: 2 });
    // Requires a fresh disposable database per run; fail on existing fixture data.
    // Teardown closes connections only. The task runner removes its owned container.
    await pool.query(
      "CREATE TABLE snapshot_probe (value integer); INSERT INTO snapshot_probe VALUES (1)",
    );
  });
  afterAll(async () => {
    await pool?.end();
  });
  it("holds a read-only snapshot across a concurrent committed update", async () => {
    const f = fixture();
    f.pool.connect.mockImplementation(() => pool.connect());
    vi.mocked(verifyLegacyPmsSourceProof).mockImplementation(async (client) => {
      const settings = await client.query(
        "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS readonly",
      );
      expect(settings.rows[0]).toEqual({ isolation: "repeatable read", readonly: "on" });
      expect((await client.query("SELECT value FROM snapshot_probe")).rows[0].value).toBe(1);
      await pool.query("UPDATE snapshot_probe SET value = 2");
      return { outcome: "source_matches", sourceUserStatus: "pending" };
    });
    vi.mocked(readLegacyOwnershipTargetEvidence).mockImplementation(async (client) => {
      expect((await client.query("SELECT value FROM snapshot_probe")).rows[0].value).toBe(1);
      return { outcome: "target_matches" };
    });
    expect((await f.run()).outcome).toBe("evidence_matches");
    expect((await pool.query("SELECT value FROM snapshot_probe")).rows[0].value).toBe(2);
    expect(pool.totalCount).toBe(pool.idleCount);
  });
  it("database rejects a reader write and the connection returns to the pool", async () => {
    const f = fixture();
    f.pool.connect.mockImplementation(() => pool.connect());
    vi.mocked(verifyLegacyPmsSourceProof).mockImplementation(async (client) => {
      await client.query("INSERT INTO snapshot_probe VALUES (99)");
      return { outcome: "source_matches", sourceUserStatus: "pending" };
    });
    await expect(f.run()).rejects.toMatchObject({ code: "25006" });
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM snapshot_probe")).rows[0].count,
    ).toBe(1);
    expect(pool.totalCount).toBe(pool.idleCount);
  });
});
describe("read-only owner evidence snapshot orchestration (mocked database)", () => {
  it("uses one client and snapshot, retaining actual statuses without granting access", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({
      outcome: "evidence_matches",
      sourceUserStatus: "pending",
      userStatus: "pending",
      organizationStatus: "suspended",
    });
    expect(f.pool.connect).toHaveBeenCalledTimes(1);
    expect(f.client.query.mock.calls).toEqual([
      ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"],
      ["ROLLBACK"],
    ]);
    expect(verifyLegacyPmsSourceProof).toHaveBeenCalledWith(f.client, f.request.source, uuid(1));
    expect(readLegacyOwnershipTargetEvidence).toHaveBeenCalledWith(
      f.client,
      f.request.target,
      uuid(10),
    );
    expect(verifyLegacyCurrentOwnerIdentity).toHaveBeenCalledWith(
      f.client,
      f.request.identity,
      f.session,
    );
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each([
    "source owner",
    "identity owner",
    "identity org",
    "invalid rows",
    "QA",
    "staging",
    "legacy fixture",
  ])("rejects %s before acquiring a client", async (change) => {
    const f = fixture();
    if (change === "source owner") f.request.source.ownerUserId = uuid(99);
    if (change === "identity owner") f.request.identity.userId = uuid(99);
    if (change === "identity org") f.request.identity.organizationId = uuid(99);
    if (change === "invalid rows") f.request.target = [];
    if (change === "QA")
      f.request.target.find((r) => r.kind === "property")!.id =
        "17621565-40b5-4ebc-8727-3a301ac947a2";
    if (change === "staging")
      f.request.target.find((r) => r.kind === "property")!.id =
        "65f6b2fc-c783-4963-9d6b-a85f82319769";
    if (change === "legacy fixture")
      f.request.source.legacyHotelId = "65f6b2fc-c783-4963-9d6b-a85f82319769";
    expect((await f.run()).outcome).toBe("blocked");
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it.each(["source", "target", "identity"])("stops on %s denial and rolls back", async (stage) => {
    const f = fixture();
    const blocked = { outcome: "blocked" as const, reason: "fixture_denial" };
    if (stage === "source") vi.mocked(verifyLegacyPmsSourceProof).mockResolvedValue(blocked);
    if (stage === "target") vi.mocked(readLegacyOwnershipTargetEvidence).mockResolvedValue(blocked);
    if (stage === "identity")
      vi.mocked(verifyLegacyCurrentOwnerIdentity).mockResolvedValue(blocked);
    expect(await f.run()).toEqual(blocked);
    if (stage === "source") expect(readLegacyOwnershipTargetEvidence).not.toHaveBeenCalled();
    if (stage !== "identity") expect(verifyLegacyCurrentOwnerIdentity).not.toHaveBeenCalled();
    expect(f.client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each(["begin", "source", "target", "identity", "rollback"])(
    "propagates %s failures and releases the client",
    async (stage) => {
      const f = fixture();
      const error = new Error("synthetic failure");
      if (stage === "begin") f.client.query.mockRejectedValueOnce(error);
      if (stage === "source") vi.mocked(verifyLegacyPmsSourceProof).mockRejectedValue(error);
      if (stage === "target") vi.mocked(readLegacyOwnershipTargetEvidence).mockRejectedValue(error);
      if (stage === "identity")
        vi.mocked(verifyLegacyCurrentOwnerIdentity).mockRejectedValue(error);
      if (stage === "rollback")
        f.client.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(error);
      await expect(f.run()).rejects.toThrow(error);
      expect(f.client.release).toHaveBeenCalledExactlyOnceWith(stage === "rollback");
    },
  );
  it("does not acquire or release a nonexistent connection", async () => {
    const f = fixture();
    f.pool.connect.mockRejectedValue(new Error("unavailable"));
    await expect(f.run()).rejects.toThrow("unavailable");
    expect(f.client.release).not.toHaveBeenCalled();
  });
  it("isolates expected evidence and session from caller mutation during reads", async () => {
    const f = fixture();
    const originalIdentity = structuredClone(f.request.identity);
    const originalSession = structuredClone(f.session);
    vi.mocked(verifyLegacyPmsSourceProof).mockImplementation(async () => {
      f.request.identity.userId = uuid(99);
      f.request.target.find((r) => r.kind === "organization")!.id = uuid(99);
      f.session.workosUserId = "user_other";
      return { outcome: "source_matches", sourceUserStatus: "pending" };
    });
    expect((await f.run()).outcome).toBe("evidence_matches");
    expect(verifyLegacyCurrentOwnerIdentity).toHaveBeenCalledWith(
      f.client,
      originalIdentity,
      originalSession,
    );
    expect(
      vi
        .mocked(readLegacyOwnershipTargetEvidence)
        .mock.calls[0]![1].find((r) => r.kind === "organization")!.id,
    ).toBe(uuid(3));
  });
});
