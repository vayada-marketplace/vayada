"use client";

import { ArrowDownTrayIcon, ArrowPathIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import type {
  FinanceExpense,
  FinanceExpenseCategory,
  FinanceExpenseOrigin,
  FinanceReportingMoney,
} from "@vayada/domain-finance";
import { useEffect, useMemo, useState } from "react";

import { ApiErrorResponse } from "@/services/api/client";
import {
  getExpenseCategories,
  getExpenseCsv,
  getFinanceExpenses,
  requestExpenseCsv,
  type ExpenseFilters,
  type FinanceExpensesResponse,
} from "@/services/finance/financialExpenses";

type ExpensesState =
  | { kind: "loading" }
  | { kind: "ready"; data: FinanceExpensesResponse; categories: FinanceExpenseCategory[] }
  | { kind: "permission" }
  | { kind: "unavailable" }
  | { kind: "error" };

export function ExpensesTab({
  propertyId,
  locale,
  generatedAt,
  timeZone,
}: {
  propertyId: string;
  locale: string;
  generatedAt: string;
  timeZone: string;
}) {
  const range = useMemo(() => currentMonthRange(generatedAt, timeZone), [generatedAt, timeZone]);
  const [filters, setFilters] = useState<ExpenseFilters>({ ...range, sort: "incurredOn_desc" });
  const [search, setSearch] = useState("");
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<ExpensesState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [exportJob, setExportJob] = useState<{ id: string; key: string }>();
  const [exportNotice, setExportNotice] = useState<string>();
  const [downloadUrl, setDownloadUrl] = useState<string>();
  const exportKey = JSON.stringify(filters);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void Promise.all([
      getFinanceExpenses(propertyId, filters, { signal: controller.signal }),
      getExpenseCategories(propertyId, controller.signal),
    ])
      .then(([data, categories]) => {
        if (!controller.signal.aborted)
          setState({ kind: "ready", data, categories: categories.item });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({ kind: errorKind(error) });
      });
    return () => controller.abort();
  }, [filters, propertyId, reload]);

  useEffect(() => {
    setExportJob(undefined);
    setDownloadUrl(undefined);
    setExportNotice(undefined);
  }, [exportKey]);

  const loadMore = async () => {
    if (state.kind !== "ready" || !state.data.page.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = await getFinanceExpenses(propertyId, filters, {
        cursor: state.data.page.nextCursor,
      });
      setState((current) =>
        current.kind === "ready"
          ? {
              ...current,
              data: {
                ...next,
                page: { ...next.page, items: [...current.data.page.items, ...next.page.items] },
              },
            }
          : current,
      );
    } catch {
      setExportNotice("More expenses could not be loaded. Try again.");
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = async () => {
    try {
      const id =
        exportJob?.key === exportKey
          ? exportJob.id
          : (await requestExpenseCsv(propertyId, filters)).item.resourceId;
      setExportJob({ id, key: exportKey });
      const result = await getExpenseCsv(propertyId, id);
      if (result.item.download?.url) {
        setDownloadUrl(result.item.download.url);
        setExportNotice("Filtered expense CSV is ready.");
      } else if (result.item.state === "failed" || result.item.state === "expired") {
        setExportJob(undefined);
        setExportNotice("The CSV was not available. Request a new export.");
      } else {
        setExportNotice("CSV preparation started. Check again shortly.");
      }
    } catch (error) {
      setExportNotice(message(error, "The filtered CSV could not be requested."));
    }
  };

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Expense ledger</h2>
          <p className="mt-1 text-sm text-gray-600">
            Property costs, payment state, and generated charges.
          </p>
        </div>
        <div className="flex gap-2">
          {downloadUrl && (
            <a
              className="inline-flex h-10 items-center rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              href={downloadUrl}
            >
              Download CSV
            </a>
          )}
          <button
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            type="button"
            disabled={state.kind !== "ready"}
            onClick={exportCsv}
          >
            <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" />
            {exportJob?.key === exportKey ? "Check export" : "Export CSV"}
          </button>
        </div>
      </section>

      {exportNotice && (
        <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900" role="status">
          {exportNotice}
        </p>
      )}

      {state.kind === "loading" && <ExpensesSkeleton />}
      {state.kind === "ready" && (
        <ExpensesWorkspace
          data={state.data}
          categories={state.categories}
          locale={locale}
          filters={filters}
          search={search}
          loadingMore={loadingMore}
          onSearch={setSearch}
          onFilters={setFilters}
          onLoadMore={loadMore}
        />
      )}
      {state.kind !== "loading" && state.kind !== "ready" && (
        <StatusPanel kind={state.kind} onRetry={() => setReload((value) => value + 1)} />
      )}
    </div>
  );
}

function ExpensesWorkspace({
  data,
  categories,
  locale,
  filters,
  search,
  loadingMore,
  onSearch,
  onFilters,
  onLoadMore,
}: {
  data: FinanceExpensesResponse;
  categories: FinanceExpenseCategory[];
  locale: string;
  filters: ExpenseFilters;
  search: string;
  loadingMore: boolean;
  onSearch: (value: string) => void;
  onFilters: (value: ExpenseFilters) => void;
  onLoadMore: () => void;
}) {
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  return (
    <>
      {data.incompleteEvidence.length > 0 && (
        <p
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
          role="status"
        >
          Some expense evidence is incomplete. Totals may exclude mismatched source currency.
        </p>
      )}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Expense summary">
        <Metric label="Spend this month" value={formatMoney(data.summary.totalMtd.value, locale)} />
        <Metric
          label="Per occupied night"
          value={formatMoney(data.summary.perOccupiedNight.value, locale)}
        />
        <Metric
          label="Unpaid amount"
          value={formatMoney(data.summary.unpaidAmount.value, locale)}
        />
        <Metric
          label="Unpaid expenses"
          value={formatCount(data.summary.unpaidCount.value, locale)}
        />
      </section>
      <CategoryDistribution data={data} locale={locale} />
      <form
        className="grid gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3 md:grid-cols-2 xl:grid-cols-7"
        onSubmit={(event) => {
          event.preventDefault();
          onFilters({ ...filters, search: search.trim() || undefined });
        }}
        aria-label="Expense filters"
      >
        <label className="grid gap-1 text-xs font-medium text-gray-600">
          From
          <input
            className={control}
            type="date"
            value={filters.from}
            onChange={(event) => onFilters({ ...filters, from: event.target.value })}
          />
        </label>
        <label className="grid gap-1 text-xs font-medium text-gray-600">
          To
          <input
            className={control}
            type="date"
            value={filters.to}
            onChange={(event) => onFilters({ ...filters, to: event.target.value })}
          />
        </label>
        <FilterSelect
          label="Category"
          value={filters.categoryId ?? ""}
          onChange={(value) => onFilters({ ...filters, categoryId: value || undefined })}
        >
          <option value="">All categories</option>
          {categories
            .filter((category) => !category.archived)
            .map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
        </FilterSelect>
        <FilterSelect
          label="Paid state"
          value={filters.paymentStatus ?? ""}
          onChange={(value) =>
            onFilters({
              ...filters,
              paymentStatus: value ? (value as "paid" | "unpaid") : undefined,
            })
          }
        >
          <option value="">Paid and unpaid</option>
          <option value="paid">Paid</option>
          <option value="unpaid">Unpaid</option>
        </FilterSelect>
        <FilterSelect
          label="Origin"
          value={filters.origin ?? ""}
          onChange={(value) =>
            onFilters({ ...filters, origin: value ? (value as FinanceExpenseOrigin) : undefined })
          }
        >
          <option value="">All origins</option>
          <option value="manual">Manual</option>
          <option value="recurring">Recurring</option>
          <option value="ota_commission">OTA commission</option>
          <option value="platform_fee">Platform fee</option>
          <option value="supplier_bill">Supplier bill</option>
        </FilterSelect>
        <FilterSelect
          label="Recurrence"
          value={filters.recurring === undefined ? "" : String(filters.recurring)}
          onChange={(value) =>
            onFilters({ ...filters, recurring: value === "" ? undefined : value === "true" })
          }
        >
          <option value="">Any recurrence</option>
          <option value="true">Recurring only</option>
          <option value="false">One-off only</option>
        </FilterSelect>
        <div className="flex items-end gap-2 md:col-span-2 xl:col-span-1">
          <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium text-gray-600">
            Search
            <span className="flex h-10 items-center rounded-lg border border-gray-300 bg-white px-3 shadow-sm focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-100">
              <MagnifyingGlassIcon className="mr-2 h-4 w-4 text-gray-400" aria-hidden="true" />
              <input
                className="min-w-0 flex-1 border-0 p-0 text-sm outline-none"
                value={search}
                onChange={(event) => onSearch(event.target.value)}
                placeholder="Vendor or category"
              />
            </span>
          </label>
          <button
            className="h-10 rounded-lg bg-gray-900 px-3 text-sm font-medium text-white"
            type="submit"
          >
            Apply
          </button>
        </div>
      </form>
      <ExpenseTable items={data.page.items} categoryNames={categoryNames} locale={locale} />
      {data.page.nextCursor && (
        <div className="text-center">
          <button
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 disabled:opacity-50"
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore && <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}

function CategoryDistribution({ data, locale }: { data: FinanceExpensesResponse; locale: string }) {
  const total = data.categories.reduce((sum, item) => sum + numeric(item.amount.amount), 0);
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="text-base font-semibold text-gray-900">Spend by category</h3>
      <div
        className="mt-4 flex h-3 overflow-hidden rounded-full bg-gray-100"
        aria-label="Expense category distribution"
      >
        {data.categories.map(({ category, amount }) => (
          <span
            key={category.id}
            style={{
              backgroundColor: category.color,
              width: `${total ? (numeric(amount.amount) / total) * 100 : 0}%`,
            }}
            title={`${category.name}: ${formatMoney(amount, locale)}`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-gray-600">
        {data.categories.length ? (
          data.categories.map(({ category, amount }) => (
            <span key={category.id} className="inline-flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: category.color }}
              />
              {category.name}{" "}
              <strong className="font-medium text-gray-900">{formatMoney(amount, locale)}</strong>
            </span>
          ))
        ) : (
          <span>No categorized spend this month.</span>
        )}
      </div>
    </section>
  );
}

function ExpenseTable({
  items,
  categoryNames,
  locale,
}: {
  items: FinanceExpense[];
  categoryNames: Map<string, string>;
  locale: string;
}) {
  return (
    <section className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full min-w-[52rem] text-left text-sm">
        <caption className="sr-only">Filtered property expenses</caption>
        <thead className="border-b border-gray-200 bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-4 py-3" scope="col">
              Date
            </th>
            <th className="px-4 py-3" scope="col">
              Vendor
            </th>
            <th className="px-4 py-3" scope="col">
              Category
            </th>
            <th className="px-4 py-3" scope="col">
              Origin
            </th>
            <th className="px-4 py-3" scope="col">
              Status
            </th>
            <th className="px-4 py-3 text-right" scope="col">
              Amount
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.length ? (
            items.map((item) => (
              <tr key={item.id}>
                <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                  {formatDate(item.incurredOn, locale)}
                </td>
                <th className="px-4 py-3 font-medium text-gray-900" scope="row">
                  {item.vendor}
                </th>
                <td className="px-4 py-3 text-gray-600">
                  {categoryNames.get(item.categoryId) ?? "Archived category"}
                </td>
                <td className="px-4 py-3">
                  <OriginBadge item={item} />
                </td>
                <td className="px-4 py-3">
                  <span
                    className={
                      item.paymentStatus === "paid"
                        ? "rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800"
                        : "rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900"
                    }
                  >
                    {item.paymentStatus === "paid" ? "Paid" : "Unpaid"}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-semibold text-gray-900">
                  {formatMoney(item.amount, locale)}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td className="px-4 py-10 text-center text-gray-500" colSpan={6}>
                No expenses match these filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function OriginBadge({ item }: { item: FinanceExpense }) {
  const generated = item.origin !== "manual";
  const label = item.recurringRuleId ? "Recurring" : item.origin.replaceAll("_", " ");
  return (
    <span
      className={
        generated
          ? "rounded-full bg-blue-50 px-2 py-1 text-xs font-medium capitalize text-blue-800"
          : "text-sm capitalize text-gray-600"
      }
    >
      {label}
      {generated && !item.recurringRuleId ? " · generated" : ""}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium text-gray-600">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-gray-900">{value}</p>
    </article>
  );
}
function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-gray-600">
      {label}
      <select className={control} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  );
}
function ExpensesSkeleton() {
  return (
    <div className="space-y-4" aria-label="Loading expenses">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="h-24 animate-pulse rounded-xl bg-gray-100" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl bg-gray-100" />
    </div>
  );
}
function StatusPanel({
  kind,
  onRetry,
}: {
  kind: "permission" | "unavailable" | "error";
  onRetry: () => void;
}) {
  const copy =
    kind === "permission"
      ? "You do not have access to Financials expenses."
      : kind === "unavailable"
        ? "Expense reporting is not available for this property yet."
        : "Expenses could not be loaded.";
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-8 text-center">
      <p className="text-sm text-gray-700">{copy}</p>
      {kind === "error" && (
        <button
          className="mt-4 rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white"
          type="button"
          onClick={onRetry}
        >
          Try again
        </button>
      )}
    </section>
  );
}

const control =
  "h-10 min-w-0 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 shadow-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100";
function currentMonthRange(generatedAt: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(generatedAt))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    from: `${parts.year}-${parts.month}-01`,
    to: `${parts.year}-${parts.month}-${parts.day}`,
  };
}
function numeric(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function formatMoney(value: FinanceReportingMoney, locale: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: value.currency }).format(
    numeric(value.amount),
  );
}
function formatCount(value: number, locale: string) {
  return new Intl.NumberFormat(locale).format(value);
}
function formatDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${value}T00:00:00Z`),
  );
}
function errorKind(error: unknown): "permission" | "unavailable" | "error" {
  if (error instanceof ApiErrorResponse) {
    if (error.status === 401 || error.status === 403) return "permission";
    if (error.status === 404 || error.status === 422) return "unavailable";
  }
  return "error";
}
function message(error: unknown, fallback: string) {
  return error instanceof ApiErrorResponse && error.data.code === "evidence_unavailable"
    ? "The export cannot be created until expense evidence is complete."
    : fallback;
}
