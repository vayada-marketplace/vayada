import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { PropertySetupRouteReadModel } from "@vayada/domain-hotels";
import { FirstPricingSetup } from "@vayada/product-onboarding/FirstPricingSetup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  saveCurrency: vi.fn(),
  read: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("@/services/api/onboardingPricingClient", async () => ({
  ...(await vi.importActual<typeof import("@/services/api/onboardingPricingClient")>(
    "@/services/api/onboardingPricingClient",
  )),
  onboardingPricingApi: {
    load: mocks.load,
    saveCurrency: mocks.saveCurrency,
    replacementPricing: () => ({ read: mocks.read }),
  },
}));
vi.mock("./publishFirstPricing", async () => ({
  ...(await vi.importActual<typeof import("./publishFirstPricing")>("./publishFirstPricing")),
  publishFirstPricing: mocks.publish,
}));

import { ApiErrorResponse } from "@/services/api/client";
import { PricingStep } from "./PricingStep";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomTypeId = "33333333-3333-4333-8333-333333333333";

describe("PricingStep", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.load.mockResolvedValue(owners());
    mocks.read.mockResolvedValue(null);
    mocks.publish.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("saves one hotel currency before showing the first-rate form", async () => {
    mocks.load.mockResolvedValue(owners({ currency: null }));
    mocks.saveCurrency.mockResolvedValue(owners());
    const view = await render();
    expect(view.root.findAllByType(FirstPricingSetup)).toHaveLength(0);
    const select = view.root.findByType("select");
    expect(select.findAllByType("option").map((option) => option.props.value)).toEqual([
      "",
      "CHF",
      "EUR",
    ]);
    await act(async () => select.props.onChange({ target: { value: "EUR" } }));
    await act(async () => button(view.root, "Save currency").props.onClick());
    expect(mocks.saveCurrency).toHaveBeenCalledWith(propertyId, "EUR", owners({ currency: null }));
    expect(text(view.root)).toContain("All prices are in EUR.");
    expect(view.root.findByType(FirstPricingSetup).props).toMatchObject({
      fixedCurrency: "EUR",
      rooms: [{ roomTypeId, name: "Garden Suite", capacity: { total: 3, adults: 2, children: 1 } }],
    });
    view.unmount();
  });

  it("publishes the first rate of every room as the final-price declaration and continues", async () => {
    const context = props();
    const view = await render(context);
    const publishButton = () => button(view.root, "Publish prices and continue");
    await act(async () => view.root.findByType(FirstPricingSetup).props.onCreate(firstRate()));
    expect(text(view.root)).toContain("Ready to publish");
    expect(view.root.findAllByType(FirstPricingSetup)).toHaveLength(0);
    // Publishing is the mandatory-charges declaration: no checkbox, one visible line (VAY-2079).
    expect(view.root.findAll((node) => node.props.type === "checkbox")).toHaveLength(0);
    expect(publishButton().props.disabled).toBe(false);
    expect(text(view.root)).toContain(
      "By publishing, you confirm these prices include all mandatory taxes and fees.",
    );
    mocks.read.mockResolvedValue(publication());
    // A double click starts one publish.
    await act(async () => {
      const click = publishButton().props.onClick;
      click();
      click();
    });
    expect(mocks.publish).toHaveBeenCalledOnce();

    expect(mocks.publish).toHaveBeenCalledWith(
      expect.anything(),
      null,
      [firstRate()],
      expect.objectContaining({ draftId: expect.any(String) }),
    );
    expect(context.refreshRoute).toHaveBeenCalledOnce();
    expect(context.saveAndContinue).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("sends the owner to Payments before any rate is entered", async () => {
    const context = props("not_started");
    const view = await render(context);
    expect(view.root.findAllByType(FirstPricingSetup)).toHaveLength(0);
    expect(button(view.root, "Publish prices and continue").props.disabled).toBe(true);
    await act(async () => button(view.root, "Go to Payments").props.onClick());
    expect(context.goToStep).toHaveBeenCalledWith("payments");
    expect(mocks.publish).not.toHaveBeenCalled();
    view.unmount();
  });

  it("resumes the same publish attempt after a lost response", async () => {
    const view = await render();
    await act(async () => view.root.findByType(FirstPricingSetup).props.onCreate(firstRate()));
    mocks.publish.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => button(view.root, "Publish prices and continue").props.onClick());
    expect(text(view.root)).toContain("Pricing was not saved");
    await act(async () => button(view.root, "Try again").props.onClick());
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.publish.mock.calls[1]![3]).toBe(mocks.publish.mock.calls[0]![3]);
    view.unmount();
  });

  it("explains a refused preparation and asks for a reload after a conflict", async () => {
    const view = await render();
    await act(async () => view.root.findByType(FirstPricingSetup).props.onCreate(firstRate()));
    mocks.publish.mockRejectedValueOnce(new ApiErrorResponse(403, { code: "denied" }));
    await act(async () => button(view.root, "Publish prices and continue").props.onClick());
    expect(text(view.root)).toContain("Check that Payments is complete");
    // A Finance reason names what to fix; the rates stay and "Try again" resumes.
    mocks.publish.mockRejectedValueOnce(
      new ApiErrorResponse(403, { code: "denied", reason: "method_unavailable" } as never),
    );
    await act(async () => button(view.root, "Try again").props.onClick());
    expect(text(view.root)).toContain("Change the rate to accept pay at property");
    expect(text(view.root)).toContain("Ready to publish");
    mocks.publish.mockRejectedValueOnce(new ApiErrorResponse(409, { code: "stale" }));
    await act(async () => button(view.root, "Try again").props.onClick());
    expect(text(view.root)).toContain("Pricing changed in another session");
    await act(async () => button(view.root, "Reload pricing").props.onClick());
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(text(view.root)).not.toContain("Ready to publish");
    view.unmount();
  });

  it("continues without writes when setup confirms every room is published", async () => {
    mocks.read.mockResolvedValue(publication());
    const context = props("complete", "complete");
    const view = await render(context);
    expect(text(view.root)).toContain("Published · 1 rate");
    expect(view.root.findAllByType(FirstPricingSetup)).toHaveLength(0);
    expect(view.root.findAll((node) => node.props.type === "checkbox")).toHaveLength(0);
    await act(async () => button(view.root, "Continue").props.onClick());
    expect(context.saveAndContinue).toHaveBeenCalledOnce();
    expect(mocks.publish).not.toHaveBeenCalled();
    view.unmount();
  });

  it("explains a published publication that setup has not completed", async () => {
    mocks.read.mockResolvedValue(publication());
    const view = await render();
    expect(text(view.root)).toContain("Pricing is not complete yet");
    expect(button(view.root, "Publish prices and continue").props.disabled).toBe(true);
    await act(async () => button(view.root, "Reload pricing").props.onClick());
    expect(mocks.load).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("publishes a stale publication again before continuing", async () => {
    mocks.read.mockResolvedValue({ ...publication(), stale: true });
    const context = props("complete", "complete");
    const view = await render(context);
    expect(text(view.root)).toContain("Publish the prices again to confirm them.");
    expect(
      view.root.findAll((node) => node.type === "button" && text(node) === "Continue"),
    ).toHaveLength(0);
    mocks.read.mockResolvedValue(publication());
    await act(async () => button(view.root, "Publish prices and continue").props.onClick());
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stale: true }),
      [],
      expect.anything(),
    );
    expect(context.saveAndContinue).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("refuses a publication in another currency than the hotel's", async () => {
    mocks.read.mockResolvedValue({ ...publication(), currency: "CHF" });
    const view = await render();
    expect(text(view.root)).toContain(
      "Published prices are in CHF, but the hotel currency is EUR.",
    );
    view.unmount();
  });
});

function owners({ currency = "EUR" as string | null }: { currency?: string | null } = {}) {
  return {
    currencies: ["CHF", "EUR"],
    rooms: [
      {
        roomTypeId,
        roomFactsRevision: 3,
        lifecycle: "active",
        facts: { name: "Garden Suite", occupancy: { maxGuests: 3, maxAdults: 2, maxChildren: 1 } },
      },
    ],
    pricing: currency ? { pricingCurrency: { currency, pricingCurrencyRevision: 2 } } : null,
  };
}

function publication() {
  return { currency: "EUR", revision: 1, rooms: [{ roomTypeId, offers: [{ id: "flex" }] }] };
}

function firstRate() {
  return {
    configuration: { roomTypeId, currency: "EUR", offers: [{ id: "flex" }] },
    terms: { roomTypeId, offerId: "flex" },
  };
}

function route(
  paymentsState = "complete",
  pricingState = "not_started",
): PropertySetupRouteReadModel {
  const step = (stepId: string, state: string) => ({
    stepId,
    position: stepId === "pricing" ? 5 : 8,
    state,
    sourceRevision: `${stepId}:1`,
    currentBaseRevisions: {},
    draft: null,
    blockers: [],
  });
  return {
    contractVersion: "property-setup-route.v2",
    scope: { organizationId, propertyId },
    selectedTracks: ["hotel_operations"],
    trackRevision: 3,
    sessionId: null,
    sessionRevision: null,
    resumeStepId: "pricing",
    progress: { complete: 0, total: 2 },
    steps: [step("pricing", pricingState), step("payments", paymentsState)],
  } as never;
}

function props(paymentsState = "complete", pricingState = "not_started") {
  const value = route(paymentsState, pricingState);
  return {
    propertyId,
    route: value,
    step: value.steps[0]!,
    interfaceLocale: "en" as const,
    saveAndContinue: vi.fn().mockResolvedValue(undefined),
    refreshRoute: vi.fn().mockResolvedValue(undefined),
    goToStep: vi.fn(),
    reportRevisionConflict: vi.fn(),
    registerBeforeLeave: vi.fn(() => () => undefined),
  };
}

async function render(context = props()): Promise<ReactTestRenderer> {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(PricingStep, context));
  });
  return view;
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find((node) => node.type === "button" && text(node) === label);
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}
