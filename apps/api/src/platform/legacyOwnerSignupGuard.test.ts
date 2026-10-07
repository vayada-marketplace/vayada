import type { CreateIdentityUserCommand } from "@vayada/backend-auth";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPgIdentityLifecycleCommandBus } from "./identityLifecycle.js";
import { assertNotBootstrapProtectedUser } from "./legacyOwnerSignupGuard.js";
import { createPgWorkosWebhookStore } from "./workosWebhooks.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const command: CreateIdentityUserCommand = {
  commandType: "identity.user.create",
  commandId: "test-command",
  idempotencyKey: "test-command",
  audit: {
    actor: { kind: "system", service: "test" },
    source: "web",
    requestId: "test-request",
    reason: "Synthetic signup guard test",
    requestedAt: "2026-09-14T00:00:00.000Z",
  },
  payload: {
    email: "synthetic@example.test",
    initialStatus: "active",
    providerIdentity: { provider: "workos", providerUserId: "user_test" },
    organization: { kind: "hotel_group", name: "Synthetic" },
    membership: { roleKey: "hotel_owner", propertyAccessMode: "all" },
  },
};
const webhookInput = {
  workosUserId: "user_test",
  email: "synthetic-new@example.test",
  name: "Changed name",
  emailVerified: true,
  status: "active" as const,
  rawProfile: { id: "user_test" },
};

afterEach(() => vi.restoreAllMocks());

// Exercise real caller ordering with a transaction-client double, not a guard mock.
function fixture(match: "provider" | "email", protection: unknown = true) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("legacy_owner_bootstrap_receipts")) {
      if (protection instanceof Error) throw protection;
      return { rows: [{ protected: protection }] };
    }
    if (sql.includes("SELECT user_id")) {
      return { rows: match === "provider" ? [{ user_id: ownerId }] : [] };
    }
    if (sql.includes("FROM identity.users")) return { rows: [{ id: ownerId }] };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({ query, release } as never);
  return { query, release };
}

function deletedOwnerFixture(protection: unknown = true) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("legacy_owner_bootstrap_receipts")) {
      if (protection instanceof Error) throw protection;
      return { rows: [{ protected: protection }] };
    }
    if (sql.includes("status <> 'deleted'")) return { rows: [] };
    if (sql.includes("FROM identity.users")) return { rows: [{ id: ownerId }] };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({ query, release } as never);
  return { query, release };
}

function expectRolledBackWithoutWrites(query: ReturnType<typeof vi.fn>) {
  const statements = query.mock.calls.map(([sql]) => sql as string);
  expect(statements[0]).toBe("BEGIN");
  expect(statements.at(-1)).toBe("ROLLBACK");
  expect(statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE|COMMIT)\b/.test(sql))).toBe(false);
}

describe("prepared-owner signup guard", () => {
  it.each(["provider", "email"] as const)(
    "denies lifecycle %s reuse before linking or grants",
    async (match) => {
      const { query, release } = fixture(match);
      const bus = createPgIdentityLifecycleCommandBus({ connectionString: "postgresql://unused" });
      await expect(bus.execute(command)).rejects.toThrow(
        "Legacy owner account reconciliation required",
      );
      expect(query).toHaveBeenCalledWith(expect.stringContaining("ANY(owner_user_ids)"), [ownerId]);
      expectRolledBackWithoutWrites(query);
      expect(release).toHaveBeenCalledOnce();
      await bus.close();
    },
  );

  it("denies email reuse without a provider or organization payload", async () => {
    const { query } = fixture("email");
    const bus = createPgIdentityLifecycleCommandBus({ connectionString: "postgresql://unused" });
    await expect(
      bus.execute({
        ...command,
        payload: { email: command.payload.email, initialStatus: "pending" },
      }),
    ).rejects.toThrow("Legacy owner account reconciliation required");
    expectRolledBackWithoutWrites(query);
    await bus.close();
  });

  it("denies a deleted protected owner before it can be recreated", async () => {
    const { query } = deletedOwnerFixture();
    const bus = createPgIdentityLifecycleCommandBus({ connectionString: "postgresql://unused" });
    await expect(
      bus.execute({
        ...command,
        payload: {
          ...command.payload,
          providerIdentity: { provider: "workos", providerUserId: "new_workos_user" },
        },
      }),
    ).rejects.toThrow("Legacy owner account reconciliation required");
    expectRolledBackWithoutWrites(query);
    await bus.close();
  });

  it("denies webhook activation, email, profile and external-identity updates together", async () => {
    const { query, release } = fixture("provider");
    const store = createPgWorkosWebhookStore({ connectionString: "postgresql://unused" });
    await expect(store.upsertWorkosUser(webhookInput)).rejects.toThrow(
      "Legacy owner account reconciliation required",
    );
    expectRolledBackWithoutWrites(query);
    expect(release).toHaveBeenCalledOnce();
    await store.close();
  });

  it.each(["lifecycle", "webhook"] as const)(
    "rolls back %s on inaccessible receipt storage",
    async (caller) => {
      const { query } = fixture("provider", new Error("permission denied: sensitive detail"));
      const bus = createPgIdentityLifecycleCommandBus({ connectionString: "postgresql://unused" });
      const store = createPgWorkosWebhookStore({ connectionString: "postgresql://unused" });
      await expect(
        caller === "lifecycle" ? bus.execute(command) : store.upsertWorkosUser(webhookInput),
      ).rejects.toThrow(/^Legacy owner account reconciliation required$/);
      expectRolledBackWithoutWrites(query);
      await Promise.all([bus.close(), store.close()]);
    },
  );

  it.each(["provider", "email"] as const)(
    "preserves ordinary lifecycle %s reuse",
    async (match) => {
      const { query } = fixture(match, false);
      const bus = createPgIdentityLifecycleCommandBus({ connectionString: "postgresql://unused" });
      const result = await bus.execute({
        ...command,
        payload: { ...command.payload, organization: undefined, membership: undefined },
      });
      expect(result).toMatchObject({ status: "idempotent_replay", userId: ownerId });
      expect(query).toHaveBeenLastCalledWith("COMMIT");
      if (match === "email")
        expect(query).toHaveBeenCalledWith(
          expect.stringContaining("INSERT INTO identity.external_identities"),
          expect.any(Array),
        );
      await bus.close();
    },
  );

  it("preserves ordinary webhook updates", async () => {
    const { query } = fixture("provider", false);
    const store = createPgWorkosWebhookStore({ connectionString: "postgresql://unused" });
    await expect(store.upsertWorkosUser(webhookInput)).resolves.toBe(ownerId);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE identity.users"),
      expect.any(Array),
    );
    expect(query).toHaveBeenLastCalledWith("COMMIT");
    await store.close();
  });

  it.each([
    { rows: [] },
    { rows: [{ protected: null }] },
    { rows: [{ protected: "false" }] },
    { rows: [{ protected: false }, { protected: false }] },
  ])("fails closed on malformed rows $rows", async ({ rows }) => {
    const query = vi.fn().mockResolvedValue({ rows });
    await expect(assertNotBootstrapProtectedUser({ query } as never, ownerId)).rejects.toThrow(
      "Legacy owner account reconciliation required",
    );
  });
});
