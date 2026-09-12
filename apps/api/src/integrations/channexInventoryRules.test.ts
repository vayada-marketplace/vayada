import { describe, expect, it, vi } from "vitest";
import {
  reconcileChannexInventoryRules,
  type InventoryRulesPlan,
} from "./channexInventoryRules.js";
const propertyId = "property";
const rule = {
  id: "rule",
  type: "availability_offset" as const,
  value: 2,
  channelIds: ["channel"],
  roomTypeIds: ["room"],
  startDate: "2026-09-07",
  endDate: "2026-09-10",
  days: ["mo" as const],
};
const plan: InventoryRulesPlan = {
  propertyId,
  externalPropertyId: "external-property",
  rules: [rule],
  roomMappings: { room: "external-room" },
};
function harness() {
  let remote: Array<{ id: string; attributes: Record<string, unknown> }> = [];
  let loseCreateResponse = false;
  const request = vi.fn(async (path: string, method: string, body?: unknown): Promise<unknown> => {
    if (path.startsWith("/api/v1/channels?"))
      return {
        data: [
          {
            id: "channel",
            attributes: {
              properties: [plan.externalPropertyId],
              channel: "BookingCom",
              is_active: true,
            },
          },
        ],
        meta: { total: 1 },
      };
    if (method === "GET") return { data: remote, meta: { total: remote.length } };
    const attributes =
      (body as { channel_availability_rule?: Record<string, unknown> })
        ?.channel_availability_rule ?? {};
    if (method === "POST") {
      const item = { id: `remote-${remote.length + 1}`, attributes };
      remote.push(item);
      if (loseCreateResponse) {
        loseCreateResponse = false;
        throw new Error("connection lost after commit");
      }
      return { data: item };
    }
    const id = path.split("/").at(-1)!;
    if (method === "PUT") {
      remote = remote.map((item) => (item.id === id ? { id, attributes } : item));
      return { data: { id } };
    }
    remote = remote.filter((item) => item.id !== id);
    return {};
  });
  return {
    request,
    remote: () => remote,
    seed: (items: typeof remote) => {
      remote = items;
    },
    loseResponse: () => {
      loseCreateResponse = true;
    },
  };
}
describe("Channex inventory reconciliation (mock provider)", () => {
  it("rejects a scope swap before either PUT can leave an overlapping partial state", async () => {
    const h = harness();
    const second = { ...rule, id: "second", days: ["tu" as const] };
    await reconcileChannexInventoryRules({ ...plan, rules: [rule, second] }, h.request);
    h.request.mockClear();
    await expect(
      reconcileChannexInventoryRules(
        {
          ...plan,
          rules: [
            { ...rule, days: ["tu"] },
            { ...second, days: ["mo"] },
          ],
        },
        h.request,
      ),
    ).rejects.toMatchObject({
      code: "invalid_state",
      message: expect.stringContaining("scope swaps"),
    });
    expect(h.request.mock.calls.every((call) => call[1] === "GET")).toBe(true);
    expect(h.remote().map((item) => item.attributes.days)).toEqual([["mo"], ["tu"]]);
  });
  it("recovers lost create responses without duplicates, edits all types, and removes", async () => {
    const h = harness();
    h.loseResponse();
    await expect(reconcileChannexInventoryRules(plan, h.request)).rejects.toThrow(
      "connection lost",
    );
    await reconcileChannexInventoryRules(plan, h.request);
    expect(h.remote()).toHaveLength(1);
    expect(h.request.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
    for (const type of ["availability_offset", "max_availability", "close_out"] as const) {
      await reconcileChannexInventoryRules(
        { ...plan, rules: [{ ...rule, type, value: type === "close_out" ? null : 3 }] },
        h.request,
      );
      expect(h.remote()[0]?.attributes).toMatchObject({
        type,
        value: type === "close_out" ? null : 3,
        property_id: plan.externalPropertyId,
        affected_channels: ["channel"],
        affected_room_types: ["external-room"],
        start_date: rule.startDate,
        end_date: rule.endDate,
        days: ["mo"],
      });
    }
    await reconcileChannexInventoryRules({ ...plan, rules: [] }, h.request);
    await reconcileChannexInventoryRules({ ...plan, rules: [] }, h.request);
    expect(h.remote()).toHaveLength(0);
  });
  it("rejects unmanaged overlaps without writes and preserves non-overlapping provider rules", async () => {
    const h = harness();
    const unmanaged = {
      id: "unmanaged",
      attributes: {
        property_id: plan.externalPropertyId,
        title: "Staff rule",
        affected_channels: ["channel"],
        affected_room_types: ["external-room"],
        start_date: rule.startDate,
      },
    };
    h.seed([unmanaged]);
    await expect(reconcileChannexInventoryRules(plan, h.request)).rejects.toMatchObject({
      code: "invalid_state",
      message: expect.stringContaining("overlaps"),
    });
    expect(h.request.mock.calls.every((call) => call[1] === "GET")).toBe(true);
    h.seed([
      { ...unmanaged, attributes: { ...unmanaged.attributes, affected_channels: ["other"] } },
    ]);
    await reconcileChannexInventoryRules(plan, h.request);
    await reconcileChannexInventoryRules({ ...plan, rules: [] }, h.request);
    expect(h.remote()).toHaveLength(1);
    expect(h.remote()[0]?.id).toBe("unmanaged");
  });
  it("fails closed on stale channels, room mappings and cross-property provider results", async () => {
    for (const patch of [{ roomMappings: {} }, { rules: [{ ...rule, channelIds: ["foreign"] }] }]) {
      const h = harness();
      await expect(
        reconcileChannexInventoryRules({ ...plan, ...patch }, h.request),
      ).rejects.toMatchObject({ code: "invalid_state" });
      expect(h.request.mock.calls.every((call) => call[1] === "GET")).toBe(true);
    }
    const h = harness();
    h.seed([{ id: "foreign", attributes: { property_id: "another-property" } }]);
    await expect(reconcileChannexInventoryRules(plan, h.request)).rejects.toMatchObject({
      code: "invalid_state",
    });
  });
  it("reads every page before deciding to create", async () => {
    const h = harness();
    let pages = 0;
    const paginated = vi.fn(
      async (url: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: unknown) => {
        if (url.startsWith("/api/v1/channel_availability_rules?") && ++pages === 1)
          return { data: [], meta: { total: 1 } };
        return h.request(url, method, body);
      },
    );
    await expect(reconcileChannexInventoryRules(plan, paginated)).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(h.request.mock.calls.filter((call) => call[1] !== "GET")).toHaveLength(0);
  });
});
