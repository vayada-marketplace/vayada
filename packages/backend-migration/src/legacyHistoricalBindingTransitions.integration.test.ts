import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";

const url = process.env["VAY2017_TRANSITION_TEST_DATABASE_URL"];
const table = "platform.legacy_historical_binding_transitions";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (char = "a") => char.repeat(64);
describe.skipIf(!url)("historical binding transition storage", () => {
  let client: pg.Client;
  let sequence = 100;
  const prepare = () => ({
    command_id: id(sequence++),
    contract_version: "legacy-historical-binding-transition.v1",
    environment: "local",
    event_kind: "prepare",
    compensates_command_id: null as string | null,
    claim_id: id(2),
    property_id: id(1),
    external_property_id: id(3),
    provider: "channex",
    claim_source: "migration",
    claim_created_at: "2026-09-15T00:00:00.000Z",
    source_run_id: `vay1351-${"a".repeat(24)}`,
    source_active: true,
    source_evidence_sha256: hash(),
    payload_sha256: hash(),
    target_before_sha256: hash(),
    target_after_sha256: hash("b"),
    approval_envelope_sha256: hash(),
    executor_principal_sha256: hash(),
    before_state: "historical",
    after_state: "verified_non_active",
  });
  const compensate = (original: ReturnType<typeof prepare>) => ({
    ...original,
    command_id: id(sequence++),
    event_kind: "compensate",
    compensates_command_id: original.command_id,
    before_state: "verified_non_active",
    after_state: "historical",
    target_before_sha256: original.target_after_sha256,
    target_after_sha256: hash("c"),
    approval_envelope_sha256: hash("d"),
    payload_sha256: hash("e"),
  });
  const write = (row: ReturnType<typeof prepare>, db = client) =>
    db.query(
      `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES
    (${Object.keys(row)
      .map((_, i) => `$${i + 1}`)
      .join(",")})`,
      Object.values(row),
    );
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      parsed.hostname !== "127.0.0.1" ||
      !["56636", "56637"].includes(parsed.port) ||
      parsed.pathname !== "/vay2017_transition_fixture" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Dedicated loopback transition fixture required");
    client = new pg.Client({ connectionString: url });
    await client.connect();
    expect(
      (await client.query("SELECT 1 FROM pg_namespace WHERE nspname='identity'")).rowCount,
    ).toBe(0);
    const result = await runMigrations({
      connectionString: url!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(result.failed).toBeNull();
    expect(result.applied).toContain("0214");
    await client.query(
      `INSERT INTO hotel_catalog.properties(id,public_id,display_name)
      VALUES($1,'transition-fixture','Synthetic')`,
      [id(1)],
    );
    await client.query(
      `INSERT INTO pms.channel_binding_claims
      (id,property_id,provider,external_property_id,claim_state,claim_source,created_at)
      VALUES($1,$2,'channex',$3,'historical','migration','2026-09-15T00:00:00Z')`,
      [id(2), id(1), id(3)],
    );
    await client.query(
      `INSERT INTO pms.channel_connections(id,property_id,provider,connection_status)
      VALUES($1,$2,'channex','disconnected')`,
      [id(4), id(1)],
    );
  }, 120_000);
  afterAll(async () => {
    await client?.end();
  });

  it("retains prepare and exact compensation without altering the real binding", async () => {
    const original = prepare();
    await write(original);
    await write(compensate(original));
    const claims = await client.query(
      "SELECT claim_state FROM pms.channel_binding_claims WHERE id=$1",
      [id(2)],
    );
    expect(claims.rows).toEqual([{ claim_state: "historical" }]);
    const connections = await client.query(
      "SELECT connection_status,external_property_id FROM pms.channel_connections WHERE id=$1",
      [id(4)],
    );
    expect(connections.rows).toEqual([
      { connection_status: "disconnected", external_property_id: null },
    ]);
    expect((await client.query("SELECT 1 FROM identity.users")).rowCount).toBe(0);
  });
  it.each([
    { source_active: false },
    { source_active: null },
    { event_kind: "activate" },
    { after_state: "active" },
    { before_state: "active" },
    { provider: "custom" },
    { claim_source: "adoption" },
    { target_before_sha256: "invalid" },
    { contract_version: "legacy-owner-internal-setup.v1" },
    { environment: "unknown" },
    { source_run_id: "old" },
    { claim_created_at: "infinity" },
    { compensates_command_id: id(100) },
  ])("rejects invalid metadata %j", async (change) => {
    await expect(
      write({ ...prepare(), ...change } as ReturnType<typeof prepare>),
    ).rejects.toThrow();
  });
  it.each([
    "17621565-40b5-4ebc-8727-3a301ac947a2",
    "46906724-72cb-4acf-a2eb-b740a3bdbcf7",
    "65f6b2fc-c783-4963-9d6b-a85f82319769",
    "8f4c1e47-3de1-4150-8bde-ad031a013842",
  ])("rejects protected key in either pair position: %s", async (key) => {
    for (const field of ["property_id", "external_property_id"])
      await expect(write({ ...prepare(), [field]: key })).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects missing claim and retains the original claim against deletion", async () => {
    await expect(write({ ...prepare(), claim_id: id(99) })).rejects.toMatchObject({
      code: "23503",
    });
    await write(prepare());
    await expect(
      client.query("DELETE FROM pms.channel_binding_claims WHERE id=$1", [id(2)]),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects compensation lineage drift, duplicate compensation and compensation-of-compensation", async () => {
    const original = prepare();
    await write(original);
    for (const change of [
      { compensates_command_id: id(99) },
      { claim_id: id(99) },
      { property_id: id(99) },
      { external_property_id: id(99) },
      { environment: "staging" },
      { source_run_id: `vay1351-${"b".repeat(24)}` },
      { source_evidence_sha256: hash("b") },
      { target_before_sha256: hash("c") },
      { claim_created_at: "2026-09-16T00:00:00.000Z" },
    ])
      await expect(write({ ...compensate(original), ...change })).rejects.toMatchObject({
        code: "23514",
      });
    const undo = compensate(original);
    await write(undo);
    await expect(write(compensate(original))).rejects.toMatchObject({ code: "23505" });
    await expect(write(compensate(undo))).rejects.toMatchObject({ code: "23514" });
  });
  it("blocks update/delete/truncate and grants nothing to PUBLIC", async () => {
    for (const sql of [
      `UPDATE ${table} SET payload_sha256=repeat('b',64)`,
      `DELETE FROM ${table}`,
      `TRUNCATE ${table}`,
    ])
      await expect(client.query(sql)).rejects.toThrow();
    const acl = await client.query(
      `SELECT count(*)::int AS n FROM pg_class c,
      aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=$1::regclass AND a.grantee=0`,
      [table],
    );
    expect(acl.rows[0].n).toBe(0);
  });
  it("rolls back a simulated claim change with a failed receipt", async () => {
    const event = prepare();
    await client.query("BEGIN");
    try {
      await client.query(
        "UPDATE pms.channel_binding_claims SET claim_state='verified_non_active' WHERE id=$1",
        [id(2)],
      );
      await expect(write({ ...event, payload_sha256: "bad" })).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK");
    }
    expect(
      (await client.query(`SELECT 1 FROM ${table} WHERE command_id=$1`, [event.command_id]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await client.query("SELECT claim_state FROM pms.channel_binding_claims WHERE id=$1", [
          id(2),
        ])
      ).rows[0].claim_state,
    ).toBe("historical");
  });
  it("primary key arbitrates racing duplicate commands without overwrite", async () => {
    const other = new pg.Client({ connectionString: url });
    await other.connect();
    try {
      const event = prepare();
      const results = await Promise.allSettled([
        write(event),
        write({ ...event, payload_sha256: hash("b") }, other),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(failed.reason.code).toBe("23505");
    } finally {
      await other.end();
    }
  });
});
