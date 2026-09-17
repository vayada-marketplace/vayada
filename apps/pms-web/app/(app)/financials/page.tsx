"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownTrayIcon, PlusIcon } from "@heroicons/react/24/outline";
import { usePmsAccess } from "@/lib/settings/PmsAccessContext";
import { ApiErrorResponse } from "@/services/api/client";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";
import {
  finalizeFolio,
  getFolio,
  getFolioCsv,
  listFolios,
  prepareFolio,
  requestFolioCsv,
  type Folio,
  type FolioSummary,
} from "@/services/api/financeFoliosClient";

import { DashboardWorkspace } from "./DashboardWorkspace";

const initialForm = {
  recipientName: "",
  recipientEmail: "",
  from: "",
  to: "",
  description: "",
  amount: "",
};
const button =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export default function FinancialsPage() {
  const [tab, setTab] = useState<"dashboard" | "folios">("dashboard");
  const access = usePmsAccess();
  const canManage = access.permissions.includes("pms.finance.manage");
  const [propertyId, setPropertyId] = useState<string>();
  const [currency, setCurrency] = useState("EUR");
  const [items, setItems] = useState<FolioSummary[]>([]);
  const [selected, setSelected] = useState<Folio>();
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [downloadUrl, setDownloadUrl] = useState<string>();
  const [exportJob, setExportJob] = useState<{ id: string; key: string }>();
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [form, setForm] = useState(initialForm);
  const createCommandId = useRef<string>();
  const finalizeCommandId = useRef<string>();
  const filters = useMemo(
    () => ({ state: filter || undefined, search: search || undefined, sort: "createdAt_desc" }),
    [filter, search],
  );
  const readyCount = items.filter((item) => item.state === "ready").length;
  const exportFilters = useMemo(
    () => ({ search: search || undefined, sort: "createdAt_desc" }),
    [search],
  );
  const exportKey = JSON.stringify(exportFilters);

  const load = useCallback(
    async (id = propertyId, cursor?: string, append = false) => {
      if (!id) return;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(undefined);
      try {
        const response = await listFolios(id, { ...filters, cursor });
        setItems((current) =>
          append ? [...current, ...response.page.items] : response.page.items,
        );
        setCurrency(response.currency);
        setNextCursor(response.page.nextCursor);
      } catch (cause) {
        setError(message(cause, "Folios could not be loaded."));
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [filters, propertyId],
  );

  useEffect(() => {
    if (tab !== "folios") return;
    void resolveSelectedPmsPropertyId("loading folios")
      .then(setPropertyId)
      .catch((cause) => {
        setError(message(cause, "Select a property before loading folios."));
        setLoading(false);
      });
  }, [tab]);
  useEffect(() => {
    if (tab === "folios" && propertyId) {
      setDownloadUrl(undefined);
      setExportJob(undefined);
      void load();
    }
  }, [load, propertyId, tab]);

  const select = async (folioId: string) => {
    if (!propertyId) return;
    try {
      setSelected((item) => (item?.folioId === folioId ? item : undefined));
      setSelected((await getFolio(propertyId, folioId)).item);
    } catch (cause) {
      setError(message(cause, "Folio details could not be loaded."));
    }
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!propertyId || saving) return;
    const id = (createCommandId.current ??= crypto.randomUUID());
    setSaving(true);
    try {
      const result = await prepareFolio(propertyId, { ...form, currency }, id);
      createCommandId.current = undefined;
      setCreating(false);
      setForm(initialForm);
      await load();
      await select(result.resourceId);
      setNotice("Folio prepared as a draft. Review it before finalizing.");
    } catch (cause) {
      setError(message(cause, "The folio could not be prepared."));
    } finally {
      setSaving(false);
    }
  };
  const finalize = async () => {
    if (!propertyId || !selected || finalizing) return;
    const id = (finalizeCommandId.current ??= crypto.randomUUID());
    setFinalizing(true);
    try {
      await finalizeFolio(propertyId, selected.folioId, selected.revision, id);
      finalizeCommandId.current = undefined;
      await select(selected.folioId);
      await load();
      setNotice("Folio finalized. It is ready for accounting export.");
    } catch (cause) {
      setError(message(cause, "The folio could not be finalized."));
    } finally {
      setFinalizing(false);
    }
  };
  const exportCsv = async () => {
    if (!propertyId) return;
    try {
      const id =
        exportJob?.key === exportKey
          ? exportJob.id
          : (await requestFolioCsv(propertyId, exportFilters)).item.resourceId;
      setExportJob({ id, key: exportKey });
      const status = await getFolioCsv(propertyId, id);
      if (status.item.download?.url) {
        setDownloadUrl(status.item.download.url);
        setNotice("CSV is ready to download.");
      } else if (["failed", "expired"].includes(status.item.state)) {
        setExportJob(undefined);
        setDownloadUrl(undefined);
        setNotice("CSV export was not available. Try exporting again.");
      } else
        setNotice("CSV preparation has started. Select Export CSV again shortly to download it.");
    } catch (cause) {
      setError(message(cause, "The CSV export could not be requested."));
    }
  };

  return (
    <div>
      <nav
        aria-label="Financials sections"
        className="mx-auto flex max-w-7xl gap-1 overflow-x-auto border-b border-gray-200 px-4 pt-4 md:px-6"
        role="tablist"
      >
        {(["dashboard", "folios"] as const).map((item) => (
          <button
            key={item}
            aria-controls={`financials-${item}-panel`}
            aria-selected={tab === item}
            className={`rounded-t-lg px-4 py-2 text-sm font-medium ${tab === item ? "bg-blue-50 text-blue-800" : "text-gray-600 hover:bg-gray-50"}`}
            id={`financials-${item}-tab`}
            onClick={() => setTab(item)}
            role="tab"
            type="button"
          >
            {item === "dashboard" ? "Dashboard" : "Folios"}
          </button>
        ))}
      </nav>
      {tab === "dashboard" ? (
        <div
          aria-labelledby="financials-dashboard-tab"
          id="financials-dashboard-panel"
          role="tabpanel"
        >
          <DashboardWorkspace />
        </div>
      ) : (
        <div
          aria-labelledby="financials-folios-tab"
          data-testid="folios-workspace"
          id="financials-folios-panel"
          role="tabpanel"
          className="p-4 md:p-6"
        >
          <div className="mx-auto max-w-6xl space-y-5">
            <header className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Folios</h1>
                <p className="mt-1 max-w-2xl text-sm text-gray-600">
                  Operational guest statements. They are not official invoices and do not receive
                  invoice numbers.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={exportCsv}
                  disabled={!propertyId}
                  className={`${button} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}
                >
                  <ArrowDownTrayIcon className="h-4 w-4" />
                  Export CSV
                </button>
                {downloadUrl && (
                  <a
                    href={downloadUrl}
                    className={`${button} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}
                  >
                    Download CSV
                  </a>
                )}
                {canManage && (
                  <button
                    onClick={() => setCreating(true)}
                    className={`${button} bg-primary-600 text-white hover:bg-primary-700`}
                  >
                    <PlusIcon className="h-4 w-4" />
                    Prepare folio
                  </button>
                )}
              </div>
            </header>
            {notice && (
              <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
                {notice}
              </p>
            )}
            {error && (
              <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
                {error}
              </p>
            )}
            <section aria-label="Folio summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Metric label="Visible folios" value={String(items.length)} />
              <Metric
                label="Drafts"
                value={String(items.filter((item) => item.state === "draft").length)}
              />
              <Metric label="Ready for export" value={String(readyCount)} />
            </section>
            {creating && canManage && (
              <form
                onSubmit={create}
                className="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-2"
              >
                <h2 className="sm:col-span-2 text-base font-semibold text-gray-900">
                  Prepare a folio
                </h2>
                <fieldset disabled={saving} className="contents">
                  <Field
                    label="Guest or recipient"
                    value={form.recipientName}
                    onChange={(recipientName) => setForm({ ...form, recipientName })}
                    required
                  />
                  <Field
                    label="Email (optional)"
                    type="email"
                    value={form.recipientEmail}
                    onChange={(recipientEmail) => setForm({ ...form, recipientEmail })}
                  />
                  <Field
                    label="Service from"
                    type="date"
                    value={form.from}
                    onChange={(from) => setForm({ ...form, from })}
                    required
                  />
                  <Field
                    label="Service to"
                    type="date"
                    value={form.to}
                    onChange={(to) => setForm({ ...form, to })}
                    required
                  />
                  <Field
                    label="Line item"
                    value={form.description}
                    onChange={(description) => setForm({ ...form, description })}
                    required
                  />
                  <Field
                    label={`Amount (${currency})`}
                    inputMode="decimal"
                    value={form.amount}
                    onChange={(amount) => setForm({ ...form, amount })}
                    required
                  />
                </fieldset>
                <div className="flex gap-2 sm:col-span-2">
                  <button
                    disabled={saving}
                    className={`${button} bg-primary-600 text-white hover:bg-primary-700`}
                  >
                    {saving ? "Saving draft…" : "Save draft"}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      createCommandId.current = undefined;
                      setCreating(false);
                    }}
                    className={`${button} border border-gray-300 text-gray-700 hover:bg-gray-50`}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            <section className="rounded-xl border border-gray-200 bg-white">
              <div className="flex flex-col gap-3 border-b border-gray-200 p-4 sm:flex-row">
                <input
                  aria-label="Search folios"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by folio reference"
                  className="h-10 flex-1 rounded-lg border border-gray-300 px-3 text-sm"
                />
                <select
                  aria-label="Folio state"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  className="h-10 rounded-lg border border-gray-300 px-3 text-sm"
                >
                  <option value="">All states</option>
                  <option value="draft">Draft</option>
                  <option value="ready">Ready</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
              {loading ? (
                <div className="space-y-3 p-4" aria-label="Loading folios">
                  <div className="h-12 animate-pulse rounded bg-gray-100" />
                  <div className="h-12 animate-pulse rounded bg-gray-100" />
                </div>
              ) : items.length === 0 ? (
                <p className="p-8 text-center text-sm text-gray-500">
                  No folios match these filters. Prepare a folio when a guest statement is needed.
                </p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {items.map((item) => (
                    <button
                      key={item.folioId}
                      onClick={() => void select(item.folioId)}
                      className="grid w-full grid-cols-[1fr_auto] gap-3 p-4 text-left hover:bg-gray-50"
                    >
                      <span>
                        <span className="block font-medium text-gray-900">
                          Folio {item.folioId.slice(0, 8)}
                        </span>
                        <span className="text-sm text-gray-500">
                          {item.serviceFrom} to {item.serviceTo}
                        </span>
                      </span>
                      <span className="text-right">
                        <span className="block font-semibold text-gray-900">
                          {money(item.total)}
                        </span>
                        <span className="text-sm capitalize text-gray-500">{item.state}</span>
                      </span>
                    </button>
                  ))}
                  {nextCursor && (
                    <div className="p-4 text-center">
                      <button
                        onClick={() => void load(propertyId, nextCursor, true)}
                        disabled={loadingMore}
                        className={`${button} border border-gray-300 text-gray-700 hover:bg-gray-50`}
                      >
                        {loadingMore ? "Loading…" : "Load more folios"}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
            {selected && (
              <section
                aria-label="Folio details"
                className="rounded-xl border border-gray-200 bg-white p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">
                      Folio {selected.folioId.slice(0, 8)}
                    </h2>
                    <p className="text-sm text-gray-600">
                      {selected.recipient.name}
                      {selected.recipient.email ? ` · ${selected.recipient.email}` : ""}
                    </p>
                  </div>
                  {selected.state === "draft" && canManage && (
                    <button
                      onClick={finalize}
                      disabled={finalizing}
                      className={`${button} bg-primary-600 text-white hover:bg-primary-700`}
                    >
                      {finalizing ? "Finalizing…" : "Finalize folio"}
                    </button>
                  )}
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                  <Definition label="State" value={selected.state} />
                  <Definition
                    label="Service period"
                    value={`${selected.serviceFrom} to ${selected.serviceTo}`}
                  />
                  <Definition label="Total" value={money(selected.total)} />
                </dl>
                <h3 className="mt-5 font-semibold text-gray-900">Line items</h3>
                <ul className="mt-2 space-y-2">
                  {selected.lines.map((line) => (
                    <li
                      key={line.lineId}
                      className="flex justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2 text-sm"
                    >
                      <span>
                        {line.description}{" "}
                        <span className="text-gray-500">
                          ({line.kind}, {line.quantity})
                        </span>
                      </span>
                      <strong>{money(line.total)}</strong>
                    </li>
                  ))}
                </ul>
                <h3 className="mt-5 font-semibold text-gray-900">Payment references</h3>
                {selected.paymentRefs.length ? (
                  <ul className="mt-2 space-y-2">
                    {selected.paymentRefs.map((payment) => (
                      <li
                        key={payment.paymentId}
                        className="flex justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2 text-sm"
                      >
                        <span>{payment.paymentId}</span>
                        <strong>{money(payment.amount)}</strong>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-gray-500">
                    No payment references are attached to this folio.
                  </p>
                )}
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}
function Definition({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-gray-500">{label}</dt>
      <dd className="mt-1 font-medium capitalize text-gray-900">{value}</dd>
    </div>
  );
}
function Field({
  label,
  value,
  onChange,
  type = "text",
  required,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <label className="grid gap-1 text-sm font-medium text-gray-700">
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        inputMode={inputMode}
        className="h-10 rounded-lg border border-gray-300 px-3 font-normal"
      />
    </label>
  );
}
function money(value: { amount: string; currency: string }) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: value.currency }).format(
    Number(value.amount),
  );
}
function message(cause: unknown, fallback: string) {
  return cause instanceof ApiErrorResponse && cause.status === 403
    ? "You do not have permission to use property financials."
    : cause instanceof Error
      ? cause.message
      : fallback;
}
