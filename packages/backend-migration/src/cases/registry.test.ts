import { describe, expect, it } from "vitest";

import { getParityHandlers, getTransformHandler } from "./registry.js";

describe("fixture case registry", () => {
  it("registers identity transform and parity handlers", () => {
    expect(getTransformHandler("identity-organization-links")).toBeTypeOf("function");
    expect(getParityHandlers("identity-organization-links")).toHaveLength(1);
  });

  it("registers property catalog parity without a transform", () => {
    expect(getTransformHandler("property-catalog-public-profiles")).toBeUndefined();
    expect(getParityHandlers("property-catalog-public-profiles")).toHaveLength(1);
  });

  it("returns empty handlers for unregistered fixture cases", () => {
    expect(getTransformHandler("unknown-fixture")).toBeUndefined();
    expect(getParityHandlers("unknown-fixture")).toEqual([]);
  });
});
