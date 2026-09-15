import pg from "pg";
import { generateKeyPairSync, verify } from "node:crypto";
import { collectLegacyOwnerCurrentSourceEvidence } from "./legacyOwnerCurrentSourceCollector.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readLegacyOwnerCurrentSources } from "./legacyOwnerCurrentSourceReader.js";

const url = process.env["VAY2017_SOURCE_READER_TEST_URL"];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pairs = Array.from({ length: 8 }, (_, i) => ({ ownerId: id(i + 1), hotelId: id(i + 11) }));
describe.skipIf(!url)("current owner source reader on isolated PostgreSQL", () => {
  let auth: pg.Pool, pms: pg.Pool, a: pg.Client, p: pg.Client;
  let input: Parameters<typeof readLegacyOwnerCurrentSources>[2];
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      parsed.hostname !== "127.0.0.1" ||
      !["56640", "56641"].includes(parsed.port) ||
      parsed.pathname !== "/vay2017_source_auth" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Dedicated source fixtures required");
    a = new pg.Client({ connectionString: parsed.toString() });
    await a.connect();
    parsed.pathname = "/vay2017_source_pms";
    p = new pg.Client({ connectionString: parsed.toString() });
    await p.connect();
    await a.query(`CREATE ROLE vay2017_current_reader LOGIN;
      CREATE TABLE public.users(id uuid,email text,name text,type text,status text,password_hash text);
      GRANT SELECT(id,email,name,type,status) ON public.users TO vay2017_current_reader`);
    await p.query(`CREATE TABLE public.hotels(id uuid,user_id uuid,private_note text);
      GRANT SELECT(id,user_id) ON public.hotels TO vay2017_current_reader`);
    parsed.username = "vay2017_current_reader";
    parsed.password = "";
    pms = new pg.Pool({ connectionString: parsed.toString(), max: 1 });
    parsed.pathname = "/vay2017_source_auth";
    auth = new pg.Pool({ connectionString: parsed.toString(), max: 1 });
    const pin = async (c: pg.Client) =>
      (
        await c.query(
          `SELECT current_database() AS "databaseName",oid::int AS "databaseOid" FROM pg_database WHERE datname=current_database()`,
        )
      ).rows[0];
    input = { pairs, auth: await pin(a), pms: await pin(p) };
  });
  beforeEach(async () => {
    await a.query("TRUNCATE public.users");
    await p.query("TRUNCATE public.hotels");
    for (const [i, pair] of pairs.entries()) {
      await a.query(
        "INSERT INTO public.users VALUES($1,$2,'Owner','hotel','pending','secret-unused')",
        [pair.ownerId, `owner${i}@example.invalid`],
      );
      await p.query("INSERT INTO public.hotels VALUES($1,$2,'private-unused')", [
        pair.hotelId,
        pair.ownerId,
      ]);
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await a.query(
      "ALTER TABLE public.users DISABLE ROW LEVEL SECURITY; ALTER TABLE public.users ALTER COLUMN email TYPE text; GRANT SELECT(id,email,name,type,status) ON public.users TO vay2017_current_reader",
    );
    await p.query(
      "ALTER TABLE public.hotels DISABLE ROW LEVEL SECURITY; GRANT SELECT(id,user_id) ON public.hotels TO vay2017_current_reader",
    );
  });
  afterAll(async () => {
    await Promise.allSettled([auth?.end(), pms?.end(), a?.end(), p?.end()]);
  });
  const read = () => readLegacyOwnerCurrentSources(auth, pms, input);
  it("collects signed evidence directly from both column-limited source databases", async () => {
    const keys = generateKeyPairSync("ed25519");
    const collect = () =>
      collectLegacyOwnerCurrentSourceEvidence(
        auth,
        pms,
        input,
        {
          environment: "local",
          sourceRunId: "vay1351-" + "a".repeat(24),
          sourceLedgerSha256: "a".repeat(64),
          authDatabaseSha256: "b".repeat(64),
          pmsDatabaseSha256: "c".repeat(64),
          signingKeyId: "synthetic-live",
        },
        keys,
      );
    const artifacts = await collect();
    expect(artifacts).toHaveLength(8);
    for (const [i, artifact] of artifacts.entries()) {
      expect(JSON.parse(artifact.canonicalPayload)).toMatchObject({
        ...pairs[i],
        sourceStatus: "pending",
        email: `owner${i}@example.invalid`,
      });
      expect(
        verify(
          null,
          Buffer.from(
            "vayada:legacy-owner-internal-setup:v1\0current-source-attestation\0" +
              artifact.canonicalPayload,
          ),
          keys.publicKey,
          Buffer.from(artifact.detachedSignature, "base64url"),
        ),
      ).toBe(true);
    }
    await a.query("UPDATE public.users SET status='suspended'");
    await expect(collect()).rejects.toThrow(/^LEGACY_OWNER_CURRENT_SOURCE_COLLECTION_FAILED$/);
  });
  it("reads only approved columns/pairs from two separate authenticated database sessions", async () => {
    const rows = await read();
    expect(rows).toHaveLength(8);
    for (const [i, row] of rows.entries())
      expect(row).toEqual({
        ...pairs[i],
        email: `owner${i}@example.invalid`,
        name: "Owner",
        sourceStatus: "pending",
        authObservedAt: expect.any(String),
        pmsObservedAt: expect.any(String),
      });
    await expect(auth.query("SELECT password_hash FROM public.users")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(auth.query("UPDATE public.users SET status='verified'")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(pms.query("SELECT private_note FROM public.hotels")).rejects.toMatchObject({
      code: "42501",
    });
    expect(
      (
        await a.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE usename='vay2017_current_reader' AND state='idle in transaction'",
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it.each([
    "missingAuth",
    "missingHotel",
    "wrongOwner",
    "wrongType",
    "suspended",
    "rejected",
    "duplicate",
    "invalidEmail",
    "invalidName",
    "rlsAuth",
    "rlsPms",
    "wrongColumn",
    "missingGrant",
  ])("rejects %s without partial observations", async (mode) => {
    if (mode === "missingAuth") await a.query("DELETE FROM public.users WHERE id=$1", [id(1)]);
    if (mode === "missingHotel") await p.query("DELETE FROM public.hotels WHERE id=$1", [id(11)]);
    if (mode === "wrongOwner")
      await p.query("UPDATE public.hotels SET user_id=$1 WHERE id=$2", [id(88), id(11)]);
    if (mode === "wrongType") await a.query("UPDATE public.users SET type='creator'");
    if (mode === "suspended" || mode === "rejected")
      await a.query("UPDATE public.users SET status=$1", [mode]);
    if (mode === "duplicate")
      await a.query("INSERT INTO public.users SELECT * FROM public.users WHERE id=$1", [id(1)]);
    if (mode === "invalidEmail") await a.query("UPDATE public.users SET email='invalid'");
    if (mode === "invalidName") await a.query("UPDATE public.users SET name=' '");
    if (mode === "rlsAuth") await a.query("ALTER TABLE public.users ENABLE ROW LEVEL SECURITY");
    if (mode === "rlsPms") await p.query("ALTER TABLE public.hotels ENABLE ROW LEVEL SECURITY");
    if (mode === "wrongColumn")
      await a.query("ALTER TABLE public.users ALTER COLUMN email TYPE varchar(254)");
    if (mode === "missingGrant")
      await p.query("REVOKE SELECT(id) ON public.hotels FROM vay2017_current_reader");
    await expect(read()).rejects.toThrow(/^LEGACY_OWNER_CURRENT_SOURCE_READ_FAILED$/);
  });
  it.each(["swapped", "oid", "protected", "duplicate", "missing"])(
    "rejects %s source scope",
    async (mode) => {
      const bad = structuredClone(input);
      if (mode === "oid") bad.auth.databaseOid++;
      if (mode === "protected") bad.pairs[0]!.hotelId = "17621565-40b5-4ebc-8727-3a301ac947a2";
      if (mode === "duplicate") bad.pairs[1]!.ownerId = bad.pairs[0]!.ownerId;
      if (mode === "missing") bad.pairs = bad.pairs.slice(1);
      await expect(
        readLegacyOwnerCurrentSources(
          mode === "swapped" ? pms : auth,
          mode === "swapped" ? auth : pms,
          bad,
        ),
      ).rejects.toThrow(/^LEGACY_OWNER_CURRENT_SOURCE_READ_FAILED$/);
    },
  );
  it("does not reuse an old read-only snapshot from its dedicated pool", async () => {
    const client = await auth.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT id FROM public.users");
    client.release();
    await a.query("UPDATE public.users SET status='suspended'");
    await expect(read()).rejects.toThrow(/^LEGACY_OWNER_CURRENT_SOURCE_READ_FAILED$/);
  });
  it.each(["backward", "forward", "elapsed"])("rejects %s clock drift", async (mode) => {
    let calls = 0;
    const base = Date.parse("2026-09-15T01:00:00.000Z");
    if (mode === "elapsed")
      vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(900001);
    await expect(
      readLegacyOwnerCurrentSources(
        auth,
        pms,
        input,
        () =>
          new Date(
            base + (calls++ === 0 ? 0 : mode === "backward" ? -1 : mode === "forward" ? 900001 : 0),
          ),
      ),
    ).rejects.toThrow(/^LEGACY_OWNER_CURRENT_SOURCE_READ_FAILED$/);
  });
  it("discards the source connection when rollback cannot be confirmed", async () => {
    const client = await auth.connect();
    const query = client.query.bind(client);
    let rollbacks = 0;
    vi.spyOn(auth, "connect").mockImplementation((async () => client) as typeof auth.connect);
    vi.spyOn(client, "query").mockImplementation((async (sql: string, values?: unknown[]) => {
      if (sql === "ROLLBACK" && ++rollbacks === 2) throw new Error("private connection detail");
      return query(sql, values);
    }) as typeof client.query);
    const release = vi.spyOn(client, "release");
    await expect(read()).rejects.toThrow(/^LEGACY_OWNER_CURRENT_SOURCE_READ_FAILED$/);
    expect(release).toHaveBeenCalledWith(true);
  });
});
