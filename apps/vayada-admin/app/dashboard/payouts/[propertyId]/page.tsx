"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  BankDetails,
  errorOf,
  PayoutModal,
  type PayoutTarget,
  ReturnPayoutModal,
} from "@/components/payouts/PayoutDialogs";
import {
  ENTRY_LABELS,
  formatDay,
  formatMinor,
  isNegative,
  isPositive,
  vayadaPayoutsService,
  type Payout,
  type PayoutHotelDetail,
  type PayoutMode,
} from "@/services/api/vayadaPayouts";

const th = "px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider";

export default function PayoutHotelPage() {
  return (
    <Suspense fallback={null}>
      <PayoutHotelView />
    </Suspense>
  );
}

function PayoutHotelView() {
  const params = useParams();
  const propertyId = params.propertyId as string;
  const mode: PayoutMode = useSearchParams().get("mode") === "test" ? "test" : "live";
  const [data, setData] = useState<PayoutHotelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState<PayoutTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [returning, setReturning] = useState<Payout | null>(null);

  const load = useCallback(() => {
    setError(null);
    vayadaPayoutsService
      .detail(propertyId, mode)
      .then(setData)
      .catch((failure) => {
        const problem = errorOf(failure);
        setError(
          problem.status === 404 && problem.code === "property_not_found"
            ? "There's no hotel at this link."
            : problem.status === 404
              ? "vayada Payment is switched off."
              : problem.message,
        );
      });
  }, [propertyId, mode]);
  useEffect(load, [load]);

  const back = mode === "test" ? "/dashboard/payouts?mode=test" : "/dashboard/payouts";
  const finish = (payout: Payout) => {
    const balance = data?.balances.find((row) => row.currency === payout.currency);
    if (balance)
      setPaying({ hotel: balance, started: { id: payout.id, amountMinor: payout.amountMinor } });
  };
  return (
    <div className="p-4 md:p-8 max-w-[1400px]">
      <Link href={back} className="text-[12px] text-gray-500 hover:text-gray-900">
        ← Payouts
      </Link>
      {error ? (
        <div className="mt-4 bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-[13px] text-gray-500">{error}</p>
        </div>
      ) : !data ? (
        <div className="mt-4 animate-pulse h-64 bg-gray-100 rounded-xl" />
      ) : (
        <>
          {notice && (
            <p className="mt-3 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-2.5 text-[12px] text-emerald-800">
              {notice}
            </p>
          )}
          <div className="mt-2 mb-5 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-gray-900">{data.name}</h1>
            {mode === "test" && (
              <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800">
                Test mode
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-6">
            <div className="lg:col-span-2 space-y-3">
              {data.balances.length === 0 && (
                <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 text-[13px] text-gray-500">
                  No vayada Payment money for this hotel yet.
                </div>
              )}
              {data.balances.map((balance) => (
                <div
                  key={balance.currency}
                  className="bg-white border border-gray-200 rounded-xl px-4 py-4 flex flex-col sm:flex-row sm:items-center gap-4"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 flex-1">
                    <Figure
                      label="Pay now"
                      value={
                        isNegative(balance.payableMinor)
                          ? `Owes ${formatMinor(balance.payableMinor.replace(/^-/, ""), balance.currency)}`
                          : formatMinor(balance.payNowMinor, balance.currency)
                      }
                      note={`Checked out by ${formatDay(data.cutoff, true)}`}
                      tone={isNegative(balance.payableMinor) ? "red" : "strong"}
                    />
                    <Figure
                      label="Next weeks"
                      value={formatMinor(balance.upcomingMinor, balance.currency)}
                      note="Stays checking out later"
                    />
                    {balance.payableMinor !== balance.payNowMinor &&
                      !isNegative(balance.payableMinor) && (
                        <Figure
                          label="Kept for later"
                          value={formatMinor(
                            (BigInt(balance.payableMinor) - BigInt(balance.payNowMinor)).toString(),
                            balance.currency,
                          )}
                          note="Below one rupiah"
                        />
                      )}
                  </div>
                  {balance.sending ? (
                    <button
                      type="button"
                      onClick={() => setPaying({ hotel: balance, started: balance.sending! })}
                      className="shrink-0 px-4 py-2 text-[13px] font-medium rounded-lg border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                    >
                      {`Finish payout of ${formatMinor(balance.sending.amountMinor, balance.currency)}`}
                    </button>
                  ) : (
                    isPositive(balance.payNowMinor) &&
                    data.destination && (
                      <button
                        type="button"
                        onClick={() => setPaying({ hotel: balance })}
                        className="shrink-0 px-4 py-2 text-[13px] font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800"
                      >
                        Pay
                      </button>
                    )
                  )}
                </div>
              ))}
            </div>
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-4">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-gray-500">
                Payout account
              </p>
              <BankDetails propertyId={data.propertyId} destination={data.destination} />
            </div>
          </div>

          <h2 className="text-[15px] font-semibold text-gray-900 mb-2">Payouts</h2>
          {data.payouts.length === 0 ? (
            <div className="mb-6 bg-white border border-gray-200 rounded-xl p-6 text-center text-[13px] text-gray-500">
              No payouts yet.
            </div>
          ) : (
            <>
              <div className="hidden md:block mb-6 bg-white border border-gray-200 rounded-xl overflow-hidden">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50/80">
                      <th className={`${th} text-left`}>Paid on</th>
                      <th className={`${th} text-right`}>Amount</th>
                      <th className={`${th} text-left`}>Reference</th>
                      <th className={`${th} text-left`}>For stays by</th>
                      <th className={`${th} text-left`}>Status</th>
                      <th className={th} />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.payouts.map((payout) => (
                      <tr key={payout.id}>
                        <td className="px-4 py-3 text-gray-700">
                          {payout.paidOn ? formatDay(payout.paidOn) : "—"}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-900 font-medium">
                          {formatMinor(payout.amountMinor, payout.currency)}
                        </td>
                        <td className="px-4 py-3 font-mono text-[12px] text-gray-600">
                          {payout.reference ?? "—"}
                          <span className="block font-sans text-[11px] text-gray-400">
                            {`To account ending ${payout.accountLast4}`}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{formatDay(payout.cutoff)}</td>
                        <td className="px-4 py-3">
                          <PayoutStatus payout={payout} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <PayoutAction
                            payout={payout}
                            onFinish={() => finish(payout)}
                            onReturned={() => setReturning(payout)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="md:hidden mb-6 bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
                {data.payouts.map((payout) => (
                  <li key={payout.id} className="px-4 py-3 text-[13px]">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-gray-900 font-semibold whitespace-nowrap">
                        {formatMinor(payout.amountMinor, payout.currency)}
                      </p>
                      <PayoutStatus payout={payout} />
                    </div>
                    <p className="mt-1 text-[12px] text-gray-600">
                      {`${payout.paidOn ? `Paid ${formatDay(payout.paidOn)}` : `Started ${formatDay(payout.startedAt)}`} · stays by ${formatDay(payout.cutoff)} · account ${payout.accountLast4}`}
                    </p>
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <p className="font-mono text-[11px] text-gray-500 truncate">
                        {payout.reference ?? "—"}
                      </p>
                      <PayoutAction
                        payout={payout}
                        onFinish={() => finish(payout)}
                        onReturned={() => setReturning(payout)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h2 className="text-[15px] font-semibold text-gray-900 mb-2">Lines</h2>
          {data.entries.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-6 text-center text-[13px] text-gray-500">
              No lines yet.
            </div>
          ) : (
            <>
              <div className="hidden md:block bg-white border border-gray-200 rounded-xl overflow-hidden">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50/80">
                      <th className={`${th} text-left`}>Date</th>
                      <th className={`${th} text-left`}>What</th>
                      <th className={`${th} text-left`}>Booking</th>
                      <th className={`${th} text-left`}>Check-out</th>
                      <th className={`${th} text-right`}>Amount</th>
                      <th className={`${th} text-right`}>Fees</th>
                      <th className={`${th} text-right`}>Hotel gets</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.entries.map((entry) => (
                      <tr key={entry.id}>
                        <td className="px-4 py-3 text-gray-600">{formatDay(entry.occurredAt)}</td>
                        <td className="px-4 py-3 text-gray-900">
                          {ENTRY_LABELS[entry.kind] ?? entry.kind}
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-gray-600">
                          {entry.bookingReference ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {entry.checkOut ? formatDay(entry.checkOut) : "—"}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-700">
                          {formatMinor(entry.grossMinor, entry.currency)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-500">
                          {formatMinor(entry.feeMinor, entry.currency)}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-medium ${
                            isNegative(entry.netMinor) ? "text-red-600" : "text-gray-900"
                          }`}
                        >
                          {formatMinor(entry.netMinor, entry.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="md:hidden bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
                {data.entries.map((entry) => (
                  <li key={entry.id} className="px-4 py-3 text-[13px]">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-gray-900">{ENTRY_LABELS[entry.kind] ?? entry.kind}</p>
                        <p className="text-[11px] text-gray-500">
                          {[
                            formatDay(entry.occurredAt),
                            entry.bookingReference,
                            entry.checkOut ? `check-out ${formatDay(entry.checkOut)}` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <p
                        className={`shrink-0 font-medium whitespace-nowrap ${
                          isNegative(entry.netMinor) ? "text-red-600" : "text-gray-900"
                        }`}
                      >
                        {formatMinor(entry.netMinor, entry.currency)}
                      </p>
                    </div>
                    <p className="mt-0.5 text-[11px] text-gray-400">
                      {`Amount ${formatMinor(entry.grossMinor, entry.currency)} · fees ${formatMinor(entry.feeMinor, entry.currency)}`}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}

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
          <ReturnPayoutModal
            propertyId={data.propertyId}
            payout={returning}
            onClose={() => setReturning(null)}
            onReturned={() => {
              setReturning(null);
              load();
            }}
          />
        </>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  note,
  tone = "normal",
}: {
  label: string;
  value: string;
  note: string;
  tone?: "normal" | "strong" | "red";
}) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p
        className={`mt-1 text-lg font-bold ${
          tone === "red" ? "text-red-600" : tone === "strong" ? "text-gray-900" : "text-gray-700"
        }`}
      >
        {value}
      </p>
      <p className="text-[11px] text-gray-400">{note}</p>
    </div>
  );
}

function PayoutStatus({ payout }: { payout: Payout }) {
  const badge = (label: string, tone: string) => (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${tone}`}>
      {label}
    </span>
  );
  if (payout.returnedAt && !payout.sentAt)
    return (
      <span title={payout.returnReason ?? undefined}>
        {badge("Cancelled", "bg-gray-100 text-gray-600")}
      </span>
    );
  if (payout.returnedAt)
    return (
      <span title={payout.returnReason ?? undefined}>
        {badge("Returned", "bg-red-100 text-red-700")}
        <span className="block text-[11px] text-gray-500 mt-0.5">{payout.returnReason}</span>
      </span>
    );
  if (!payout.sentAt) return badge("Being sent", "bg-amber-100 text-amber-800");
  return badge("Paid", "bg-emerald-100 text-emerald-700");
}

function PayoutAction({
  payout,
  onFinish,
  onReturned,
}: {
  payout: Payout;
  onFinish: () => void;
  onReturned: () => void;
}) {
  if (payout.returnedAt) return null;
  return (
    <button
      type="button"
      onClick={payout.sentAt ? onReturned : onFinish}
      className="shrink-0 text-[12px] font-medium text-gray-500 hover:text-gray-900"
    >
      {payout.sentAt ? "Mark returned" : "Finish payout"}
    </button>
  );
}
