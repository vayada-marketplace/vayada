import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthError } from "./errors.js";
import { createPgIdentityRepository } from "./repository.js";
import { resolveRequestContext } from "./resolve.js";

const userRow = {
  user_id: "00000000-0000-4000-8000-000000000001",
  email: "ordinary@example.invalid",
  name: "Ordinary user",
  phone: null,
  profile_picture_url: null,
  profile_picture_media_object_id: null,
  status: "active",
  bootstrap_protected: false,
};

function repository() {
  return createPgIdentityRepository({ connectionString: "postgres://unused.invalid/test" });
}

afterEach(() => vi.restoreAllMocks());

describe("legacy owner session hold at the Postgres repository boundary", () => {
  it.each(["active", "pending"])(
    "throws for protected %s users instead of returning null",
    async (status) => {
      const query = vi.spyOn(pg.Pool.prototype, "query").mockResolvedValue({
        rows: [{ ...userRow, status, bootstrap_protected: true }],
      } as never);
      await expect(
        repository().findUserByProviderUserId("workos", "provider-user"),
      ).rejects.toMatchObject({
        name: "AuthError",
        code: "USER_RECONCILIATION_REQUIRED",
        message: "Legacy owner account reconciliation required",
      });
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, null, 0, "false"])("rejects non-boolean-false evidence %s", async (value) => {
    vi.spyOn(pg.Pool.prototype, "query").mockResolvedValue({
      rows: [{ ...userRow, bootstrap_protected: value }],
    } as never);
    await expect(
      repository().findUserByProviderUserId("workos", "provider-user"),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it.each(["active", "pending", "suspended", "deleted"])(
    "preserves ordinary %s users and their profile",
    async (status) => {
      const query = vi.spyOn(pg.Pool.prototype, "query").mockResolvedValue({
        rows: [{ ...userRow, status }],
      } as never);
      await expect(
        repository().findUserByProviderUserId("workos", "provider-user"),
      ).resolves.toEqual({
        userId: userRow.user_id,
        email: userRow.email,
        name: userRow.name,
        phone: null,
        profilePictureUrl: null,
        profilePictureMediaObjectId: null,
        status,
      });
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0]!;
      expect(sql).toContain("FROM platform.legacy_owner_bootstrap_receipts receipt");
      expect(sql).toContain("WHERE u.id = ANY(receipt.owner_user_ids)");
      expect(sql).toContain("AS bootstrap_protected");
      expect(params).toEqual(["workos", "provider-user"]);
    },
  );

  it.each(["42P01", "42501", "08006"])(
    "sanitizes unavailable evidence (%s) without returning a JIT null",
    async (code) => {
      vi.spyOn(pg.Pool.prototype, "query").mockRejectedValue(
        Object.assign(new Error("private database detail"), { code }),
      );
      const error = await repository()
        .findUserByProviderUserId("workos", "provider-user")
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ message: "Identity session evidence unavailable" });
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("code");
      expect(String(error)).not.toContain("private database detail");
    },
  );

  it("returns null only for a genuinely absent user after a successful query", async () => {
    vi.spyOn(pg.Pool.prototype, "query").mockResolvedValue({ rows: [] } as never);
    await expect(
      repository().findUserByProviderUserId("workos", "absent-user"),
    ).resolves.toBeNull();
  });

  it("stops existing-session resolution before organization, membership, or resource reads", async () => {
    const query = vi.spyOn(pg.Pool.prototype, "query").mockResolvedValue({
      rows: [{ ...userRow, bootstrap_protected: true }],
    } as never);
    await expect(
      resolveRequestContext(
        {
          workosUserId: "provider-user",
          workosOrgId: "provider-org",
          sessionId: "session-test",
          expiresAt: 4_000_000_000,
        },
        repository(),
        { requestId: "test" },
      ),
    ).rejects.toMatchObject({ code: "USER_RECONCILIATION_REQUIRED" });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
