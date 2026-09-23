import { describe, expect, it } from "vitest";

import {
  assertPricingCommandPoolScope,
  assertPricingCommandTransactionScope,
  loadPricingCommandServiceConfig,
} from "./pricingCommandServiceConfig.js";

const env = {
  PRICING_COMMAND_INTERNAL_TOKEN: "internal-token-with-at-least-32-bytes",
  PRICING_COMMAND_PROPERTY_ID: "11111111-1111-4111-8111-111111111111",
  PRICING_COMMAND_HOTEL_SLUG: "synthetic-hotel",
  PRICING_COMMAND_AUTH_DATABASE_URL: "postgresql://identity_reader@db/vayada",
  PRICING_COMMAND_OWNER_READ_DATABASE_URL:
    "postgresql://vayada_next_pricing_hotel_owner_read@db/vayada",
  PRICING_COMMAND_OWNER_MANAGE_DATABASE_URL:
    "postgresql://vayada_next_pricing_hotel_owner_manage@db/vayada",
  PRICING_COMMAND_PUBLIC_DATABASE_URL: "postgresql://vayada_next_pricing_hotel_public@db/vayada",
  PRICING_COMMAND_WORKOS_JWKS_URL: "https://api.workos.com/sso/jwks/client",
  PRICING_COMMAND_WORKOS_ISSUER: "https://api.workos.com",
  PRICING_COMMAND_WORKOS_AUDIENCE: "client",
};

describe("pricing command service config", () => {
  it("loads an isolated owner service configuration", () => {
    expect(loadPricingCommandServiceConfig(env)).toMatchObject({
      host: "0.0.0.0",
      port: 8010,
      propertyId: env.PRICING_COMMAND_PROPERTY_ID,
      hotelSlug: env.PRICING_COMMAND_HOTEL_SLUG,
      authDatabaseUrl: env.PRICING_COMMAND_AUTH_DATABASE_URL,
      ownerReadDatabaseUrl: env.PRICING_COMMAND_OWNER_READ_DATABASE_URL,
      ownerManageDatabaseUrl: env.PRICING_COMMAND_OWNER_MANAGE_DATABASE_URL,
      publicDatabaseUrl: env.PRICING_COMMAND_PUBLIC_DATABASE_URL,
    });
  });

  it("rejects missing, shared and non-pricing operation credentials", () => {
    expect(() => loadPricingCommandServiceConfig({})).toThrow(
      "PRICING_COMMAND_INTERNAL_TOKEN is required",
    );
    expect(() =>
      loadPricingCommandServiceConfig({
        ...env,
        PRICING_COMMAND_OWNER_MANAGE_DATABASE_URL: env.PRICING_COMMAND_OWNER_READ_DATABASE_URL,
      }),
    ).toThrow("distinct PostgreSQL users");
    expect(() =>
      loadPricingCommandServiceConfig({
        ...env,
        PRICING_COMMAND_OWNER_READ_DATABASE_URL: "postgresql://ordinary_api@db/vayada",
      }),
    ).toThrow("pricing-scoped PostgreSQL users");
    expect(() =>
      loadPricingCommandServiceConfig({
        ...env,
        PRICING_COMMAND_PUBLIC_DATABASE_URL: env.PRICING_COMMAND_OWNER_READ_DATABASE_URL,
      }),
    ).toThrow("distinct PostgreSQL users");
  });

  it("preflights the database-owned property and operation assignment", async () => {
    const row = {
      sessionUser: "vayada_next_pricing_hotel_owner_read",
      currentUser: "vayada_next_pricing_hotel_owner_read",
      operationClass: "owner_read",
      propertyId: env.PRICING_COMMAND_PROPERTY_ID,
      organizationId: "22222222-2222-4222-8222-222222222222",
    };
    const pool = (overrides: Partial<typeof row> = {}) => ({
      async query<T>() {
        return { rows: [{ ...row, ...overrides }] as T[] };
      },
    });
    await expect(
      assertPricingCommandPoolScope(pool(), {
        propertyId: env.PRICING_COMMAND_PROPERTY_ID,
        operationClass: "owner_read",
      }),
    ).resolves.toEqual({
      propertyId: env.PRICING_COMMAND_PROPERTY_ID,
      organizationId: row.organizationId,
    });
    for (const overrides of [
      { currentUser: "migration_owner" },
      { operationClass: "owner_manage" },
      { propertyId: "33333333-3333-4333-8333-333333333333" },
    ])
      await expect(
        assertPricingCommandPoolScope(pool(overrides), {
          propertyId: env.PRICING_COMMAND_PROPERTY_ID,
          operationClass: "owner_read",
        }),
      ).rejects.toThrow("scope preflight failed");
  });

  it("pins and verifies organization scope inside an authority transaction", async () => {
    const queries: string[] = [];
    const pool = (organizationId: string) => ({
      async query<T>(text: string) {
        queries.push(text);
        return {
          rows: (text.startsWith("SET TRANSACTION")
            ? []
            : [
                {
                  sessionUser: "vayada_next_pricing_hotel_owner_manage",
                  currentUser: "vayada_next_pricing_hotel_owner_manage",
                  operationClass: "owner_manage",
                  propertyId: env.PRICING_COMMAND_PROPERTY_ID,
                  organizationId,
                },
              ]) as T[],
        };
      },
    });
    const expected = {
      propertyId: env.PRICING_COMMAND_PROPERTY_ID,
      organizationId: "22222222-2222-4222-8222-222222222222",
      operationClass: "owner_manage" as const,
    };
    await expect(
      assertPricingCommandTransactionScope(pool(expected.organizationId), expected),
    ).resolves.toEqual({
      propertyId: env.PRICING_COMMAND_PROPERTY_ID,
      organizationId: expected.organizationId,
    });
    expect(queries[0]).toBe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await expect(
      assertPricingCommandTransactionScope(pool("33333333-3333-4333-8333-333333333333"), expected),
    ).rejects.toThrow("scope preflight failed");
  });
});
