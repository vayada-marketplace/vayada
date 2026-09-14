import { describe, expect, it, vi } from "vitest";
import type { ChannexInventoryRule } from "@vayada/domain-pms-channex";
import { validateInventoryRules } from "./pmsChannexInventoryRules.js";
const id = "123e4567-e89b-42d3-a456-426614174000";
const other = "223e4567-e89b-42d3-a456-426614174000";
const rule: ChannexInventoryRule = {
  id,
  type: "availability_offset",
  value: 2,
  channelIds: [id],
  roomTypeIds: [id],
  startDate: "2026-09-07",
  endDate: "2026-09-09",
  days: ["mo"],
};
function client() {
  return {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes("connection_metadata")
        ? [
            {
              metadata: {
                connectedChannels: [{ externalChannelId: id, isActive: true }],
                inventoryRules: { operationId: id },
              },
            },
          ]
        : [{ id }],
    })),
  };
}
describe("property-scoped inventory rule commands", () => {
  it("locks desired state and requires the last operation to prevent lost updates", async () => {
    const db = client();
    expect(
      await validateInventoryRules(db as never, id, { expectedOperationId: null, rules: [rule] }),
    ).toMatch(/Refresh/);
    expect(
      await validateInventoryRules(db as never, id, { expectedOperationId: id, rules: [rule] }),
    ).toBeNull();
    expect(db.query.mock.calls[0]?.[0]).toContain("FOR UPDATE");
  });
  it("rejects foreign channels, foreign rooms, overlaps and malformed values", async () => {
    for (const patch of [{ channelIds: [other] }, { roomTypeIds: [other] }, { value: -1 }]) {
      expect(
        await validateInventoryRules(client() as never, id, {
          expectedOperationId: id,
          rules: [{ ...rule, ...patch }],
        }),
      ).not.toBeNull();
    }
    expect(
      await validateInventoryRules(client() as never, id, {
        expectedOperationId: id,
        rules: [rule, { ...rule, id: other }],
      }),
    ).toMatch(/overlap/);
    expect(
      await validateInventoryRules(client() as never, id, {
        expectedOperationId: id,
        rules: [rule, { ...rule, id: other, days: ["tu"] }],
      }),
    ).toBeNull();
    expect(
      await validateInventoryRules(client() as never, id, { expectedOperationId: id, rules: [] }),
    ).toBeNull();
  });
});
