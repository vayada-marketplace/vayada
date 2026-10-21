"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import SharedSignupPage from "@vayada/product-onboarding/SharedSignupPage";
import { useTranslation } from "@/lib/i18n";
import { resolveBookingSetupGuard } from "@/lib/utils/sharedSetupGuard";
import { hasPendingHotelAccountInvite } from "@/services/api/hotelAccountInvites";
import { AuthStateError, authService, storePendingEmailVerification } from "@/services/auth";
import {
  signupErrorKey,
  signupRedirectErrorKey,
  type SignupErrorKey,
} from "@/lib/utils/signupError";

export default function SignupPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [submitError, setSubmitError] = useState<SignupErrorKey | "">("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");
    if (authError !== null)
      setSubmitError(signupRedirectErrorKey(authError, params.get("auth_error_code")));
  }, []);

  async function handleSignup(data: { email: string; password: string }) {
    setSubmitError("");
    setIsSubmitting(true);
    try {
      await authService.signup(data);
      // An owner who came from /invite finishes the invitation before any setup redirect.
      if (hasPendingHotelAccountInvite()) {
        router.push("/invite");
        return;
      }
      const decision = await resolveBookingSetupGuard("/dashboard");
      if (decision.action === "redirect_to_setup") {
        window.location.replace(decision.redirectPath);
        return;
      }
      router.push("/dashboard");
    } catch (error) {
      if (
        error instanceof AuthStateError &&
        error.state === "email_verification_required" &&
        storePendingEmailVerification({ ...error, flow: "signup", intent: "hotel" })
      ) {
        router.push("/verify-email");
        return;
      }
      setSubmitError(signupErrorKey(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <SharedSignupPage
      translate={t}
      onSubmit={handleSignup}
      isSubmitting={isSubmitting}
      submitError={submitError && t(submitError)}
      submitErrorAction={
        submitError === "auth.register.errorEmailExists"
          ? { label: t("signup.signIn"), href: "/login" }
          : undefined
      }
      onErrorClear={() => setSubmitError("")}
      onGoogleSignup={() => authService.startGoogleSignup("/dashboard")}
    />
  );
}
