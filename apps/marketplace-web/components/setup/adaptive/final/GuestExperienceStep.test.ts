import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PMS_ROOM_FACTS_CONTRACT_VERSION } from "@vayada/domain-pms";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  preview: vi.fn(),
  save: vi.fn(),
  draft: vi.fn(),
  reset: vi.fn(),
  rooms: vi.fn(),
}));
vi.mock("@/services/api/bookingGuestPolicyClient", () => ({
  bookingGuestPolicyClient: { load: mocks.load, preview: mocks.preview, save: mocks.save },
}));
vi.mock("@/services/api/adaptiveSetupDraftClient", () => ({
  adaptiveSetupDraftClient: { save: mocks.draft },
}));
vi.mock("@/services/api/propertySetupDraftResetClient", () => ({
  propertySetupDraftResetApi: { reset: mocks.reset },
  PropertySetupDraftResetError: class extends Error {},
}));
vi.mock("@/services/api/targetClient", () => ({ targetApiClient: { get: mocks.rooms } }));
import { GuestExperienceStep } from "./GuestExperienceStep";
const propertyId = "22222222-2222-4222-8222-222222222222",
  organizationId = "11111111-1111-4111-8111-111111111111",
  roomTypeId = "33333333-3333-4333-8333-333333333333";
const choices = {
  defaultGuestLanguage: "en",
  childrenEnabled: false,
  adultAgeThreshold: null,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
  checkInUntil: "23:00",
};
const bundle = {
  propertyId,
  organizationId,
  choices,
  sourceFingerprint: `sha256:${"1".repeat(64)}`,
  bundleHash: `sha256:${"2".repeat(64)}`,
  pricingCurrency: "EUR",
  propertyTimeZone: "Europe/Berlin",
  rates: [
    {
      roomTypeId,
      roomFactsRevision: 1,
      flexible: {
        freeCancellationDeadlineDays: 2,
        cutoff: { localTime: "18:00", timeZone: "Europe/Berlin" },
      },
      nonRefundable: null,
      additionalGuest: null,
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue({ revision: 0, choices });
  mocks.preview.mockResolvedValue({ outcome: "ready", bundle });
  mocks.save.mockResolvedValue({ revision: 1, choices });
  mocks.draft.mockResolvedValue({
    sessionId: "session",
    trackRevision: 1,
    sessionRevision: 2,
    draftRevision: 1,
  });
  mocks.reset.mockResolvedValue({ sessionRevision: 3 });
  mocks.rooms.mockResolvedValue({
    propertyId,
    items: [
      {
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId,
        roomTypeId,
        roomFactsRevision: 1,
        lifecycle: "active",
        createdAt: "2026-09-11T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z",
        facts: {
          name: "Garden Suite",
          description: "",
          category: null,
          occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 2 },
          beds: [{ type: "king", quantity: 1 }],
          bedrooms: null,
          bathrooms: 1,
          bathroomType: "private",
          size: null,
        },
      },
    ],
  });
});
async function render(track: "hotel_operations" | "both" = "hotel_operations") {
  let leave!: () => Promise<void>;
  const step = {
    stepId: "guest_experience",
    currentBaseRevisions: { "booking.guest_experience": "guest-policy:absent" },
    draft: null,
  };
  const props = {
    propertyId,
    route: {
      scope: { organizationId, propertyId },
      selectedTracks: track === "both" ? ["hotel_operations", "creator_marketplace"] : [track],
      trackRevision: 1,
      sessionRevision: 1,
      sessionId: "session",
      steps: [step],
    },
    step,
    interfaceLocale: "de",
    registerBeforeLeave: (callback: () => Promise<void>) => {
      leave = callback;
      return () => {};
    },
    registerStaleRecovery: () => () => {},
    refreshRoute: vi.fn(),
    reportRevisionConflict: vi.fn(),
    saveAndContinue: vi.fn(),
  } as unknown as AdaptiveSetupStepComponentProps;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(GuestExperienceStep, props));
  });
  return { renderer, props, leave: () => leave() };
}
function review(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("button").find((button) => button.props.type === "button")!;
}
function confirm(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType("input")
    .filter((input) => input.props.type === "checkbox")
    .at(-1)!;
}
async function submit(renderer: ReactTestRenderer) {
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}
describe("guest experience editor", () => {
  it("requires explicit first-entry choices independent of interface language", async () => {
    mocks.load.mockResolvedValue({
      revision: 0,
      choices: {
        ...choices,
        defaultGuestLanguage: null,
        childrenEnabled: null,
        checkInTime: null,
        checkOutTime: null,
      },
    });
    const h = await render();
    expect(
      h.renderer.root
        .findAllByType("select")
        .slice(0, 2)
        .map((input) => input.props.value),
    ).toEqual(["", ""]);
    await act(async () => review(h.renderer).props.onClick());
    expect(mocks.preview).not.toHaveBeenCalled();
    h.renderer.unmount();
  });
  it.each(["hotel_operations", "both"] as const)(
    "reviews named room terms and saves for %s",
    async (track) => {
      const h = await render(track);
      await act(async () => review(h.renderer).props.onClick());
      expect(JSON.stringify(h.renderer.toJSON())).toContain("Garden Suite");
      await act(async () => confirm(h.renderer).props.onChange({ target: { checked: true } }));
      await submit(h.renderer);
      expect(mocks.save).toHaveBeenCalledWith(
        { organizationId, propertyId },
        expect.objectContaining({
          expectedRevision: 0,
          confirmPolicyBundle: true,
          choices: expect.objectContaining({ checkInUntil: "23:00" }),
        }),
        bundle,
      );
      expect(mocks.reset).toHaveBeenCalledOnce();
      expect(h.props.saveAndContinue).toHaveBeenCalledOnce();
      h.renderer.unmount();
    },
  );
  it("clears confirmation and preview after an answer changes", async () => {
    const h = await render();
    await act(async () => review(h.renderer).props.onClick());
    await act(async () => confirm(h.renderer).props.onChange({ target: { checked: true } }));
    await act(async () =>
      h.renderer.root.findAllByType("select")[0].props.onChange({ target: { value: "de" } }),
    );
    expect(
      h.renderer.root.findAllByType("button").find((button) => button.props.type === "submit")!
        .props.disabled,
    ).toBe(true);
    await submit(h.renderer);
    expect(mocks.save).not.toHaveBeenCalled();
    h.renderer.unmount();
  });
  it("keeps missing pricing blocked and saves partial answers on exit", async () => {
    mocks.preview.mockResolvedValue({
      outcome: "blocked",
      blockers: [{ code: "pricing_source_missing" }],
    });
    const h = await render();
    await act(async () => review(h.renderer).props.onClick());
    expect(JSON.stringify(h.renderer.toJSON())).toContain("Policy review is not ready");
    await act(async () => h.leave());
    expect(mocks.draft).toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    h.renderer.unmount();
  });
  it("rejects a stale canonical revision without overwriting it", async () => {
    mocks.load.mockResolvedValue({ revision: 2, choices });
    const h = await render();
    await act(async () => review(h.renderer).props.onClick());
    await act(async () => confirm(h.renderer).props.onChange({ target: { checked: true } }));
    await submit(h.renderer);
    expect(h.props.reportRevisionConflict).toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    h.renderer.unmount();
  });
  it("preserves a custom adult threshold through disabling children and draft exit", async () => {
    mocks.load.mockResolvedValue({
      revision: 0,
      choices: { ...choices, childrenEnabled: true, adultAgeThreshold: 16 },
    });
    const h = await render();
    await act(async () =>
      h.renderer.root.findAllByType("select")[1].props.onChange({ target: { value: "false" } }),
    );
    await act(async () => h.leave());
    expect(mocks.draft).toHaveBeenLastCalledWith(
      propertyId,
      expect.objectContaining({
        payload: expect.objectContaining({
          "guest.adult_age_threshold": 16,
          "guest.children_enabled": false,
        }),
      }),
    );
    await act(async () =>
      h.renderer.root.findAllByType("select")[1].props.onChange({ target: { value: "true" } }),
    );
    expect(
      h.renderer.root.findAllByType("input").find((input) => input.props.type === "number")!.props
        .value,
    ).toBe(16);
    h.renderer.unmount();
  });
  it("discloses nightly per-person charges and non-refundable payment prerequisites", async () => {
    mocks.preview.mockResolvedValue({
      outcome: "ready",
      bundle: {
        ...bundle,
        rates: [
          {
            ...bundle.rates[0],
            nonRefundable: {},
            additionalGuest: {
              includedGuestsPerRoom: 2,
              amountDecimal: "30",
              currency: "EUR",
              countedGuestTypes: ["adult", "child"],
            },
          },
        ],
      },
    });
    const h = await render();
    await act(async () => review(h.renderer).props.onClick());
    const copy = JSON.stringify(h.renderer.toJSON());
    expect(copy).toContain("per night");
    expect(copy).toContain("Each additional");
    expect(copy).toContain("ready online card payment method");
    h.renderer.unmount();
  });
  it("does not render an editable form when access is denied", async () => {
    mocks.load.mockRejectedValue(new Error("Forbidden"));
    const h = await render();
    expect(h.renderer.root.findAllByType("form")).toHaveLength(0);
    expect(JSON.stringify(h.renderer.toJSON())).toContain("Forbidden");
    h.renderer.unmount();
  });
});
