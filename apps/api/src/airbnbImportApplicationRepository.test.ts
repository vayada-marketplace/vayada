import { afterEach, expect, it, vi } from "vitest";
import pg from "pg";
import { createPgAirbnbImportApplicationRepository } from "./domains/airbnbImportApplicationRepository.js";

afterEach(() => vi.restoreAllMocks());
it.each(["success", "execute-error", "receipt-error"])(
  "preserves %s outcome when advisory unlock fails",
  async (outcome) => {
    const original = new Error("application failure");
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_unlock")) throw new Error("unlock failure");
      if (sql.includes("INSERT") && outcome === "receipt-error") throw original;
      if (sql.includes("LEFT JOIN"))
        return {
          rows: [
            {
              sourceId: "10090000-0000-4000-8000-000000000001",
              propertyId: "10090000-0000-4000-8000-000000000002",
              data: { contractVersion: "prepared-hotel-import.v1", property: {}, rooms: [] },
              results: {},
            },
          ],
        };
      return { rows: [] };
    });
    const release = vi.fn();
    vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({ query, release } as never);
    const repository = createPgAirbnbImportApplicationRepository("postgresql://unused");
    const items = [{ itemId: "room:one", status: "applied" as const, resourceId: "one" }];
    try {
      const result = repository.apply(
        { organizationId: "org", actorUserId: "actor", propertyId: "property", sourceId: "source" },
        async () => {
          if (outcome === "execute-error") throw original;
          return items;
        },
      );
      if (outcome === "success") await expect(result).resolves.toEqual(items);
      else await expect(result).rejects.toBe(original);
      expect(release).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      await repository.close();
    }
  },
);
