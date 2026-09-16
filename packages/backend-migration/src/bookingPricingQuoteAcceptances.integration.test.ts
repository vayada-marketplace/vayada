import { createHash, randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
const url = process.env["TEST_DATABASE_URL"];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
describe.skipIf(!url)("immutable pricing acceptance schema", () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());
  const assertTestDatabase = () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
  };
  async function fixture(client: PoolClient, scope?: { property: string; org: string }) {
    const property = scope?.property ?? randomUUID(),
      org = scope?.org ?? randomUUID();
    if (!scope) {
      await client.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1::uuid,'hotel_group','Acceptance schema',$1::text)",
        [org],
      );
      await client.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Acceptance schema')",
        [property],
      );
    }
    const quoteId = randomUUID(),
      bookingId = randomUUID(),
      receiptId = randomUUID(),
      requestId = randomUUID();
    // Synthetic storage shapes, not a domain-valid quote or an accepted booking flow.
    const quote = {
      version: "stored-pricing-quote.v1",
      quoteId,
      stay: { propertyId: property },
      evidence: { totalMinor: "12345678901234567890" },
    };
    await client.query(
      `INSERT INTO booking.pricing_quotes(id,property_id,organization_id,request_id,request_hash,payload)
      VALUES($1,$2,$3,$4,$5,$6)`,
      [quoteId, property, org, requestId, hash(requestId), { quote }],
    );
    await client.query(
      `INSERT INTO booking.guest_bookings(id,property_id,public_reference,lifecycle_status,
      check_in,check_out,currency) VALUES($1::uuid,$2,$1::text,'draft','2026-10-01','2026-10-02','EUR')`,
      [bookingId, property],
    );
    const fingerprint = hash("command:" + requestId);
    await client.query(
      `INSERT INTO platform.idempotency_keys(id,operation_scope,operation,key_hash,
      request_fingerprint_hash,status,tenant_scope,property_id,expires_at,completed_at,response_status_code,response_body_hash)
      VALUES($1,'booking','booking.pricing_quote.accept',$2,$3,'completed','property',$4,
      clock_timestamp()+interval '1 day',clock_timestamp(),200,$3)`,
      [receiptId, hash(requestId), fingerprint, property],
    );
    const disclosure = JSON.stringify(
      { version: "booking.quote-guest-disclosure.v1", quote, choices: {} },
      null,
      2,
    );
    return {
      property,
      org,
      row: {
        id: randomUUID(),
        property_id: property,
        organization_id: org,
        pricing_quote_id: quoteId,
        guest_booking_id: bookingId,
        command_receipt_id: receiptId,
        request_id: requestId,
        key_hash: hash(requestId),
        request_fingerprint_hash: fingerprint,
        quote_snapshot: quote,
        disclosure_json: disclosure,
        guest_policy_source_revision: randomUUID(),
        disclosure_hash: "sha256:" + hash(disclosure),
        acceptance_command: {
          version: "booking-quote-acceptance.v1",
          requestId,
          quoteId,
          acceptance: { accepted: true },
        },
        inventory_reservation_bundle: {
          contractVersion: "pms-inventory-reservation-bundle.v1",
          owner: "pms",
          receipts: [{ receiptId: randomUUID() }],
        },
        billing_plan_snapshot: "fixed",
        commission_terms_snapshot: {
          bookingEngineFeePercent: 0,
          channelManagerFeePercent: 0,
          affiliatePlatformFeePercent: 5,
          financeConfigUpdatedAt: "2026-09-01T00:00:00Z",
        },
        finance_terms_captured_at: "2026-09-01T00:00:00Z",
      },
    };
  }
  async function insert(client: PoolClient, row: Record<string, unknown>) {
    const keys = Object.keys(row);
    return client.query(
      `INSERT INTO booking.pricing_quote_acceptances(${keys.join(",")})
      VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
      Object.values(row),
    );
  }
  async function rejected(client: PoolClient, query: () => Promise<unknown>, code?: string) {
    await client.query("SAVEPOINT invalid");
    if (code) await expect(query()).rejects.toMatchObject({ code });
    else await expect(query()).rejects.toThrow();
    await client.query("ROLLBACK TO SAVEPOINT invalid");
  }
  it("stores exact immutable quote/disclosure/Finance and rolls back the whole local write set", async () => {
    assertTestDatabase();
    const client = await pool.connect();
    let id: string | undefined, booking: string | undefined, receipt: string | undefined;
    try {
      await client.query("BEGIN");
      const { row } = await fixture(client);
      id = row.id;
      booking = row.guest_booking_id;
      receipt = row.command_receipt_id;
      const before = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
      const saved = (await insert(client, row)).rows[0];
      expect(saved.quote_snapshot).toEqual(row.quote_snapshot);
      expect(saved.disclosure_json).toBe(row.disclosure_json);
      expect(saved.commission_terms_snapshot).toEqual(row.commission_terms_snapshot);
      expect(saved.accepted_at.valueOf()).toBeGreaterThanOrEqual(before.valueOf());
      for (const sql of [
        "UPDATE booking.pricing_quote_acceptances SET disclosure_json='changed' WHERE id=$1",
        "DELETE FROM booking.pricing_quote_acceptances WHERE id=$1",
      ])
        await rejected(client, () => client.query(sql, [id]));
      await rejected(client, () =>
        client.query("TRUNCATE booking.pricing_quote_acceptances CASCADE"),
      );
      await rejected(client, () =>
        client.query("UPDATE platform.idempotency_keys SET status='expired' WHERE id=$1", [
          receipt,
        ]),
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    for (const [table, value] of [
      ["booking.pricing_quote_acceptances", id],
      ["booking.guest_bookings", booking],
      ["platform.idempotency_keys", receipt],
    ])
      expect((await pool.query(`SELECT id FROM ${table} WHERE id=$1`, [value])).rowCount).toBe(0);
  });
  it("rejects crossed tenant references, wrong receipt operation/hash/status and malformed evidence", async () => {
    assertTestDatabase();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const own = await fixture(client),
        other = await fixture(client);
      for (const patch of [
        { organization_id: other.org },
        { property_id: other.property },
        { pricing_quote_id: other.row.pricing_quote_id },
        { guest_booking_id: other.row.guest_booking_id },
        { command_receipt_id: other.row.command_receipt_id },
        { request_fingerprint_hash: "a".repeat(64) },
        { key_hash: "a".repeat(64) },
        { disclosure_hash: "sha256:" + "a".repeat(64) },
        { disclosure_json: own.row.disclosure_json + " " },
        { commission_terms_snapshot: {} },
        { commission_terms_snapshot: [] },
        { inventory_reservation_bundle: {} },
        { inventory_reservation_bundle: { ...own.row.inventory_reservation_bundle, receipts: [] } },
        { disclosure_json: "{}", disclosure_hash: "sha256:" + hash("{}") },
        { disclosure_json: "invalid", disclosure_hash: "sha256:" + hash("invalid") },
        { billing_plan_snapshot: "unknown" },
        { finance_terms_captured_at: null },
        { finance_terms_captured_at: "9999-01-01" },
        { quote_snapshot: { ...own.row.quote_snapshot, evidence: { totalMinor: "0" } } },
        { acceptance_command: { ...own.row.acceptance_command, requestId: "changed" } },
        { acceptance_command: {} },
        { quote_snapshot: {} },
      ])
        await rejected(client, () => insert(client, { ...own.row, ...patch }));
      for (const patch of [
        "operation='legacy.checkout'",
        "operation_scope='pms'",
        "status='in_progress'",
        "key_hash='wrong'",
        "request_fingerprint_hash='wrong'",
      ]) {
        await client.query("SAVEPOINT receipt");
        await client.query(`UPDATE platform.idempotency_keys SET ${patch} WHERE id=$1`, [
          own.row.command_receipt_id,
        ]);
        await rejected(client, () => insert(client, own.row));
        await client.query("ROLLBACK TO SAVEPOINT receipt");
      }
      expect((await insert(client, own.row)).rowCount).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("enforces quote, booking and receipt uniqueness independently", async () => {
    assertTestDatabase();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const first = await fixture(client),
        next = await fixture(client, first);
      await insert(client, first.row);
      const disclosure = JSON.stringify({
        ...JSON.parse(next.row.disclosure_json),
        quote: first.row.quote_snapshot,
      });
      await rejected(
        client,
        () =>
          insert(client, {
            ...next.row,
            pricing_quote_id: first.row.pricing_quote_id,
            quote_snapshot: first.row.quote_snapshot,
            disclosure_json: disclosure,
            disclosure_hash: "sha256:" + hash(disclosure),
            acceptance_command: {
              ...next.row.acceptance_command,
              quoteId: first.row.pricing_quote_id,
            },
          }),
        "23505",
      );
      await rejected(
        client,
        () => insert(client, { ...next.row, guest_booking_id: first.row.guest_booking_id }),
        "23505",
      );
      await rejected(
        client,
        () =>
          insert(client, {
            ...next.row,
            command_receipt_id: first.row.command_receipt_id,
            request_id: first.row.request_id,
            key_hash: first.row.key_hash,
            request_fingerprint_hash: first.row.request_fingerprint_hash,
            acceptance_command: { ...next.row.acceptance_command, requestId: first.row.request_id },
          }),
        "23505",
      );
      expect((await insert(client, next.row)).rowCount).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
