import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_booking_web_events_test";
const TABLE = "0486_booking_web_events.sql";

// VAY-2212: booking-page analytics move out of the append-only event log into a table the API can
// prune. The copy keeps what the charts read and nothing that could identify a guest.
describe.skipIf(!URL)("booking web events table 0486", () => {
  it("copies counted history with allowlisted properties only", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2212-"));
    const run = () =>
      runMigrations({
        connectionString: targetUrl.href,
        migrationsDir: before,
        environment: "local",
      });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      for (const file of await readdir(MIGRATIONS))
        if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) < 486)
          await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run()).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();

      const [hotel, other] = [randomUUID(), randomUUID()];
      await target.query(
        `INSERT INTO hotel_catalog.properties(id,public_id,display_name)
         VALUES($1::uuid,$1::text,'Events hotel'),($2::uuid,$2::text,'Other hotel')`,
        [hotel, other],
      );
      // "events-hotel" names one hotel; "shared" names two (per locale), so it can't be resolved.
      await target.query(
        `INSERT INTO hotel_catalog.property_slugs(property_id,slug,locale,purpose)
         VALUES($1,'events-hotel',NULL,'canonical'),($1,'shared','en','redirect'),
               ($2,'shared','de','redirect')`,
        [hotel, other],
      );

      // Each row gets its own time, a day or more ago and later than the row before it, so a
      // retry follows its original and copied times can be checked.
      let minutes = 0;
      const insert = async (row: {
        type: string;
        payload: Record<string, unknown>;
        meta?: Record<string, unknown>;
        property?: string;
        slug?: string;
        source?: string;
        status?: string;
        daysAgo?: number;
      }) => {
        const id = randomUUID();
        minutes += 1;
        const at = new Date(
          Date.now() - (row.daysAgo ?? 1) * 86_400_000 - 3_600_000 + minutes * 60_000,
        );
        await target!.query(
          `INSERT INTO platform.domain_events
             (id,source_system,event_key,event_type,occurred_at,recorded_at,event_status,
              tenant_scope,property_id,resource_product,resource_type,resource_id,actor_type,
              correlation_id,payload,event_metadata)
           VALUES ($1,$2,$12,$3,$4,$4::timestamptz + interval '2 seconds',$5,$6,$7,$2,$8,
             $9,'provider','correlation',$10,$11)`,
          [
            id,
            row.source ?? "distribution",
            row.type,
            at.toISOString(),
            row.status ?? "recorded",
            row.property ? "property" : "external",
            row.property ?? null,
            row.source === "marketplace" ? "affiliate_referral" : "booking_web_hotel",
            row.slug ?? "events-hotel",
            JSON.stringify(row.payload),
            JSON.stringify(row.meta ?? { trafficClass: "human" }),
            `key-${id}`,
          ],
        );
        return { id, at };
      };

      const [eventId, sessionId] = [randomUUID(), randomUUID()];
      const clicked = await insert({
        type: "booking_web.complete_booking_clicked",
        property: hotel,
        payload: {
          eventId,
          sessionId,
          metadata: {
            funnelVersion: 1,
            funnelSequence: 5,
            paymentMethod: "card",
            mode: "instant",
            roomTypeId: "room type @ free text",
            code: 41791234567,
            reason: "JohnSmith",
            entry: ["room_card"],
            nights: 3,
            email: "guest@example.test",
          },
        },
        meta: {
          trafficClass: "human",
          requestId: "req-1",
          ipAddressHash: "ip-hash",
          userAgentHash: "ua-hash",
        },
      });
      // Booleans and listed values survive; an unlisted payment method and an object do not.
      const addons = await insert({
        type: "booking_web.addons_step_passed",
        property: hotel,
        payload: {
          eventId: "not-a-uuid",
          sessionId,
          metadata: {
            funnelVersion: 1,
            funnelSequence: 3,
            extrasShown: true,
            extrasChosen: false,
            paymentMethod: "crypto",
            step: { name: "extras" },
          },
        },
      });
      // Before VAY-2197 a page visit could carry no ids and no hotel id, only its slug.
      const legacyVisit = await insert({ type: "booking_web.page_visit", payload: {} });
      const testVisit = randomUUID();
      const testRow = await insert({
        type: "booking_web.page_visit",
        property: hotel,
        payload: { eventId: testVisit, metadata: { isTestData: true } },
      });
      // A second row with the same event id is a retry, so there is one copy.
      await insert({
        type: "booking_web.complete_booking_clicked",
        property: hotel,
        payload: {
          eventId,
          sessionId,
          metadata: { funnelVersion: 1, funnelSequence: 5, paymentMethod: "card", mode: "instant" },
        },
      });
      // Not copied: bots, ignored events, rows past retention, unresolvable or unknown slugs,
      // other event families and odd type names.
      const skipped = { property: hotel, payload: {} };
      await insert({ type: "booking_web.page_visit", ...skipped, meta: { trafficClass: "bot" } });
      await insert({ type: "booking_web.page_visit", ...skipped, status: "ignored" });
      await insert({ type: "booking_web.page_visit", ...skipped, daysAgo: 400 });
      await insert({ type: "booking_web.page_visit", payload: {}, slug: "shared" });
      await insert({ type: "booking_web.page_visit", payload: {}, slug: "no-such-hotel" });
      await insert({
        type: "marketplace.affiliate_click.recorded",
        source: "marketplace",
        payload: {},
      });
      await insert({ type: "booking_web.Page-Visit", ...skipped });
      const logRows = Number(
        (await target.query("SELECT count(*) FROM platform.domain_events")).rows[0].count,
      );

      await cp(join(MIGRATIONS, TABLE), join(before, TABLE));
      expect((await run()).applied).toEqual(["0486"]);

      const copied = (
        await target.query(
          `SELECT property_id AS "propertyId", event_type AS "eventType", event_id AS "eventId",
             session_id AS "sessionId", metadata, traffic_class AS "trafficClass",
             occurred_at AS "occurredAt", recorded_at - occurred_at = interval '2 seconds' AS "keptRecordedAt"
           FROM distribution.booking_web_events ORDER BY event_type, traffic_class`,
        )
      ).rows;
      const row = (source: { at: Date }, values: Record<string, unknown>) => ({
        propertyId: hotel,
        ...values,
        occurredAt: source.at,
        keptRecordedAt: true,
      });
      expect(copied).toEqual([
        row(addons, {
          eventType: "addons_step_passed",
          eventId: addons.id,
          sessionId,
          metadata: { funnelVersion: 1, funnelSequence: 3, extrasShown: true, extrasChosen: false },
          trafficClass: "human",
        }),
        row(clicked, {
          eventType: "complete_booking_clicked",
          eventId,
          sessionId,
          metadata: { funnelVersion: 1, funnelSequence: 5, paymentMethod: "card", mode: "instant" },
          trafficClass: "human",
        }),
        row(legacyVisit, {
          eventType: "page_visit",
          eventId: legacyVisit.id,
          sessionId: null,
          metadata: {},
          trafficClass: "human",
        }),
        row(testRow, {
          eventType: "page_visit",
          eventId: testVisit,
          sessionId: null,
          metadata: {},
          trafficClass: "test",
        }),
      ]);

      // No column for anything request-derived, and the log itself is untouched.
      const columns = (
        await target.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='distribution' AND table_name='booking_web_events'
           ORDER BY ordinal_position`,
        )
      ).rows.map((column) => column.column_name);
      expect(columns).toEqual([
        "id",
        "property_id",
        "event_type",
        "event_id",
        "session_id",
        "metadata",
        "traffic_class",
        "occurred_at",
        "recorded_at",
      ]);
      expect(
        Number((await target.query("SELECT count(*) FROM platform.domain_events")).rows[0].count),
      ).toBe(logRows);

      // The table is ordinary: rows can be deleted, which the retention job relies on.
      await expect(
        target.query("DELETE FROM distribution.booking_web_events WHERE property_id=$1", [hotel]),
      ).resolves.toMatchObject({ rowCount: 4 });
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 120_000);
});
