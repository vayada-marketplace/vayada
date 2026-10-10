import { describe, expect, it } from "vitest";
import { CHANNEX_RESERVED_TEST_IDS, channexExcludedIds } from "./channexOwnershipGate.js";

describe("channexExcludedIds", () => {
  it("excludes the reserved staging/test ids everywhere except staging Channex", () => {
    expect(channexExcludedIds("https://app.channex.io")).toEqual(CHANNEX_RESERVED_TEST_IDS);
    expect(channexExcludedIds(undefined)).toEqual(CHANNEX_RESERVED_TEST_IDS);
    expect(channexExcludedIds("https://staging.channex.io")).toEqual([]);
  });

  it("keeps the staging pair from migration 0432 reserved", () => {
    expect(CHANNEX_RESERVED_TEST_IDS).toContain("65f6b2fc-c783-4963-9d6b-a85f82319769");
    expect(CHANNEX_RESERVED_TEST_IDS).toContain("8f4c1e47-3de1-4150-8bde-ad031a013842");
  });
});
