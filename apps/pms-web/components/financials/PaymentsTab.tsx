"use client";

import { useEffect, useState } from "react";
import {
  financialsService,
  PaymentLedgerEntry,
  PaymentLedgerResponse,
} from "@/services/financials";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";

function formatDateTime(s: string): string {
  return new Date(s).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PaymentsTab() {
  const { t } = useTranslation();
  const [data, setData] = useState<PaymentLedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const limit = 25;

  useEffect(() => {
    setLoading(true);
    financialsService
      .listPayments({ limit, offset })
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch((err: unknown) => {
        setData(null);
        setError(err instanceof Error ? err.message : "Payment ledger is unavailable.");
      })
      .finally(() => setLoading(false));
  }, [offset]);

  if (error) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        {error}
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="space-y-2">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-14 bg-gray-100/70 rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  if (!data || data.payments.length === 0) {
    return (
      <div className="py-16 text-center text-sm text-gray-400">{t("financials.noPayments")}</div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">
              {t("financials.tableInvoiceGuest")}
            </th>
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">
              {t("financials.tableMethod")}
            </th>
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">
              {t("financials.tableReference")}
            </th>
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">
              {t("financials.tableRecordedAt")}
            </th>
            <th className="text-right px-4 py-3 text-xs font-medium text-gray-400">
              {t("financials.tableTotal")}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.payments.map((p) => (
            <PaymentRow key={p.id} p={p} />
          ))}
        </tbody>
      </table>

      {data.total > limit && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
          <p className="text-sm text-gray-400">
            {t("pagination.showing", {
              from: String(offset + 1),
              to: String(Math.min(offset + limit, data.total)),
              total: String(data.total),
            })}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={offset === 0}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition-colors"
            >
              {t("pagination.previous")}
            </button>
            <button
              onClick={() => setOffset(offset + limit)}
              disabled={offset + limit >= data.total}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition-colors"
            >
              {t("pagination.next")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PaymentRow({ p }: { p: PaymentLedgerEntry }) {
  return (
    <tr className="border-b border-gray-100 last:border-b-0">
      <td className="px-4 py-3">
        <div className="text-[12px] font-mono text-gray-500">{p.invoiceNumber}</div>
        <div className="text-[13px] font-medium text-gray-900">
          {p.guestFirstName} {p.guestLastName}
        </div>
      </td>
      <td className="px-4 py-3 text-[13px] text-gray-600">{p.methodLabel}</td>
      <td className="px-4 py-3 text-[12px] text-gray-500 font-mono">{p.reference || "—"}</td>
      <td className="px-4 py-3 text-[12px] text-gray-500">{formatDateTime(p.recordedAt)}</td>
      <td className="px-4 py-3 text-right text-[13px] font-semibold text-gray-900">
        {formatCurrency(p.amount, p.currency)}
      </td>
    </tr>
  );
}
