import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { affiliateDestinationSafetyLockKey } from "../domains/bookingAffiliateDestinationSafetyLock.js";
import {
  createTargetBookingCustomDomainRepository,
  type BookingCustomDomainPool,
} from "./bookingCustomDomain.js";

const propertyId = "15060000-0000-4000-8000-000000000001";

describe("target booking custom-domain repository", () => {
  it("serializes domain upsert and deletion with affiliate destination approval", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: BookingCustomDomainPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ) {
        queries.push({ text, values });
        if (text.startsWith("SELECT property.id"))
          return { rows: [{ propertyId } as unknown as T] };
        if (text.includes("WHERE hostname = $1")) return { rows: [] };
        return {
          rows: [
            {
              propertyId,
              domain: "book.hotel.example",
              verificationStatus: "pending",
              verifiedAt: null,
              updatedAt: new Date(),
            } as unknown as T,
          ],
        };
      },
      async end() {},
    };
    const repository = createTargetBookingCustomDomainRepository({
      connectionString: "postgres://target",
      pool,
    });

    await repository.upsertForPropertyId(propertyId, "book.hotel.example");
    await repository.deleteForPropertyId(propertyId);

    const lockKey = affiliateDestinationSafetyLockKey(propertyId);
    expect(queries[2]!.text).toContain("pg_advisory_xact_lock(hashtextextended($3,0))");
    expect(queries[2]!.values).toEqual([propertyId, "book.hotel.example", lockKey]);
    expect(queries[3]!.text).toContain("pg_advisory_xact_lock(hashtextextended($2,0))");
    expect(queries[3]!.values).toEqual([propertyId, lockKey]);
  });
});
