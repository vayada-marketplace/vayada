"use client";

import { useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { financialsService, InvoiceDetail, ManualPaymentMethod } from "@/services/financials";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";

interface Props {
  invoice: InvoiceDetail;
  onClose: () => void;
  onSuccess: (updated: InvoiceDetail) => void;
}

const METHODS: { value: ManualPaymentMethod; labelKey: string }[] = [
  { value: "cash", labelKey: "financials.recordMethodCash" },
  { value: "bank_transfer", labelKey: "financials.recordMethodBankTransfer" },
  { value: "manual_card", labelKey: "financials.recordMethodManualCard" },
  { value: "other", labelKey: "financials.recordMethodOther" },
];

export default function RecordPaymentModal({ invoice, onClose, onSuccess }: Props) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState<string>(invoice.balanceDue.toFixed(2));
  const [method, setMethod] = useState<ManualPaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFloat(amount);
    if (!parsed || parsed <= 0) {
      setError(t("financials.recordError"));
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const updated = await financialsService.recordPayment(invoice.bookingId, {
        amount: parsed,
        paymentMethod: method,
        reference: reference.trim() || undefined,
      });
      onSuccess(updated);
    } catch (err: any) {
      setError(err?.message || t("financials.recordError"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <span className="inline-flex w-6 h-6 items-center justify-center rounded bg-emerald-100">
              <span className="w-3 h-3 rounded-sm bg-emerald-600" />
            </span>
            {t("financials.recordPayment")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100"
            aria-label="Close"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Invoice summary */}
        <div className="rounded-lg border border-gray-200 px-3 py-2.5 mb-4 text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-gray-500">{t("financials.recordInvoiceLabel")}</span>
            <span className="font-mono text-gray-700">{invoice.invoiceNumber}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">{t("financials.recordBalanceLabel")}</span>
            <span className="font-bold text-rose-600 tabular-nums">
              {formatCurrency(invoice.balanceDue, invoice.currency)}
            </span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Amount */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              {t("financials.recordAmountLabel", { currency: invoice.currency })}
            </label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max={invoice.balanceDue}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full px-3 py-2.5 text-base border-2 border-primary-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              required
              autoFocus
            />
            <button
              type="button"
              onClick={() => setAmount(invoice.balanceDue.toFixed(2))}
              className="text-xs text-primary-600 hover:underline mt-1"
            >
              {t("financials.recordPayFullBalance")}
            </button>
          </div>

          {/* Method */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              {t("financials.recordMethodLabel")}
            </label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as ManualPaymentMethod)}
              className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
            >
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {t(m.labelKey)}
                </option>
              ))}
            </select>
          </div>

          {/* Reference */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              {t("financials.recordReferenceLabel")}
            </label>
            <input
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("financials.recordReferencePlaceholder")}
              className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
            />
          </div>

          {error && <p className="text-sm text-rose-600">{error}</p>}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors disabled:opacity-50"
            >
              {submitting ? t("financials.recordSubmitting") : t("financials.recordSubmit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
