import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  readAdoptionTargetRow,
  readLegacyHistoricalBindingTargetRow,
} from "./channexAdoptionTargetRows.js";
import { readLegacyHistoricalBindingTargetSnapshot as read } from "./legacyHistoricalBindingTargetReader.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const input = { propertyId: id(601), externalPropertyId: id(699) };

describe("historical binding target boundary", () => {
  it("leaves the clean-adoption table boundary unchanged", async () => {
    const query = vi.fn();
    await expect(
      readAdoptionTargetRow({ query } as never, "pms.channel_connections" as never, id(1)),
    ).rejects.toThrow("not allowlisted");
    await expect(
      readLegacyHistoricalBindingTargetRow({ query } as never, "identity.users" as never, id(1)),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it.each(["visibility", "query", "rollback"])(
    "fails closed and cleans up on %s failure",
    async (mode) => {
      const release = vi.fn();
      const query = vi.fn(async (sql: string) => {
        if (sql === "ROLLBACK" && mode === "rollback") throw new Error("cleanup failed");
        if (sql.includes("pg_class") && mode === "query") throw new Error("read failed");
        return { rows: [{ complete: false }] };
      });
      const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };
      await expect(read(pool as never, input)).rejects.toThrow();
      expect(query).toHaveBeenNthCalledWith(1, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(query).toHaveBeenLastCalledWith("ROLLBACK");
      expect(release).toHaveBeenCalledWith(mode === "rollback");
    },
  );
  it("rejects invalid IDs before obtaining a connection", async () => {
    const pool = { connect: vi.fn() };
    await expect(read(pool as never, { ...input, propertyId: "unknown" })).rejects.toThrow(
      "identifiers",
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

const url = process.env["VAY2017_BINDING_READER_TEST_DATABASE_URL"];
describe.skipIf(!url)("parent-migrated disposable PostgreSQL target reader", () => {
  let pool: pg.Pool;
  let reader: pg.Pool;
  let ownsRole = false;
  const tables = [
    "hotel_catalog.properties",
    "pms.channel_binding_claims",
    "pms.channel_connections",
  ];
  const projections = [
    "id,profile_status",
    "id,property_id,provider,external_property_id,claim_state,claim_source",
    "id,property_id,provider,connection_status,external_property_id,connection_metadata",
  ];
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== "127.0.0.1" ||
      parsed.pathname !== "/vay2017_binding_reader_fixture" ||
      parsed.search
    )
      throw new Error("Only the dedicated loopback fixture database is allowed");
    pool = new pg.Pool({ connectionString: url });
    await pool.query("CREATE ROLE vay2017_binding_reader LOGIN");
    ownsRole = true;
    await pool.query("GRANT USAGE ON SCHEMA hotel_catalog,pms TO vay2017_binding_reader");
    await pool.query(`GRANT SELECT ON ${tables.join(",")} TO vay2017_binding_reader`);
    parsed.username = "vay2017_binding_reader";
    reader = new pg.Pool({ connectionString: parsed.toString() });
    // Fail on duplicate fixture IDs; parent owns schema setup and DB disposal.
    for (const n of [601, 602, 603, 604])
      await pool.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name,profile_status) VALUES($1,$2,'Synthetic','private')",
        [id(n), `binding-reader-${n}`],
      );
    await pool.query(
      `INSERT INTO pms.channel_binding_claims
      (id,property_id,provider,external_property_id,claim_state,claim_source)
      VALUES($1,$2,'channex',$3,'historical','migration'),($4,$5,'channex',$6,'active','enable')`,
      [id(611), id(601), id(698), id(612), id(602), id(699)],
    );
    for (const n of [601, 602, 603, 604])
      await pool.query(
        `INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,external_property_id,connection_metadata)
       VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          id(n + 20),
          id(n),
          n === 604 ? "custom" : "channex",
          n === 602 ? "connected" : "disconnected",
          n === 602 ? id(699) : null,
          JSON.stringify({
            legacyExternalPropertyId: id(699),
            migrationRunId: `vay1351-${"a".repeat(24)}`,
            secretSentinel: "DO_NOT_REPORT",
          }),
        ],
      );
  });
  afterAll(async () => {
    await reader?.end();
    if (ownsRole)
      await pool.query("DROP OWNED BY vay2017_binding_reader; DROP ROLE vay2017_binding_reader");
    await pool?.end();
  });
  it.each([0, 1, 2])(
    "rejects column-only/RLS visibility and post-check ACL loss on table %s",
    async (index) => {
      const table = tables[index]!;
      const restrict = async () => {
        await pool.query(`REVOKE SELECT ON ${table} FROM vay2017_binding_reader`);
        await pool.query(
          `GRANT SELECT (${projections[index]}) ON ${table} TO vay2017_binding_reader`,
        );
      };
      try {
        await restrict();
        await expect(read(reader, input)).rejects.toMatchObject({ code: "42501" });
        await pool.query(`GRANT SELECT ON ${table} TO vay2017_binding_reader`);
        await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
        try {
          await expect(read(reader, input)).rejects.toThrow("visibility is incomplete");
        } finally {
          await pool.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
        }
        const client = await reader.connect();
        const query = client.query.bind(client);
        const wrapped = {
          query: async (sql: string, args?: unknown[]) => {
            const result = await query(sql, args);
            if (sql.includes("FROM pg_class")) await restrict();
            return result;
          },
          release: client.release.bind(client),
        };
        await expect(read({ connect: async () => wrapped } as never, input)).rejects.toThrow(
          "TARGET_COLUMN_VISIBILITY_INCOMPLETE",
        );
      } finally {
        await pool.query(`GRANT SELECT ON ${table} TO vay2017_binding_reader`);
      }
      expect(reader.totalCount).toBe(reader.idleCount);
    },
  );
  it("enumerates property, live-external and metadata-only competitors without truncation", async () => {
    const result = await read(pool, input);
    expect(result.property).toMatchObject({ id: id(601), profileStatus: "private" });
    expect(result.claims.map((r) => [r.id, r.claimState])).toEqual([
      [id(611), "historical"],
      [id(612), "active"],
    ]);
    expect(result.connections.map((r) => r.id)).toEqual([id(621), id(622), id(623)]);
    expect(JSON.stringify(result)).not.toMatch(
      /DO_NOT_REPORT|secretSentinel|connection_metadata|display_name/,
    );
    expect(Object.isFrozen(result.connections[0])).toBe(true);
    expect(Object.isFrozen(result.connections)).toBe(true);
    for (const row of [result.property, ...result.claims, ...result.connections])
      expect(row.rowStateSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pool.totalCount).toBe(pool.idleCount);
  });
  it("keeps summary fields and full-row hashes in one snapshot across concurrent metadata drift", async () => {
    const before = await read(pool, input);
    const client = await pool.connect();
    const query = client.query.bind(client);
    const wrapped = {
      query: async (sql: string, args?: unknown[]) => {
        const result = await query(sql, args);
        if (sql.includes("connection_metadata->>'legacyExternalPropertyId' AS")) {
          expect((await query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe(
            "on",
          );
          await pool.query(
            "UPDATE pms.channel_connections SET connection_metadata = connection_metadata || '{\"unreturned\":true}'::jsonb WHERE id=$1",
            [id(623)],
          );
        }
        return result;
      },
      release: client.release.bind(client),
    };
    expect(await read({ connect: async () => wrapped } as never, input)).toEqual(before);
    const after = await read(pool, input);
    expect(after.connections[2]!.rowStateSha256).not.toBe(before.connections[2]!.rowStateSha256);
    expect(after.property).toEqual(before.property);
  });
  it("preserves empty Channex sets and rejects a missing canonical property", async () => {
    const empty = await read(pool, { propertyId: id(604), externalPropertyId: id(697) });
    expect(empty.claims).toEqual([]);
    expect(empty.connections).toEqual([]);
    await expect(read(pool, { ...input, propertyId: id(696) })).rejects.toThrow("property missing");
    expect(pool.totalCount).toBe(pool.idleCount);
  });
  it("fails closed on unsafe JSON numbers and malformed retained identifiers", async () => {
    for (const json of [
      '{"legacyExternalPropertyId":"private@example.test"}',
      '{"number":9007199254740993}',
    ]) {
      await pool.query(
        "UPDATE pms.channel_connections SET connection_metadata=$1::jsonb WHERE id=$2",
        [json, id(621)],
      );
      try {
        await expect(read(pool, input)).rejects.toThrow();
      } finally {
        await pool.query(
          "UPDATE pms.channel_connections SET connection_metadata='{}'::jsonb WHERE id=$1",
          [id(621)],
        );
      }
    }
    expect(pool.totalCount).toBe(pool.idleCount);
  });
});
