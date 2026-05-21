"use client";

import { useEffect, useState } from "react";
import {
  XMarkIcon,
  CreditCardIcon,
  PaperAirplaneIcon,
  ArrowDownTrayIcon,
  PrinterIcon,
  ReceiptRefundIcon,
  NoSymbolIcon,
  UserIcon,
  EnvelopeIcon,
  HomeIcon,
  CalendarIcon,
} from "@heroicons/react/24/outline";
import { financialsService, InvoiceDetail, InvoiceStatus } from "@/services/financials";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";
import RecordPaymentModal from "./RecordPaymentModal";

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: "border-gray-200 text-gray-600 bg-gray-50",
  sent: "border-sky-200 text-sky-700 bg-sky-50",
  paid: "border-emerald-200 text-emerald-700 bg-emerald-50",
  partial: "border-amber-200 text-amber-700 bg-amber-50",
  overdue: "border-rose-200 text-rose-600 bg-rose-50",
  voided: "border-gray-200 text-gray-500 bg-gray-50",
};

function formatDate(s: string): string {
  return new Date(s).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(s: string): string {
  return new Date(s).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface Props {
  bookingId: string;
  onClose: () => void;
  onChanged?: () => void;
}

export default function InvoiceDetailModal({ bookingId, onClose, onChanged }: Props) {
  const { t } = useTranslation();
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [recordOpen, setRecordOpen] = useState(false);

  useEffect(() => {
    financialsService
      .getInvoice(bookingId)
      .then(setInvoice)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [bookingId]);

  const handlePaymentRecorded = (updated: InvoiceDetail) => {
    setInvoice(updated);
    setRecordOpen(false);
    onChanged?.();
  };

  return (
    <>
      <div className="fixed inset-0 z-40 flex items-start sm:items-center justify-center print:static">
        <div className="absolute inset-0 bg-black/40 print:hidden" onClick={onClose} />
        <div
          id="invoice-detail-modal"
          className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 my-4 sm:my-12 max-h-[92vh] overflow-y-auto print:shadow-none print:rounded-none print:my-0 print:max-w-full print:max-h-none"
        >
          {loading || !invoice ? (
            <div className="p-6 animate-pulse space-y-4">
              <div className="h-6 w-48 bg-gray-200 rounded" />
              <div className="h-32 bg-gray-100 rounded" />
              <div className="h-32 bg-gray-100 rounded" />
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="sticky top-0 z-10 bg-white px-6 pt-6 pb-4 flex items-start justify-between gap-4 border-b border-gray-100 print:static print:border-b-0">
                <div>
                  <div className="flex items-center gap-3">
                    <h2 className="text-lg font-bold text-gray-900 font-mono">
                      {invoice.invoiceNumber}
                    </h2>
                    <span
                      className={`inline-flex px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${STATUS_STYLES[invoice.status]}`}
                    >
                      {t(
                        `financials.status${invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}`,
                      )}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 print:hidden"
                  aria-label="Close"
                >
                  <XMarkIcon className="w-5 h-5" />
                </button>
              </div>

              {/* Body */}
              <div className="px-6 pb-6 space-y-5">
                {/* Guest summary */}
                <div className="text-sm space-y-1.5">
                  <Row icon={<UserIcon className="w-4 h-4 text-gray-400" />}>
                    {invoice.guestFirstName} {invoice.guestLastName}
                  </Row>
                  <Row icon={<EnvelopeIcon className="w-4 h-4 text-gray-400" />}>
                    {invoice.guestEmail}
                  </Row>
                  <Row icon={<HomeIcon className="w-4 h-4 text-gray-400" />}>
                    {invoice.roomNumber ? `Room ${invoice.roomNumber} · ` : ""}
                    {invoice.roomName}
                  </Row>
                  <Row icon={<CalendarIcon className="w-4 h-4 text-gray-400" />}>
                    {formatDate(invoice.checkIn)} <span className="text-gray-300">→</span>{" "}
                    {formatDate(invoice.checkOut)}
                  </Row>
                </div>

                {/* Charges */}
                <section>
                  <p className="text-[11px] uppercase tracking-wider font-semibold text-gray-400 mb-2">
                    {t("financials.detailCharges")}
                  </p>
                  <div className="space-y-2.5">
                    {invoice.charges.map((c, i) => (
                      <div key={i} className="flex items-baseline justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[14px] font-medium text-gray-900">{c.description}</p>
                          {c.detail && <p className="text-[12px] text-gray-500">{c.detail}</p>}
                        </div>
                        <p className="text-[14px] font-medium text-gray-900 tabular-nums whitespace-nowrap">
                          {formatCurrency(c.amount, invoice.currency)}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>

                {/* Totals */}
                <div className="space-y-1.5 pt-3 border-t border-gray-100 text-sm">
                  {invoice.subtotal !== invoice.totalAmount && (
                    <div className="flex justify-between text-gray-600">
                      <span>{t("financials.detailSubtotal")}</span>
                      <span className="tabular-nums">
                        {formatCurrency(invoice.subtotal, invoice.currency)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold text-gray-900 text-base pt-1">
                    <span>{t("financials.detailTotal")}</span>
                    <span className="tabular-nums">
                      {formatCurrency(invoice.totalAmount, invoice.currency)}
                    </span>
                  </div>
                </div>

                {/* Payments */}
                <section>
                  <p className="text-[11px] uppercase tracking-wider font-semibold text-gray-400 mb-2">
                    {t("financials.detailPayments")}
                  </p>
                  {invoice.payments.length === 0 ? (
                    <p className="text-sm text-gray-400">{t("financials.detailNoPayments")}</p>
                  ) : (
                    <div className="space-y-2.5">
                      {invoice.payments.map((p) => (
                        <div key={p.id} className="flex items-baseline justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[14px] font-medium text-gray-900">{p.methodLabel}</p>
                            <p className="text-[12px] text-gray-500">
                              {formatDateTime(p.recordedAt)}
                              {p.reference && (
                                <>
                                  <span className="text-gray-300"> · </span>
                                  <span className="font-mono">{p.reference}</span>
                                </>
                              )}
                            </p>
                          </div>
                          <p className="text-[14px] font-medium text-emerald-600 tabular-nums whitespace-nowrap">
                            −{formatCurrency(p.amount, p.currency)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Balance summary */}
                <div className="space-y-1.5 pt-3 border-t border-gray-100 text-sm">
                  <div className="flex justify-between text-gray-600">
                    <span>{t("financials.detailAmountPaid")}</span>
                    <span className="tabular-nums">
                      {formatCurrency(invoice.amountPaid, invoice.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between font-bold">
                    <span className="text-rose-600">{t("financials.detailBalanceDue")}</span>
                    <span
                      className={`tabular-nums ${invoice.balanceDue > 0 ? "text-rose-600" : "text-emerald-600"}`}
                    >
                      {formatCurrency(invoice.balanceDue, invoice.currency)}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="space-y-2 pt-2 print:hidden">
                  {invoice.balanceDue > 0 && invoice.status !== "voided" && (
                    <button
                      type="button"
                      onClick={() => setRecordOpen(true)}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 transition-colors"
                    >
                      <CreditCardIcon className="w-4 h-4" />
                      {t("financials.actionRecordPayment", {
                        amount: formatCurrency(invoice.balanceDue, invoice.currency),
                      })}
                    </button>
                  )}
                  <div className="grid grid-cols-3 gap-2">
                    <ActionButton
                      icon={<PaperAirplaneIcon className="w-4 h-4" />}
                      label={t("financials.actionResend")}
                      disabled
                    />
                    <ActionButton
                      icon={<ArrowDownTrayIcon className="w-4 h-4" />}
                      label={t("financials.actionPdf")}
                      disabled
                    />
                    <ActionButton
                      icon={<PrinterIcon className="w-4 h-4" />}
                      label={t("financials.actionPrint")}
                      onClick={() => window.print()}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <ActionButton
                      icon={<ReceiptRefundIcon className="w-4 h-4" />}
                      label={t("financials.actionCreditNote")}
                      disabled
                    />
                    <ActionButton
                      icon={<NoSymbolIcon className="w-4 h-4" />}
                      label={t("financials.actionVoidInvoice")}
                      disabled
                      tone="danger"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {recordOpen && invoice && (
        <RecordPaymentModal
          invoice={invoice}
          onClose={() => setRecordOpen(false)}
          onSuccess={handlePaymentRecorded}
        />
      )}
    </>
  );
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-gray-700">
      <span className="shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? t("financials.actionComingSoon") : undefined}
      className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm border transition-colors ${
        tone === "danger"
          ? "border-rose-200 text-rose-600 hover:bg-rose-50 disabled:text-rose-300 disabled:hover:bg-transparent"
          : "border-gray-200 text-gray-700 hover:bg-gray-50 disabled:text-gray-300 disabled:hover:bg-transparent"
      } disabled:cursor-not-allowed`}
    >
      {icon}
      {label}
    </button>
  );
}
