"use client";

import { useEffect, useMemo, useState } from "react";
import { MagnifyingGlassIcon, ArrowDownTrayIcon } from "@heroicons/react/24/outline";
import {
  financialsService,
  InvoiceListItem,
  InvoiceListResponse,
  InvoiceStatus,
} from "@/services/financials";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";
import InvoiceDetailModal from "./InvoiceDetailModal";

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: "border-gray-200 text-gray-600 bg-gray-50",
  sent: "border-sky-200 text-sky-700 bg-sky-50",
  paid: "border-emerald-200 text-emerald-700 bg-emerald-50",
  partial: "border-amber-200 text-amber-700 bg-amber-50",
  overdue: "border-rose-200 text-rose-600 bg-rose-50",
  voided: "border-gray-200 text-gray-500 bg-gray-50 line-through",
};

const ORDERED_STATUSES: (InvoiceStatus | "all")[] = [
  "all",
  "draft",
  "sent",
  "paid",
  "partial",
  "overdue",
  "voided",
];

type SortKey = "date" | "guest" | "amount";

function formatDate(s: string): string {
  return new Date(s).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function InvoicesTab() {
  const { t } = useTranslation();
  const [data, setData] = useState<InvoiceListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | "">("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("date");
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const limit = 25;

  useEffect(() => {
    setLoading(true);
    financialsService
      .listInvoices({
        status: statusFilter || undefined,
        search: search.trim() || undefined,
        sort,
        limit,
        offset: 0,
      })
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch((err: unknown) => {
        setData(null);
        setError(err instanceof Error ? err.message : "Financial invoices are unavailable.");
      })
      .finally(() => setLoading(false));
  }, [statusFilter, search, sort]);

  const counts = data?.counts;
  const visibleStatuses = useMemo(
    () =>
      ORDERED_STATUSES.filter(
        (s) => s === "all" || statusFilter === s || (counts && counts[s as InvoiceStatus] > 0),
      ),
    [counts, statusFilter],
  );

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="text-base md:text-lg font-semibold text-gray-900">
          {t("financials.guestInvoices")}
        </h2>
        <button
          type="button"
          disabled
          title="Financial invoice CSV export is not available on PMS next-stack yet."
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg bg-white hover:bg-gray-50 text-gray-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowDownTrayIcon className="w-4 h-4" />
          {t("financials.exportCsv")}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {error}
        </div>
      )}

      {/* Search + sort */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 mb-4">
        <div className="relative flex-1 sm:flex-initial sm:max-w-sm">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder={t("financials.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-80 pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg bg-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
          />
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          <span className="text-xs text-gray-500">{t("financials.sortBy")}</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="text-sm border border-gray-200 rounded-lg bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
          >
            <option value="date">{t("financials.sortDate")}</option>
            <option value="guest">{t("financials.sortGuest")}</option>
            <option value="amount">{t("financials.sortAmount")}</option>
          </select>
        </div>
      </div>

      {/* Status chips */}
      <div className="flex items-center gap-1.5 mb-4 overflow-x-auto scrollbar-hide -mx-4 px-4 md:mx-0 md:px-0">
        {visibleStatuses.map((s) => {
          const isAll = s === "all";
          const active = isAll ? !statusFilter : statusFilter === s;
          const count = isAll ? data?.total : counts?.[s as InvoiceStatus];
          const labelKey = isAll
            ? "financials.statusAll"
            : (
                {
                  draft: "financials.statusDraft",
                  sent: "financials.statusSent",
                  paid: "financials.statusPaid",
                  partial: "financials.statusPartial",
                  overdue: "financials.statusOverdue",
                  voided: "financials.statusVoided",
                } as Record<InvoiceStatus, string>
              )[s as InvoiceStatus];
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(isAll ? "" : (s as InvoiceStatus))}
              className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-colors ${
                active
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
              }`}
            >
              {t(labelKey)}
              {count != null && count > 0 && (
                <span className={`text-[10px] ${active ? "text-gray-300" : "text-gray-400"}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* List */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-16 bg-gray-100/70 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : !data || data.invoices.length === 0 ? (
        <div className="py-16 text-center text-sm text-gray-400">{t("financials.noInvoices")}</div>
      ) : (
        <>
          {/* Mobile cards */}
          <div className="md:hidden space-y-2.5">
            {data.invoices.map((inv) => (
              <InvoiceCard key={inv.id} inv={inv} onOpen={() => setOpenId(inv.bookingId)} />
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">
                    {t("financials.tableInvoiceGuest")}
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">
                    {t("financials.tableStay")}
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">
                    {t("financials.tableRoom")}
                  </th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-400">
                    {t("financials.tableTotal")}
                  </th>
                  <th className="text-center px-4 py-3 text-xs font-medium text-gray-400 w-[100px]">
                    {t("financials.tableStatus")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((inv) => (
                  <tr
                    key={inv.id}
                    onClick={() => setOpenId(inv.bookingId)}
                    className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/50 transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <div className="text-[13px] font-mono text-gray-500">{inv.invoiceNumber}</div>
                      <div className="text-[13px] font-medium text-gray-900">
                        {inv.guestFirstName} {inv.guestLastName}
                      </div>
                      <div className="text-[11px] text-gray-400">{inv.guestEmail}</div>
                    </td>
                    <td className="px-4 py-3 text-[13px] text-gray-600">
                      {formatDate(inv.checkIn)} <span className="text-gray-300">→</span>{" "}
                      {formatDate(inv.checkOut)}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-gray-600">
                      {inv.roomNumber ? (
                        <>
                          <span className="font-medium text-gray-800">#{inv.roomNumber}</span>
                          <span className="text-gray-400"> · </span>
                          {inv.roomName}
                        </>
                      ) : (
                        inv.roomName
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="text-[13px] font-semibold text-gray-900">
                        {formatCurrency(inv.totalAmount, inv.currency)}
                      </div>
                      {inv.balanceDue > 0 && inv.status !== "voided" && (
                        <div className="text-[11px] text-rose-600 mt-0.5">
                          {t("financials.dueLabel", {
                            amount: formatCurrency(inv.balanceDue, inv.currency),
                          })}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold border ${STATUS_STYLES[inv.status]}`}
                      >
                        {t(
                          `financials.status${inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}`,
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {openId && (
        <InvoiceDetailModal
          bookingId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            // Refresh list when a payment is recorded.
            financialsService
              .listInvoices({
                status: statusFilter || undefined,
                search: search.trim() || undefined,
                sort,
                limit,
                offset: 0,
              })
              .then(setData)
              .catch(console.error);
          }}
        />
      )}
    </div>
  );
}

function InvoiceCard({ inv, onOpen }: { inv: InvoiceListItem; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onOpen}
      className="block w-full text-left bg-white border border-gray-200 rounded-xl p-3.5 active:bg-gray-50 transition-colors"
    >
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="min-w-0">
          <p className="text-[11px] font-mono text-gray-400">{inv.invoiceNumber}</p>
          <p className="text-sm font-semibold text-gray-900 truncate">
            {inv.guestFirstName} {inv.guestLastName}
          </p>
        </div>
        <span
          className={`shrink-0 inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${STATUS_STYLES[inv.status]}`}
        >
          {t(`financials.status${inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}`)}
        </span>
      </div>
      <div className="flex items-end justify-between gap-3 pt-2 border-t border-gray-100">
        <div className="text-[12px] text-gray-500">
          {formatDate(inv.checkIn)} → {formatDate(inv.checkOut)}
          {inv.roomNumber && (
            <>
              <span className="text-gray-300"> · </span>
              <span className="text-gray-700">#{inv.roomNumber}</span>
            </>
          )}
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold text-gray-900">
            {formatCurrency(inv.totalAmount, inv.currency)}
          </p>
          {inv.balanceDue > 0 && inv.status !== "voided" && (
            <p className="text-[11px] text-rose-600 mt-0.5">
              {t("financials.dueLabel", { amount: formatCurrency(inv.balanceDue, inv.currency) })}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}
