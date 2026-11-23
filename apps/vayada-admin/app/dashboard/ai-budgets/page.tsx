"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  aiBudgetsService,
  budgetUse,
  changedOn,
  formatUsd,
  monthLabel,
  monthStartLabel,
  noAiUse,
  problemOf,
  stoppedNote,
  type AiAccountBudget,
  type AiBudgetOverview,
} from "@/services/api/aiBudgets";
import { AiBudgetDialog } from "./AiBudgetDialog";

/**
 * VAY-2504: what each hotel account spent on AI this month and its monthly AI budget. Only
 * vayada staff can open it or change a budget (the API checks); AI that reaches a hotel's budget
 * pauses until the 1st of next month (UTC).
 */
export default function AiBudgetsPage() {
  const [data, setData] = useState<AiBudgetOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<AiAccountBudget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    aiBudgetsService
      .overview()
      .then(setData)
      .catch((failure) => {
        // A failed reload keeps the list already shown, with the error above it.
        const problem = problemOf(failure);
        setError(problem.status === 403 ? "AI budgets need vayada staff access." : problem.message);
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const accounts = useMemo(() => {
    const query = search.trim().toLowerCase();
    const all = data?.accounts ?? [];
    return query ? all.filter((account) => account.name.toLowerCase().includes(query)) : all;
  }, [data, search]);
  const own = data?.accounts.filter((account) => account.custom).length ?? 0;
  const usedUp =
    data?.accounts.filter((account) => account.custom && budgetUse(account).usedUp).length ?? 0;
  const open = (account: AiAccountBudget, button: HTMLButtonElement) => {
    opener.current = button;
    setNotice(null);
    setEditing(account);
  };
  const close = () => {
    setEditing(null);
    opener.current?.focus();
  };

  return (
    <div className="p-4 md:p-8 max-w-[1400px]">
      <div className="mb-4 md:mb-6 flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI budgets</h1>
          <p className="text-[13px] text-gray-500 mt-1">
            {data
              ? `${monthLabel(data.month)} · what each hotel account spent on AI this month, and its monthly budget`
              : "What each hotel account spent on AI this month, and its monthly budget"}
          </p>
        </div>
        <label className="flex h-[34px] w-full md:w-60 items-center gap-2 rounded-lg border border-gray-200 bg-white px-2.5 focus-within:border-gray-400">
          <SearchIcon />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search hotels"
            aria-label="Search hotels"
            className="w-full min-w-0 bg-transparent text-[13px] text-gray-900 placeholder:text-gray-400 outline-none"
          />
        </label>
      </div>

      {/* Always mounted, so screen readers announce a notice when it appears. */}
      <div role="status">
        {notice && (
          <p className="mb-4 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-2.5 text-[12px] text-emerald-800">
            {notice}
          </p>
        )}
      </div>

      {loading && !data ? (
        <div className="animate-pulse h-64 bg-gray-100 rounded-xl" />
      ) : !data ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-[13px] text-gray-500">{error ?? "Something went wrong."}</p>
        </div>
      ) : (
        <>
          {error && (
            <p
              role="alert"
              className="mb-4 rounded-xl bg-red-50 border border-red-200 px-4 py-2.5 text-[12px] text-red-700"
            >
              {`Couldn't load the latest numbers: ${error}`}
            </p>
          )}
          <div className="hidden sm:grid grid-cols-3 gap-3 mb-4">
            <Summary
              label="Spent this month"
              value={formatUsd(data.totalUsedMicroUsd)}
              note={`Everything vayada spent on AI since ${monthStartLabel(data.month)}`}
            />
            <Summary
              label="Default budget"
              value={`${formatUsd(data.defaultMonthlyLimitMicroUsd)} a month`}
              note={
                data.defaultMonthlyLimitMicroUsd === 0
                  ? "For hotels without their own budget: no AI until you set one"
                  : "For hotels without their own budget"
              }
            />
            <Summary
              label="Own budgets"
              value={`${own} ${own === 1 ? "hotel" : "hotels"}`}
              note={
                usedUp > 0
                  ? `${usedUp} ${usedUp === 1 ? "has" : "have"} used up this month's budget`
                  : "The others use the default budget"
              }
              warn={usedUp > 0}
            />
          </div>
          <div className="sm:hidden mb-3 flex justify-between gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3">
            <Figure label="Spent" value={formatUsd(data.totalUsedMicroUsd)} />
            <Figure label="Default" value={formatUsd(data.defaultMonthlyLimitMicroUsd)} />
            <Figure label="Own" value={String(own)} />
          </div>

          {accounts.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
              <p className="text-[13px] text-gray-500">
                {search.trim() ? `No hotel matches “${search.trim()}”.` : "No hotel accounts yet."}
              </p>
            </div>
          ) : (
            <>
              {/* The table needs about 1,000px: below that (with the menu open) hotels are cards. */}
              <div className="hidden xl:block bg-white border border-gray-200 rounded-xl overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      <Th>Hotel account</Th>
                      <Th className="w-[296px]">Used this month</Th>
                      <Th className="w-[206px]">Monthly budget</Th>
                      <Th className="w-[96px] text-right">AI calls</Th>
                      <Th className="w-[136px]">Budget changed</Th>
                      <Th className="w-[116px]">
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {accounts.map((account) => (
                      <tr key={account.organizationId}>
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-2">
                            <span className="text-gray-900 font-medium">{account.name}</span>
                            <StatusTag status={account.status} />
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <Used account={account} month={data.month} />
                        </td>
                        <td className="px-4 py-3">
                          <Budget account={account} />
                        </td>
                        <td
                          className={`px-4 py-3 text-right ${account.calls ? "text-gray-700" : "text-gray-400"}`}
                        >
                          {account.calls.toLocaleString("en-US")}
                        </td>
                        <td
                          className={`px-4 py-3 text-[12px] ${changed(account, data.month) ? "text-gray-600" : "text-gray-400"}`}
                        >
                          {changed(account, data.month) ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <ChangeButton account={account} onOpen={open} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="xl:hidden grid grid-cols-1 gap-3 lg:grid-cols-2">
                {accounts.map((account) => (
                  <li
                    key={account.organizationId}
                    className="min-w-0 bg-white border border-gray-200 rounded-xl px-4 py-3.5 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-gray-900">
                          {account.name}
                        </span>
                        <StatusTag status={account.status} />
                      </span>
                      <ChangeButton account={account} onOpen={open} />
                    </div>
                    <PhoneUse account={account} month={data.month} />
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-4 text-[12px] text-gray-500">
            Each AI call counts as soon as it runs. Budgets start again on the 1st of each month
            (UTC). Hotels with the most use come first.
          </p>
        </>
      )}

      {editing && data && (
        <AiBudgetDialog
          account={editing}
          defaultMonthlyLimitMicroUsd={data.defaultMonthlyLimitMicroUsd}
          onClose={close}
          onSaved={(message) => {
            close();
            setNotice(message);
            load();
          }}
        />
      )}
    </div>
  );
}

/** When staff last set the account's own budget ("Nov 12"); null while the default applies (putting
 * an account back on the default removes its own budget, and with it the date). */
function changed(account: AiAccountBudget, month: string): string | null {
  return account.custom && account.updatedAt ? changedOn(account.updatedAt, month) : null;
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`whitespace-nowrap px-4 py-3 text-left font-medium text-[11px] text-gray-500 uppercase tracking-wider ${className}`}
    >
      {children}
    </th>
  );
}

function Summary({
  label,
  value,
  note,
  warn = false,
}: {
  label: string;
  value: string;
  note: string;
  warn?: boolean;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-1 text-lg font-bold text-gray-900">{value}</p>
      <p className={`mt-0.5 text-[11px] ${warn ? "text-amber-700" : "text-gray-500"}`}>{note}</p>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-0.5 text-lg font-bold text-gray-900">{value}</p>
    </div>
  );
}

function StatusTag({ status }: { status: string }) {
  if (status === "active") return null;
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        status === "suspended" ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-600"
      }`}
    >
      {status === "suspended" ? "Suspended" : status === "archived" ? "Archived" : status}
    </span>
  );
}

function Bar({
  share,
  stopped,
  className = "",
}: {
  share: number;
  stopped: boolean;
  className?: string;
}) {
  return (
    <div className={`h-1 rounded-full bg-gray-100 ${className}`}>
      <div
        className={`h-1 rounded-full ${stopped ? "bg-amber-500" : "bg-gray-900"}`}
        style={{ width: `${Math.round(share * 100)}%` }}
      />
    </div>
  );
}

function Used({ account, month }: { account: AiAccountBudget; month: string }) {
  if (noAiUse(account)) return <span className="text-gray-400">No AI use</span>;
  const note = stoppedNote(account, month);
  return (
    <div className="space-y-1.5">
      <p className="whitespace-nowrap">
        <span className="font-semibold text-gray-900">{formatUsd(account.usedMicroUsd)}</span>{" "}
        <span className="text-gray-500">{`of ${formatUsd(account.monthlyLimitMicroUsd)}`}</span>
      </p>
      <Bar share={budgetUse(account).share} stopped={note !== null} className="w-60" />
      {note && <p className="text-[11px] text-amber-700">{note}</p>}
    </div>
  );
}

function Budget({ account }: { account: AiAccountBudget }) {
  return (
    <span className="flex items-center gap-2">
      <span className={account.custom ? "text-gray-900" : "text-gray-500"}>
        {formatUsd(account.monthlyLimitMicroUsd)}
      </span>
      {account.custom ? (
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700">
          Own
        </span>
      ) : (
        <span className="rounded-full border border-gray-200 bg-white px-2 py-px text-[11px] font-medium text-gray-500">
          Default
        </span>
      )}
    </span>
  );
}

function PhoneUse({ account, month }: { account: AiAccountBudget; month: string }) {
  if (noAiUse(account))
    return (
      <p className="text-[13px] text-gray-400">
        {`No AI use · ${account.custom ? "Own budget" : "Default"} ${formatUsd(account.monthlyLimitMicroUsd)}`}
      </p>
    );
  const note = stoppedNote(account, month);
  const calls = `${account.calls.toLocaleString("en-US")} ${account.calls === 1 ? "call" : "calls"}`;
  return (
    <>
      <p className="text-[13px]">
        <span className="font-semibold text-gray-900">{formatUsd(account.usedMicroUsd)}</span>{" "}
        <span className="text-gray-500">{`of ${formatUsd(account.monthlyLimitMicroUsd)} · ${account.custom ? "Own budget" : "Default budget"}`}</span>
      </p>
      <Bar share={budgetUse(account).share} stopped={note !== null} />
      <div className="flex justify-between gap-2 text-[11px]">
        <span className={note ? "text-amber-700" : "text-gray-500"}>
          {note ?? (changed(account, month) ? `Changed ${changed(account, month)}` : "")}
        </span>
        <span className="shrink-0 text-gray-500">{calls}</span>
      </div>
    </>
  );
}

function ChangeButton({
  account,
  onOpen,
}: {
  account: AiAccountBudget;
  onOpen: (account: AiAccountBudget, button: HTMLButtonElement) => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => onOpen(account, event.currentTarget)}
      aria-label={`${account.custom ? "Change budget" : "Set budget"} for ${account.name}`}
      className="shrink-0 whitespace-nowrap rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[12px] font-medium text-gray-700 hover:bg-gray-50"
    >
      {account.custom ? "Change" : "Set budget"}
    </button>
  );
}

function SearchIcon() {
  return (
    <svg
      className="h-[15px] w-[15px] shrink-0 text-gray-400"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}
