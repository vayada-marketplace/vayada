import { createHash, randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
const url = process.env["TEST_DATABASE_URL"];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

// VAY-2110: a date change appends an amendment; the acceptance itself never changes.
describe.skipIf(!url)("append-only pricing acceptance amendments", () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());
  const assertTestDatabase = () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
  };
  const roomTypeId = randomUUID();
  const rooms = [
    {
      selectionId: "selection-1",
      offerId: "offer-1",
      roomTypeId,
      guests: { adults: 2, childAgesAtCheckIn: [6] },
    },
  ];
  const terms = [
    {
      roomTypeId,
      offerId: "offer-1",
      revision: "terms-1",
      cancellation: { kind: "non_refundable" },
      payment: { kind: "pay_at_property" },
    },
  ];
  type Scope = { property: string; org: string };
  type Quote = { quoteId: string; stay: { checkIn: string; checkOut: string } };
  // Synthetic storage shapes, not a domain-valid quote or an accepted booking flow.
  async function storedQuote(
    client: PoolClient,
    scope: Scope,
    stay: Record<string, unknown>,
    quote: Record<string, unknown> = {},
  ): Promise<Quote> {
    const quoteId = randomUUID(),
      requestId = randomUUID();
    const stored = {
      version: "stored-pricing-quote.v1",
      quoteId,
      paymentMethod: "pay_at_property",
      acceptanceMode: "instant",
      stay: { propertyId: scope.property, currency: "EUR", rooms, ...stay },
      rooms: [{ selectionId: "selection-1", mealPlan: "room_only" }],
      evidence: { totalMinor: "20000", terms },
      ...quote,
    };
    await client.query(
      `INSERT INTO booking.pricing_quotes(id,property_id,organization_id,request_id,request_hash,payload)
      VALUES($1,$2,$3,$4,$5,$6)`,
      [quoteId, scope.property, scope.org, requestId, hash(requestId), { quote: stored }],
    );
    return stored as unknown as Quote;
  }
  // A hold row for the quote's dates; its upstream calendar/event links are not under test.
  async function held(client: PoolClient, scope: Scope, quote: Quote) {
    const receiptId = randomUUID();
    await client.query("SET LOCAL session_replication_role=replica");
    await client.query(
      `INSERT INTO pms.inventory_reservation_receipts(receipt_id,contract_version,receipt_owner,
      organization_id,property_id,room_type_id,check_in,check_out,room_count,quote_session_id,
      public_offer_key,calendar_revision,materialized_revision,reserve_fingerprint_hash,
      reserve_idempotency_key_id,reserve_domain_event_id,reserve_outbox_event_id,reserved_at)
      VALUES($1,'pms-inventory-reservation-lifecycle.v1','pms',$2,$3,$4,$5,$6,1,$7,'offer-1',1,1,$8,
      gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),clock_timestamp())`,
      [
        receiptId,
        scope.org,
        scope.property,
        roomTypeId,
        quote.stay.checkIn,
        quote.stay.checkOut,
        quote.quoteId,
        "sha256:" + hash(receiptId),
      ],
    );
    await client.query("SET LOCAL session_replication_role=origin");
    return {
      contractVersion: "pms-inventory-reservation-bundle.v1",
      owner: "pms",
      receipts: [{ receiptId }],
    };
  }
  async function accepted(client: PoolClient) {
    const property = randomUUID(),
      org = randomUUID(),
      bookingId = randomUUID(),
      receiptId = randomUUID(),
      requestId = randomUUID();
    await client.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1::uuid,'hotel_group','Amendments',$1::text)",
      [org],
    );
    await client.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Amendments')",
      [property],
    );
    const scope = { property, org };
    const quote = await storedQuote(client, scope, {
      checkIn: "2026-11-16",
      checkOut: "2026-11-18",
    });
    await client.query(
      `INSERT INTO booking.guest_bookings(id,property_id,public_reference,lifecycle_status,
      check_in,check_out,currency) VALUES($1::uuid,$2,$1::text,'confirmed','2026-11-16','2026-11-18','EUR')`,
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
    const disclosure = JSON.stringify({
      version: "booking.quote-guest-disclosure.v1",
      quote,
      choices: {},
    });
    const acceptance = (
      await client.query(
        `INSERT INTO booking.pricing_quote_acceptances(property_id,organization_id,pricing_quote_id,
        guest_booking_id,command_receipt_id,request_id,key_hash,request_fingerprint_hash,quote_snapshot,
        disclosure_json,guest_policy_source_revision,disclosure_hash,acceptance_command,
        inventory_reservation_bundle,billing_plan_snapshot,commission_terms_snapshot,finance_terms_captured_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'guest-policy:1',$11,$12,$13,'fixed',$14,'2026-09-01T00:00:00Z')
        RETURNING id`,
        [
          property,
          org,
          quote.quoteId,
          bookingId,
          receiptId,
          requestId,
          hash(requestId),
          fingerprint,
          quote,
          disclosure,
          "sha256:" + hash(disclosure),
          {
            version: "booking-quote-acceptance.v1",
            requestId,
            quoteId: quote.quoteId,
            acceptance: { accepted: true },
          },
          await held(client, scope, quote),
          { bookingEngineFeePercent: 0, financeConfigUpdatedAt: "2026-09-01T00:00:00Z" },
        ],
      )
    ).rows[0].id as string;
    return { scope, bookingId, acceptance, quote };
  }
  async function amend(
    client: PoolClient,
    base: Awaited<ReturnType<typeof accepted>>,
    quote: Quote,
    row: Record<string, unknown> = {},
  ) {
    const values: Record<string, unknown> = {
      acceptance_id: base.acceptance,
      property_id: base.scope.property,
      organization_id: base.scope.org,
      guest_booking_id: base.bookingId,
      revision: 1,
      edit_revision: 1,
      pricing_quote_id: quote.quoteId,
      quote_snapshot: quote,
      inventory_reservation_bundle: await held(client, base.scope, quote),
      source: "host_edit",
      source_id: randomUUID(),
      ...row,
    };
    const keys = Object.keys(values);
    return client.query(
      `INSERT INTO booking.pricing_acceptance_amendments(${keys.join(",")})
      VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
      Object.values(values),
    );
  }
  async function rejected(client: PoolClient, query: () => Promise<unknown>, code?: string) {
    await client.query("SAVEPOINT invalid");
    if (code) await expect(query()).rejects.toMatchObject({ code });
    else await expect(query()).rejects.toThrow();
    await client.query("ROLLBACK TO SAVEPOINT invalid");
  }
  const moveTo = (client: PoolClient, scope: Scope, checkIn: string, checkOut: string) =>
    storedQuote(client, scope, { checkIn, checkOut });

  it("appends date changes in revision order and never changes one", async () => {
    assertTestDatabase();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const base = await accepted(client);
      const moved = await moveTo(client, base.scope, "2026-11-20", "2026-11-23");
      const movedAgain = await moveTo(client, base.scope, "2026-11-21", "2026-11-23");
      // Revisions follow each other: 2 cannot come before 1, and 1 cannot repeat.
      await rejected(client, () => amend(client, base, movedAgain, { revision: 2 }), "23514");
      const first = (await amend(client, base, moved)).rows[0];
      expect(first).toMatchObject({ revision: 1, edit_revision: 1, source: "host_edit" });
      await rejected(client, () => amend(client, base, movedAgain), "23514");
      // The booking's edit revision only moves forward.
      await rejected(
        client,
        () => amend(client, base, movedAgain, { revision: 2, edit_revision: 1 }),
        "23514",
      );
      const second = (
        await amend(client, base, movedAgain, {
          revision: 2,
          edit_revision: 2,
          source: "guest_change_request",
        })
      ).rows[0];
      expect(second.quote_snapshot).toEqual(movedAgain);
      for (const sql of [
        "UPDATE booking.pricing_acceptance_amendments SET edit_revision=9 WHERE id=$1",
        "DELETE FROM booking.pricing_acceptance_amendments WHERE id=$1",
      ])
        await rejected(client, () => client.query(sql, [first.id]));
      await rejected(client, () =>
        client.query("TRUNCATE booking.pricing_acceptance_amendments CASCADE"),
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("refuses an amendment that is not a new stored quote or changes more than dates and prices", async () => {
    assertTestDatabase();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const base = await accepted(client),
        other = await accepted(client);
      const moved = await moveTo(client, base.scope, "2026-11-20", "2026-11-23");
      // Another booking's acceptance, booking or organization.
      await rejected(client, () => amend(client, base, moved, { acceptance_id: other.acceptance }));
      await rejected(client, () =>
        amend(client, base, moved, { guest_booking_id: other.bookingId }),
      );
      await rejected(client, () =>
        amend(client, base, moved, { organization_id: other.scope.org }),
      );
      // The snapshot must be exactly the stored quote it names, and not an accepted quote.
      await rejected(
        client,
        () =>
          amend(client, base, moved, {
            quote_snapshot: { ...moved, evidence: { totalMinor: "1" } },
          }),
        "23514",
      );
      await rejected(client, () => amend(client, base, base.quote), "23514");
      // Rooms, offers, room types, guests, meal plans, booked terms, payment, acceptance mode and
      // currency stay.
      const withTerms = (patch: Record<string, unknown>) => ({
        evidence: { totalMinor: "20000", terms: [{ ...terms[0]!, ...patch }] },
      });
      for (const [stay, quote] of [
        [{ currency: "USD" }, {}],
        [{ rooms: [{ ...rooms[0]!, offerId: "offer-2" }] }, {}],
        [{ rooms: [{ ...rooms[0]!, roomTypeId: randomUUID() }] }, {}],
        [{ rooms: [{ ...rooms[0]!, guests: { adults: 1, childAgesAtCheckIn: [6] } }] }, {}],
        [{ rooms: [{ ...rooms[0]!, guests: { adults: 2, childAgesAtCheckIn: [7] } }] }, {}],
        [{ rooms: [...rooms, { ...rooms[0]!, selectionId: "selection-2" }] }, {}],
        [{}, { rooms: [{ selectionId: "selection-1", mealPlan: "breakfast" }] }],
        [{}, { paymentMethod: "card" }],
        [{}, { acceptanceMode: "request" }],
        [{}, withTerms({ cancellation: { kind: "flexible" } })],
        [{}, withTerms({ payment: { kind: "deposit", basisPoints: 3000 } })],
        [{}, withTerms({ offerId: "offer-2" })],
        [{}, { evidence: { totalMinor: "20000" } }],
      ] as const) {
        const changed = await storedQuote(
          client,
          base.scope,
          { checkIn: "2026-11-20", checkOut: "2026-11-23", ...stay },
          quote,
        );
        await rejected(client, () => amend(client, base, changed), "23514");
      }
      // The holds must be this property's, reserved for this quote and its dates.
      const otherHolds = await held(client, base.scope, other.quote);
      const staleDates = await held(client, base.scope, base.quote);
      for (const bundle of [otherHolds, staleDates])
        await rejected(
          client,
          () => amend(client, base, moved, { inventory_reservation_bundle: bundle }),
          "23514",
        );
      await rejected(client, () =>
        amend(client, base, moved, {
          inventory_reservation_bundle: { ...otherHolds, receipts: [] },
        }),
      );
      await rejected(client, () => amend(client, base, moved, { source: "manual" }));
      await rejected(client, () => amend(client, base, moved, { edit_revision: 0 }));
      // Only a confirmed booking changes its dates.
      await client.query("SAVEPOINT pending");
      await client.query(
        "UPDATE booking.guest_bookings SET lifecycle_status='pending_payment' WHERE id=$1",
        [base.bookingId],
      );
      await rejected(client, () => amend(client, base, moved), "23514");
      await client.query("ROLLBACK TO SAVEPOINT pending");
      // A newer revision of the same cancellation and payment terms is still what was booked.
      const sameTerms = await storedQuote(
        client,
        base.scope,
        { checkIn: "2026-11-20", checkOut: "2026-11-23" },
        withTerms({ revision: "terms-2" }),
      );
      expect((await amend(client, base, sameTerms)).rowCount).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
