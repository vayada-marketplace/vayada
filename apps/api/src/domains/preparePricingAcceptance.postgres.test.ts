import pg, { type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { preparationFixture } from "./preparePricingAcceptance.fixtures.js";
import { preparePricingAcceptance } from "./preparePricingAcceptance.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { lockCurrentQuoteGuestDisclosure } from "./currentQuoteGuestDisclosure.js";
import { lockFinancePricingAcceptanceTerms } from "./financePricingAcceptanceTerms.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
vi.mock("./currentQuoteRevalidation.js", () => ({ lockCurrentQuoteRevalidation: vi.fn() }));
vi.mock("./currentQuoteGuestDisclosure.js", () => ({ lockCurrentQuoteGuestDisclosure: vi.fn() }));
vi.mock("./financePricingAcceptanceTerms.js", () => ({
  lockFinancePricingAcceptanceTerms: vi.fn(),
}));
const url = process.env.TEST_DATABASE_URL;
// Real property advisory lock, receipt/replay SQL and transactions; authority
// discovery and fresh pricing/disclosure/Finance owners are mocked.
describe.skipIf(!url)("acceptance preparation PostgreSQL", () => {
  it("waits for a competing property command and can retry after its full rollback", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    vi.resetAllMocks();
    const f = preparationFixture(),
      scope = f.current.scope;
    vi.mocked(lockPublicPricingAuthority).mockImplementation(async (client) => {
      await lockPmsInventoryMutationScope(client, scope.propertyId);
      return scope;
    });
    vi.mocked(lockCurrentQuoteRevalidation).mockResolvedValue(f.current);
    vi.mocked(lockCurrentQuoteGuestDisclosure).mockResolvedValue(f.disclosure);
    vi.mocked(lockFinancePricingAcceptanceTerms).mockResolvedValue(f.finance);
    const a = new pg.Client({ connectionString: url }),
      b = new pg.Client({ connectionString: url }),
      observer = new pg.Client({ connectionString: url });
    await Promise.all([a.connect(), b.connect(), observer.connect()]);
    let competing: Promise<unknown> | undefined;
    try {
      await observer.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,($1::uuid)::text,'Synthetic preparation')",
        [scope.propertyId],
      );
      await a.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await b.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await b.query("SET LOCAL statement_timeout='5s'");
      const first = await preparePricingAcceptance(a as unknown as PoolClient, "hotel", f.input);
      expect(first.kind).toBe("fresh");
      const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      competing = preparePricingAcceptance(b as unknown as PoolClient, "hotel", f.input);
      // Attach rejection handler immediately while the observer verifies the wait.
      const outcome = competing.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = (
          await observer.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])
        ).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(
        (
          await observer.query(
            "SELECT count(*)::int AS n FROM platform.idempotency_keys WHERE property_id=$1",
            [scope.propertyId],
          )
        ).rows[0].n,
      ).toBe(0);
      await a.query("ROLLBACK");
      expect(await outcome).toMatchObject({ value: { kind: "fresh" } });
      const rows = (
        await b.query(
          "SELECT status,operation,request_fingerprint_hash FROM platform.idempotency_keys WHERE property_id=$1",
          [scope.propertyId],
        )
      ).rows;
      expect(rows).toEqual([
        {
          status: "in_progress",
          operation: "booking.pricing_quote.accept",
          request_fingerprint_hash: f.command.fingerprint.slice(7),
        },
      ]);
      // An incomplete receipt cannot be mistaken for a completed booking replay.
      await expect(
        preparePricingAcceptance(b as unknown as PoolClient, "hotel", f.input),
      ).rejects.toThrow("unavailable");
      await b.query("ROLLBACK");
      expect(
        (
          await observer.query(
            "SELECT count(*)::int AS n FROM platform.idempotency_keys WHERE property_id=$1",
            [scope.propertyId],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await a.query("ROLLBACK");
      await competing?.catch(() => undefined);
      await b.query("ROLLBACK");
      await observer.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [scope.propertyId]);
      await Promise.all([a.end(), b.end(), observer.end()]);
    }
  });
});
