import { describe, expect, it, vi } from "vitest";

import { createPgBookingPublicationCommandRepository } from "./domains/bookingPublicationCommandRepository.js";
import {
  createPgHotelCatalogStep1Repository,
  lockHotelCatalogSetupScope,
} from "./domains/hotelCatalogStep1Repository.js";
import {
  createPgMarketplaceHotelCollaborationPreferencesRepository,
  lockMarketplaceHotelProfileForSetup,
  readLockedMarketplaceHotelCollaborationPreferences,
} from "./domains/marketplaceHotelCollaborationPreferencesRepository.js";
import { createPgMarketplaceSubmissionRepository } from "./domains/marketplaceSubmissionRepository.js";

const organizationId = "a4000000-0000-4000-8000-000000000001";
const propertyId = "a4000000-0000-4000-8000-000000000002";
const actorUserId = "a4000000-0000-4000-8000-000000000003";

describe("owner setup reads with a SELECT-only database role", () => {
  it("uses read-only SQL for the setup route's public Catalog and Marketplace readers", async () => {
    const sql: string[] = [];
    const client = {
      async query(text: string) {
        sql.push(text);
        if (/FOR (?:UPDATE|SHARE|KEY SHARE)|\b(?:INSERT|UPDATE|DELETE)\b/i.test(text))
          throw Object.assign(new Error("permission denied for table properties"), {
            code: "42501",
          });
        if (text.includes("FROM marketplace.marketplace_hotel_profiles profile"))
          return { rows: [{ property_id: propertyId }], rowCount: 1 };
        if (text.includes("FROM identity.product_entitlements"))
          return {
            rows: [{ status: "active", startsAt: null, expiresAt: null }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const pool = { connect: async () => client, end: async () => {} } as never;
    const catalog = createPgHotelCatalogStep1Repository({
      connectionString: "postgresql://test.invalid/test",
      pool,
    });
    const preferences = createPgMarketplaceHotelCollaborationPreferencesRepository({
      connectionString: "postgresql://test.invalid/test",
      pool,
    });

    await expect(catalog.getState({ organizationId, propertyId, actorUserId })).resolves.toBeNull();
    await expect(
      preferences.getHotelCollaborationPreferences({ organizationId, propertyId }),
    ).resolves.toMatchObject({ outcome: "available" });
    expect(
      sql.filter((query) => query === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"),
    ).toHaveLength(2);
    expect(sql.some((query) => query.includes("WHERE property.id = $2::uuid"))).toBe(true);
  });

  it("runs the nested Marketplace owner readers without row locks", async () => {
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
        if (text.includes("FROM marketplace.marketplace_hotel_profiles profile"))
          return { rows: [{ property_id: propertyId }], rowCount: 1 };
        if (text.includes("FROM identity.product_entitlements"))
          return {
            rows: [{ status: "active", startsAt: null, expiresAt: null }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const audit = {
      requestedAt: new Date().toISOString(),
      actor: { kind: "user" as const, userId: actorUserId },
      requestId: "read-only-test",
      correlationId: "read-only-test",
    };

    await expect(
      lockHotelCatalogSetupScope(
        client as never,
        { organizationId, propertyId, actorUserId },
        true,
      ),
    ).resolves.toBe(true);
    await expect(
      lockMarketplaceHotelProfileForSetup(
        client as never,
        { organizationId, propertyId, audit },
        new Date(),
        true,
      ),
    ).resolves.toBe(true);
    await expect(
      readLockedMarketplaceHotelCollaborationPreferences(
        client as never,
        { organizationId, propertyId },
        new Date(),
        true,
      ),
    ).resolves.toMatchObject({ outcome: "available" });
    expect(sql.some((query) => query.includes("WHERE property.id = $2::uuid"))).toBe(true);
    expect(sql.some((query) => query.includes("WHERE profile.property_id = $2::uuid"))).toBe(true);
  });

  it("keeps Marketplace review scoped and issues no row locks or writes", async () => {
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
        if (text.includes("FROM marketplace.marketplace_hotel_profiles profile"))
          return { rows: [{ property_id: propertyId }], rowCount: 1 };
        if (text.includes("FROM identity.product_entitlements"))
          return {
            rows: [{ status: "active", startsAt: null, expiresAt: null }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const sources = vi.fn(() => ({ getReadiness: async () => ({ status: "blocked" }) }));
    const repository = createPgMarketplaceSubmissionRepository({
      connectionString: "postgresql://test.invalid/test",
      pool: { connect: async () => client, end: async () => {} } as never,
      sources: sources as never,
    });

    await expect(
      repository.getReview({
        organizationId,
        propertyId,
        audit: {
          requestedAt: new Date().toISOString(),
          actor: { kind: "user", userId: actorUserId },
          requestId: "read-only-test",
          correlationId: "read-only-test",
        },
      }),
    ).resolves.toMatchObject({ propertyId, latestSubmission: null });
    expect(sql[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(sql.some((query) => query.includes("WHERE property.id = $2::uuid"))).toBe(true);
    expect(sources).toHaveBeenCalledWith(client, true);
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
