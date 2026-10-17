import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiErrorResponse } from "@/services/api/client";
const mocks = vi.hoisted(() => ({ plan: vi.fn(), commission: vi.fn(), checkout: vi.fn() }));
vi.mock("@/services/api/hotelOperationsSetupClient", async (original) => ({
  ...(await original<object>()),
  hotelOperationsSetupApi: {
    getPlanStatus: mocks.plan,
    selectCommissionPlan: mocks.commission,
    startFixedPlanCheckout: mocks.checkout,
  },
}));
import { BillingPlanChoice } from "./BillingPlanChoice";

const propertyId = "22222222-2222-4222-8222-222222222222";
const notSelected = {
  plan: null,
  status: "not_selected",
  currency: "EUR",
  activeRoomCount: 2,
  amountMinor: 3_500,
  fixedPlanAvailable: true,
  checkoutPending: false,
  updatedAt: "2026-10-13T00:00:00.000Z",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.plan.mockResolvedValue(notSelected);
});
async function harness() {
  const onStatus = vi.fn();
  const onChanged = vi.fn();
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(
      createElement(BillingPlanChoice, { propertyId, disabled: false, onStatus, onChanged }),
    );
  });
  const radios = () =>
    view.root.findAll((node) => node.type === "input" && node.props.type === "radio");
  return {
    onStatus,
    onChanged,
    radios,
    text: () => JSON.stringify(view.toJSON()),
    button: (text: string) =>
      view.root.findAllByType("button").find((node) => node.children.includes(text))!,
  };
}

it("starts the existing Fixed Fee checkout in a new tab and counts it as pending", async () => {
  const tab = { location: { assign: vi.fn() }, close: vi.fn() };
  vi.stubGlobal("window", { open: vi.fn(() => tab) });
  mocks.checkout.mockResolvedValue({ checkoutUrl: "https://checkout.stripe.test/s" });
  const h = await harness();
  expect(h.text()).toContain("€35 / 30 days");
  expect(h.text()).toContain("€30 first active room + €5 each additional room");
  await act(async () => h.radios()[1]!.props.onChange());
  await act(async () => {
    await h.button("Continue to Stripe Checkout").props.onClick();
  });
  expect(mocks.checkout).toHaveBeenCalledWith(propertyId, expect.any(String));
  expect(mocks.commission).not.toHaveBeenCalled();
  expect(tab.location.assign).toHaveBeenCalledWith("https://checkout.stripe.test/s");
  expect(h.onStatus).toHaveBeenLastCalledWith(
    expect.objectContaining({ plan: null, checkoutPending: true }),
  );
  expect(h.text()).toContain("Stripe Checkout opened in a new tab.");
  // Once Stripe confirms, Check again shows the plan and refreshes the step.
  mocks.plan.mockResolvedValue({ ...notSelected, plan: "fixed", status: "active" });
  await act(async () => {
    await h.button("Check again").props.onClick();
  });
  expect(h.text()).toContain("Fixed Fee · €35 / 30 days");
  expect(h.onChanged).toHaveBeenCalledTimes(2);
});

it("asks to allow pop-ups instead of starting a checkout it can't show", async () => {
  vi.stubGlobal("window", { open: vi.fn(() => null) });
  const h = await harness();
  await act(async () => h.radios()[1]!.props.onChange());
  await act(async () => {
    await h.button("Continue to Stripe Checkout").props.onClick();
  });
  expect(mocks.checkout).not.toHaveBeenCalled();
  expect(h.text()).toContain("Allow pop-ups for vayada, then try opening Stripe Checkout again.");
});

it("tells a team member that only the owner chooses the plan", async () => {
  mocks.commission.mockRejectedValue(new ApiErrorResponse(403, { code: "forbidden" }));
  const h = await harness();
  await act(async () => {
    await h.button("Confirm Commission plan").props.onClick();
  });
  expect(h.text()).toContain("Your role can't choose the vayada plan.");
  expect(h.onChanged).not.toHaveBeenCalled();
  expect(h.onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ plan: "commission" }));
});

it("keeps Fixed Fee unavailable where Finance can't bill it", async () => {
  mocks.plan.mockResolvedValue({ ...notSelected, currency: "CHF", fixedPlanAvailable: false });
  const h = await harness();
  expect(h.radios().map((node) => node.props.disabled)).toEqual([false, true]);
  expect(h.text()).toContain("Not available in CHF yet.");
  expect(h.text()).not.toContain("CHF 0");
});
