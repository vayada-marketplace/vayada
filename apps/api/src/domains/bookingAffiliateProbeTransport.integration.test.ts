import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  context,
  databaseUrl,
  id,
  publicationCommandFixture,
} from "./affiliatePublicationCommandTestFixture.js";
import {
  bindCheckoutValidationProbe,
  resolveCheckoutValidationProbe,
  type AffiliateProbeCheckout,
} from "./bookingAffiliateProbeBinding.js";
import { manageAffiliateValidationProbe } from "./bookingAffiliateValidationProbe.js";

const migrations = new URL("../../../../packages/backend-migration/migrations/", import.meta.url);
const migration = async (name: string) => readFile(new URL(name, migrations), "utf8");
const deployment = {
  environment: "local" as const,
  connectionReference: "isolated-browser-transport",
  adapterVersion: "native-v1",
};
const bookingId = id(40);

describe.skipIf(!databaseUrl)("isolated validation probe browser transport", () => {
  const fixture = publicationCommandFixture();
  let probe: string;

  beforeEach(async () => {
    await fixture.pool().query(`CREATE TABLE booking.guest_bookings(
      id UUID PRIMARY KEY,
      property_id UUID NOT NULL,
      public_reference TEXT NOT NULL UNIQUE,
      lifecycle_status TEXT NOT NULL,
      currency CHAR(3) NOT NULL,
      total_amount NUMERIC(15,2) NOT NULL,
      balance_amount NUMERIC(15,2) NOT NULL,
      booking_metadata JSONB NOT NULL,
      UNIQUE(id,property_id)
    )`);
    await fixture.pool().query(await migration("0212_booking_affiliate_validation_probes.sql"));
    await fixture.pool().query(await migration("0213_booking_affiliate_probe_bindings.sql"));
    await fixture.pool().query(await migration("0195_finance_affiliate_earning_journal.sql"));
    await fixture.pool().query(`CREATE FUNCTION finance.reject_validation_journal_write()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'Validation transport reached Finance';
      END $$;
      CREATE TRIGGER reject_validation_journal_write
      BEFORE INSERT ON finance.affiliate_earning_journal
      FOR EACH ROW EXECUTE FUNCTION finance.reject_validation_journal_write()`);
    const issued = await manageAffiliateValidationProbe(
      fixture.pool(),
      {
        context: context(),
        propertyId: id(3),
        destinationVersionId: id(30),
        action: "create",
        idempotencyKey: "isolated-browser-transport",
        lifetimeSeconds: 3600,
      },
      deployment,
    );
    if (!issued.ok || !("probe" in issued)) throw new Error("Probe creation failed");
    probe = issued.probe;
  });

  const checkout = (): AffiliateProbeCheckout => ({
    ...deployment,
    probe,
    destinationVersionId: id(30),
    freshContext: async () => context(),
  });

  const buildIsolatedTransport = () => {
    const app = Fastify({ logger: false });
    const observedReferers: Array<string | null> = [];
    app.get("/", async (_request, reply) =>
      reply.type("text/html").send("<!doctype html><title>Affiliate validation transport</title>"),
    );
    app.post<{ Body: unknown }>("/validation/booking-binding", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("X-Robots-Tag", "noindex");
      const body = request.body;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.getPrototypeOf(body) !== Object.prototype ||
        Object.keys(body).length !== 1 ||
        !("probe" in body) ||
        body.probe !== probe
      ) {
        return reply.code(400).send({ error: "invalid_validation_probe" });
      }
      observedReferers.push(request.headers.referer ?? null);

      const client = await fixture.pool().connect();
      try {
        await client.query("BEGIN");
        const database = (await client.query("SELECT current_database() AS name")).rows[0]?.name;
        if (typeof database !== "string" || !/(^|[_-])(test|verify)([_-]|$)/i.test(database)) {
          throw new Error("Validation transport requires an isolated test database");
        }
        const probeId = await resolveCheckoutValidationProbe(client, id(3), checkout());
        const existing = (
          await client.query(
            "SELECT probe_id FROM booking.affiliate_validation_booking_bindings WHERE booking_id=$1 AND property_id=$2",
            [bookingId, id(3)],
          )
        ).rows[0];
        if (existing) {
          if (existing.probe_id !== probeId) throw new Error("Synthetic booking scope conflict");
          await client.query("COMMIT");
          return reply.code(200).send({ accepted: true, replayed: true });
        }
        await client.query(
          `INSERT INTO booking.guest_bookings
          (id,property_id,public_reference,lifecycle_status,currency,total_amount,balance_amount,booking_metadata)
          VALUES($1,$2,$3,'draft','EUR',0,0,$4::jsonb)`,
          [
            bookingId,
            id(3),
            `VALIDATION-${createHash("sha256").update(probe).digest("hex").slice(0, 16)}`,
            JSON.stringify({ isTestBooking: true, purpose: "affiliate_validation" }),
          ],
        );
        await bindCheckoutValidationProbe(client, id(3), bookingId, probeId, request.id);
        await client.query("COMMIT");
        return reply.code(201).send({ accepted: true, replayed: false });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
    return { app, observedReferers };
  };

  it("rejects missing, forged and scope-bearing browser input before any write", async () => {
    const { app } = buildIsolatedTransport();
    try {
      for (const payload of [
        {},
        { probe: "avp_forged" },
        { probe, propertyId: id(3) },
        { probe, bookingId },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/validation/booking-binding",
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(
        (await fixture.pool().query("SELECT count(*)::int AS n FROM booking.guest_bookings"))
          .rows[0].n,
      ).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("binds one zero-value synthetic booking atomically and replays without another write", async () => {
    const { app } = buildIsolatedTransport();
    try {
      const responses = await Promise.all(
        [0, 1].map(() =>
          app.inject({
            method: "POST",
            url: "/validation/booking-binding",
            payload: { probe },
          }),
        ),
      );
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
      expect(responses.map((response) => response.json().replayed).sort()).toEqual([false, true]);
      expect(
        (
          await fixture.pool().query(
            `SELECT g.lifecycle_status,g.total_amount,g.balance_amount,g.booking_metadata,b.probe_id
            FROM booking.guest_bookings g
            JOIN booking.affiliate_validation_booking_bindings b ON b.booking_id=g.id
            WHERE g.id=$1`,
            [bookingId],
          )
        ).rows,
      ).toEqual([
        {
          lifecycle_status: "draft",
          total_amount: "0.00",
          balance_amount: "0.00",
          booking_metadata: { isTestBooking: true, purpose: "affiliate_validation" },
          probe_id: probe.slice(4),
        },
      ]);
      expect(
        (
          await fixture
            .pool()
            .query("SELECT count(*)::int AS n FROM finance.affiliate_earning_journal")
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await app.close();
    }
  });

  it.skipIf(process.env["TEST_AFFILIATE_BROWSER"] !== "1")(
    "carries only the opaque probe through Chromium without browser storage",
    async () => {
      const { app, observedReferers } = buildIsolatedTransport();
      const browser = await chromium.launch({ headless: true });
      try {
        const origin = await app.listen({ host: "127.0.0.1", port: 0 });
        const browserContext = await browser.newContext({ serviceWorkers: "block" });
        await browserContext.addInitScript(() => {
          const blocked = () => {
            throw new Error("Storage blocked");
          };
          Object.defineProperty(globalThis, "localStorage", { configurable: true, get: blocked });
          Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: blocked });
          const documentConstructor = Reflect.get(globalThis, "Document") as {
            prototype: object;
          };
          Object.defineProperty(documentConstructor.prototype, "cookie", {
            configurable: true,
            get: blocked,
            set: blocked,
          });
        });
        const page = await browserContext.newPage();
        await page.goto(origin);
        const response = await page.evaluate(async (validationProbe) => {
          const result = await fetch("/validation/booking-binding", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ probe: validationProbe }),
            referrerPolicy: "no-referrer",
          });
          return { status: result.status, body: await result.json() };
        }, probe);
        expect(response).toEqual({
          status: 201,
          body: { accepted: true, replayed: false },
        });
        expect(observedReferers).toEqual([null]);
        expect(await browserContext.cookies()).toEqual([]);
        expect(
          await page.evaluate(() => {
            const denied: boolean[] = [];
            const documentValue = Reflect.get(globalThis, "document") as object;
            for (const access of [
              () => Reflect.get(globalThis, "localStorage"),
              () => Reflect.get(globalThis, "sessionStorage"),
              () => Reflect.get(documentValue, "cookie"),
            ]) {
              try {
                access();
                denied.push(false);
              } catch {
                denied.push(true);
              }
            }
            return denied;
          }),
        ).toEqual([true, true, true]);
      } finally {
        await browser.close();
        await app.close();
      }
    },
  );
});
