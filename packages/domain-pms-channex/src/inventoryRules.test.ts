import { describe, expect, it } from "vitest";
import {
  inventoryRulesOverlap,
  parseInventoryRules,
  type ChannexInventoryRule,
} from "./inventoryRules.js";
const id = "123e4567-e89b-42d3-a456-426614174000";
const rule: ChannexInventoryRule = {
  id,
  type: "availability_offset",
  value: 2,
  channelIds: [id],
  roomTypeIds: [id],
  startDate: "2026-09-07",
  endDate: "2026-09-10",
  days: ["mo"],
};
describe("channel inventory rule boundaries", () => {
  it.each([
    { value: -1 },
    { value: 1.5 },
    { value: Infinity },
    { value: null },
    { startDate: "2026-02-30" },
    { endDate: "2026-09-06" },
    { days: [] },
    { days: ["xx"] },
    { channelIds: [] },
    { roomTypeIds: ["foreign"] },
    { type: "close_out", value: 2 },
  ])("rejects invalid input %j", (patch) => {
    expect(
      parseInventoryRules({ expectedOperationId: null, rules: [{ ...rule, ...patch }] }),
    ).toBeNull();
  });
  it("accepts all three types and an empty replacement for removal", () => {
    for (const type of ["availability_offset", "max_availability", "close_out"]) {
      expect(
        parseInventoryRules({
          expectedOperationId: null,
          rules: [{ ...rule, type, value: type === "close_out" ? null : 2 }],
        }),
      ).not.toBeNull();
    }
    expect(parseInventoryRules({ expectedOperationId: null, rules: [] })).not.toBeNull();
  });
  it("checks actual inclusive dates and weekdays, channels and room types", () => {
    expect(inventoryRulesOverlap(rule, rule)).toBe(true);
    for (const patch of [
      { days: ["tu"] },
      { startDate: "2026-09-08" },
      { channelIds: ["other"] },
      { roomTypeIds: ["other"] },
    ])
      expect(inventoryRulesOverlap(rule, { ...rule, ...patch } as ChannexInventoryRule)).toBe(
        false,
      );
    expect(inventoryRulesOverlap(rule, { ...rule, endDate: "2026-09-07" })).toBe(true);
  });
});
