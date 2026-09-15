import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { verifyLegacyOwnerEmailIndex } from "./legacyOwnerEmailIndexVerification.js";

const hashes = Array.from({ length: 8 }, (_, i) => i.toString(16).repeat(64));
describe("installed owner email index verification", () => {
  it.each([
    [],
    [{ valid: false }],
    [{ valid: null }],
    [{ valid: "true" }],
    [{ valid: true }, { valid: true }],
  ])("rejects missing, malformed or non-matching catalog results: %j", async (...rows) => {
    const query = vi.fn().mockResolvedValue({ rows });
    await expect(
      verifyLegacyOwnerEmailIndex({ query } as unknown as pg.Client, hashes),
    ).rejects.toThrow("LEGACY_OWNER_EMAIL_INDEX_NOT_VERIFIED");
  });
  it("sanitizes unavailable catalog errors", async () => {
    const query = vi.fn().mockRejectedValue(new Error("private database details"));
    await expect(
      verifyLegacyOwnerEmailIndex({ query } as unknown as pg.Client, hashes),
    ).rejects.toThrow(/^LEGACY_OWNER_EMAIL_INDEX_NOT_VERIFIED$/);
  });
  it("validates input before SQL and returns no executable authority", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ valid: true }] });
    const client = { query } as unknown as pg.Client;
    await expect(verifyLegacyOwnerEmailIndex(client, hashes.slice(1))).rejects.toThrow(
      "INVALID_OWNER_EMAIL_GUARD_SCOPE",
    );
    expect(query).not.toHaveBeenCalled();
    await expect(verifyLegacyOwnerEmailIndex(client, hashes)).resolves.toMatchObject({
      executable: false,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toMatch(/^SELECT /);
  });
});
