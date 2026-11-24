"use client";

import { useTranslation } from "@/lib/i18n";
import type { CustomDomainStatus } from "@/services/settings";

const CNAME_TARGET = "custom.booking.vayada.com";

// What the last check found, in the hotel's words (VAY-2568).
const ISSUE_MESSAGES = {
  dns_record_missing: "admin.customDomainRecordMissing",
  dns_record_wrong_target: "admin.customDomainRecordWrongTarget",
  certificate_pending: "admin.customDomainCertificatePending",
  routing_pending: "admin.customDomainRoutingPending",
  hostname_rejected: "admin.customDomainRejected",
  check_unavailable: "admin.customDomainCheckUnavailable",
} as const;

interface CustomDomainCardProps {
  bookingUrl: string;
  domainInput: string;
  domainStatus: CustomDomainStatus | null;
  saving: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onDomainInputChange: (value: string) => void;
  onRefresh: () => void;
}

export default function CustomDomainCard({
  bookingUrl,
  domainInput,
  domainStatus,
  saving,
  onConnect,
  onDisconnect,
  onDomainInputChange,
  onRefresh,
}: CustomDomainCardProps) {
  const { t, locale } = useTranslation();
  const configured = Boolean(domainStatus?.configured && domainStatus.domain);
  const connected = domainStatus?.sslStatus === "active";
  const issue = domainStatus?.verificationIssue ?? null;
  // "Verifying..." only while the record is right and the certificate is being issued.
  const badge = (): [label: string, color: string] => {
    if (saving) return [t("admin.customDomainChecking"), "bg-gray-400"];
    if (connected) return [t("settings.billing.connected"), "bg-green-500"];
    if (!configured) return [t("admin.notConnected"), "bg-gray-400"];
    if (issue?.code === "check_unavailable")
      return [t("admin.customDomainNotChecked"), "bg-gray-400"];
    if (issue?.code === "routing_pending")
      return [t("admin.customDomainSettingUp"), "bg-yellow-500"];
    if (domainStatus?.status === "pending") return [t("settings.totp.confirming"), "bg-yellow-500"];
    return [t("admin.customDomainNotVerified"), "bg-red-500"];
  };
  const [statusLabel, statusColor] = badge();
  const record = domainStatus?.dnsRecords[0];
  const issueMessage = issue
    ? t(
        ISSUE_MESSAGES[issue.code] ??
          "admin.domainVerificationHasNotCompletedCheckTheCNAMERecordAnd",
        {
          domain: domainStatus?.domain ?? "",
          target: issue.foundTarget ?? "",
        },
      )
    : domainStatus?.status === "failed"
      ? t("admin.domainVerificationHasNotCompletedCheckTheCNAMERecordAnd")
      : null;
  const checkedAt = domainStatus?.checkedAt ? new Date(domainStatus.checkedAt) : null;

  return (
    <>
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-[13px] font-semibold text-gray-900">{t("admin.currentBookingURL")}</h2>
        <p className="mt-0.5 text-[12px] text-gray-500">
          {t("admin.yourSlugComesFromThePropertyName")}
        </p>
        <div className="mt-3 truncate rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] text-gray-700">
          {bookingUrl || t("admin.bookingURLUnavailable")}
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-[13px] font-semibold text-gray-900">
          {t("settings.booking.customDomain")}
        </h2>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={domainInput}
            onChange={(event) => onDomainInputChange(event.target.value)}
            placeholder="booking.yourdomain.com"
            disabled={saving}
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50"
          />
          <button
            type="button"
            onClick={onConnect}
            disabled={saving || !domainInput.trim()}
            className="rounded-lg bg-primary-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-primary-700 disabled:opacity-60"
          >
            {t("settings.booking.connectDomain")}
          </button>
        </div>

        {configured && !connected && record ? (
          <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3">
            <p className="text-[12px] font-medium text-gray-900">
              {t("admin.customDomainRecordToAdd")}
            </p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px] text-gray-600">
              <dt>{t("admin.customDomainRecordType")}</dt>
              <dd className="font-mono text-gray-900">{record.type}</dd>
              <dt>{t("admin.customDomainRecordName")}</dt>
              <dd className="break-all font-mono text-gray-900">{record.host ?? record.name}</dd>
              <dt>{t("admin.customDomainRecordTarget")}</dt>
              <dd className="break-all font-mono text-gray-900">{record.value}</dd>
            </dl>
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3">
            <p className="text-[12px] font-medium text-gray-900">{t("admin.dnsSetup")}</p>
            <p className="mt-1 text-[12px] leading-5 text-gray-600">
              {t("admin.addACNAMERecordForYourSubdomainPointingTo")}{" "}
              <code className="text-gray-900">{CNAME_TARGET}</code>
              {t("admin.propagationUsuallyTakes15MinutesUpTo48Hours")}
            </p>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-700">
              <span className={`h-2 w-2 rounded-full ${statusColor}`} />
              {statusLabel}
            </span>
            {domainStatus?.domain && (
              <p className="mt-1 truncate text-[11px] text-gray-500">{domainStatus.domain}</p>
            )}
            {configured && checkedAt && (
              <p className="mt-0.5 text-[11px] text-gray-400">
                {t("admin.customDomainLastChecked", {
                  time: new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(checkedAt),
                })}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onRefresh}
              disabled={saving}
              className="text-[11px] text-primary-600 hover:text-primary-700 disabled:opacity-50"
            >
              {t("settings.booking.refresh")}
            </button>
            {domainStatus?.configured && (
              <button
                type="button"
                onClick={onDisconnect}
                disabled={saving}
                className="text-[11px] text-red-600 hover:text-red-700 disabled:opacity-50"
              >
                {t("admin.removeDomain")}
              </button>
            )}
          </div>
        </div>

        {configured && !connected && issueMessage && (
          <p
            role="status"
            className={`mt-3 rounded-lg border p-3 text-[12px] ${
              domainStatus?.status === "failed"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-amber-200 bg-amber-50 text-amber-800"
            }`}
          >
            {issueMessage}
          </p>
        )}
      </div>
    </>
  );
}
