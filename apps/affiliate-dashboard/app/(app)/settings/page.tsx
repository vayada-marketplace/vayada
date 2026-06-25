"use client";

import { useEffect, useState } from "react";
import { useForm, Controller, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import useSWR from "swr";
import Navbar from "@/components/Navbar";
import { apiClient, extractErrorMessage } from "@/services/api/client";
import { affiliateApiPaths } from "@/services/api/paths";
import { authService } from "@/services/auth";
import {
  DEFAULT_SETTINGS,
  PAYOUT_PROVIDERS,
  PAYOUT_SCHEDULES,
  type PayoutProvider,
  type PayoutSchedule,
  type SettingsFormValues,
  settingsSchema,
} from "@/services/schemas/settings";
import type { PayoutSettingsPatchCommand, PayoutSettingsResponse } from "@/services/types";

const PROVIDER_LABELS: Record<PayoutProvider, string> = {
  stripe: "Stripe",
  bank_transfer: "Bank Transfer",
  manual: "Manual",
};

const SCHEDULE_LABELS: Record<PayoutSchedule, string> = {
  monthly: "Monthly",
  manual: "Manual",
  threshold: "Threshold",
};

function formValuesFromSettings(response: PayoutSettingsResponse): SettingsFormValues {
  const settings = response.payoutSettings;
  return {
    payoutProvider: settings.payoutProvider,
    payoutCurrency: settings.payoutCurrency || "EUR",
    payoutSchedule: settings.payoutSchedule,
    payoutThresholdAmount: settings.payoutThresholdAmount || "",
  };
}

export default function SettingsPage() {
  const {
    data,
    error: loadError,
    mutate,
  } = useSWR<PayoutSettingsResponse>(affiliateApiPaths.payoutSettings);

  const [saving, setSaving] = useState(false);
  const [topError, setTopError] = useState("");
  const [success, setSuccess] = useState("");

  const userName = authService.getUserName();
  const userInitials = authService.getUserInitials();

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: DEFAULT_SETTINGS,
  });

  const payoutSchedule = useWatch({ control, name: "payoutSchedule" });

  useEffect(() => {
    if (data) reset(formValuesFromSettings(data));
  }, [data, reset]);

  const onSubmit = async (values: SettingsFormValues) => {
    setTopError("");
    setSuccess("");
    setSaving(true);
    try {
      const commandId = buildCommandId();
      const payload: PayoutSettingsPatchCommand = {
        commandId,
        idempotencyKey: commandId,
        payoutsEnabled: values.payoutProvider !== "manual",
        payoutProvider: values.payoutProvider,
        payoutCurrency: values.payoutCurrency.trim().toUpperCase(),
        payoutSchedule: values.payoutSchedule,
        payoutThresholdAmount:
          values.payoutSchedule === "threshold" ? values.payoutThresholdAmount.trim() : null,
      };
      const saved = await apiClient.patch<PayoutSettingsResponse>(
        affiliateApiPaths.payoutSettings,
        payload,
      );
      mutate(saved, { revalidate: false });
      setSuccess("Payout settings saved");
    } catch (err) {
      setTopError(extractErrorMessage(err, "Failed to save"));
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="text-red-600 text-sm">Failed to load settings.</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="text-gray-500 text-sm">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <Navbar userName={userName} userInitials={userInitials} />

      <main className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Manage your payout preferences</p>
        </div>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="bg-white border border-gray-200 rounded-xl p-6"
        >
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Payout Method</h2>

          {topError && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
              {topError}
            </div>
          )}
          {success && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg">
              {success}
            </div>
          )}

          <div className="space-y-5">
            <Controller
              control={control}
              name="payoutProvider"
              render={({ field }) => (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {PAYOUT_PROVIDERS.map((provider) => (
                    <button
                      key={provider}
                      type="button"
                      onClick={() => {
                        field.onChange(provider);
                        setTopError("");
                        setSuccess("");
                      }}
                      className={`px-3 py-2 text-sm rounded-lg border font-medium transition-colors ${
                        field.value === provider
                          ? "border-primary-600 bg-primary-50 text-primary-700"
                          : "border-gray-200 text-gray-600 hover:border-gray-300"
                      }`}
                    >
                      {PROVIDER_LABELS[provider]}
                    </button>
                  ))}
                </div>
              )}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Currency</label>
                <input
                  {...register("payoutCurrency")}
                  type="text"
                  maxLength={3}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg uppercase focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                {errors.payoutCurrency && (
                  <p className="mt-1 text-xs text-red-600">{errors.payoutCurrency.message}</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Schedule</label>
                <select
                  {...register("payoutSchedule")}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {PAYOUT_SCHEDULES.map((schedule) => (
                    <option key={schedule} value={schedule}>
                      {SCHEDULE_LABELS[schedule]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {payoutSchedule === "threshold" && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Threshold Amount
                </label>
                <input
                  {...register("payoutThresholdAmount")}
                  type="text"
                  inputMode="decimal"
                  placeholder="100.00"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                {errors.payoutThresholdAmount && (
                  <p className="mt-1 text-xs text-red-600">
                    {errors.payoutThresholdAmount.message}
                  </p>
                )}
              </div>
            )}

            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
              <p className="text-xs text-gray-600">
                Provider status: {data.payoutSettings.providerAccount.status.replace("_", " ")}
              </p>
            </div>

            <button
              type="submit"
              disabled={saving || isSubmitting}
              className="w-full mt-2 px-4 py-2.5 text-sm font-medium text-white bg-primary-800 rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : "Save Payout Settings"}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

function buildCommandId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `affiliate-payout-settings:${random}`;
}
