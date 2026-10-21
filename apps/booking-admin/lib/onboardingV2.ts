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
