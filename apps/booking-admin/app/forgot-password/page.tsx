"use client";

import { useState } from "react";
import { authService } from "@/services/auth";
import ForgotPasswordForm from "@/components/auth/ForgotPasswordForm";
import { useTranslation } from "@/lib/i18n";

export default function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleForgotPassword = async (email: string) => {
    setIsSubmitting(true);
    try {
      await authService.forgotPassword(email);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-8">
        {/* Logo / Title */}
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 bg-primary-600 rounded-lg mb-3">
            <span className="text-white font-bold text-[16px]">B</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">{t("auth.forgotPassword.title")}</h1>
          <p className="text-[13px] text-gray-500 mt-1">{t("auth.forgotPassword.subtitle")}</p>
        </div>

        <ForgotPasswordForm onSubmit={handleForgotPassword} isSubmitting={isSubmitting} />
      </div>
    </div>
  );
}
