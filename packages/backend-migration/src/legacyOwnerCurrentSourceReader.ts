import type pg from "pg";

type SourcePin = { databaseName: string; databaseOid: number };
type Pair = { ownerId: string; hotelId: string };
type SourceRow = Pair & {
  present: boolean;
  accountType?: string;
  status?: string;
  email?: string;
  name?: string | null;
  ownerMatches?: boolean;
};

/** Protected observations only: no signer, CLI, provider call or write authority.
 * Dedicated read pools MUST independently authenticate approved LIVE TLS endpoints/resources.
 * Name/OID checks cannot distinguish an identically cloned database. Caller
 * supplies exactly eight approved historical pairs; never log returned contacts. */
export async function readLegacyOwnerCurrentSources(
  authPool: Pick<pg.Pool, "connect">,
  pmsPool: Pick<pg.Pool, "connect">,
  input: { pairs: readonly Pair[]; auth: SourcePin; pms: SourcePin },
  clock: () => Date = () => new Date(),
) {
  try {
    const expected = structuredClone(input);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const pairs = expected.pairs;
    if (
      !Array.isArray(pairs) ||
      pairs.length !== 8 ||
      new Set(pairs.map((p) => p.ownerId)).size !== 8 ||
      new Set(pairs.map((p) => p.hotelId)).size !== 8 ||
      pairs.some(
        (p) =>
          !uuid.test(p.ownerId) ||
          !uuid.test(p.hotelId) ||
          ["17621565-40b5-4ebc-8727-3a301ac947a2", "65f6b2fc-c783-4963-9d6b-a85f82319769"].includes(
            p.hotelId,
          ),
      )
    )
      throw new Error();
    for (const pin of [expected.auth, expected.pms])
      if (
        typeof pin.databaseName !== "string" ||
        !pin.databaseName ||
        !Number.isSafeInteger(pin.databaseOid) ||
        pin.databaseOid < 1 ||
        pin.databaseOid > 4294967295
      )
        throw new Error();
    const started = performance.now();
    let previous = clock().getTime();
    const wallStarted = previous;
    const observedNow = () => {
      const now = clock().getTime();
      if (
        !Number.isFinite(now) ||
        now < previous ||
        now - wallStarted > 900_000 ||
        performance.now() - started > 900_000
      )
        throw new Error();
      previous = now;
      return new Date(now).toISOString();
    };
    if (!Number.isFinite(previous)) throw new Error();
    async function read(pool: Pick<pg.Pool, "connect">, kind: "auth" | "pms") {
      const client = await pool.connect();
      let discard = false;
      try {
        // Dedicated reader pool: never relabel a leaked old read-only snapshot as fresh.
        await client.query("ROLLBACK");
        const observedAt = observedNow();
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query(
          "SET LOCAL search_path = pg_catalog; SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s'",
        );
        const table = kind === "auth" ? "public.users" : "public.hotels";
        // Empty column-authorized SELECT retains ACCESS SHARE without table-wide SELECT grants.
        await client.query(`SELECT id FROM ${table} WHERE false`);
        const pin = expected[kind];
        const db = await client.query<{
          name: string;
          oid: string;
          encoding: string;
          version: number;
        }>(`SELECT
          current_database() AS name, oid::text AS oid, current_setting('server_encoding') AS encoding,
          current_setting('server_version_num')::int AS version FROM pg_database WHERE datname=current_database()`);
        const row = db.rows[0];
        if (
          db.rows.length !== 1 ||
          row?.name !== pin.databaseName ||
          row.oid !== String(pin.databaseOid) ||
          row.encoding !== "UTF8" ||
          row.version < 160000 ||
          row.version >= 180000
        )
          throw new Error();
        const columns =
          kind === "auth" ? ["id", "type", "status", "email", "name"] : ["id", "user_id"];
        const schema = await client.query<{ safe: boolean }>(
          `SELECT
          c.relkind='r' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
          AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
          AND (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname=ANY($2::text[])
            AND NOT a.attisdropped AND a.attgenerated='' AND a.atttypid=CASE
              WHEN a.attname IN ('id','user_id') THEN 'uuid'::regtype ELSE 'text'::regtype END
            AND has_column_privilege(current_user,c.oid,a.attname,'SELECT'))=$3 AS safe
          FROM pg_class c WHERE c.oid=$1::regclass`,
          [table, columns, columns.length],
        );
        if (schema.rows.length !== 1 || schema.rows[0]?.safe !== true) throw new Error();
        const projection =
          kind === "auth"
            ? `u.id IS NOT NULL AS present,u.type AS "accountType",u.status,u.email,u.name
             FROM wanted w LEFT JOIN public.users u ON u.id=w.owner_id`
            : `h.id IS NOT NULL AS present,h.user_id=w.owner_id AS "ownerMatches"
             FROM wanted w LEFT JOIN public.hotels h ON h.id=w.hotel_id`;
        const result = await client.query<SourceRow>(
          `WITH wanted AS (
          SELECT * FROM unnest($1::uuid[],$2::uuid[]) AS p(owner_id,hotel_id))
          SELECT w.owner_id::text AS "ownerId",w.hotel_id::text AS "hotelId",${projection}
          ORDER BY w.owner_id LIMIT 9`,
          [pairs.map((p) => p.ownerId), pairs.map((p) => p.hotelId)],
        );
        if (
          result.rows.length !== 8 ||
          new Set(result.rows.map((r) => r.ownerId)).size !== 8 ||
          result.rows.some(
            (r) =>
              r.present !== true ||
              !pairs.some((p) => p.ownerId === r.ownerId && p.hotelId === r.hotelId),
          )
        )
          throw new Error();
        observedNow();
        return { rows: result.rows, observedAt };
      } finally {
        try {
          await client.query("ROLLBACK");
        } catch {
          discard = true;
          throw new Error();
        } finally {
          client.release(discard);
        }
      }
    }
    const auth = await read(authPool, "auth");
    // Never return partial contacts if the second source or cleanup fails.
    const pms = await read(pmsPool, "pms");
    observedNow();
    return auth.rows.map((row) => {
      if (
        row.accountType !== "hotel" ||
        !["pending", "verified"].includes(row.status ?? "") ||
        pms.rows.find((p) => p.ownerId === row.ownerId)?.ownerMatches !== true ||
        typeof row.email !== "string" ||
        row.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) ||
        row.email.includes("\0") ||
        (row.name !== null &&
          (typeof row.name !== "string" ||
            !row.name.trim() ||
            row.name.length > 256 ||
            row.name.includes("\0")))
      )
        throw new Error();
      return {
        ownerId: row.ownerId,
        hotelId: row.hotelId,
        email: row.email,
        name: row.name,
        sourceStatus: row.status as "pending" | "verified",
        authObservedAt: auth.observedAt,
        pmsObservedAt: pms.observedAt,
      };
    });
  } catch {
    throw new Error("LEGACY_OWNER_CURRENT_SOURCE_READ_FAILED");
  }
}
