"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  countryName,
  errorOf,
  PayoutModal,
  type PayoutTarget,
} from "@/components/payouts/PayoutDialogs";
import {
  formatDay,
  formatMinor,
  isNegative,
  isPositive,
  vayadaPayoutsService,
  type PayoutHotel,
  type PayoutList,
  type PayoutMode,
} from "@/services/api/vayadaPayouts";

const MODES: { value: PayoutMode; label: string }[] = [
  { value: "live", label: "Live" },
  { value: "test", label: "Test mode" },
];

/** Totals per currency, in minor units (exact: BigInt from the strings). */
function totals(rows: PayoutHotel[], pick: (row: PayoutHotel) => string | null) {
  const sums = new Map<string, bigint>();
  for (const row of rows) {
    const value = pick(row);
    if (value === null) continue;
    sums.set(row.currency, (sums.get(row.currency) ?? BigInt(0)) + BigInt(value));
  }
  return Array.from(sums.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, sum]) => formatMinor(sum.toString(), currency));
}

const canPay = (row: PayoutHotel) =>
  isPositive(row.payNowMinor) && row.destination !== null && row.sending === null;
const needsAction = (row: PayoutHotel) => canPay(row) || row.sending !== null;

export default function PayoutsPage() {
  return (
    <Suspense fallback={null}>
      <Payouts />
    </Suspense>
  );
}

function Payouts() {
  const router = useRouter();
  const search = useSearchParams();
  const mode: PayoutMode = search.get("mode") === "test" ? "test" : "live";
  const [data, setData] = useState<PayoutList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState<PayoutTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    vayadaPayoutsService
      .list(mode)
      .then(setData)
      .catch((failure) => {
        const problem = errorOf(failure);
        setData(null);
        setError(
          problem.status === 404
            ? "vayada Payment is switched off."
            : problem.status === 403
              ? "Payouts need Vayada finance access."
              : problem.message,
        );
      })
      .finally(() => setLoading(false));
  }, [mode]);
  useEffect(load, [load]);

  const hotels = useMemo(
    () =>
      (data?.hotels ?? [])
        .slice()
        .sort(
          (a, b) => Number(needsAction(b)) - Number(needsAction(a)) || a.name.localeCompare(b.name),
        ),
    [data],
  );
  const toPay = totals(hotels, (row) => (canPay(row) ? row.payNowMinor : null));
  const owing = hotels.filter((row) => isNegative(row.payableMinor));
  const owed = totals(owing, (row) => row.payableMinor.replace(/^-/, ""));
  const missingAccount = hotels.filter((row) => isPositive(row.payNowMinor) && !row.destination);

  const open = (row: PayoutHotel) =>
    router.push(`/dashboard/payouts/${row.propertyId}${mode === "test" ? "?mode=test" : ""}`);

  return (
    <div className="p-4 md:p-8 max-w-[1400px]">
      <div className="mb-5 md:mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Payouts</h1>
          <p className="text-[13px] text-gray-500 mt-1">
            {data
              ? `vayada Payment · Monday payouts for stays checked out by ${formatDay(data.cutoff, true)}`
              : "vayada Payment · Monday payouts for stays checked out by the Sunday before"}
          </p>
        </div>
        <div className="flex gap-2" role="group" aria-label="Money">
          {MODES.map((item) => (
            <Link
              key={item.value}
              href={item.value === "test" ? "/dashboard/payouts?mode=test" : "/dashboard/payouts"}
              aria-current={mode === item.value ? "page" : undefined}
              className={`px-3 py-1.5 text-[12px] font-medium rounded-full border transition-colors ${
                mode === item.value
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </div>
      </div>

      {mode === "test" && (
        <p className="mb-4 rounded-xl bg-amber-50 border border-amber-200 px-4 py-2.5 text-[12px] text-amber-800">
          Test mode: Stripe test payments only. Payouts recorded here are tests; never send real
          money for them.
        </p>
      )}
      {notice && (
        <p className="mb-4 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-2.5 text-[12px] text-emerald-800">
          {notice}
        </p>
      )}

      {loading ? (
        <div className="animate-pulse h-64 bg-gray-100 rounded-xl" />
      ) : error ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-[13px] text-gray-500">{error}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            <Summary label="To pay now" lines={toPay.length ? toPay : ["Nothing to pay"]} />
            <Summary
              label="Hotels to pay"
              lines={[String(hotels.filter(canPay).length)]}
              note={
                missingAccount.length
                  ? `${missingAccount.length} more without a payout account`
                  : undefined
              }
            />
            <Summary
              label="Owed to Vayada"
              lines={owed.length ? owed : ["Nothing"]}
              note={
                owing.length
                  ? `${owing.length} hotel${owing.length === 1 ? "" : "s"}, taken from their next payouts`
                  : undefined
              }
            />
          </div>

          {hotels.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
              <p className="text-[13px] text-gray-500">
                No vayada Payment money yet. Hotels show here after their first card payment.
              </p>
            </div>
          ) : (
            <>
              <div className="hidden md:block bg-white border border-gray-200 rounded-xl overflow-hidden">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50/80">
                      {["Hotel", "Payout account", "Pay now", "Next weeks", "Last payout", ""].map(
                        (label, index) => (
                          <th
                            key={label || index}
                            className={`px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider ${
                              index >= 2 && index <= 3 ? "text-right" : "text-left"
                            }`}
                          >
                            {label}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {hotels.map((row) => (
                      <tr
                        key={`${row.propertyId}:${row.currency}`}
                        onClick={() => open(row)}
                        className="hover:bg-gray-50/50 cursor-pointer"
                      >
                        <td className="px-4 py-3">
                          <p className="text-gray-900 font-medium">{row.name}</p>
                          <p className="text-[11px] text-gray-400">{row.currency}</p>
                        </td>
                        <td className="px-4 py-3 text-[12px]">
                          <Account row={row} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <PayNow row={row} />
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          {isPositive(row.upcomingMinor) || isNegative(row.upcomingMinor)
                            ? formatMinor(row.upcomingMinor, row.currency)
                            : "—"}
                        </td>
                        <td className="px-4 py-3 text-[12px] text-gray-600">
                          <LastPayout row={row} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <PayButton row={row} onPay={setPaying} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="md:hidden space-y-3">
                {hotels.map((row) => (
                  <li
                    key={`${row.propertyId}:${row.currency}`}
                    className="bg-white border border-gray-200 rounded-xl p-4"
                  >
                    <button type="button" onClick={() => open(row)} className="w-full text-left">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[13px] text-gray-900 font-medium truncate">
                            {row.name}
                          </p>
                          <div className="text-[12px] mt-0.5">
                            <Account row={row} />
                          </div>
                        </div>
                        <div className="text-right shrink-0 text-[13px]">
                          <PayNow row={row} />
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
                        <div>
                          <p className="text-[11px] text-gray-400">Next weeks</p>
                          <p className="text-gray-700">
                            {isPositive(row.upcomingMinor) || isNegative(row.upcomingMinor)
                              ? formatMinor(row.upcomingMinor, row.currency)
                              : "—"}
                          </p>
                        </div>
                        <div>
                          <p className="text-[11px] text-gray-400">Last payout</p>
                          <div className="text-gray-700">
                            <LastPayout row={row} />
                          </div>
                        </div>
                      </div>
                    </button>
                    {needsAction(row) && (
                      <div className="mt-3">
                        <PayButton row={row} onPay={setPaying} wide />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {data && (
        <PayoutModal
          target={paying}
          mode={mode}
          cutoff={data.cutoff}
          onClose={() => setPaying(null)}
          onChanged={(message) => {
            setNotice(message || null);
            setPaying(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function Summary({ label, lines, note }: { label: string; lines: string[]; note?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{label}</p>
      {lines.map((line) => (
        <p key={line} className="mt-1 text-lg font-bold text-gray-900">
          {line}
        </p>
      ))}
      {note && <p className="mt-0.5 text-[11px] text-gray-500">{note}</p>}
    </div>
  );
}

function Account({ row }: { row: PayoutHotel }) {
  return row.destination ? (
    <span className="text-gray-600">
      {countryName(row.destination.countryCode)} ·{" "}
      <span className="font-mono">···· {row.destination.accountLast4}</span>
    </span>
  ) : (
    <span className="text-amber-700">No payout account</span>
  );
}

function PayNow({ row }: { row: PayoutHotel }) {
  if (isNegative(row.payableMinor))
    return (
      <span className="text-red-600 font-medium">
        {`Owes ${formatMinor(row.payableMinor.replace(/^-/, ""), row.currency)}`}
      </span>
    );
  if (!isPositive(row.payNowMinor)) return <span className="text-gray-400">—</span>;
  return (
    <span className="text-gray-900 font-semibold">
      {formatMinor(row.payNowMinor, row.currency)}
    </span>
  );
}

function LastPayout({ row }: { row: PayoutHotel }) {
  if (row.sending)
    return (
      <span className="text-amber-700">
        {`Being sent: ${formatMinor(row.sending.amountMinor, row.currency)}`}
        <span className="block text-[11px] text-amber-600">
          {`Started ${formatDay(row.sending.startedAt)}, not marked sent yet`}
        </span>
      </span>
    );
  if (!row.lastPayout) return <span className="text-gray-400">—</span>;
  return (
    <>
      {`${formatMinor(row.lastPayout.amountMinor, row.currency)} · ${formatDay(row.lastPayout.paidOn)}`}
      <span className="block text-[11px] text-gray-400 font-mono truncate">
        {row.lastPayout.reference}
      </span>
    </>
  );
}

function PayButton({
  row,
  onPay,
  wide = false,
}: {
  row: PayoutHotel;
  onPay: (target: PayoutTarget) => void;
  wide?: boolean;
}) {
  if (!needsAction(row)) return null;
  const sending = row.sending;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onPay(sending ? { hotel: row, started: sending } : { hotel: row });
      }}
      className={`px-3 py-1.5 text-[12px] font-medium rounded-lg ${
        sending
          ? "border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
          : "bg-gray-900 text-white hover:bg-gray-800"
      } ${wide ? "w-full py-2" : ""}`}
    >
      {sending ? "Finish payout" : "Pay"}
    </button>
  );
}
