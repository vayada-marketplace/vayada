import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { createFinancePaymentReadinessSnapshot } from "@vayada/domain-finance";
import { ApiErrorResponse } from "@/services/api/client";
import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  draft: vi.fn(),
  reset: vi.fn(),
  route: vi.fn(),
  currencies: vi.fn(),
  saveCurrency: vi.fn(),
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
vi.mock("@/services/api/onboardingPricingClient", () => ({
  onboardingPricingApi: { load: mocks.currencies, saveCurrency: mocks.saveCurrency },
}));
vi.mock("./StripeSetupControls", () => ({
  StripeSetupControls: (props: unknown) => createElement("stripe-controls", props as {}),
}));
import { PaymentsStep } from "./PaymentsStep";
const propertyId = "22222222-2222-4222-8222-222222222222";
const setElsewhere = { pricingCurrency: { currency: "EUR" } };
const pricing = { contractVersion: "pms-pricing.v1", currency: "EUR", pricingCurrencyRevision: 1 };
function snapshot(
  selectedMethods: ("card" | "pay_at_property" | "bank_transfer")[] = [],
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
  const owners = { currencies: ["EUR", "USD"], rooms: [], pricing: null };
  mocks.currencies.mockResolvedValue(owners);
  mocks.saveCurrency.mockResolvedValue(owners);
  mocks.save.mockImplementation(async (_id, request) =>
    snapshot(request.selectedMethods, request.expectedPaymentMethodsRevision + 1),
  );
});
async function harness(
  track: "hotel_operations" | "combined" = "hotel_operations",
  resumed = false,
  paymentRevision = 0,
  pricingRevision = 1,
) {
  let leave!: () => Promise<void>;
  const step = {
    stepId: "payments",
    currentBaseRevisions: {
      "finance.payment_methods": `payment-methods:${paymentRevision}`,
      "pms.pricing_settings": `pricing:${pricingRevision}`,
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
          "finance.payment_methods": mocks.save.mock.calls.length
            ? "payment-methods:1"
            : `payment-methods:${paymentRevision}`,
          "pms.pricing_settings": "pricing:1",
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
it("saves the complete selection when an unsupported method was previously selected", async () => {
  mocks.load.mockResolvedValue(snapshot(["pay_at_property", "bank_transfer"], 1));
  const h = await harness("hotel_operations", false, 1);
  expect(h.text()).toContain("Selection not saved");
  expect(h.button("Save and continue").props.disabled).toBe(true);
  await act(async () => { await h.button("Save selection").props.onClick(); });
  expect(mocks.save).toHaveBeenCalledWith(propertyId, {
    expectedPaymentMethodsRevision: 1,
    expectedPricingCurrencyRevision: 1,
    selectedMethods: ["pay_at_property"],
  });
  expect(h.button("Save and continue").props.disabled).toBe(false);
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

it("chooses the hotel currency here, then saves methods against it without a conflict", async () => {
  mocks.load.mockResolvedValueOnce(snapshot([], 0, null));
  const h = await harness("hotel_operations", false, 0, 0);
  expect(h.text()).toContain("Hotel currency");
  expect(h.text()).not.toContain("in Pricing");
  expect(h.button("Save selection").props.disabled).toBe(true);
  const select = () => h.view.root.findByType("select");
  expect(
    select()
      .findAllByType("option")
      .map((option) => option.props.value),
  ).toEqual(["", "EUR", "USD"]);
  await act(async () => select().props.onChange({ target: { value: "EUR" } }));
  await act(async () => {
    await h.button("Save currency").props.onClick();
  });
  expect(mocks.saveCurrency).toHaveBeenCalledWith(propertyId, "EUR", {
    currencies: ["EUR", "USD"],
    rooms: [],
    pricing: null,
  });
  expect(h.props.refreshRoute).toHaveBeenCalled();
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(h.view.root.findAllByType("select")).toHaveLength(0);
  expect(h.text()).toContain("EUR");
  await act(async () => h.check(0).props.onChange());
  await act(async () => {
    await h.button("Save selection").props.onClick();
  });
  expect(h.props.reportRevisionConflict).not.toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalledWith(propertyId, {
    expectedPaymentMethodsRevision: 0,
    expectedPricingCurrencyRevision: 1,
    selectedMethods: ["pay_at_property"],
  });
  h.view.unmount();
});

it("keeps a chosen pay-at-hotel answer while the currency is saved", async () => {
  mocks.load.mockResolvedValueOnce(snapshot([], 0, null));
  const h = await harness("hotel_operations", false, 0, 0);
  await act(async () => h.check(0).props.onChange());
  await act(async () =>
    h.view.root.findByType("select").props.onChange({ target: { value: "USD" } }),
  );
  await act(async () => {
    await h.button("Save currency").props.onClick();
  });
  expect(h.check(0).props.checked).toBe(true);
  expect(h.button("Save selection").props.disabled).toBe(false);
  h.view.unmount();
});

it("continues with a currency another session chose instead of retrying a stale write", async () => {
  mocks.load.mockResolvedValueOnce(snapshot([], 0, null));
  const h = await harness("hotel_operations", false, 0, 0);
  mocks.saveCurrency.mockRejectedValueOnce(
    new Error("The pricing currency changed in another session."),
  );
  mocks.currencies.mockResolvedValueOnce({ currencies: ["EUR"], rooms: [], pricing: setElsewhere });
  await act(async () =>
    h.view.root.findByType("select").props.onChange({ target: { value: "USD" } }),
  );
  await act(async () => {
    await h.button("Save currency").props.onClick();
  });
  expect(mocks.saveCurrency).toHaveBeenCalledOnce();
  expect(mocks.route).toHaveBeenCalled();
  expect(h.text()).not.toContain("changed in another session");
  expect(h.text()).not.toContain("Hotel currency");
  expect(h.text()).toContain("The hotel currency was already set to EUR in another session.");
  h.view.unmount();
});

it("retries a landed currency save after the reload failed", async () => {
  mocks.load.mockResolvedValueOnce(snapshot([], 0, null));
  const h = await harness("hotel_operations", false, 0, 0);
  mocks.route.mockRejectedValueOnce(new Error("Setup is temporarily unavailable."));
  await act(async () =>
    h.view.root.findByType("select").props.onChange({ target: { value: "EUR" } }),
  );
  await act(async () => {
    await h.button("Save currency").props.onClick();
  });
  expect(h.text()).toContain("Setup is temporarily unavailable.");
  // The server replays the same idempotent save.
  await act(async () => {
    await h.button("Save currency").props.onClick();
  });
  expect(mocks.saveCurrency).toHaveBeenCalledTimes(2);
  expect(mocks.saveCurrency.mock.calls[1]).toEqual(mocks.saveCurrency.mock.calls[0]);
  expect(h.text()).not.toContain("Hotel currency");
  expect(h.text()).not.toContain("another session");
  h.view.unmount();
});

it("adopts a currency chosen elsewhere before the picker loaded", async () => {
  mocks.load.mockResolvedValueOnce(snapshot([], 0, null));
  mocks.currencies.mockResolvedValueOnce({ currencies: ["EUR"], rooms: [], pricing: setElsewhere });
  const h = await harness("hotel_operations", false, 0, 0);
  await act(async () => {});
  expect(mocks.saveCurrency).not.toHaveBeenCalled();
  expect(mocks.route).toHaveBeenCalled();
  expect(h.text()).not.toContain("Hotel currency");
  h.view.unmount();
});

it("explains that only the owner can choose the currency", async () => {
  mocks.load.mockResolvedValueOnce(snapshot([], 0, null));
  const h = await harness("hotel_operations", false, 0, 0);
  mocks.saveCurrency.mockRejectedValueOnce(new ApiErrorResponse(403, { code: "forbidden" }));
  await act(async () =>
    h.view.root.findByType("select").props.onChange({ target: { value: "EUR" } }),
  );
  await act(async () => {
    await h.button("Save currency").props.onClick();
  });
  expect(h.text()).toContain("Only the hotel owner can choose the hotel currency.");
  expect(mocks.route).not.toHaveBeenCalled();
  h.view.unmount();
});

it("does not leave the step while the currency is being saved", async () => {
  mocks.load.mockResolvedValueOnce(snapshot([], 0, null));
  const h = await harness("hotel_operations", false, 0, 0);
  let finish!: () => void;
  mocks.saveCurrency.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = () => resolve({ currencies: ["EUR"], rooms: [], pricing: setElsewhere });
    }),
  );
  await act(async () =>
    h.view.root.findByType("select").props.onChange({ target: { value: "EUR" } }),
  );
  await act(async () => {
    const save = h.button("Save currency");
    save.props.onClick();
    // A second click in the same frame is ignored.
    save.props.onClick();
  });
  await expect(h.leave()).rejects.toThrow("Wait for this step to finish saving.");
  await act(async () => finish());
  expect(mocks.saveCurrency).toHaveBeenCalledOnce();
  expect(h.text()).not.toContain("Hotel currency");
  h.view.unmount();
});

it("shows a currency load failure with a retry", async () => {
  mocks.load.mockResolvedValueOnce(snapshot([], 0, null));
  mocks.currencies.mockRejectedValueOnce(new Error("Pricing access is no longer available."));
  const h = await harness();
  expect(h.text()).toContain("Pricing access is no longer available.");
  await act(async () => {
    await h.button("Retry").props.onClick();
  });
  expect(mocks.currencies).toHaveBeenCalledTimes(2);
  expect(h.view.root.findAllByType("select")).toHaveLength(1);
  h.view.unmount();
});
