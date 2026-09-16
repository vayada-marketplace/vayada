import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("@/services/api/bookingGuestRulesClient", () => ({
  bookingGuestRulesClient: mocks,
  guestRulesErrorMessage: (error: Error) => error.message,
}));
import { GuestExperienceStep } from "./GuestExperienceStep";
const propertyId = "22222222-2222-4222-8222-222222222222",
  organizationId = "11111111-1111-4111-8111-111111111111";
const choices = {
  defaultGuestLanguage: "en",
  childrenEnabled: false,
  adultAgeThreshold: 16,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
  checkInUntil: "23:00",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue({ revision: propertyId, choices });
  mocks.save.mockResolvedValue({ revision: organizationId, choices });
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
function confirm(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType("input")
    .filter((i) => i.props.type === "checkbox")
    .at(-1)!;
}
async function submit(renderer: ReactTestRenderer) {
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}
describe("replacement guest rules editor", () => {
  it("requires first-entry choices and explicit confirmation", async () => {
    mocks.load.mockResolvedValue(null);
    const h = await render();
    expect(
      h.renderer.root
        .findAllByType("select")
        .slice(0, 2)
        .map((i) => i.props.value),
    ).toEqual(["", ""]);
    await submit(h.renderer);
    expect(mocks.save).not.toHaveBeenCalled();
    h.renderer.unmount();
  });
  it("saves confirmed rules then delegates refreshed navigation to the controller", async () => {
    const h = await render();
    await act(async () => confirm(h.renderer).props.onChange({ target: { checked: true } }));
    await submit(h.renderer);
    expect(mocks.save).toHaveBeenCalledWith(propertyId, propertyId, choices, expect.any(String));
    expect(JSON.stringify(h.renderer.toJSON())).toContain("Guest rules saved.");
    expect(h.props.saveAndContinue).toHaveBeenCalledOnce();
    expect(h.props.refreshRoute).not.toHaveBeenCalled();
    await expect(h.leave()).resolves.toBeUndefined();
    h.renderer.unmount();
  });
  it("clears confirmation on edits, preserves age bounds and blocks unsaved navigation", async () => {
    const h = await render();
    await act(async () => confirm(h.renderer).props.onChange({ target: { checked: true } }));
    await act(async () =>
      h.renderer.root.findAllByType("select")[1].props.onChange({ target: { value: "true" } }),
    );
    expect(confirm(h.renderer).props.checked).toBe(false);
    expect(
      h.renderer.root.findAllByType("input").find((i) => i.props.type === "number")!.props.value,
    ).toBe(16);
    await expect(h.leave()).rejects.toThrow("Save your guest rules");
    await submit(h.renderer);
    expect(mocks.save).not.toHaveBeenCalled();
    h.renderer.unmount();
  });
  it("keeps the retry identity and edits after an uncertain save", async () => {
    mocks.save.mockRejectedValueOnce(new Error("Network unavailable"));
    const h = await render();
    await act(async () =>
      h.renderer.root.findAllByType("select")[0].props.onChange({ target: { value: "de" } }),
    );
    await act(async () => confirm(h.renderer).props.onChange({ target: { checked: true } }));
    await submit(h.renderer);
    await expect(h.leave()).rejects.toThrow();
    const first = mocks.save.mock.calls[0];
    await submit(h.renderer);
    expect(mocks.save.mock.calls[1]).toEqual(first);
    h.renderer.unmount();
  });
  it("allows the controller leave guard after saving and retries navigation without another write", async () => {
    const h = await render();
    vi.mocked(h.props.saveAndContinue).mockImplementationOnce(async () => {
      await h.leave();
      throw new Error("Setup progress unavailable");
    });
    await act(async () => confirm(h.renderer).props.onChange({ target: { checked: true } }));
    await submit(h.renderer);
    expect(JSON.stringify(h.renderer.toJSON())).toContain("Guest rules saved.");
    expect(JSON.stringify(h.renderer.toJSON())).toContain("Setup progress unavailable");
    await submit(h.renderer);
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(h.props.saveAndContinue).toHaveBeenCalledTimes(2);
    h.renderer.unmount();
  });
  it("blocks navigation and duplicate submits while the save is pending", async () => {
    let finish!: (value: unknown) => void;
    mocks.save.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const h = await render();
    await act(async () => confirm(h.renderer).props.onChange({ target: { checked: true } }));
    await submit(h.renderer);
    await submit(h.renderer);
    await expect(h.leave()).rejects.toThrow("Wait for guest rules");
    expect(h.props.saveAndContinue).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledOnce();
    await act(async () => finish({ revision: organizationId, choices }));
    expect(h.props.saveAndContinue).toHaveBeenCalledOnce();
    h.renderer.unmount();
  });
  it("ignores a saved response after the property scope changes", async () => {
    let finish!: (value: unknown) => void;
    mocks.save.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const h = await render();
    await act(async () => confirm(h.renderer).props.onChange({ target: { checked: true } }));
    await submit(h.renderer);
    await act(async () =>
      h.renderer.update(
        createElement(GuestExperienceStep, {
          ...h.props,
          route: {
            ...h.props.route,
            scope: { ...h.props.route.scope, propertyId: organizationId },
          },
        }),
      ),
    );
    await act(async () => finish({ revision: organizationId, choices }));
    expect(h.props.saveAndContinue).not.toHaveBeenCalled();
    h.renderer.unmount();
  });
  it("does not expose the editor after a failed authorized load", async () => {
    mocks.load.mockRejectedValue(new Error("Forbidden"));
    const h = await render();
    expect(h.renderer.root.findAllByType("form")).toHaveLength(0);
    h.renderer.unmount();
  });
});
