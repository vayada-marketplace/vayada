import type { RequestContext } from "@vayada/backend-auth";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPmsChannexManagementCommandPort } from "./pmsChannexManagementCommandStore.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("Test database required");
const user = randomUUID(),
  native = randomUUID(),
  provisioned = randomUUID(),
  imported = randomUUID(),
  bound = randomUUID();

describe.skipIf(!url)("VAY-1362 Channex enable guard for imported hotels", () => {
  const db = new pg.Pool({ connectionString: url });
  const commands = createPgPmsChannexManagementCommandPort({
    connectionString: url ?? "postgresql://disabled",
  });
  const context = {
    actor: { internalUserId: user },
    audit: { requestId: "vay1362", correlationId: "vay1362" },
  } as RequestContext;
  const enable = (propertyId: string) =>
    commands.enqueue(context, propertyId, {
      commandId: randomUUID(),
      idempotencyKey: `vay1362:${propertyId}`,
      operationType: "enable",
    });
  const queued = async (propertyId: string) =>
    (
      await db.query(
        "SELECT count(*)::int AS count FROM platform.jobs WHERE property_id=$1::uuid AND job_type='channex.enable'",
        [propertyId],
      )
    ).rows[0].count;

  beforeAll(async () => {
    await db.query(
      "INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Enable guard tester')",
      [user, `vay1362-${user}@example.test`],
    );
    for (const id of [native, provisioned, imported, bound])
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Enable guard')",
        [id],
      );
    await db.query(
      `INSERT INTO hotel_catalog.property_source_links(property_id,source_system,source_table,source_id,relationship)
       VALUES($1::uuid,'platform','platform_admin_provisioning',$1::text,'canonical_input'),
         ($2::uuid,'pms','hotels',$2::text,'canonical_input'),
         ($2::uuid,'booking','booking_hotels',$2::text,'canonical_input'),
         ($3::uuid,'pms','hotels',$3::text,'canonical_input')`,
      [provisioned, imported, bound],
    );
    // The VAY-2017 historical binding: a migration claim and a disconnected
    // connection retaining the original Channex property.
    const external = randomUUID();
    await db.query(
      `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source)
       VALUES($1,'channex',$2,'historical','migration')`,
      [bound, external],
    );
    await db.query(
      `INSERT INTO pms.channel_connections(property_id,provider,connection_status,connection_metadata)
       VALUES($1,'channex','disconnected',jsonb_build_object('legacyExternalPropertyId',$2::text))`,
      [bound, external],
    );
  });
  afterAll(async () => {
    await commands.close?.();
    await db.end();
  });

  it("queues enable for native hotels exactly as before", async () => {
    for (const propertyId of [native, provisioned]) {
      expect(await enable(propertyId)).toMatchObject({
        ok: true,
        replayed: false,
        operation: { propertyId, status: "queued" },
      });
      expect(await queued(propertyId)).toBe(1);
    }
  });

  it("refuses enable for an imported hotel without a historical binding", async () => {
    expect(await enable(imported)).toEqual({
      ok: false,
      code: "channex_historical_binding_required",
      message:
        "This hotel's existing Channex connection must be restored before it can be enabled.",
    });
    expect(await queued(imported)).toBe(0);
    const reserved = await db.query(
      "SELECT 1 FROM platform.idempotency_keys WHERE property_id=$1::uuid",
      [imported],
    );
    expect(reserved.rowCount).toBe(0);
  });

  it("lets an imported hotel with its historical binding past the guard", async () => {
    const result = await enable(bound);
    expect(result).toMatchObject({ ok: false, code: "channex_binding_exists" });
    expect(await queued(bound)).toBe(0);
  });
});
