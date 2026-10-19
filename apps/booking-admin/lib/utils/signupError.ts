/** Which sign-up message to show for a failed sign-up (VAY-2250). The API answers in English only, so match its cases. */
export type SignupErrorKey =
  | "auth.register.errorEmailExists"
  | "auth.register.errorPasswordWeak"
  | "auth.register.errorSignupFailed"
  | "auth.register.errorUnexpected";

export function signupErrorKey(error: unknown): SignupErrorKey {
  if (typeof error !== "object" || error === null) return "auth.register.errorUnexpected";
  const { status, message } = error as { status?: unknown; message?: unknown };
  const text = typeof message === "string" ? message : "";
  if (status === 409 || /already has a vayada account/i.test(text))
    return "auth.register.errorEmailExists";
  if (status === 400) {
    return /strong enough/i.test(text)
      ? "auth.register.errorPasswordWeak"
      : "auth.register.errorSignupFailed";
  }
  return "auth.register.errorUnexpected";
}

/** Google sign-up returns here with ?auth_error=<English message>. */
export function signupRedirectErrorKey(authError: string): SignupErrorKey {
  return signupErrorKey({ message: authError });
}
