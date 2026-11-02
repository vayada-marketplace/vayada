/**
 * VAY-2247: the new first run in Booking Admin (`/setup`), read on the server per request.
 * Off unless ONBOARDING_V2_ENABLED is exactly "true", so production needs no change to stay off.
 * The API's HOTEL_FIRST_RUN_ENABLED must be on wherever this is.
 */
export function isOnboardingV2Enabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env["ONBOARDING_V2_ENABLED"] === "true";
}

/**
 * VAY-2451: the four-step setup instead of the 7-step one (with ONBOARDING_V2_ENABLED), read per request.
 * Off unless FOUR_STEP_SETUP_ENABLED is exactly "true". Switch it on with the API's
 * HOTEL_GO_LIVE_CHECKLIST_ENABLED, which moves the dashboards to the new cards.
 */
export function isFourStepSetupEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isOnboardingV2Enabled(env) && env["FOUR_STEP_SETUP_ENABLED"] === "true";
}
