import { describe, expect, it, vi } from "vitest";

import { seedPendingHotelFinancialsCategories } from "./domains/financeStarterCategories.js";
import { createPgPmsPricingCommandRepository } from "./domains/pmsPricingCommandRepository.js";
import { parseUpsertPropertyPricingCurrencyCommand } from "@vayada/domain-pms";

const propertyId = "10000000-0000-4000-8000-000000000002";
const organizationId = "10000000-0000-4000-8000-000000000001";
const at = "2026-09-30T12:00:00.000Z";

describe("first-currency starter categories", () => {
  it("leaves legacy and already configured hotels alone", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await seedPendingHotelFinancialsCategories({ query }, { propertyId, organizationId });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([organizationId, propertyId]);
  });

  it.each([undefined, "currency", "currency_ready"] as const)(
    "only seeds the native readiness path (%s), before audit and commit; failures roll back",
    async (operation) => {
      for (const failure of [null, "categories", "audit"] as const) {
        const queries: string[] = [];
        const release = vi.fn();
        const query = vi.fn(async (sql: string) => {
          queries.push(sql);
          if (sql.includes("platform.hotel_setup_property_operation_allowed"))
            return {
              rows: [
                {
                  sessionUser: "vayada_next_hotel_setup_property_test",
                  currentUser: "vayada_next_hotel_setup_property_test",
                  allowed: true,
                  organizationAllowed: true,
                  safeRole: true,
                },
              ],
              rowCount: 1,
            };
          if (sql.includes("FROM hotel_catalog.properties property"))
            return { rows: [{ id: propertyId }], rowCount: 1 };
          if (sql.includes("newHotelFinancialsDefault"))
            return { rows: [{ id: propertyId }], rowCount: 1 };
          if (sql.includes("FROM identity.product_entitlements"))
            return { rows: [{ status: "active", startsAt: null, expiresAt: null }], rowCount: 1 };
          if (sql.includes("INSERT INTO platform.idempotency_keys"))
            return { rows: [{ id: propertyId, attempt: 1 }], rowCount: 1 };
          if (sql.includes("INSERT INTO pms.property_pricing_settings"))
            return {
              rows: [
                {
                  propertyId,
                  currency: "EUR",
                  pricingCurrencyRevision: 1,
                  createdAt: at,
                  updatedAt: at,
                },
              ],
              rowCount: 1,
            };
          if (sql.includes("FROM finance.expense_categories"))
            return { rows: [{ count: failure === "categories" ? 6 : 7 }], rowCount: 1 };
          if (sql.includes("INSERT INTO platform.domain_events"))
            return { rows: [{ eventId: propertyId }], rowCount: 1 };
          if (failure === "audit" && sql.includes("INSERT INTO platform.product_audit_events"))
            throw new Error("audit unavailable");
          return { rows: [], rowCount: 1 };
        });
        const repository = createPgPmsPricingCommandRepository({
          connectionString: "test",
          hotelSetupCurrencyOperation: operation,
          pool: { connect: async () => ({ query: query as never, release }), end: async () => {} },
          now: () => new Date(at),
          currencyChangeGuard: {
            async runWithCurrencyChangeGuard(_input, guarded) {
              return guarded([]);
            },
          },
        });
        const command = parseUpsertPropertyPricingCurrencyCommand({
          propertyId,
          organizationId,
          currency: "EUR",
          expectedPricingCurrencyRevision: 0,
          idempotencyKey: "first-currency",
          audit: {
            actor: { kind: "user", userId: propertyId },
            requestId: "setup",
            correlationId: null,
            requestedAt: at,
          },
        });
        if (!command) throw new Error("invalid command fixture");
        const run = repository.upsertPropertyPricingCurrency(command);
        const categoryFailure = operation === "currency_ready" && failure === "categories";
        if (categoryFailure || failure === "audit") {
          await expect(run).rejects.toThrow(
            categoryFailure ? "categories incomplete" : "audit unavailable",
          );
          expect(queries.at(-1)).toBe("ROLLBACK");
          expect(queries).not.toContain("COMMIT");
        } else {
          await expect(run).resolves.toMatchObject({ ok: true, response: { outcome: "created" } });
          expect(queries.at(-1)).toBe("COMMIT");
        }
        const categoryIndex = queries.findIndex((sql) =>
          sql.includes("INSERT INTO finance.expense_categories"),
        );
        expect(categoryIndex >= 0).toBe(operation === "currency_ready");
        if (categoryIndex >= 0) {
          expect(categoryIndex).toBeGreaterThan(
            queries.findIndex((sql) => sql.includes("INSERT INTO pms.property_pricing_settings")),
          );
          if (!categoryFailure)
            expect(categoryIndex).toBeLessThan(
              queries.findIndex((sql) => sql.includes("INSERT INTO platform.product_audit_events")),
            );
        }
        expect(release).toHaveBeenCalledTimes(2);
        expect(queries.some((sql) => /UPDATE identity.product_entitlements/.test(sql))).toBe(false);
      }
    },
  );
});
