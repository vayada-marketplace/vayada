import { describe, expect, it } from "vitest";

import { isFourStepSetupEnabled, isOnboardingV2Enabled } from "./onboardingV2";

describe("ONBOARDING_V2 (VAY-2247)", () => {
  it("is on only when set to exactly true", () => {
    expect(isOnboardingV2Enabled({ ONBOARDING_V2_ENABLED: "true" })).toBe(true);
    for (const value of [undefined, "", "false", "TRUE", "1", "yes"])
      expect(isOnboardingV2Enabled({ ONBOARDING_V2_ENABLED: value })).toBe(false);
  });
});

describe("FOUR_STEP_SETUP (VAY-2451)", () => {
  it("is on only with ONBOARDING_V2 and when set to exactly true", () => {
    const on = { ONBOARDING_V2_ENABLED: "true", FOUR_STEP_SETUP_ENABLED: "true" };
    expect(isFourStepSetupEnabled(on)).toBe(true);
    expect(isFourStepSetupEnabled({ ...on, ONBOARDING_V2_ENABLED: undefined })).toBe(false);
    for (const value of [undefined, "", "false", "TRUE", "1"])
      expect(isFourStepSetupEnabled({ ...on, FOUR_STEP_SETUP_ENABLED: value })).toBe(false);
  });
});
