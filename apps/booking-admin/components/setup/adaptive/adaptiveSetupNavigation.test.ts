import { describe, expect, it } from "vitest";

import {
  ADAPTIVE_SETUP_STEP_COPY,
  ADAPTIVE_SETUP_STEP_IDS,
  resolveAdaptiveSetupActiveStep,
  resolveNextAdaptiveSetupStep,
  resolvePreviousAdaptiveSetupStep,
  resolveSupportedInterfaceLocale,
  type AdaptiveSetupNavigationStep,
} from "./adaptiveSetupNavigation";

const routeSteps: AdaptiveSetupNavigationStep[] = [
  { stepId: "present_hotel", state: "complete" },
  { stepId: "booking_design", state: "draft" },
  { stepId: "rooms", state: "not_started" },
  { stepId: "pricing", state: "not_started" },
  { stepId: "calendar", state: "not_started" },
  { stepId: "guest_experience", state: "not_started" },
  { stepId: "payments", state: "not_started" },
  { stepId: "review", state: "not_started" },
];

describe("resolveAdaptiveSetupActiveStep", () => {
  it("honors a requested active step before resume state", () => {
    expect(
      resolveAdaptiveSetupActiveStep({
        steps: routeSteps,
        requestedStepId: "pricing",
        resumeStepId: "booking_design",
      })?.stepId,
    ).toBe("pricing");
  });

  it("ignores requested steps that are not in the server route", () => {
    const shortSteps = [routeSteps[0]!, routeSteps[1]!, routeSteps[7]!];

    expect(
      resolveAdaptiveSetupActiveStep({
        steps: shortSteps,
        requestedStepId: "pricing",
        resumeStepId: "booking_design",
      })?.stepId,
    ).toBe("booking_design");
  });

  it("uses the server resume step before scanning completion", () => {
    expect(
      resolveAdaptiveSetupActiveStep({
        steps: routeSteps,
        requestedStepId: "not-a-step",
        resumeStepId: "calendar",
      })?.stepId,
    ).toBe("calendar");
  });

  it("selects the first non-complete step in server order", () => {
    expect(
      resolveAdaptiveSetupActiveStep({
        steps: routeSteps,
        resumeStepId: "inactive-step",
      })?.stepId,
    ).toBe("booking_design");
  });

  it("selects review when every step is complete", () => {
    const completeSteps = routeSteps.map((step) => ({ ...step, state: "complete" as const }));

    expect(resolveAdaptiveSetupActiveStep({ steps: completeSteps })?.stepId).toBe("review");
  });

  it("falls back to the final server step when a route has no review step", () => {
    const completeSteps = routeSteps
      .slice(0, 2)
      .map((step) => ({ ...step, state: "complete" as const }));

    expect(resolveAdaptiveSetupActiveStep({ steps: completeSteps })?.stepId).toBe("booking_design");
  });

  it("returns null for an empty route", () => {
    expect(resolveAdaptiveSetupActiveStep({ steps: [] })).toBeNull();
  });
});

describe("adaptive route-order navigation", () => {
  it("uses the preceding and following positions from the server response", () => {
    expect(resolvePreviousAdaptiveSetupStep(routeSteps, "rooms")?.stepId).toBe("booking_design");
    expect(resolveNextAdaptiveSetupStep(routeSteps, "booking_design")?.stepId).toBe("rooms");
  });

  it("returns null at route boundaries or for inactive steps", () => {
    expect(resolvePreviousAdaptiveSetupStep(routeSteps, "present_hotel")).toBeNull();
    expect(resolvePreviousAdaptiveSetupStep(routeSteps, "not-a-step")).toBeNull();
    expect(resolveNextAdaptiveSetupStep(routeSteps, "review")).toBeNull();
    expect(resolveNextAdaptiveSetupStep(routeSteps, "not-a-step")).toBeNull();
  });
});

describe("adaptive setup copy", () => {
  it("has stable English copy for every supported step", () => {
    expect(Object.keys(ADAPTIVE_SETUP_STEP_COPY)).toEqual([...ADAPTIVE_SETUP_STEP_IDS]);
    for (const stepId of ADAPTIVE_SETUP_STEP_IDS) {
      expect(ADAPTIVE_SETUP_STEP_COPY[stepId].title.length).toBeGreaterThan(0);
      expect(ADAPTIVE_SETUP_STEP_COPY[stepId].subtitle.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveSupportedInterfaceLocale", () => {
  it("derives a supported interface locale from the browser and falls back safely", () => {
    expect(resolveSupportedInterfaceLocale("en-US")).toBe("en");
    expect(resolveSupportedInterfaceLocale("de-DE")).toBe("en");
    expect(resolveSupportedInterfaceLocale(null)).toBe("en");
  });
});
