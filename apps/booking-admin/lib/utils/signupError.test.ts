import { describe, expect, it } from "vitest";

import { signupErrorKey, signupRedirectErrorKey } from "./signupError";

describe("signupErrorKey (VAY-2250)", () => {
  it("tells the hotel an account already exists", () => {
    expect(
      signupErrorKey({
        status: 409,
        message: "This email already has a vayada account. Sign in instead.",
      }),
    ).toBe("auth.register.errorEmailExists");
  });

  it("explains a password that is too weak", () => {
    expect(
      signupErrorKey({
        status: 400,
        message:
          "This password isn't strong enough. Try several unrelated words or generate a unique password with a password manager.",
      }),
    ).toBe("auth.register.errorPasswordWeak");
  });

  it("asks to check the details for other rejected sign-ups", () => {
    expect(
      signupErrorKey({
        status: 400,
        message: "Signup failed. Please check your details and try again.",
      }),
    ).toBe("auth.register.errorSignupFailed");
  });

  it("keeps the generic message for network and server failures", () => {
    expect(signupErrorKey(new TypeError("Failed to fetch"))).toBe("auth.register.errorUnexpected");
    expect(signupErrorKey({ status: 500, message: "boom" })).toBe("auth.register.errorUnexpected");
    expect(signupErrorKey(null)).toBe("auth.register.errorUnexpected");
  });

  it("treats other refusals like the generic case", () => {
    // 403: wrong origin, or an SSO/MFA step after the account exists; a retry then answers 409.
    expect(signupErrorKey({ status: 403, message: "Sign-in requires another step." })).toBe(
      "auth.register.errorUnexpected",
    );
    // A 400 without a message (non-JSON body) still asks to check the details.
    expect(signupErrorKey({ status: 400 })).toBe("auth.register.errorSignupFailed");
  });

  it("maps the Google sign-up redirect error", () => {
    expect(
      signupRedirectErrorKey("This email already has a vayada account. Sign in instead."),
    ).toBe("auth.register.errorEmailExists");
    expect(signupRedirectErrorKey("Google sign-in failed. Please try again.")).toBe(
      "auth.register.errorUnexpected",
    );
  });
});
