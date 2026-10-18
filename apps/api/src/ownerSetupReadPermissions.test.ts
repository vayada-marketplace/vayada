import { describe, expect, it, vi } from "vitest";

import { createPgBookingPublicationCommandRepository } from "./domains/bookingPublicationCommandRepository.js";
import {
  createPgHotelCatalogStep1Repository,
  lockHotelCatalogSetupScope,
} from "./domains/hotelCatalogStep1Repository.js";

const organizationId = "a4000000-0000-4000-8000-000000000001";
const propertyId = "a4000000-0000-4000-8000-000000000002";
const actorUserId = "a4000000-0000-4000-8000-000000000003";

describe("owner setup reads with a SELECT-only database role", () => {
  it("uses read-only SQL for the setup route's public Catalog reader", async () => {
    const sql: string[] = [];
    const client = {
      async query(text: string) {
        sql.push(text);
        if (/FOR (?:UPDATE|SHARE|KEY SHARE)|\b(?:INSERT|UPDATE|DELETE)\b/i.test(text))
          throw Object.assign(new Error("permission denied for table properties"), {
            code: "42501",
          });
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const pool = { connect: async () => client, end: async () => {} } as never;
    const catalog = createPgHotelCatalogStep1Repository({
      connectionString: "postgresql://test.invalid/test",
      pool,
    });

    await expect(catalog.getState({ organizationId, propertyId, actorUserId })).resolves.toBeNull();
    expect(
      sql.filter((query) => query === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"),
    ).toHaveLength(1);
    expect(sql.some((query) => query.includes("WHERE property.id = $2::uuid"))).toBe(true);
  });

  it("runs the nested Catalog owner reader without row locks", async () => {
    const sql: string[] = [];
    const client = {
      async query(text: string) {
        sql.push(text);
        if (/FOR (?:UPDATE|SHARE|KEY SHARE)|\b(?:INSERT|UPDATE|DELETE)\b/i.test(text))
          throw Object.assign(new Error("permission denied for table properties"), {
            code: "42501",
          });
        if (text.includes("FROM hotel_catalog.properties property"))
          return { rows: [{ propertyId }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    await expect(
      lockHotelCatalogSetupScope(
        client as never,
        { organizationId, propertyId, actorUserId },
        true,
      ),
    ).resolves.toBe(true);
    expect(sql.some((query) => query.includes("WHERE property.id = $2::uuid"))).toBe(true);
  });

  it("keeps Booking publication review scoped without row-lock privileges", async () => {
    const sql: string[] = [];
    const client = {
      async query(text: string) {
        sql.push(text);
        if (/FOR (?:UPDATE|SHARE|KEY SHARE)|\b(?:INSERT|UPDATE|DELETE)\b/i.test(text))
          throw Object.assign(new Error("permission denied for table properties"), {
            code: "42501",
          });
        if (text.includes("FROM hotel_catalog.properties property"))
          return { rows: [{ lifecycleRevision: 1 }], rowCount: 1 };
        if (text.includes("FROM identity.product_entitlements"))
          return {
            rows: [{ status: "active", resourceProduct: null, startsAt: null, expiresAt: null }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const repository = createPgBookingPublicationCommandRepository({
      connectionString: "postgresql://test.invalid/test",
      pool: { connect: async () => client, end: async () => {} } as never,
      activeContent: { getActive: async () => null },
    });

    await expect(
      repository.getPublicationReview({ organizationId, propertyId, actorUserId }),
    ).resolves.toMatchObject({ propertyId, latestOperation: null });
    expect(sql[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(sql.some((query) => query.includes("WHERE property.id = $2::uuid"))).toBe(true);
    expect(sql.at(-1)).toBe("COMMIT");
  });
});
