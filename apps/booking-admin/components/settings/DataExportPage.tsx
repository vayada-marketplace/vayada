"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircleIcon, ClockIcon, ExclamationCircleIcon } from "@heroicons/react/24/outline";
import { SettingsCard } from "@vayada/settings-ui";
import { SettingsBreadcrumb } from "@/components/settings/SettingsSubPage";
import { PageHeader, PageLayout } from "@/components/layout/PageLayout";
import { FeedbackAlert } from "@/components/ui";
import { useTranslation } from "@/lib/i18n";
import {
  identityPrivacyService,
  type GdprRequestStatusResponse,
} from "@/services/api/identityPrivacyClient";

// GDPR data export (Article 20), moved from marketplace-web (VAY-2262).
export function DataExportPage() {
  const { t, locale } = useTranslation();
  const [exportStatus, setExportStatus] = useState<GdprRequestStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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
        const status = await identityPrivacyService.getExportStatus();
        if (!disposed) setExportStatus(status);
      } catch {
        // No export request yet.
        if (!disposed) setExportStatus(null);
      } finally {
        if (!disposed) setIsLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  async function requestExport() {
    try {
      setIsRequesting(true);
      setError(null);
      setSuccessMessage(null);
      const result = await identityPrivacyService.requestDataExport();
      setSuccessMessage(result.message);
      const status = await identityPrivacyService.getExportStatus();
      setExportStatus({
        ...status,
        download_token: status.download_token ?? result.download_token,
      });
    } catch {
      setError(t("settings.dataExport.requestFailed"));
    } finally {
      setIsRequesting(false);
    }
  }

  async function downloadExport() {
    const token = exportStatus?.download_token;
    if (!token) {
      setError(t("settings.dataExport.tokenMissing"));
      return;
    }
    try {
      setIsDownloading(true);
      setError(null);
      const blob = await identityPrivacyService.downloadExport(token);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "vayada-data-export.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError(t("settings.dataExport.downloadFailed"));
    } finally {
      setIsDownloading(false);
    }
  }

  const statusLabel = (status: GdprRequestStatusResponse["status"]) =>
    t(`settings.dataExport.status.${status}`);
  const statusClass = (status: string) =>
    status === "completed"
      ? "bg-green-100 text-green-800"
      : status === "processing" || status === "pending"
        ? "bg-yellow-100 text-yellow-800"
        : "bg-gray-100 text-gray-800";
  const canRequestNewExport =
    !exportStatus || ["completed", "expired", "cancelled"].includes(exportStatus.status);

  return (
    <PageLayout>
      <div className="max-w-3xl">
        <PageHeader
          breadcrumb={
            <SettingsBreadcrumb
              trail={[{ label: t("settings.cards.privacy.title"), href: "/settings/privacy" }]}
              current={t("settings.dataExport.title")}
            />
          }
          title={t("settings.dataExport.title")}
          subtitle={t("settings.dataExport.subtitle")}
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
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-5">
                <h3 className="mb-2 text-[14px] font-semibold text-blue-900">
                  {t("settings.dataExport.includedTitle")}
                </h3>
                <ul className="list-disc space-y-1 pl-5 text-[13px] text-blue-800">
                  <li>{t("settings.dataExport.includedProfile")}</li>
                  <li>{t("settings.dataExport.includedHotels")}</li>
                  <li>{t("settings.dataExport.includedConsent")}</li>
                  <li>{t("settings.dataExport.includedActivity")}</li>
                </ul>
              </div>

              {exportStatus && (
                <SettingsCard title={t("settings.dataExport.currentTitle")}>
                  <dl className="space-y-3 text-[13px]">
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-gray-500">{t("settings.dataExport.status")}</dt>
                      <dd className="flex items-center gap-2">
                        <StatusIcon status={exportStatus.status} />
                        <span
                          className={`rounded px-2 py-1 text-[12px] font-medium ${statusClass(exportStatus.status)}`}
                        >
                          {statusLabel(exportStatus.status)}
                        </span>
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-gray-500">{t("settings.dataExport.requested")}</dt>
                      <dd className="text-gray-900">{formatDate(exportStatus.requested_at)}</dd>
                    </div>
                    {exportStatus.processed_at && (
                      <div className="flex items-center justify-between gap-4">
                        <dt className="text-gray-500">{t("settings.dataExport.completed")}</dt>
                        <dd className="text-gray-900">{formatDate(exportStatus.processed_at)}</dd>
                      </div>
                    )}
                    {exportStatus.expires_at && exportStatus.status === "completed" && (
                      <div className="flex items-center justify-between gap-4">
                        <dt className="text-gray-500">
                          {t("settings.dataExport.downloadExpires")}
                        </dt>
                        <dd className="text-gray-900">{formatDate(exportStatus.expires_at)}</dd>
                      </div>
                    )}
                  </dl>
                  {exportStatus.status === "completed" && (
                    <div className="mt-5 border-t border-gray-100 pt-4">
                      <p className="mb-4 text-[13px] text-gray-600">
                        {t("settings.dataExport.readyDescription", {
                          date: formatDate(exportStatus.expires_at),
                        })}
                      </p>
                      <button
                        type="button"
                        onClick={() => void downloadExport()}
                        disabled={isDownloading || !exportStatus.download_token}
                        className="rounded-lg bg-primary-600 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isDownloading
                          ? t("settings.dataExport.downloading")
                          : t("settings.dataExport.download")}
                      </button>
                    </div>
                  )}
                  {(exportStatus.status === "pending" || exportStatus.status === "processing") && (
                    <p className="mt-5 border-t border-gray-100 pt-4 text-[13px] text-gray-600">
                      {t("settings.dataExport.preparing")}
                    </p>
                  )}
                </SettingsCard>
              )}

              <SettingsCard
                title={t("settings.dataExport.requestTitle")}
                description={t("settings.dataExport.requestDescription")}
              >
                <button
                  type="button"
                  onClick={() => void requestExport()}
                  disabled={isRequesting || !canRequestNewExport}
                  className="rounded-lg bg-primary-600 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
                >
                  {isRequesting
                    ? t("settings.dataExport.requesting")
                    : t("settings.dataExport.request")}
                </button>
                {!canRequestNewExport && (
                  <p className="mt-2 text-[13px] text-yellow-700">
                    {t("settings.dataExport.pendingNotice")}
                  </p>
                )}
              </SettingsCard>

              <div className="rounded-lg border border-gray-200 bg-gray-50 p-5">
                <h3 className="mb-2 text-[14px] font-semibold text-gray-900">
                  {t("settings.dataExport.aboutTitle")}
                </h3>
                <p className="text-[13px] text-gray-600">
                  {t("settings.dataExport.aboutDescription")}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </PageLayout>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "completed") {
    return <CheckCircleIcon className="h-5 w-5 text-green-500" aria-hidden="true" />;
  }
  if (status === "processing" || status === "pending") {
    return <ClockIcon className="h-5 w-5 text-yellow-500" aria-hidden="true" />;
  }
  return <ExclamationCircleIcon className="h-5 w-5 text-gray-500" aria-hidden="true" />;
}
