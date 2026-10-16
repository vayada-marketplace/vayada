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
const DATABASE = "vayada_booking_web_log_blanking_test";
const BLANKING = "0487_booking_web_events_log_blanking.sql";
const SOURCE = "apps/api-booking-web-public";

// VAY-2212 + VAY-2209/2215: after the copy to distribution.booking_web_events, the append-only
// log keeps no session, properties or request traces for booking-page analytics, and old
// affiliate clicks lose their landing URL, referrer, free metadata and request traces.
describe.skipIf(!URL)("booking web events log blanking 0487", () => {
  it("copies late rows, blanks analytics and strips old clicks, triggers unchanged", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2212-blank-"));
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
        if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) < 487)
          await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run()).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      const triggers = async () =>
        (
          await db.query(
            `SELECT tgrelid::regclass::text AS relation, tgname, tgenabled,
               pg_get_triggerdef(oid) AS definition
             FROM pg_trigger
             WHERE tgrelid IN ('platform.domain_events'::regclass,
                               'platform.product_audit_events'::regclass)
               AND NOT tgisinternal
             ORDER BY 1, 2`,
          )
        ).rows;
      const triggersBefore = await triggers();
      expect(triggersBefore.map((row) => row.tgenabled)).toEqual(["O", "O"]);

      const hotel = randomUUID();
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Blanking hotel')",
        [hotel],
      );

      // A log row and its audit copy, in the shapes the API wrote before VAY-2212. The audit key
      // is the event key, as the writer made it.
      const logged = async (row: {
        source: "distribution" | "marketplace";
        type: string;
        key: string;
        payload: Record<string, unknown>;
        meta: Record<string, unknown>;
        correlation: string;
        audit: { product: string; action: string; target: string };
        property?: string;
        age?: string;
      }) => {
        const id = randomUUID();
        const scope = row.property ? "property" : "external";
        await db.query(
          `INSERT INTO platform.domain_events
             (id,source_system,event_key,event_type,occurred_at,tenant_scope,property_id,
              resource_product,resource_type,resource_id,actor_type,correlation_id,
              idempotency_key_hash,payload,event_metadata)
           VALUES ($1,$2,$3,$4,now() - $5::interval,$6,$7,$2,$8,'blanking-hotel','provider',
             $9,$10,$11,$12)`,
          [
            id,
            row.source,
            row.key,
            row.type,
            row.age ?? "1 day",
            scope,
            row.property ?? null,
            row.audit.target,
            row.correlation,
            `hash-of-${row.key}`,
            JSON.stringify(row.payload),
            JSON.stringify(row.meta),
          ],
        );
        await db.query(
          `INSERT INTO platform.product_audit_events
             (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
              target_resource_product,target_resource_type,target_resource_id,domain_event_id,
              correlation_id,redacted_payload,audit_metadata)
           VALUES ($1,$2,$3,now() - $4::interval,$5,$6,'provider',$2,$7,'blanking-hotel',$8,$9,
             $10,$11)`,
          [
            row.key,
            row.audit.product,
            row.audit.action,
            row.age ?? "1 day",
            scope,
            row.property ?? null,
            row.audit.target,
            id,
            row.correlation,
            JSON.stringify(row.payload),
            JSON.stringify(row.meta),
          ],
        );
        return id;
      };
      const traces = (requestId: string, trafficClass = "human") => ({
        source: SOURCE,
        trafficClass,
        requestId,
        ipAddressHash: "ip-hash",
        userAgentHash: "ua-hash",
      });
      const telemetry = {
        product: "distribution",
        action: "booking_web.telemetry.recorded",
        target: "booking_web_hotel",
      };
      const click = {
        product: "marketplace",
        action: "affiliate_click.recorded",
        target: "affiliate_referral",
      };
      const telemetryKey = (type: string, occurrence: string) =>
        `booking-web:telemetry:${hotel}:blanking-hotel:${type}:${occurrence}`;
      const analytics = async (
        type: string,
        occurrence: string,
        payload: Record<string, unknown>,
        options: { trafficClass?: string; age?: string; correlation?: string } = {},
      ) =>
        logged({
          source: "distribution",
          type: `booking_web.${type}`,
          key: telemetryKey(type, occurrence),
          property: hotel,
          payload,
          meta: traces(`req-${type}`, options.trafficClass),
          correlation: options.correlation ?? String(payload["sessionId"] ?? `req-${type}`),
          audit: telemetry,
          age: options.age,
        });

      // A page visit logged after 0486 (not yet copied), and a rate already copied by then.
      const [visitEvent, visitSession, rateEvent] = [randomUUID(), randomUUID(), randomUUID()];
      const visit = await analytics("page_visit", visitEvent, {
        eventId: visitEvent,
        sessionId: visitSession,
        metadata: { funnelVersion: 1, funnelSequence: 1, nights: 2 },
      });
      await db.query(
        `INSERT INTO distribution.booking_web_events
           (property_id,event_type,event_id,session_id,metadata,occurred_at)
         VALUES ($1,'rate_selected',$2,$3,'{"funnelVersion":1,"funnelSequence":2,"entry":"room_card"}',
           now() - interval '1 day')`,
        [hotel, rateEvent, visitSession],
      );
      const rate = await analytics("rate_selected", rateEvent, {
        eventId: rateEvent,
        sessionId: visitSession,
        metadata: { funnelVersion: 1, funnelSequence: 2, entry: "rooms_form" },
      });
      // Before 2026-09-05 events had no id: the key ended in the request id.
      const oldVisit = await analytics(
        "page_visit",
        "req-old-visit",
        {},
        {
          correlation: "req-old-visit",
        },
      );
      // Blanked but not copied: a bot, and a visit past retention.
      const bot = await analytics("page_visit", randomUUID(), {}, { trafficClass: "bot" });
      const ancient = await analytics("page_visit", randomUUID(), {}, { age: "400 days" });

      // Affiliate clicks: since 2026-09-09 keyed by the click id (one correlated by its request
      // id, one by its session); before that with no click id, keyed by the request id.
      const clickPayload = (clickId: string | undefined, sessionId: string | null) => ({
        ...(clickId ? { clickId } : {}),
        hotelSlug: "blanking-hotel",
        referralCode: "ref-1",
        sessionId,
        landingUrl: "https://blanking-hotel.next-booking.vayada.com/?gclid=abc123&vref=x",
        referrer: "https://www.google.com/search?q=hotel",
        metadata: { utmSource: "newsletter" },
      });
      const v2Key = (clickId: string) =>
        `booking-web:affiliate-click-v2:blanking-hotel:ref-1:${clickId}`;
      const requestClick = await logged({
        source: "marketplace",
        type: "marketplace.affiliate_click.recorded",
        key: v2Key("click-request"),
        payload: clickPayload("click-request", null),
        meta: traces("req-click"),
        correlation: "req-click",
        audit: click,
      });
      const clickSession = randomUUID();
      const sessionClick = await logged({
        source: "marketplace",
        type: "marketplace.affiliate_click.recorded",
        key: v2Key("click-session"),
        payload: clickPayload("click-session", clickSession),
        meta: traces("req-click-2"),
        correlation: clickSession,
        audit: click,
      });
      const oldClick = await logged({
        source: "marketplace",
        type: "marketplace.affiliate_click.recorded",
        key: "booking-web:affiliate-click:blanking-hotel:ref-1:req-old-click",
        payload: clickPayload(undefined, null),
        meta: traces("req-old-click"),
        correlation: "req-old-click",
        audit: click,
      });

      // Unrelated rows with the same keys must not change.
      const unrelated = await logged({
        source: "distribution",
        type: "distribution.other.recorded",
        key: "distribution:other:req-other",
        property: hotel,
        payload: { landingUrl: "https://example.test/", sessionId: visitSession },
        meta: traces("req-other"),
        correlation: "req-other",
        audit: { product: "distribution", action: "other.recorded", target: "booking_web_hotel" },
      });
      const snapshot = async (id: string) =>
        (
          await db.query(
            `SELECT (SELECT to_jsonb(event) FROM platform.domain_events event WHERE id=$1) AS event,
               (SELECT to_jsonb(audit) FROM platform.product_audit_events audit
                WHERE domain_event_id=$1) AS audit`,
            [id],
          )
        ).rows[0];
      const unrelatedBefore = await snapshot(unrelated);

      // While the old writer still logs booking-page events, the migration refuses to run.
      const recent = randomUUID();
      await db.query(
        `INSERT INTO platform.domain_events
           (id,source_system,event_key,event_type,occurred_at,tenant_scope,property_id,
            resource_product,resource_type,resource_id,payload)
         VALUES ($1,'distribution',$3,'booking_web.page_visit',now(),'property',$2,
           'distribution','booking_web_hotel','blanking-hotel','{}')`,
        [recent, hotel, `recent-${recent}`],
      );
      await cp(join(MIGRATIONS, BLANKING), join(before, BLANKING));
      expect((await run()).failed).toBe("0487");
      await db.query("SET session_replication_role = replica");
      await db.query("DELETE FROM platform.domain_events WHERE id=$1", [recent]);
      await db.query("RESET session_replication_role");

      expect((await run()).applied).toEqual(["0487"]);

      // 1. Late rows are copied; an already-copied event keeps its first copy; bots and rows past
      // retention are not copied.
      const copied = new Map(
        (
          await db.query(
            `SELECT event_id AS "eventId", event_type AS "eventType", session_id AS "sessionId",
               metadata
             FROM distribution.booking_web_events WHERE property_id=$1`,
            [hotel],
          )
        ).rows.map((row) => [row.eventId, row]),
      );
      expect(copied).toEqual(
        new Map([
          [
            visitEvent,
            {
              eventId: visitEvent,
              eventType: "page_visit",
              sessionId: visitSession,
              metadata: { funnelVersion: 1, funnelSequence: 1 },
            },
          ],
          [
            rateEvent,
            {
              eventId: rateEvent,
              eventType: "rate_selected",
              sessionId: visitSession,
              metadata: { funnelVersion: 1, funnelSequence: 2, entry: "room_card" },
            },
          ],
          [oldVisit, { eventId: oldVisit, eventType: "page_visit", sessionId: null, metadata: {} }],
        ]),
      );

      const rows = async (id: string) =>
        (
          await db.query(
            `SELECT event.payload, event.event_metadata AS meta, event.correlation_id AS correlation,
               event.event_key AS key, event.idempotency_key_hash AS hash,
               audit.redacted_payload AS "auditPayload", audit.audit_metadata AS "auditMeta",
               audit.correlation_id AS "auditCorrelation", audit.audit_key AS "auditKey"
             FROM platform.domain_events event
             JOIN platform.product_audit_events audit ON audit.domain_event_id = event.id
             WHERE event.id=$1`,
            [id],
          )
        ).rows[0];
      // 2. Analytics rows keep only that an event happened: no session, properties or request
      // traces, also not in the keys.
      for (const [id, trafficClass] of [
        [visit, "human"],
        [rate, "human"],
        [oldVisit, "human"],
        [bot, "bot"],
        [ancient, "human"],
      ] as const)
        expect(await rows(id)).toEqual({
          payload: {},
          meta: { source: SOURCE, trafficClass },
          correlation: null,
          key: `booking-web:telemetry-blanked:${id}`,
          hash: null,
          auditPayload: {},
          auditMeta: { source: SOURCE, trafficClass },
          auditCorrelation: null,
          auditKey: `booking-web:telemetry-blanked:${id}`,
        });

      // 3. Clicks keep their identity; a request-id correlation becomes the click id, or NULL for
      // an old click without one, whose request-id keys are replaced too.
      const kept = (clickId: string | undefined, sessionId: string | null) => ({
        ...(clickId ? { clickId } : {}),
        hotelSlug: "blanking-hotel",
        referralCode: "ref-1",
        sessionId,
      });
      const clickMeta = { source: SOURCE, trafficClass: "human" };
      expect(await rows(requestClick)).toEqual({
        payload: kept("click-request", null),
        meta: clickMeta,
        correlation: "click-request",
        key: v2Key("click-request"),
        hash: `hash-of-${v2Key("click-request")}`,
        auditPayload: kept("click-request", null),
        auditMeta: clickMeta,
        auditCorrelation: "click-request",
        auditKey: v2Key("click-request"),
      });
      expect(await rows(sessionClick)).toEqual({
        payload: kept("click-session", clickSession),
        meta: clickMeta,
        correlation: clickSession,
        key: v2Key("click-session"),
        hash: `hash-of-${v2Key("click-session")}`,
        auditPayload: kept("click-session", clickSession),
        auditMeta: clickMeta,
        auditCorrelation: clickSession,
        auditKey: v2Key("click-session"),
      });
      expect(await rows(oldClick)).toEqual({
        payload: kept(undefined, null),
        meta: clickMeta,
        correlation: null,
        key: `booking-web:affiliate-click-scrubbed:${oldClick}`,
        hash: null,
        auditPayload: kept(undefined, null),
        auditMeta: clickMeta,
        auditCorrelation: null,
        auditKey: `booking-web:affiliate-click-scrubbed:${oldClick}`,
      });

      expect(await snapshot(unrelated)).toEqual(unrelatedBefore);

      // The triggers are back exactly as they were, and the log is append-only again.
      expect(await triggers()).toEqual(triggersBefore);
      await expect(
        db.query("UPDATE platform.domain_events SET payload='{}' WHERE id=$1", [unrelated]),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        db.query("DELETE FROM platform.product_audit_events WHERE domain_event_id=$1", [unrelated]),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 120_000);
});
