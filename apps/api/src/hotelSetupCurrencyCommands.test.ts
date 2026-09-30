import { parseUpsertPropertyPricingCurrencyCommand } from "@vayada/domain-pms";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPgPmsPricingCommandRepository } from "./domains/pmsPricingCommandRepository.js";
import { createHotelSetupCurrencyCommands } from "./hotelSetupCurrencyCommands.js";

vi.mock("./domains/pmsPricingCommandRepository.js", () => ({
  createPgPmsPricingCommandRepository: vi.fn(),
}));

const propertyId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const login = "vayada_next_hotel_setup_property_ready_test";
const password = "password-with-32-or-more-characters%40@?#:/\\ +";
const scope = { databaseLogin: login, propertyId, organizationId, operation: "currency_ready" };
const command = parseUpsertPropertyPricingCurrencyCommand({
  propertyId,
  organizationId,
  currency: "EUR",
  expectedPricingCurrencyRevision: 0,
  idempotencyKey: "first-currency",
  audit: {
    actor: { kind: "user", userId: organizationId },
    requestId: "request-test",
    correlationId: null,
    requestedAt: "2026-09-30T12:00:00.000Z",
  },
})!;

beforeEach(() => vi.resetAllMocks());

function fixture() {
  const query = vi.fn().mockResolvedValue({ rows: [scope] });
  const get = vi.fn().mockResolvedValue({ username: login, password });
  const save = vi.fn().mockResolvedValue({ ok: false, error: { code: "setup_scope_unavailable" } });
  const close = vi.fn().mockResolvedValue(undefined);
  vi.mocked(createPgPmsPricingCommandRepository).mockReturnValue({
    upsertPropertyPricingCurrency: save,
    upsertFlexibleRatePlan: vi.fn(),
    close,
  });
  const options = {
    assignments: { query },
    vault: { get },
    databaseEndpoint: "postgresql://db.example.test/target",
    secretPrefix: "vayada/hotel-setup/",
    currencyChangeGuard: { runWithCurrencyChangeGuard: vi.fn() },
  };
  return { query, get, save, close, options, commands: createHotelSetupCurrencyCommands(options) };
}

describe("private hotel setup credential selection", () => {
  it("selects the assigned login and a fixed database endpoint, preserves passwords and closes", async () => {
    const f = fixture();
    await expect(f.commands.upsertPropertyPricingCurrency(command)).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    expect(f.query.mock.calls[0]?.[1]).toEqual([propertyId, organizationId]);
    expect(f.query.mock.calls[0]?.[0]).toContain("scope.operation_class='currency_ready'");
    expect(f.query.mock.calls[0]?.[0]).toContain("organization.status='active'");
    expect(f.query.mock.calls[0]?.[0]).toContain("link.relationship='owner'");
    expect(f.get).toHaveBeenCalledWith("vayada/hotel-setup/" + login);
    const config = vi.mocked(createPgPmsPricingCommandRepository).mock.calls[0]![0];
    const connection = new URL(config.connectionString);
    expect(connection.hostname).toBe("db.example.test");
    expect(connection.pathname).toBe("/target");
    expect(connection.username).toBe(login);
    expect(decodeURIComponent(connection.password)).toBe(password);
    expect([...connection.searchParams]).toEqual([["sslmode", "verify-full"]]);
    expect(config.hotelSetupCurrencyOperation).toBe("currency_ready");
    expect(config.max).toBe(1);
    expect(f.save).toHaveBeenCalledWith(command);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it.each([
    [],
    [scope, scope],
    [{ ...scope, propertyId: organizationId }],
    [{ ...scope, organizationId: propertyId }],
    [{ ...scope, operation: "feature_hub" }],
    [{ ...scope, databaseLogin: "vayada_next_api_runtime" }],
    [{ ...scope, databaseLogin: "vayada_next_hotel_setup_property_" + "x".repeat(64) }],
  ])("rejects missing, ambiguous and mismatched assignments: %j", async (...rows) => {
    const f = fixture();
    f.query.mockResolvedValue({ rows });
    await expect(f.commands.upsertPropertyPricingCurrency(command)).rejects.toThrow(
      "Hotel setup currency command unavailable",
    );
    expect(f.get).not.toHaveBeenCalled();
    expect(createPgPmsPricingCommandRepository).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    "postgresql://owner@db/target",
    { username: "owner", password },
    { username: login, password: "short" },
    { username: login },
    { username: login, password, connectionString: "postgresql://owner@db/target" },
  ])("rejects absent or malformed secrets without a fallback: %j", async (secret) => {
    const f = fixture();
    f.get.mockResolvedValue(secret);
    await expect(f.commands.upsertPropertyPricingCurrency(command)).rejects.toThrow(
      "Hotel setup currency command unavailable",
    );
    expect(createPgPmsPricingCommandRepository).not.toHaveBeenCalled();
  });

  it("refreshes the registry and secret after revocation, without retaining the previous pool", async () => {
    const f = fixture();
    await f.commands.upsertPropertyPricingCurrency(command);
    f.query.mockResolvedValue({ rows: [] });
    await expect(f.commands.upsertPropertyPricingCurrency(command)).rejects.toThrow("unavailable");
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.get).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(createPgPmsPricingCommandRepository).toHaveBeenCalledOnce();
  });

  it.each(["query", "get", "save", "close"] as const)("sanitizes %s failures", async (stage) => {
    const f = fixture();
    f[stage].mockRejectedValue(new Error("sensitive credential detail"));
    await expect(f.commands.upsertPropertyPricingCurrency(command)).rejects.toThrow(
      /^Hotel setup currency command unavailable$/,
    );
    if (stage === "save") expect(f.close).toHaveBeenCalledOnce();
  });

  it.each([
    "https://db.example.test/target",
    "postgresql://owner:password@db/target",
    "postgresql://db/target?user=owner",
    "postgresql://db/target?options=-c%20role=owner",
    "postgresql://db/target?sslmode=disable",
    "postgresql://db/target#override",
    "postgresql://db/",
  ])(
    "rejects caller credentials and connection overrides in the endpoint: %s",
    (databaseEndpoint) => {
      const f = fixture();
      expect(() => createHotelSetupCurrencyCommands({ ...f.options, databaseEndpoint })).toThrow(
        "Invalid hotel setup credential configuration",
      );
      expect(f.query).not.toHaveBeenCalled();
    },
  );
});
