import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { createFinancePaymentReadinessSnapshot } from "@vayada/domain-finance";
import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  draft: vi.fn(),
  reset: vi.fn(),
  route: vi.fn(),
}));
vi.mock("@/services/api/financePaymentReadinessClient", () => ({
  financePaymentReadinessClient: { load: mocks.load, save: mocks.save },
}));
vi.mock("@/services/api/adaptiveSetupDraftClient", () => ({
  adaptiveSetupDraftClient: { save: mocks.draft },
}));
vi.mock("@/services/api/propertySetupDraftResetClient", () => ({
  propertySetupDraftResetApi: { reset: mocks.reset },
  PropertySetupDraftResetError: class extends Error {},
}));
vi.mock("@/services/api/propertySetupRouteClient", () => ({
  createPropertySetupRouteClient: () => ({ getRoute: mocks.route }),
}));
vi.mock("./StripeSetupControls", () => ({
  StripeSetupControls: (props: unknown) => createElement("stripe-controls", props as {}),
}));
import { PaymentsStep } from "./PaymentsStep";
const propertyId = "22222222-2222-4222-8222-222222222222";
const pricing = { contractVersion: "pms-pricing.v1", currency: "EUR", pricingCurrencyRevision: 1 };
function snapshot(
  selectedMethods: ("card" | "pay_at_property")[] = [],
  revision = 0,
  currentPricing: typeof pricing | null = pricing,
) {
  return createFinancePaymentReadinessSnapshot({
    propertyId,
    selectedMethods,
    paymentMethodsRevision: revision,
    committedPricing: revision ? pricing : null,
    currentPricing,
    onlineCardReadiness: "execution_unavailable",
    updatedAt: revision ? "2026-09-11T00:00:00.000Z" : null,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(snapshot());
  mocks.draft.mockImplementation(async (_id, request) => ({
    sessionId: "session",
    trackRevision: 1,
    sessionRevision: request.expectedSessionRevision + 1,
    draftRevision: request.expectedDraftRevision + 1,
  }));
  mocks.reset.mockResolvedValue({ sessionRevision: 3 });
  mocks.save.mockImplementation(async (_id, request) =>
    snapshot(request.selectedMethods, request.expectedPaymentMethodsRevision + 1),
  );
});
async function harness(
  track: "hotel_operations" | "combined" = "hotel_operations",
  resumed = false,
) {
  let leave!: () => Promise<void>;
  const step = {
    stepId: "payments",
    currentBaseRevisions: {
      "finance.payment_methods": "payment-methods:0",
      "pms.pricing_settings": "pricing:1",
    },
    draft: resumed
      ? {
          stepId: "payments",
          revision: 1,
          baseRevisions: {
            "finance.payment_methods": "payment-methods:0",
            "pms.pricing_settings": "pricing:1",
          },
          payload: { "payment.accepted_methods": ["online_card"] },
          dirtyFields: ["payment.accepted_methods"],
        }
      : null,
  };
  const route = {
    scope: { organizationId: "org", propertyId },
    selectedTracks:
      track === "combined" ? ["hotel_operations", "creator_marketplace"] : ["hotel_operations"],
    trackRevision: 1,
    sessionId: "session",
    sessionRevision: 1,
    steps: [step],
  };
  const props = {
    propertyId,
    step,
    route,
    registerBeforeLeave: (fn: typeof leave) => {
      leave = fn;
      return () => {};
    },
    refreshRoute: vi.fn(),
    saveAndContinue: vi.fn(),
    reportRevisionConflict: vi.fn(),
  } as unknown as AdaptiveSetupStepComponentProps;
  mocks.route.mockImplementation(async () => ({
    ...route,
    sessionRevision: 3,
    steps: [
      {
        ...step,
        draft: null,
        currentBaseRevisions: {
          ...step.currentBaseRevisions,
          "finance.payment_methods": "payment-methods:1",
        },
      },
    ],
  }));
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(createElement(PaymentsStep, props));
  });
  return {
    view,
    props,
    leave: () => leave(),
    text: () => JSON.stringify(view.toJSON()),
    check: (index: number) => view.root.findAllByType("input")[index],
    button: (text: string) =>
      view.root.findAllByType("button").find((node) => node.children.includes(text))!,
  };
}
it.each(["hotel_operations", "combined"] as const)(
  "%s saves pay-at-hotel and continues only from owner-ready evidence",
  async (track) => {
    const h = await harness(track);
    expect(h.check(0).props.checked).toBe(false);
    expect(h.check(1).props.checked).toBe(false);
    expect(h.button("Save and continue").props.disabled).toBe(true);
    await act(async () => h.check(0).props.onChange());
    await act(async () => {
      await h.button("Save selection").props.onClick();
    });
    expect(mocks.save).toHaveBeenCalledWith(propertyId, {
      expectedPaymentMethodsRevision: 0,
      expectedPricingCurrencyRevision: 1,
      selectedMethods: ["pay_at_property"],
    });
    expect(mocks.reset).toHaveBeenCalled();
    expect(h.props.saveAndContinue).not.toHaveBeenCalled();
    expect(h.button("Save and continue").props.disabled).toBe(false);
    await act(async () => {
      await h.button("Save and continue").props.onClick();
    });
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(h.props.saveAndContinue).toHaveBeenCalledOnce();
    h.view.unmount();
  },
);
it("saves pending cards without reporting readiness and preserves later edits on exit", async () => {
  const h = await harness();
  await act(async () => h.check(1).props.onChange());
  await act(async () => {
    await h.button("Save selection").props.onClick();
  });
  expect(h.text()).toContain("Saved · pending");
  expect(h.button("Save and continue").props.disabled).toBe(true);
  await act(async () => h.check(0).props.onChange());
  await act(async () => h.leave());
  expect(mocks.draft.mock.calls.at(-1)![1]).toMatchObject({
    payload: { "payment.accepted_methods": ["pay_at_hotel", "online_card"] },
    expectedBaseRevisions: {
      "finance.payment_methods": "payment-methods:1",
      "pms.pricing_settings": "pricing:1",
    },
  });
  h.view.unmount();
});
it("resumes an incomplete card selection without writing or inventing readiness", async () => {
  const h = await harness("hotel_operations", true);
  expect(h.check(1).props.checked).toBe(true);
  expect(h.button("Save and continue").props.disabled).toBe(true);
  expect(mocks.save).not.toHaveBeenCalled();
  h.view.unmount();
});
it("fails closed with missing currency and retains the draft", async () => {
  mocks.load.mockResolvedValue(snapshot([], 0, null));
  const h = await harness();
  await act(async () => h.check(0).props.onChange());
  await act(async () => h.leave());
  expect(h.button("Save selection").props.disabled).toBe(true);
  expect(mocks.draft).toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
  h.view.unmount();
});
it("rejects stale owner revision without overwriting settings", async () => {
  mocks.load.mockResolvedValue(snapshot(["card"], 2));
  const h = await harness();
  await act(async () => h.check(0).props.onChange());
  await act(async () => {
    await h.button("Save selection").props.onClick();
  });
  expect(h.props.reportRevisionConflict).toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.reset).not.toHaveBeenCalled();
  h.view.unmount();
});
it("does not overwrite a local selection when provider reconciliation refreshes readiness", async () => {
  const h = await harness();
  await act(async () => h.check(0).props.onChange());
  await act(async () =>
    h.view.root.findByType("stripe-controls" as never).props.onReadiness(snapshot(["card"], 1)),
  );
  expect(h.check(0).props.checked).toBe(true);
  expect(h.check(1).props.checked).toBe(false);
  expect(h.button("Save and continue").props.disabled).toBe(true);
  h.view.unmount();
});
it("renders denied access as an error without controls", async () => {
  mocks.load.mockRejectedValue(new Error("Forbidden"));
  const h = await harness();
  expect(h.text()).toContain("Forbidden");
  expect(h.view.root.findAllByType("input")).toHaveLength(0);
  h.view.unmount();
});

it("does not let a delayed provider read replace a newer accepted save", async () => {
  const h = await harness();
  const deliver = h.view.root.findByType("stripe-controls" as never).props.onReadiness;
  await act(async () => h.check(0).props.onChange());
  await act(async () => {
    await h.button("Save selection").props.onClick();
  });
  await act(async () => deliver(snapshot()));
  expect(h.button("Save and continue").props.disabled).toBe(false);
  await act(async () => {
    await h.button("Save and continue").props.onClick();
  });
  expect(mocks.save).toHaveBeenCalledOnce();
  expect(h.props.reportRevisionConflict).not.toHaveBeenCalled();
  h.view.unmount();
});

it("requires recovery after a currency-only refresh following an in-place save", async () => {
  const h = await harness();
  await act(async () => h.check(0).props.onChange());
  await act(async () => {
    await h.button("Save selection").props.onClick();
  });
  await act(async () =>
    h.view.root
      .findByType("stripe-controls" as never)
      .props.onReadiness(
        snapshot(["pay_at_property"], 1, { ...pricing, pricingCurrencyRevision: 2 }),
      ),
  );
  await act(async () => {
    await h.button("Save selection").props.onClick();
  });
  expect(mocks.save).toHaveBeenCalledOnce();
  expect(h.props.reportRevisionConflict).toHaveBeenCalled();
  h.view.unmount();
});
