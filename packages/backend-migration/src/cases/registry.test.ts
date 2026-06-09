import { describe, expect, it } from "vitest";

import { getParityHandlers, getTransformHandler } from "./registry.js";

describe("fixture case registry", () => {
  it("registers identity transform and parity handlers", () => {
    expect(getTransformHandler("identity-organization-links")).toBeTypeOf("function");
    expect(getParityHandlers("identity-organization-links")).toHaveLength(1);
  });

  it("registers property catalog transform and parity handlers", () => {
    expect(getTransformHandler("property-catalog-public-profiles")).toBeTypeOf("function");
    expect(getParityHandlers("property-catalog-public-profiles")).toHaveLength(1);
  });

  it("registers booking checkout transform and parity handlers", () => {
    expect(getTransformHandler("booking-checkout")).toBeTypeOf("function");
    expect(getParityHandlers("booking-checkout")).toHaveLength(1);
  });

  it("registers finance transform and parity handlers", () => {
    expect(getTransformHandler("finance")).toBeTypeOf("function");
    expect(getParityHandlers("finance")).toHaveLength(1);
  });

  it("registers PMS operations transform and parity handlers", () => {
    expect(getTransformHandler("pms-operations")).toBeTypeOf("function");
    expect(getParityHandlers("pms-operations")).toHaveLength(1);
  });

  it("registers marketplace transform and parity handlers", () => {
    expect(getTransformHandler("marketplace")).toBeTypeOf("function");
    expect(getParityHandlers("marketplace")).toHaveLength(1);
  });

  it("registers distribution bookability transform and parity handlers", () => {
    expect(getTransformHandler("distribution-bookability")).toBeTypeOf("function");
    expect(getParityHandlers("distribution-bookability")).toHaveLength(1);
  });

  it("registers intelligence parity without a transform", () => {
    expect(getTransformHandler("intelligence")).toBeUndefined();
    expect(getParityHandlers("intelligence")).toHaveLength(1);
  });

  it("registers platform jobs/events/audit parity without a transform", () => {
    expect(getTransformHandler("platform-jobs-events-audit")).toBeUndefined();
    expect(getParityHandlers("platform-jobs-events-audit")).toHaveLength(1);
  });

  it("returns empty handlers for unregistered fixture cases", () => {
    expect(getTransformHandler("unknown-fixture")).toBeUndefined();
    expect(getParityHandlers("unknown-fixture")).toEqual([]);
  });
});
