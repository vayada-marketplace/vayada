import type { RequestContext } from "@vayada/backend-auth";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createBookingPricingAuthorityStore } from "./bookingPricingAuthority.js";

const propertyId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";
const scope = { propertyId, organizationId, actorUserId };
const context = {
  actor: { internalUserId: actorUserId },
  selectedOrganization: { organizationId },
} as RequestContext;

function fixture() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
  const assertRuntimeScope = vi.fn().mockRejectedValue(new Error("scope revoked"));
  return {
    query,
    release,
    assertRuntimeScope,
    store: createBookingPricingAuthorityStore(pool, { assertRuntimeScope }),
  };
}

describe("booking pricing authority runtime scope", () => {
  it("checks owner-read scope on the transaction client before authorization reads", async () => {
    const f = fixture();
    await expect(f.store.read(context, scope)).rejects.toThrow("scope revoked");
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.assertRuntimeScope).toHaveBeenCalledWith(expect.anything(), scope, "owner_read");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("checks owner-manage scope before idempotency replay lookup", async () => {
    const f = fixture();
    await expect(
      f.store.save(context, scope, {
        requestId: "request 1",
        expectedRevision: null,
        authority: "vayada",
      }),
    ).rejects.toThrow("scope revoked");
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.assertRuntimeScope).toHaveBeenCalledWith(expect.anything(), scope, "owner_manage");
    expect(f.release).toHaveBeenCalledOnce();
  });
});
