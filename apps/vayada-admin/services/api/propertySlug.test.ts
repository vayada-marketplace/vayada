import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("./client", () => ({ apiClient: { post: mocks.post } }));

import {
  propertySlugErrorMessage,
  propertySlugService,
  type PropertySlugChangePreview,
} from "./propertySlug";

const propertyId = "11111111-1111-4111-8111-111111111111";
const preview: PropertySlugChangePreview = {
  plan: {
    propertyId,
    fromSlug: "test-only-alpenrose",
    toSlug: "alpenrose",
    change: "new_address",
    livePage: null,
  },
  planSha256: "a".repeat(64),
};

describe("booking page address (VAY-2295)", () => {
  beforeEach(() => mocks.post.mockReset());

  it("previews the new address, then changes it naming the previewed plan", async () => {
    mocks.post.mockResolvedValue(preview);
    await propertySlugService.preview(propertyId, "alpenrose");
    expect(mocks.post).toHaveBeenLastCalledWith(
      `/api/platform/admin/properties/${propertyId}/slug/preview`,
      { slug: "alpenrose" },
    );
    await propertySlugService.change(propertyId, preview, "Drop the test prefix");
    expect(mocks.post).toHaveBeenLastCalledWith(
      `/api/platform/admin/properties/${propertyId}/slug`,
      {
        slug: "alpenrose",
        reason: "Drop the test prefix",
        expectedPlanSha256: "a".repeat(64),
      },
    );
  });

  it("explains each refusal by its code", () => {
    const refusal = (code: string) => ({ status: 409, data: { code } });
    expect(propertySlugErrorMessage(refusal("slug_taken"))).toBe(
      "Another hotel already uses this address.",
    );
    expect(propertySlugErrorMessage(refusal("plan_changed"))).toBe(
      "Something changed since the preview. Preview the change again.",
    );
    expect(propertySlugErrorMessage({ status: 400, data: { code: "invalid_property_id" } })).toBe(
      "This hotel wasn't found. Open it from the Hotels list.",
    );
    expect(propertySlugErrorMessage(refusal("something_new"))).toBe(
      "The address couldn't be changed. Try again.",
    );
    expect(propertySlugErrorMessage(new Error("offline"))).toBe(
      "The address couldn't be changed. Try again.",
    );
  });
});
