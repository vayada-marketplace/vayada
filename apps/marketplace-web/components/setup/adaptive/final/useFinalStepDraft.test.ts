import { createElement, useEffect } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
const mocks = vi.hoisted(() => ({ save: vi.fn(), reset: vi.fn(), route: vi.fn() }));
vi.mock("@/services/api/adaptiveSetupDraftClient", () => ({
  adaptiveSetupDraftClient: { save: mocks.save },
}));
vi.mock("@/services/api/propertySetupDraftResetClient", () => ({
  propertySetupDraftResetApi: { reset: mocks.reset },
  PropertySetupDraftResetError: class extends Error {},
}));
vi.mock("@/services/api/propertySetupRouteClient", () => ({
  createPropertySetupRouteClient: () => ({ getRoute: mocks.route }),
}));
import { useFinalStepDraft } from "./useFinalStepDraft";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockImplementation(async (_id, request) => ({
    sessionId: "session",
    trackRevision: request.expectedTrackRevision,
    sessionRevision: request.expectedSessionRevision + 1,
    draftRevision: request.expectedDraftRevision + 1,
  }));
  mocks.reset.mockImplementation(async (_id, request) => ({
    sessionRevision: request.expectedSessionRevision + 1,
  }));
});
async function harness(stepId: "guest_experience" | "payments", resumed = false) {
  const field = stepId === "payments" ? "payment.accepted_methods" : "guest.phone_required";
  const value = stepId === "payments" ? ["pay_at_property"] : false;
  let beforeLeave!: () => Promise<void>;
  let recover!: () => Promise<void>;
  const baseRevisions =
    stepId === "payments"
      ? { "finance.payment_methods": "payment-methods:0", "pms.pricing_settings": "currency:1" }
      : { "booking.guest_experience": "guest-policy:absent" };
  const step = {
    stepId,
    currentBaseRevisions: baseRevisions,
    draft: resumed
      ? {
          stepId,
          revision: 2,
          baseRevisions,
          payload: { [field]: value, "policy.cancellation_bundle_confirmation": true },
          dirtyFields: [
            field,
            ...(stepId === "guest_experience" ? ["policy.cancellation_bundle_confirmation"] : []),
          ],
        }
      : null,
  };
  const props = {
    propertyId: "property",
    step,
    route: {
      scope: { organizationId: "org", propertyId: "property" },
      selectedTracks: ["hotel_operations"],
      trackRevision: 1,
      sessionId: "session",
      sessionRevision: 3,
      steps: [step],
    },
    registerBeforeLeave: (fn: () => Promise<void>) => {
      beforeLeave = fn;
      return () => {};
    },
    registerStaleRecovery: (fn: () => Promise<void>) => {
      recover = fn;
      return () => {};
    },
    refreshRoute: vi.fn().mockResolvedValue(undefined),
    saveAndContinue: vi.fn().mockResolvedValue(undefined),
    reportRevisionConflict: vi.fn(),
  } as unknown as AdaptiveSetupStepComponentProps;
  let current!: ReturnType<typeof useFinalStepDraft>;
  function Harness() {
    const draft = useFinalStepDraft(props, stepId);
    current = draft;
    const { initialize, reload } = draft;
    useEffect(() => {
      initialize({});
    }, [initialize, reload]);
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  return {
    get current() {
      return current;
    },
    props,
    field: field as "payment.accepted_methods" | "guest.phone_required",
    value,
    leave: () => beforeLeave(),
    recover: () => recover(),
    renderer,
  };
}
describe.each(["guest_experience", "payments"] as const)("%s draft boundary", (stepId) => {
  it("saves an incomplete edit on exit without canonical mutation", async () => {
    const h = await harness(stepId);
    await act(async () => h.current.change(h.field, h.value));
    await act(async () => h.leave());
    expect(mocks.save).toHaveBeenCalledWith(
      "property",
      expect.objectContaining({
        stepId,
        expectedDraftRevision: 0,
        expectedSessionRevision: 3,
        payload: expect.objectContaining({ [h.field]: h.value }),
      }),
    );
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(h.props.saveAndContinue).not.toHaveBeenCalled();
    h.renderer.unmount();
  });
  it("retains resumed answers and clears policy confirmation", async () => {
    const h = await harness(stepId, true);
    expect(h.current.data[h.field]).toEqual(h.value);
    if (stepId === "guest_experience")
      expect(h.current.data["policy.cancellation_bundle_confirmation"]).toBe(false);
    await act(async () => h.leave());
    expect(mocks.save).not.toHaveBeenCalled();
    h.renderer.unmount();
  });
  it("preserves edits after failed exit save", async () => {
    const h = await harness(stepId);
    await act(async () => h.current.change(h.field, h.value));
    mocks.save.mockRejectedValueOnce(new Error("offline"));
    await expect(h.leave()).rejects.toThrow("offline");
    expect(h.current.data[h.field]).toEqual(h.value);
    await act(async () => h.leave());
    expect(mocks.save).toHaveBeenCalledTimes(2);
    h.renderer.unmount();
  });
  it("resets exactly its own saved draft after canonical acceptance", async () => {
    const h = await harness(stepId);
    await act(async () => h.current.change(h.field, h.value));
    const canonical = vi.fn().mockResolvedValue(undefined);
    await act(async () => h.current.commit(canonical));
    expect(canonical).toHaveBeenCalledOnce();
    expect(mocks.reset).toHaveBeenCalledWith(
      "property",
      expect.objectContaining({
        sessionId: "session",
        expectedDraftRevision: 1,
        expectedSessionRevision: 4,
      }),
    );
    expect(h.props.saveAndContinue).toHaveBeenCalledOnce();
    h.renderer.unmount();
  });
  it("does not reset the draft when canonical save fails", async () => {
    const h = await harness(stepId);
    await act(async () => h.current.change(h.field, h.value));
    await act(async () =>
      h.current.commit(async () => {
        throw new Error("denied");
      }),
    );
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(h.props.saveAndContinue).not.toHaveBeenCalled();
    expect(h.current.error).toBe("denied");
    h.renderer.unmount();
  });
  it("blocks exit while the canonical command is in flight", async () => {
    const h = await harness(stepId);
    let resolve!: () => void;
    const waiting = new Promise<void>((done) => {
      resolve = done;
    });
    let task!: Promise<void>;
    await act(async () => {
      task = h.current.commit(() => waiting);
    });
    await expect(h.leave()).rejects.toThrow("Wait for this step");
    await act(async () => {
      resolve();
      await task;
    });
    h.renderer.unmount();
  });
  it("retains resumed answers after reset succeeds but refresh fails", async () => {
    const h = await harness(stepId, true);
    mocks.route.mockRejectedValueOnce(new Error("offline"));
    await expect(act(async () => h.recover())).rejects.toThrow("offline");
    await act(async () => h.leave());
    expect(mocks.save).toHaveBeenCalledWith(
      "property",
      expect.objectContaining({
        expectedDraftRevision: 0,
        payload: expect.objectContaining({ [h.field]: h.value }),
      }),
    );
    h.renderer.unmount();
  });
  it("blocks exit during stale recovery", async () => {
    const h = await harness(stepId, true);
    let resolve!: (value: unknown) => void;
    mocks.route.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    let task!: Promise<void>;
    await act(async () => {
      task = h.recover();
    });
    await expect(h.leave()).rejects.toThrow("Wait for this step");
    await act(async () => {
      resolve({ ...h.props.route, sessionRevision: 4, steps: [{ ...h.props.step, draft: null }] });
      await task;
    });
    h.renderer.unmount();
  });
  it("preserves local edits across an explicit reset and source reload", async () => {
    const h = await harness(stepId, true);
    await act(async () => h.current.change(h.field, h.value));
    mocks.route.mockResolvedValue({
      ...h.props.route,
      sessionRevision: 4,
      steps: [{ ...h.props.step, draft: null }],
    });
    await act(async () => h.recover());
    expect(h.current.data[h.field]).toEqual(h.value);
    await act(async () => h.leave());
    expect(mocks.save).toHaveBeenLastCalledWith(
      "property",
      expect.objectContaining({ expectedDraftRevision: 0, expectedSessionRevision: 4 }),
    );
    h.renderer.unmount();
  });
});
