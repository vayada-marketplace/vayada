"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import SharedSignupPage from "@vayada/product-onboarding/SharedSignupPage";
import { useTranslation } from "@/lib/i18n";
import { resolvePmsSetupGuard } from "@/lib/utils/sharedSetupGuard";
import { AuthStateError, authService, storePendingEmailVerification } from "@/services/auth";

export default function SignupPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [submitError, setSubmitError] = useState("");
  // The email already has an account: say so and offer to sign in instead.
  const [accountExists, setAccountExists] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setAccountExists(params.get("auth_error_code") === "account_exists");
    setSubmitError(params.get("auth_error") ?? "");
  }, []);

  function clearError() {
    setSubmitError("");
    setAccountExists(false);
  }

  async function handleSignup(data: { email: string; password: string }) {
    clearError();
    setIsSubmitting(true);
    try {
      await authService.signup(data);
      const decision = await resolvePmsSetupGuard("/dashboard");
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
      if (error instanceof AuthStateError && error.state === "account_exists") {
        setAccountExists(true);
        return;
      }
      setSubmitError(error instanceof Error ? error.message : t("auth.register.unexpectedError"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <SharedSignupPage
      onSubmit={handleSignup}
      isSubmitting={isSubmitting}
      submitError={accountExists ? t("auth.register.emailExists") : submitError}
      submitErrorAction={
        accountExists ? { label: t("auth.register.signIn"), href: "/login" } : undefined
      }
      onErrorClear={clearError}
      onGoogleSignup={() => authService.startGoogleSignup("/dashboard")}
    />
  );
}
