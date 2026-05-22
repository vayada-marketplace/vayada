"use client";

import { useState } from "react";

interface TotpFormProps {
  onSubmit: (code: string) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
  submitError: string;
  onErrorClear: () => void;
}

export default function TotpForm({
  onSubmit,
  onCancel,
  isSubmitting,
  submitError,
  onErrorClear,
}: TotpFormProps) {
  const [code, setCode] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    onErrorClear();
    await onSubmit(code.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          Enter the 6-digit code from your authenticator app, or a recovery code.
        </p>
      </div>

      <div>
        <label htmlFor="totp-code" className="block text-sm font-medium text-gray-700 mb-1.5">
          Verification code
        </label>
        <input
          id="totp-code"
          type="text"
          inputMode="numeric"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (submitError) onErrorClear();
          }}
          required
          placeholder="000000"
          autoComplete="one-time-code"
          autoFocus
          className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-sm text-gray-900 tracking-widest text-center"
        />
      </div>

      {submitError && (
        <div className="bg-red-50 border-2 border-red-300 rounded-lg p-4">
          <p className="text-sm text-red-800 font-semibold">{submitError}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={isSubmitting || code.trim().length === 0}
        className="w-full px-4 py-2.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isSubmitting ? "Verifying..." : "Verify"}
      </button>

      <button
        type="button"
        onClick={onCancel}
        className="w-full px-4 py-2.5 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
      >
        Back to login
      </button>
    </form>
  );
}
