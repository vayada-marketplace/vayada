import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AffiliateCommissionEditor } from "./AffiliateCommissionEditor";
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/services/api/targetClient", () => ({ targetApiClient: api }));
const propertyId = "15010000-0000-4000-8000-000000000003";
const path = `/api/marketplace/properties/${propertyId}/affiliate-policies`;
describe("affiliate commission editor", () => {
  let renderer: ReactTestRenderer;
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    vi.resetAllMocks();
  });
  async function mount() {
    api.get.mockResolvedValue({ policies: [] });
    await act(async () => {
      renderer = create(createElement(AffiliateCommissionEditor, { propertyId }));
    });
  }
  const button = (label: string) =>
    renderer.root.findAllByType("button").find((b) => b.children.includes(label))!;
  async function enter(value: string) {
    await act(async () => renderer.root.findByType("input").props.onChange({ target: { value } }));
  }
  it("starts blank and rejects invalid precision before sending a policy", async () => {
    await mount();
    expect(renderer.root.findByType("input").props.value).toBe("");
    expect(button("Save draft rate").props.disabled).toBe(true);
    await enter("12.345");
    await act(async () => button("Save draft rate").props.onClick());
    expect(api.post).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "two decimal places",
    );
  });
  it("reuses the same save key after failure and preserves the decimal percentage", async () => {
    await mount();
    api.post.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ ok: true });
    await enter("12.50");
    await act(async () => button("Save draft rate").props.onClick());
    await act(async () => button("Save draft rate").props.onClick());
    expect(api.post.mock.calls[0]).toEqual([
      path,
      { percentageRate: "12.50" },
      { headers: { "Idempotency-Key": expect.any(String) } },
    ]);
    expect(api.post.mock.calls[1]).toEqual(api.post.mock.calls[0]);
    expect(renderer.root.findByType("input").props.value).toBe("");
  });
  it("requires review before exact-version approval and reloads saved history", async () => {
    await mount();
    const row = {
      id: "version-1",
      rateBasisPoints: 1250,
      approved: false,
      createdAt: "2026-09-10",
    };
    api.get.mockResolvedValue({ policies: [row] });
    await act(async () => button("Reload rates").props.onClick());
    expect(button("Confirm approval")).toBeUndefined();
    await act(async () => button("Review rate").props.onClick());
    expect(api.post).not.toHaveBeenCalled();
    api.post.mockResolvedValue({ ok: true });
    api.get.mockResolvedValue({ policies: [{ ...row, approved: true }] });
    await act(async () => button("Confirm approval").props.onClick());
    expect(api.post).toHaveBeenCalledWith(`${path}/version-1/approve`, undefined, {
      headers: { "Idempotency-Key": expect.any(String) },
    });
    expect(button("Review rate")).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).toContain("Approved");
  });
});
