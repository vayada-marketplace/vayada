"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import { SettingsCard } from "@vayada/settings-ui";
import { SettingsBreadcrumb } from "@/components/settings/SettingsSubPage";
import { PageHeader, PageLayout } from "@/components/layout/PageLayout";
import { FeedbackAlert } from "@/components/ui";
import { useTranslation } from "@/lib/i18n";
import {
  identityPrivacyService,
  type GdprRequestStatusResponse,
} from "@/services/api/identityPrivacyClient";

// GDPR account deletion (Article 17) with the 30-day grace period, moved from marketplace-web (VAY-2262).
export function DeleteAccountPage() {
  const { t, locale } = useTranslation();
  const [deletionStatus, setDeletionStatus] = useState<GdprRequestStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const formatDate = useCallback(
    (value: string | null) =>
      value
        ? new Date(value).toLocaleDateString(locale, {
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "–",
    [locale],
  );

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const status = await identityPrivacyService.getDeletionStatus();
        if (!disposed) setDeletionStatus(status);
      } catch {
        // No deletion request yet.
        if (!disposed) setDeletionStatus(null);
      } finally {
        if (!disposed) setIsLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  async function requestDeletion() {
    if (confirmText !== "DELETE") {
      setError(t("settings.deleteAccount.typeDelete"));
      return;
    }
    try {
      setIsRequesting(true);
      setError(null);
      setSuccessMessage(null);
      const result = await identityPrivacyService.requestAccountDeletion();
      setSuccessMessage(result.message);
      setConfirmDelete(false);
      setConfirmText("");
      setDeletionStatus(await identityPrivacyService.getDeletionStatus());
    } catch {
      setError(t("settings.deleteAccount.requestFailed"));
    } finally {
      setIsRequesting(false);
    }
  }

  async function cancelDeletion() {
    try {
      setIsCancelling(true);
      setError(null);
      setSuccessMessage(null);
      const result = await identityPrivacyService.cancelAccountDeletion();
      setSuccessMessage(result.message);
      try {
        setDeletionStatus(await identityPrivacyService.getDeletionStatus());
      } catch {
        setDeletionStatus(null);
      }
    } catch {
      setError(t("settings.deleteAccount.cancelFailed"));
    } finally {
      setIsCancelling(false);
    }
  }

  const daysUntil = (expiresAt: string | null) => {
    if (!expiresAt) return 0;
    const diff = new Date(expiresAt).getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  };

  const hasPendingDeletion =
    deletionStatus?.status === "pending" || deletionStatus?.status === "processing";

  return (
    <PageLayout>
      <div className="max-w-3xl">
        <PageHeader
          breadcrumb={
            <SettingsBreadcrumb
              trail={[{ label: t("settings.cards.privacy.title"), href: "/settings/privacy" }]}
              current={t("settings.deleteAccount.title")}
            />
          }
          title={t("settings.deleteAccount.title")}
          subtitle={t("settings.deleteAccount.subtitle")}
        />
        <div className="space-y-4">
          {error && <FeedbackAlert type="error" message={error} />}
          {successMessage && <FeedbackAlert type="success" message={successMessage} />}

          {isLoading ? (
            <div
              className="animate-pulse rounded-lg border border-gray-200 bg-white p-5"
              aria-busy="true"
            >
              <div className="mb-4 h-5 w-1/3 rounded bg-gray-200" />
              <div className="h-4 w-2/3 rounded bg-gray-200" />
            </div>
          ) : (
            <>
              <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-5">
                <ExclamationTriangleIcon
                  className="mt-0.5 h-6 w-6 shrink-0 text-red-600"
                  aria-hidden="true"
                />
                <div>
                  <h3 className="mb-2 text-[14px] font-semibold text-red-900">
                    {t("settings.deleteAccount.warningTitle")}
                  </h3>
                  <ul className="list-disc space-y-1 pl-5 text-[13px] text-red-800">
                    <li>{t("settings.deleteAccount.warningData")}</li>
                    <li>{t("settings.deleteAccount.warningAccess")}</li>
                    <li>{t("settings.deleteAccount.warningBookings")}</li>
                    <li>{t("settings.deleteAccount.warningLegal")}</li>
                  </ul>
                </div>
              </div>

              {hasPendingDeletion && deletionStatus && (
                <div className="flex items-start gap-3 rounded-lg border border-yellow-200 bg-yellow-50 p-5">
                  <ClockIcon
                    className="mt-0.5 h-6 w-6 shrink-0 text-yellow-600"
                    aria-hidden="true"
                  />
                  <div className="flex-1">
                    <h3 className="mb-2 text-[15px] font-semibold text-yellow-900">
                      {t("settings.deleteAccount.scheduledTitle")}
                    </h3>
                    <p className="mb-4 text-[13px] text-yellow-800">
                      {t("settings.deleteAccount.scheduledDescription", {
                        days: daysUntil(deletionStatus.expires_at),
                      })}
                    </p>
                    <dl className="mb-4 space-y-2 text-[13px]">
                      <div className="flex items-center justify-between gap-4">
                        <dt className="text-yellow-700">{t("settings.deleteAccount.requested")}</dt>
                        <dd className="font-medium text-yellow-900">
                          {formatDate(deletionStatus.requested_at)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <dt className="text-yellow-700">
                          {t("settings.deleteAccount.scheduledFor")}
                        </dt>
                        <dd className="font-medium text-yellow-900">
                          {formatDate(deletionStatus.expires_at)}
                        </dd>
                      </div>
                    </dl>
                    <button
                      type="button"
                      onClick={() => void cancelDeletion()}
                      disabled={isCancelling}
                      className="rounded-lg bg-yellow-600 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-yellow-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
                    >
                      {isCancelling
                        ? t("settings.deleteAccount.cancelling")
                        : t("settings.deleteAccount.cancelRequest")}
                    </button>
                  </div>
                </div>
              )}

              {deletionStatus?.status === "cancelled" && (
                <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-5">
                  <XCircleIcon className="h-6 w-6 shrink-0 text-gray-500" aria-hidden="true" />
                  <div>
                    <h3 className="text-[14px] font-semibold text-gray-900">
                      {t("settings.deleteAccount.cancelledTitle")}
                    </h3>
                    <p className="text-[13px] text-gray-600">
                      {t("settings.deleteAccount.cancelledDescription", {
                        date: formatDate(
                          deletionStatus.processed_at || deletionStatus.requested_at,
                        ),
                      })}
                    </p>
                  </div>
                </div>
              )}

              {deletionStatus?.status === "completed" && (
                <div className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 p-5">
                  <CheckCircleIcon className="h-6 w-6 shrink-0 text-green-500" aria-hidden="true" />
                  <div>
                    <h3 className="text-[14px] font-semibold text-green-900">
                      {t("settings.deleteAccount.completedTitle")}
                    </h3>
                    <p className="text-[13px] text-green-800">
                      {t("settings.deleteAccount.completedDescription", {
                        date: formatDate(deletionStatus.processed_at),
                      })}
                    </p>
                  </div>
                </div>
              )}

              {!hasPendingDeletion && (
                <SettingsCard
                  title={t("settings.deleteAccount.requestTitle")}
                  description={t("settings.deleteAccount.requestDescription")}
                >
                  {!confirmDelete ? (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="rounded-lg bg-red-600 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-red-700"
                    >
                      {t("settings.deleteAccount.request")}
                    </button>
                  ) : (
                    <div className="space-y-4 rounded-lg bg-gray-50 p-4">
                      <label
                        htmlFor="delete-account-confirm"
                        className="block text-[13px] font-medium text-gray-700"
                      >
                        {t("settings.deleteAccount.confirmPrompt")}
                      </label>
                      <input
                        id="delete-account-confirm"
                        type="text"
                        value={confirmText}
                        onChange={(event) => setConfirmText(event.target.value)}
                        placeholder={t("settings.deleteAccount.confirmPlaceholder")}
                        className="w-full rounded-lg border border-gray-300 px-4 py-2 text-[13px] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-red-500"
                      />
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() => void requestDeletion()}
                          disabled={isRequesting || confirmText !== "DELETE"}
                          className="rounded-lg bg-red-600 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
                        >
                          {isRequesting
                            ? t("settings.deleteAccount.processing")
                            : t("settings.deleteAccount.confirm")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmDelete(false);
                            setConfirmText("");
                            setError(null);
                          }}
                          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
                        >
                          {t("common.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                </SettingsCard>
              )}

              <div className="rounded-lg border border-gray-200 bg-gray-50 p-5">
                <h3 className="mb-2 text-[14px] font-semibold text-gray-900">
                  {t("settings.deleteAccount.aboutTitle")}
                </h3>
                <p className="mb-3 text-[13px] text-gray-600">
                  {t("settings.deleteAccount.aboutDescription")}
                </p>
                <ul className="list-disc space-y-1 pl-5 text-[13px] text-gray-600">
                  <li>{t("settings.deleteAccount.aboutGrace")}</li>
                  <li>{t("settings.deleteAccount.aboutRetention")}</li>
                  <li>{t("settings.deleteAccount.aboutBookings")}</li>
                  <li>{t("settings.deleteAccount.aboutFinal")}</li>
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
    </PageLayout>
  );
}
