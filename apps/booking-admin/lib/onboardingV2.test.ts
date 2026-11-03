import { describe, expect, it } from "vitest";

import { isOnboardingV2Enabled } from "./onboardingV2";

describe("ONBOARDING_V2 (VAY-2247)", () => {
  it("is on only when set to exactly true", () => {
    expect(isOnboardingV2Enabled({ ONBOARDING_V2_ENABLED: "true" })).toBe(true);
    for (const value of [undefined, "", "false", "TRUE", "1", "yes"])
      expect(isOnboardingV2Enabled({ ONBOARDING_V2_ENABLED: value })).toBe(false);
  });
});
