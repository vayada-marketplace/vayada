/** Which sign-up message to show for a failed sign-up (VAY-2250). The API's text is English only, so match its codes and statuses first. */
export type SignupErrorKey =
  | "auth.register.errorEmailExists"
  | "auth.register.errorPasswordWeak"
  | "auth.register.errorSignupFailed"
  | "auth.register.errorUnexpected";

export function signupErrorKey(error: unknown): SignupErrorKey {
  if (typeof error !== "object" || error === null) return "auth.register.errorUnexpected";
  const { status, state, message } = error as {
    status?: unknown;
    state?: unknown;
    message?: unknown;
  };
  const text = typeof message === "string" ? message : "";
  // account_exists is the API's code; the status and text cover older API builds.
  if (state === "account_exists" || status === 409 || /already has a vayada account/i.test(text))
    return "auth.register.errorEmailExists";
  if (status === 400) {
    return /strong enough/i.test(text)
      ? "auth.register.errorPasswordWeak"
      : "auth.register.errorSignupFailed";
  }
  return "auth.register.errorUnexpected";
}

/** Google sign-up returns here with ?auth_error=<English message>&auth_error_code=<code>. */
export function signupRedirectErrorKey(
  authError: string,
  authErrorCode?: string | null,
): SignupErrorKey {
  return signupErrorKey({ state: authErrorCode, message: authError });
}
