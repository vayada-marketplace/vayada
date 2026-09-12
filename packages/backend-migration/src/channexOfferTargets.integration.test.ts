import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Channex offer target storage", () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());
  async function fixture() {
    assertSafeTestDatabase(url!);
    const property = randomUUID(),
      connection = randomUUID(),
      room = randomUUID();
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Target test')",
      [property],
    );
    await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Room')", [
      room,
      property,
    ]);
    await pool.query(
      "INSERT INTO pms.channel_connections(id,property_id,provider) VALUES($1,$2,'channex')",
      [connection, property],
    );
    const generation = (
      await pool.query("SELECT binding_generation FROM pms.channel_connections WHERE id=$1", [
        connection,
      ])
    ).rows[0].binding_generation as string;
    const target = async (offer: string = randomUUID()) =>
      (
        await pool.query(
          "INSERT INTO pms.channex_offer_targets(property_id,connection_id,room_type_id,offer_id) VALUES($1,$2,$3,$4) RETURNING id",
          [property, connection, room, offer],
        )
      ).rows[0].id as string;
    const intent = async (id: string) =>
      (
        await pool.query(
          'INSERT INTO pms.channex_offer_target_intents(target_id,operation_key,proposal) VALUES($1,$2,\'{"currency":"EUR"}\') RETURNING id,version',
          [id, randomUUID()],
        )
      ).rows[0];
    const seal = (
      id: string,
      i: { id: string; version: string },
      external: string = randomUUID(),
    ) =>
      pool.query(
        `INSERT INTO pms.channex_offer_target_versions
      (target_id,version,intent_id,binding_generation,external_property_id,external_room_type_id,external_rate_plan_id,configuration,readback_evidence)
      VALUES($1,$2,$3,$7,$4,$5,$6,'{"currency":"EUR"}','{"verified":true}')`,
        [id, i.version, i.id, property, room, external, generation],
      );
    const createAttempt = async (
      id: string,
      i: { id: string; version: string },
      correlation?: { jobAttempt: string; worker: string },
    ) =>
      (
        await pool.query(
          `INSERT INTO pms.channex_offer_create_attempts
        (target_id,intent_id,version,binding_generation,external_property_id,external_room_type_id,request_body,job_attempt_id,worker_id)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
          [
            id,
            i.id,
            i.version,
            generation,
            property,
            room,
            JSON.stringify({ rate_plan: { property_id: property, room_type_id: room } }),
            correlation?.jobAttempt ?? null,
            correlation?.worker ?? null,
          ],
        )
      ).rows[0];
    return { property, connection, room, generation, target, intent, seal, createAttempt };
  }
  it("allocates retained versions, seals atomically and preserves active history on failure", async () => {
    const f = await fixture(),
      t = await f.target(),
      first = await f.intent(t),
      external = randomUUID();
    expect(first.version).toBe("1");
    await f.seal(t, first, external);
    expect(
      (
        await pool.query(
          "SELECT binding_generation FROM pms.channex_offer_target_versions WHERE target_id=$1",
          [t],
        )
      ).rows[0].binding_generation,
    ).toBe(f.generation);
    await pool.query("UPDATE pms.channex_offer_targets SET active_version=1 WHERE id=$1", [t]);
    const second = await f.intent(t);
    expect(second.version).toBe("2");
    await pool.query("UPDATE pms.channex_offer_target_intents SET status='failed' WHERE id=$1", [
      second.id,
    ]);
    const third = await f.intent(t);
    expect(third.version).toBe("3");
    await f.seal(t, third, external);
    expect(
      (await pool.query("SELECT active_version FROM pms.channex_offer_targets WHERE id=$1", [t]))
        .rows[0].active_version,
    ).toBe("1");
    expect(
      (
        await pool.query("SELECT status FROM pms.channex_offer_target_intents WHERE id=$1", [
          third.id,
        ])
      ).rows[0].status,
    ).toBe("sealed");
    await expect(
      pool.query(
        "UPDATE pms.channex_offer_target_versions SET external_rate_plan_id='changed' WHERE target_id=$1",
        [t],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM pms.channex_offer_target_versions WHERE target_id=$1", [t]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM pms.channex_external_rate_owners WHERE connection_id=$1", [
        f.connection,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE pms.channex_offer_target_intents SET status='pending' WHERE id=$1", [
        second.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE pms.channex_offer_targets SET next_version=1 WHERE id=$1", [t]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("enforces scope and does not select another target's active version", async () => {
    const f = await fixture(),
      g = await fixture(),
      t = await f.target("same"),
      u = await f.target();
    await expect(f.target("same")).rejects.toMatchObject({ code: "23505" });
    await expect(f.target(" ")).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "INSERT INTO pms.channex_offer_targets(property_id,connection_id,room_type_id,offer_id) VALUES($1,$2,$3,'foreign')",
        [f.property, g.connection, f.room],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query(
        "INSERT INTO pms.channex_offer_targets(property_id,connection_id,room_type_id,offer_id) VALUES($1,$2,$3,'foreign')",
        [f.property, f.connection, g.room],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await f.seal(u, await f.intent(u));
    await expect(
      pool.query("UPDATE pms.channex_offer_targets SET active_version=1 WHERE id=$1", [t]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query("UPDATE pms.channex_offer_targets SET offer_id='retarget' WHERE id=$1", [t]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("serializes competing pending intents and external rate claims", async () => {
    const f = await fixture(),
      t = await f.target();
    const pending = await Promise.allSettled([f.intent(t), f.intent(t)]);
    expect(pending.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(pending.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "23505" },
    });
    const u = await f.target(),
      v = await f.target(),
      ui = await f.intent(u),
      vi = await f.intent(v),
      external = randomUUID();
    const sealed = await Promise.allSettled([f.seal(u, ui, external), f.seal(v, vi, external)]);
    expect(sealed.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(sealed.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "23514" },
    });
    const loser = sealed[0].status === "rejected" ? ui : vi;
    expect(
      (
        await pool.query("SELECT status FROM pms.channex_offer_target_intents WHERE id=$1", [
          loser.id,
        ])
      ).rows[0].status,
    ).toBe("pending");
  });
  it("rejects an incomplete seal and preserves pending identity until success", async () => {
    const f = await fixture(),
      t = await f.target(),
      i = await f.intent(t);
    await expect(
      pool.query("UPDATE pms.channex_offer_target_intents SET status='sealed' WHERE id=$1", [i.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE pms.channex_offer_target_intents SET proposal='{}' WHERE id=$1", [i.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(f.seal(t, i, "")).rejects.toMatchObject({ code: "23514" });
    await f.seal(t, i);
  });
  it("prevents legacy and replacement stores from claiming each other's provider rate", async () => {
    const f = await fixture(),
      rate = randomUUID(),
      legacy = randomUUID(),
      external = randomUUID();
    await pool.query(
      "INSERT INTO pms.rate_plans(id,property_id,room_type_id,code,currency,name) VALUES($1,$2,$3,'retained','EUR','Retained')",
      [rate, f.property, f.room],
    );
    const old = (id: string, ext: string) =>
      pool.query(
        `INSERT INTO pms.channel_rate_plan_mappings
      (id,property_id,connection_id,room_type_id,rate_plan_id,channel,external_room_type_id,external_rate_plan_id)
      VALUES($1::uuid,$2,$3,$4::uuid,$5,$1::text,$4::text,$6)`,
        [id, f.property, f.connection, f.room, rate, ext],
      );
    await old(legacy, external);
    // Match the production retry: INSERT generates a new UUID before conflict resolution.
    await pool.query(
      `INSERT INTO pms.channel_rate_plan_mappings
       (property_id,connection_id,room_type_id,rate_plan_id,channel,external_room_type_id,external_rate_plan_id)
       SELECT property_id,connection_id,room_type_id,rate_plan_id,channel,external_room_type_id,external_rate_plan_id
       FROM pms.channel_rate_plan_mappings WHERE id=$1
       ON CONFLICT(connection_id,rate_plan_id,channel) DO UPDATE SET status=EXCLUDED.status`,
      [legacy],
    );
    const t = await f.target(),
      i = await f.intent(t);
    await expect(f.seal(t, i, external)).rejects.toMatchObject({ code: "23514" });
    const owned = randomUUID();
    await f.seal(t, i, owned);
    await expect(old(randomUUID(), owned)).rejects.toMatchObject({ code: "23514" });
    await pool.query("DELETE FROM pms.channel_rate_plan_mappings WHERE id=$1", [legacy]);
    await old(legacy, external);
    await pool.query("DELETE FROM pms.channel_rate_plan_mappings WHERE id=$1", [legacy]);
    // Reusing the UUID must not transfer its provider identity to a different channel.
    await expect(
      pool.query(
        `INSERT INTO pms.channel_rate_plan_mappings
       (id,property_id,connection_id,room_type_id,rate_plan_id,channel,external_room_type_id,external_rate_plan_id)
       VALUES($1,$2,$3,$4::uuid,$5,'retarget',$4::text,$6)`,
        [legacy, f.property, f.connection, f.room, rate, external],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const retainedTarget = await f.target();
    await expect(
      f.seal(retainedTarget, await f.intent(retainedTarget), external),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(old(randomUUID(), external)).rejects.toMatchObject({ code: "23514" });
  });
  it("retains unresolved creation across failed intents and competing retries", async () => {
    const f = await fixture(),
      target = await f.target(),
      intent = await f.intent(target);
    const starts = await Promise.allSettled([
      f.createAttempt(target, intent),
      f.createAttempt(target, intent),
    ]);
    expect(starts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(starts.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "23505" },
    });
    const attempt = (
      await pool.query("SELECT * FROM pms.channex_offer_create_attempts WHERE intent_id=$1", [
        intent.id,
      ])
    ).rows[0];
    expect(attempt).toMatchObject({
      state: "unresolved",
      external_rate_plan_id: null,
      binding_generation: f.generation,
      external_property_id: f.property,
      external_room_type_id: f.room,
      request_body: { rate_plan: { property_id: f.property, room_type_id: f.room } },
    });
    await pool.query("UPDATE pms.channex_offer_target_intents SET status='failed' WHERE id=$1", [
      intent.id,
    ]);
    const replacement = await f.intent(target);
    await expect(f.createAttempt(target, replacement)).rejects.toMatchObject({ code: "23505" });
    // Knowing the rate ID retains ownership but is not a verified target version.
    const external = randomUUID();
    await pool.query(
      "UPDATE pms.channex_offer_create_attempts SET state='identified',external_rate_plan_id=$2 WHERE id=$1",
      [attempt.id, external],
    );
    expect(
      (
        await pool.query(
          "SELECT owner_kind,owner_id FROM pms.channex_external_rate_owners WHERE connection_id=$1 AND external_rate_plan_id=$2",
          [f.connection, external],
        )
      ).rows[0],
    ).toEqual({ owner_kind: "offer", owner_id: target });
    expect(
      (
        await pool.query("SELECT active_version FROM pms.channex_offer_targets WHERE id=$1", [
          target,
        ])
      ).rows[0].active_version,
    ).toBeNull();
    expect(
      (
        await pool.query("SELECT 1 FROM pms.channex_offer_target_versions WHERE target_id=$1", [
          target,
        ])
      ).rowCount,
    ).toBe(0);
    await f.createAttempt(target, replacement);
  });
  it("requires a matching pending intent and an initially unknown outcome", async () => {
    const f = await fixture(),
      target = await f.target(),
      intent = await f.intent(target),
      other = await f.target();
    await expect(f.createAttempt(other, intent)).rejects.toMatchObject({ code: "23514" });
    await expect(f.createAttempt(target, { ...intent, version: "99" })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      pool.query(
        `INSERT INTO pms.channex_offer_create_attempts
      (target_id,intent_id,version,binding_generation,external_property_id,external_room_type_id,request_body,state,external_rate_plan_id)
      VALUES($1,$2,$3,$4,$5,$6,'{"rate_plan":{}}','identified','claimed')`,
        [target, intent.id, intent.version, f.generation, f.property, f.room],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query("UPDATE pms.channex_offer_target_intents SET status='failed' WHERE id=$1", [
      intent.id,
    ]);
    await expect(f.createAttempt(target, intent)).rejects.toMatchObject({ code: "23514" });
  });
  it("keeps creation scope and request immutable and permits only one identification", async () => {
    const f = await fixture(),
      target = await f.target(),
      intent = await f.intent(target),
      attempt = await f.createAttempt(target, intent);
    for (const assignment of [
      "request_body='{\"changed\":true}'",
      "binding_generation=gen_random_uuid()",
      "external_property_id='other'",
      "external_room_type_id='other'",
      "created_at=created_at+interval '1 second'",
      "id=gen_random_uuid()",
      "version=version+1",
      "intent_id=gen_random_uuid()",
      "target_id=gen_random_uuid()",
    ])
      await expect(
        pool.query(`UPDATE pms.channex_offer_create_attempts SET ${assignment} WHERE id=$1`, [
          attempt.id,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM pms.channex_offer_create_attempts WHERE id=$1", [attempt.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE pms.channex_offer_create_attempts SET state='identified' WHERE id=$1", [
        attempt.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "UPDATE pms.channex_offer_create_attempts SET state='identified',external_rate_plan_id=' ' WHERE id=$1",
        [attempt.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      "UPDATE pms.channex_offer_create_attempts SET state='identified',external_rate_plan_id=$2 WHERE id=$1",
      [attempt.id, randomUUID()],
    );
    await expect(f.createAttempt(target, intent)).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        "UPDATE pms.channex_offer_create_attempts SET state='unresolved',external_rate_plan_id=NULL WHERE id=$1",
        [attempt.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "UPDATE pms.channex_offer_create_attempts SET external_rate_plan_id='other' WHERE id=$1",
        [attempt.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("rolls back identification on competing external ownership", async () => {
    const f = await fixture(),
      left = await f.target(),
      right = await f.target();
    const a = await f.createAttempt(left, await f.intent(left)),
      b = await f.createAttempt(right, await f.intent(right)),
      external = randomUUID();
    const identify = (id: string) =>
      pool.query(
        "UPDATE pms.channex_offer_create_attempts SET state='identified',external_rate_plan_id=$2 WHERE id=$1",
        [id, external],
      );
    const results = await Promise.allSettled([identify(a.id), identify(b.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "23514" },
    });
    const loser = results[0].status === "rejected" ? a : b;
    expect(
      (
        await pool.query(
          "SELECT state,external_rate_plan_id FROM pms.channex_offer_create_attempts WHERE id=$1",
          [loser.id],
        )
      ).rows[0],
    ).toEqual({ state: "unresolved", external_rate_plan_id: null });
    // Retained legacy claims use the same registry and cannot be adopted.
    const legacy = randomUUID();
    await pool.query("SELECT pms.claim_channex_external_rate($1,$2,'legacy',$3,'[]')", [
      f.connection,
      legacy,
      randomUUID(),
    ]);
    await expect(
      pool.query(
        "UPDATE pms.channex_offer_create_attempts SET state='identified',external_rate_plan_id=$2 WHERE id=$1",
        [loser.id, legacy],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  async function correlatedFixture() {
    const f = await fixture(),
      t = await f.target(),
      i = await f.intent(t);
    const job = randomUUID(),
      jobAttempt = randomUUID(),
      worker = randomUUID();
    await pool.query(
      `INSERT INTO platform.jobs(id,job_key,queue_name,job_type,tenant_scope,property_id)
      VALUES($1::uuid,$1::text,'pms_channex_management','pms_channex_management','property',$2)`,
      [job, f.property],
    );
    await pool.query(
      `INSERT INTO platform.job_attempts(id,job_id,attempt_number,worker_id)
      VALUES($1,$2,1,$3)`,
      [jobAttempt, job, worker],
    );
    const a = await f.createAttempt(t, i, { jobAttempt, worker });
    const receipt = (id = randomUUID(), evidence = {}, originalWorker: string = worker) =>
      pool.query(
        `INSERT INTO pms.channex_offer_create_receipts
       (id,attempt_id,job_attempt_id,worker_id,outcome,http_status,identity_evidence,captured_at)
       VALUES($1,$2,$3,$4,'complete_json',201,$5,'2000-01-01') RETURNING *`,
        [id, a.id, jobAttempt, originalWorker, JSON.stringify(evidence)],
      );
    return { ...f, t, i, a, job, jobAttempt, worker, receipt };
  }
  it("retains late correlated observations without identifying or activating", async () => {
    const f = await correlatedFixture();
    await pool.query(
      "UPDATE platform.job_attempts SET status='timed_out',finished_at=now() WHERE id=$1",
      [f.jobAttempt],
    );
    await pool.query("UPDATE pms.channex_offer_target_intents SET status='failed' WHERE id=$1", [
      f.i.id,
    ]);
    await pool.query("UPDATE pms.channel_connections SET binding_generation=$2 WHERE id=$1", [
      f.connection,
      randomUUID(),
    ]);
    const row = (await f.receipt()).rows[0];
    expect(row.captured_at.getUTCFullYear()).toBeGreaterThan(2000);
    expect(row.job_attempt_id).toBe(f.jobAttempt);
    expect(
      (
        await pool.query("SELECT state FROM pms.channex_offer_create_attempts WHERE id=$1", [
          f.a.id,
        ])
      ).rows[0].state,
    ).toBe("unresolved");
    expect(
      (await pool.query("SELECT active_version FROM pms.channex_offer_targets WHERE id=$1", [f.t]))
        .rows[0].active_version,
    ).toBeNull();
  });
  it("rejects cross-property correlation and historical correlation backfill", async () => {
    const f = await correlatedFixture(),
      other = await fixture(),
      t = await other.target(),
      i = await other.intent(t);
    await expect(
      other.createAttempt(t, i, { jobAttempt: f.jobAttempt, worker: f.worker }),
    ).rejects.toMatchObject({ code: "23514" });
    const old = await other.createAttempt(t, i);
    await expect(
      pool.query(
        "UPDATE pms.channex_offer_create_attempts SET job_attempt_id=$2,worker_id=$3 WHERE id=$1",
        [old.id, f.jobAttempt, f.worker],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(f.receipt(randomUUID(), {}, "other-worker")).rejects.toMatchObject({
      code: "23503",
    });
    await expect(
      pool.query(
        `INSERT INTO pms.channex_offer_create_receipts(id,attempt_id,job_attempt_id,worker_id,outcome)
      VALUES($1,$2,$3,$4,'transport_error')`,
        [randomUUID(), old.id, f.jobAttempt, f.worker],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("retains distinct concurrent receipts and prevents duplicate overwrite or deletion", async () => {
    const f = await correlatedFixture(),
      id = randomUUID();
    const results = await Promise.allSettled([
      f.receipt(id, { id: "one" }),
      f.receipt(id, { id: "two" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "23505" },
    });
    await Promise.all([
      f.receipt(randomUUID(), { id: "three" }),
      f.receipt(randomUUID(), { id: "four" }),
    ]);
    expect(
      (
        await pool.query("SELECT id FROM pms.channex_offer_create_receipts WHERE attempt_id=$1", [
          f.a.id,
        ])
      ).rows,
    ).toHaveLength(3);
    await expect(
      pool.query(
        "UPDATE pms.channex_offer_create_receipts SET identity_evidence='{}' WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM pms.channex_offer_create_receipts WHERE id=$1", [id]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects malformed or oversized receipt envelopes", async () => {
    const f = await correlatedFixture();
    await expect(f.receipt(randomUUID(), { value: "x".repeat(8192) })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(f.receipt(randomUUID(), [])).rejects.toMatchObject({ code: "23514" });
    for (const [outcome, status, evidence] of [
      ["unknown", 201, {}],
      ["transport_error", 201, {}],
      ["invalid_json", 200, { id: "partial" }],
      ["complete_json", null, {}],
      ["complete_json", 999, {}],
    ]) {
      await expect(
        pool.query(
          `INSERT INTO pms.channex_offer_create_receipts
        (id,attempt_id,job_attempt_id,worker_id,outcome,http_status,identity_evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), f.a.id, f.jobAttempt, f.worker, outcome, status, JSON.stringify(evidence)],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
  it("serializes receipt capture on its logical target", async () => {
    const f = await correlatedFixture(),
      holder = await pool.connect(),
      writer = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM pms.channex_offer_targets WHERE id=$1 FOR UPDATE", [f.t]);
      await writer.query("SET lock_timeout='100ms'");
      await expect(
        writer.query(
          `INSERT INTO pms.channex_offer_create_receipts
        (id,attempt_id,job_attempt_id,worker_id,outcome) VALUES($1,$2,$3,$4,'transport_error')`,
          [randomUUID(), f.a.id, f.jobAttempt, f.worker],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await holder.query("ROLLBACK");
      await f.receipt();
    } finally {
      await holder.query("ROLLBACK");
      await writer.query("RESET lock_timeout");
      holder.release();
      writer.release();
    }
  });
});
