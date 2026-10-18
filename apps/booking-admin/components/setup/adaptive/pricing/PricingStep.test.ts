import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { PropertySetupRouteReadModel } from "@vayada/domain-hotels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  saveCurrency: vi.fn(),
  read: vi.fn(),
  publish: vi.fn(),
  readiness: vi.fn(),
}));
vi.mock("@/services/api/financePaymentReadinessClient", () => ({
  financePaymentReadinessClient: { load: mocks.readiness },
}));

vi.mock("@/services/api/onboardingPricingClient", async () => ({
  ...(await vi.importActual<typeof import("@/services/api/onboardingPricingClient")>(
    "@/services/api/onboardingPricingClient",
  )),
  onboardingPricingApi: {
    load: mocks.load,
    saveCurrency: mocks.saveCurrency,
    replacementPricing: () => ({ read: mocks.read, paymentMethods: async () => [] }),
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
    // The Payments step chose pay at the hotel, and it is ready.
    mocks.readiness.mockResolvedValue({
      methods: [
        { method: "pay_at_property", selected: true, readiness: "ready" },
        { method: "card", selected: false, readiness: "unready" },
      ],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("saves one hotel currency before showing the first-rate form", async () => {
    mocks.load.mockResolvedValue(owners({ currency: null }));
    mocks.saveCurrency.mockResolvedValue(owners());
    const view = await render();
    expect(priceInputs(view.root)).toHaveLength(0);
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
    expect(priceInputs(view.root).map((input) => input.props["aria-label"])).toEqual([
      "Price per night for Garden Suite",
    ]);
    view.unmount();
  });

  it("publishes one price per room with the defaults as the final-price declaration and continues (VAY-2188)", async () => {
    const context = props();
    const view = await render(context);
    const publishButton = () => button(view.root, "Publish prices and continue");
    // Without a price, publishing names what is missing and sends nothing.
    await act(async () => publishButton().props.onClick());
    expect(text(view.root)).toContain("A price per night for Garden Suite");
    expect(mocks.publish).not.toHaveBeenCalled();
    await type(view.root, "120");
    // How guests pay comes from the Payments step; publishing is the mandatory-charges declaration
    // (no checkbox, one visible line, VAY-2079).
    expect(text(view.root)).toContain("Pay at hotel");
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
      [expect.anything()],
      expect.objectContaining({ draftId: expect.any(String) }),
    );
    const [rate] = mocks.publish.mock.calls[0]![2] as {
      configuration: Record<string, any>;
      terms: Record<string, any>;
    }[];
    expect(rate!.configuration).toMatchObject({
      roomTypeId,
      currency: "EUR",
      children: {
        adultFromAge: 12,
        bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
      },
      offers: [
        {
          price: { calendar: { base: { mode: "flat", amountMinor: "12000" } } },
          restrictions: { rules: { minArrivalNights: 1, maxStayNights: null } },
        },
      ],
    });
    expect(rate!.terms).toMatchObject({
      cancellation: { kind: "flexible", terms: { freeCancellationDeadlineDays: 3 } },
      payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
    });
    expect(context.refreshRoute).toHaveBeenCalledOnce();
    expect(context.saveAndContinue).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("offers non-refundable only with a way to pay in advance, and never sends pay at property with it (VAY-2280)", async () => {
    // Only pay at the hotel is ready: non-refundable stays (paid in advance) can't be offered.
    const view = await render();
    expect(button(view.root, "Non-refundable").props.disabled).toBe(true);
    expect(text(view.root)).toContain("Non-refundable stays are paid in advance");
    view.unmount();
    mocks.readiness.mockResolvedValue({
      methods: [
        { method: "pay_at_property", selected: true, readiness: "ready" },
        { method: "card", selected: true, readiness: "ready" },
      ],
    });
    const next = await render();
    await act(async () => button(next.root, "Non-refundable").props.onClick());
    expect(text(next.root)).toContain(
      "Pay at property: not offered, non-refundable stays are paid in advance",
    );
    await type(next.root, "120");
    mocks.read.mockResolvedValue(publication());
    await act(async () => button(next.root, "Publish prices and continue").props.onClick());
    const [rate] = mocks.publish.mock.calls[0]![2] as { terms: Record<string, any> }[];
    expect(rate!.terms).toMatchObject({
      cancellation: { kind: "non_refundable" },
      payment: { kind: "full", acceptedMethods: ["card"] },
    });
    next.unmount();
  });

  it("starts a flexible rate as paid at the property even when card is ready (VAY-2205)", async () => {
    mocks.readiness.mockResolvedValue({
      methods: [
        { method: "pay_at_property", selected: true, readiness: "ready" },
        { method: "card", selected: true, readiness: "ready" },
      ],
    });
    const view = await render();
    expect(text(view.root)).toContain("Guests pay at the property. Rates paid when booking");
    await type(view.root, "120");
    mocks.read.mockResolvedValue(publication());
    await act(async () => button(view.root, "Publish prices and continue").props.onClick());
    const [rate] = mocks.publish.mock.calls[0]![2] as { terms: Record<string, any> }[];
    expect(rate!.terms).toMatchObject({
      cancellation: { kind: "flexible" },
      payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
    });
    view.unmount();
    // Card only: the flexible rate is paid in full when booking.
    mocks.publish.mockClear();
    mocks.read.mockResolvedValue(null);
    mocks.readiness.mockResolvedValue({
      methods: [{ method: "card", selected: true, readiness: "ready" }],
    });
    const cardOnly = await render();
    expect(text(cardOnly.root)).not.toContain("Guests pay at the property.");
    await type(cardOnly.root, "120");
    mocks.read.mockResolvedValue(publication());
    await act(async () => button(cardOnly.root, "Publish prices and continue").props.onClick());
    const [paid] = mocks.publish.mock.calls[0]![2] as { terms: Record<string, any> }[];
    expect(paid!.terms.payment).toEqual({ kind: "full", acceptedMethods: ["card"] });
    cardOnly.unmount();
  });

  it("sends the owner to Payments before any rate is entered", async () => {
    const context = props("not_started");
    const view = await render(context);
    expect(priceInputs(view.root)).toHaveLength(0);
    expect(button(view.root, "Publish prices and continue").props.disabled).toBe(true);
    await act(async () => button(view.root, "Back to Payments").props.onClick());
    expect(context.goToStep).toHaveBeenCalledWith("payments");
    expect(mocks.publish).not.toHaveBeenCalled();
    view.unmount();
  });

  it("resumes the same publish attempt after a lost response", async () => {
    const view = await render();
    await type(view.root, "120");
    mocks.publish.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => button(view.root, "Publish prices and continue").props.onClick());
    expect(text(view.root)).toContain("Pricing was not saved");
    await act(async () => button(view.root, "Try again").props.onClick());
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.publish.mock.calls[1]![3]).toBe(mocks.publish.mock.calls[0]![3]);
    view.unmount();
  });

  it("keeps the offer ids when Publish is pressed again after a failure", async () => {
    const view = await render();
    await type(view.root, "120");
    mocks.publish.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => button(view.root, "Publish prices and continue").props.onClick());
    await act(async () => button(view.root, "Publish prices and continue").props.onClick());
    const offerId = (call: number) =>
      (mocks.publish.mock.calls[call]![2] as { terms: { offerId: string } }[])[0]!.terms.offerId;
    expect(offerId(1)).toBe(offerId(0));
    view.unmount();
  });

  it("names a price that isn't a number with its room, and never publishes an older price (VAY-2188)", async () => {
    const view = await render();
    await type(view.root, "120");
    mocks.publish.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => button(view.root, "Publish prices and continue").props.onClick());
    expect(text(view.root)).toContain("Pricing was not saved");
    await type(view.root, "89,50");
    expect(text(view.root)).not.toContain("Pricing was not saved");
    await act(async () => button(view.root, "Publish prices and continue").props.onClick());
    expect(text(view.root)).toContain(
      "A price per night for Garden Suite in numbers only, like 89.50",
    );
    expect(text(view.root)).not.toContain("Pricing was not saved");
    expect(priceInputs(view.root)[0]!.props["aria-invalid"]).toBe(true);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    await type(view.root, "89.50");
    expect(text(view.root)).not.toContain("Fill in what is still missing:");
    await act(async () => button(view.root, "Publish prices and continue").props.onClick());
    const [rate] = mocks.publish.mock.calls[1]![2] as { configuration: Record<string, any> }[];
    expect(rate!.configuration.offers[0].price.calendar.base).toEqual({
      mode: "flat",
      amountMinor: "8950",
    });
    view.unmount();
  });

  it("waits for the Payments step's choice, and says when none of its ways to pay is ready", async () => {
    let answer!: (value: unknown) => void;
    mocks.readiness.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const view = await render();
    await type(view.root, "120");
    expect(button(view.root, "Publish prices and continue").props.disabled).toBe(true);
    await act(async () =>
      answer({ methods: [{ method: "card", selected: true, readiness: "unready" }] }),
    );
    expect(button(view.root, "Publish prices and continue").props.disabled).toBe(false);
    expect(text(view.root)).toContain(
      "None of the ways to pay from the Payments step is ready yet.",
    );
    view.unmount();
  });

  it("explains a refused preparation and asks for a reload after a conflict", async () => {
    const view = await render();
    await type(view.root, "120");
    mocks.publish.mockRejectedValueOnce(new ApiErrorResponse(403, { code: "denied" }));
    await act(async () => button(view.root, "Publish prices and continue").props.onClick());
    expect(text(view.root)).toContain("Check that Payments is complete");
    // A Finance reason names what to fix; the rates stay and "Try again" resumes.
    mocks.publish.mockRejectedValueOnce(
      new ApiErrorResponse(403, { code: "denied", reason: "method_unavailable" } as never),
    );
    await act(async () => button(view.root, "Try again").props.onClick());
    expect(text(view.root)).toContain("Change the rate to accept pay at property");
    expect(priceInputs(view.root)[0]!.props.value).toBe("120");
    mocks.publish.mockRejectedValueOnce(new ApiErrorResponse(409, { code: "stale" }));
    await act(async () => button(view.root, "Try again").props.onClick());
    expect(text(view.root)).toContain("Pricing changed in another session");
    await act(async () => button(view.root, "Reload pricing").props.onClick());
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(priceInputs(view.root)[0]!.props.value).toBe("");
    view.unmount();
  });

  it("asks how guests pay when the Payments step's choice can't be read (VAY-2188)", async () => {
    mocks.readiness.mockRejectedValue(new TypeError("Failed to fetch"));
    const view = await render();
    await type(view.root, "95");
    await act(async () => button(view.root, "Publish prices and continue").props.onClick());
    expect(text(view.root)).toContain("Fill in what is still missing:");
    expect(text(view.root)).toContain("How guests pay");
    expect(mocks.publish).not.toHaveBeenCalled();
    const atHotel = view.root.find(
      (node) => node.type === "input" && node.props["aria-label"] === "Pay at property",
    );
    await act(async () => atHotel.props.onChange({ target: { checked: true } }));
    await act(async () => button(view.root, "Publish prices and continue").props.onClick());
    const [rate] = mocks.publish.mock.calls[0]![2] as { terms: Record<string, any> }[];
    expect(rate!.terms.payment).toEqual({ kind: "full", acceptedMethods: ["pay_at_property"] });
    view.unmount();
  });

  it("continues without writes when setup confirms every room is published", async () => {
    mocks.read.mockResolvedValue(publication());
    const context = props("complete", "complete");
    const view = await render(context);
    expect(text(view.root)).toContain("Published · 1 rate");
    expect(priceInputs(view.root)).toHaveLength(0);
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

function priceInputs(root: ReactTestInstance) {
  return root.findAll(
    (node) =>
      node.type === "input" && String(node.props["aria-label"]).startsWith("Price per night for"),
  );
}

async function type(root: ReactTestInstance, value: string) {
  await act(async () => priceInputs(root)[0]!.props.onChange({ target: { value } }));
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
