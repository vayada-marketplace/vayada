import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { AffiliateOfferTermsEditor } from "./AffiliateOfferTermsEditor";
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/services/api/targetClient", () => ({ targetApiClient: api }));
let renderer: ReactTestRenderer;
const terms = {
  bookingDestinationId: "existing-destination",
  financePolicyVersionId: "old",
  attributionWindowDays: 14,
};
const draft = {
  revision: 3,
  draft: {
    id: "draft",
    terms,
    commission: {
      status: "available",
      policyVersionId: "old",
      policy: { percentageRate: "12.50", rateBasisPoints: 1250 },
    },
  },
};
let current: unknown = draft;
async function mount(value: unknown = draft) {
  current = value;
  api.get.mockImplementation(async (path: string) =>
    path.endsWith("affiliate-policies")
      ? {
          policies: [
            { id: "new", rateBasisPoints: 2000, approved: true },
            { id: "unapproved", rateBasisPoints: 3000, approved: false },
          ],
        }
      : current,
  );
  await act(async () => {
    renderer = create(
      createElement(AffiliateOfferTermsEditor, { propertyId: "property", offerId: "offer" }),
    );
  });
}
const button = (label: string) =>
  renderer.root.findAllByType("button").find((b) => b.children.includes(label))!;
const edit = async (type: "input" | "select", value: string) => {
  await act(async () => renderer.root.findByType(type).props.onChange({ target: { value } }));
};
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.resetAllMocks();
});
it("requires existing setup, never inventing initial terms", async () => {
  await mount({ revision: 0, draft: null });
  expect(button("Save affiliate draft")).toBeUndefined();
  expect(renderer.root.findAllByType("input")).toHaveLength(0);
  expect(api.put).not.toHaveBeenCalled();
});
it("preserves the current approved version beyond history and excludes unapproved choices", async () => {
  await mount();
  expect(renderer.root.findByType("select").props.value).toBe("old");
  expect(renderer.root.findAllByType("option").map((o) => o.props.value)).toEqual([
    "",
    "new",
    "old",
  ]);
  await edit("input", "1.5");
  await act(async () => button("Save affiliate draft").props.onClick());
  expect(api.put).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("whole number");
});
it("retries identical writes with the same key, preserves destination and reloads the revision", async () => {
  await mount();
  await edit("select", "new");
  await edit("input", "30");
  api.put.mockRejectedValueOnce(new Error("network")).mockImplementationOnce(async () => {
    current = {
      ...draft,
      revision: 4,
      draft: {
        ...draft.draft,
        terms: { ...terms, financePolicyVersionId: "new", attributionWindowDays: 30 },
        commission: {
          status: "available",
          policyVersionId: "new",
          policy: { percentageRate: "20.00", rateBasisPoints: 2000 },
        },
      },
    };
  });
  await act(async () => button("Save affiliate draft").props.onClick());
  await act(async () => button("Save affiliate draft").props.onClick());
  expect(api.put.mock.calls[0]).toEqual(api.put.mock.calls[1]);
  expect(api.put.mock.calls[0]).toEqual([
    expect.stringContaining("/properties/property/offers/offer/affiliate-draft"),
    {
      expectedRevision: 3,
      terms: { ...terms, financePolicyVersionId: "new", attributionWindowDays: 30 },
    },
    { headers: { "Idempotency-Key": expect.any(String) } },
  ]);
  expect(renderer.root.findByType("select").props.value).toBe("new");
  expect(renderer.root.findByType("input").props.value).toBe("30");
});
it("hides the stale form after a successful save when reload fails", async () => {
  await mount();
  api.put.mockImplementation(async () => {
    api.get.mockRejectedValue(new Error("reload"));
  });
  await act(async () => button("Save affiliate draft").props.onClick());
  expect(api.put).toHaveBeenCalledTimes(1);
  expect(button("Save affiliate draft")).toBeUndefined();
  expect(button("Reload affiliate terms").props.disabled).toBe(false);
});
