"use client";

import { useEffect, useId, useState } from "react";
import {
  aiBudgetsService,
  budgetField,
  budgetInput,
  formatUsd,
  problemOf,
  type AiAccountBudget,
} from "@/services/api/aiBudgets";

type Choice = "own" | "default";

/** VAY-2504: staff set a hotel account's own monthly AI budget, or put it back on the default.
 * Every change needs a reason; the server keeps it with the staff member's name in the audit log. */
export function AiBudgetDialog({
  account,
  defaultMonthlyLimitMicroUsd,
  onClose,
  onSaved,
}: {
  account: AiAccountBudget;
  defaultMonthlyLimitMicroUsd: number;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const titleId = useId();
  const [choice, setChoice] = useState<Choice>("own");
  const [amount, setAmount] = useState(() => budgetField(account));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const dollars = budgetInput(amount);
  const amountInvalid = choice === "own" && amount.trim() !== "" && dollars === null;
  const ready = reason.trim() !== "" && (choice === "default" || dollars !== null);
  const defaultLabel = `${formatUsd(defaultMonthlyLimitMicroUsd)} a month today${
    defaultMonthlyLimitMicroUsd === 0 ? ", so no AI for this hotel" : ""
  }`;

  const save = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await aiBudgetsService.setBudget(account.organizationId, {
        monthlyLimitUsd: choice === "own" ? dollars : null,
        reason: reason.trim(),
      });
      onSaved(
        saved.custom
          ? `${saved.name}: AI budget is now ${formatUsd(saved.monthlyLimitMicroUsd)} a month.`
          : `${saved.name} is back on the default AI budget (${formatUsd(saved.monthlyLimitMicroUsd)} a month).`,
      );
    } catch (failure) {
      const problem = problemOf(failure);
      setError(
        problem.status === 403
          ? "Changing AI budgets needs vayada admin access."
          : problem.code === "hotel_account_not_found"
            ? "This is no longer a hotel account. Close this and reload the page."
            : problem.code === "invalid_ai_budget"
              ? "Enter a reason, and dollars and cents up to $100,000."
              : problem.message,
      );
      setSaving(false);
    }
  };

  const used =
    account.calls === 0 && account.usedMicroUsd === 0
      ? "No AI use this month."
      : `Used ${formatUsd(account.usedMicroUsd)} of ${formatUsd(account.monthlyLimitMicroUsd)} this month, in ${account.calls.toLocaleString("en-US")} AI ${account.calls === 1 ? "call" : "calls"}.`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-xl bg-white shadow-xl"
      >
        <div className="border-b border-gray-200 px-6 py-5">
          <h2 id={titleId} className="text-lg font-semibold text-gray-900">
            {`AI budget for ${account.name}`}
          </h2>
          <p className="mt-1 text-sm text-gray-500">{used}</p>
        </div>

        <form
          className="space-y-4 px-6 py-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label
            className={`flex gap-3 rounded-[10px] px-4 py-3.5 cursor-pointer ${
              choice === "own" ? "border-[1.5px] border-gray-900" : "border border-gray-200"
            }`}
          >
            <input
              type="radio"
              name="ai-budget-choice"
              checked={choice === "own"}
              onChange={() => setChoice("own")}
              className="mt-0.5 h-4 w-4 shrink-0 accent-gray-900"
            />
            <span className="flex-1 space-y-2.5">
              <span className="block text-sm font-semibold text-gray-900">Own budget</span>
              <span className="flex items-center gap-2.5">
                <span className="flex h-[38px] w-[140px] items-center gap-1.5 rounded-lg border border-gray-300 px-3 focus-within:border-gray-900">
                  <span className="text-sm text-gray-500">$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoFocus
                    aria-label="Monthly budget in dollars"
                    aria-invalid={amountInvalid}
                    value={amount}
                    placeholder="0.00"
                    onFocus={() => setChoice("own")}
                    onChange={(event) => {
                      setChoice("own");
                      setAmount(event.target.value);
                    }}
                    className="w-full min-w-0 bg-transparent text-sm text-gray-900 outline-none"
                  />
                </span>
                <span className="text-sm text-gray-600">a month</span>
              </span>
              <span
                className={`block text-[12px] ${amountInvalid ? "text-red-600" : "text-gray-500"}`}
              >
                {amountInvalid
                  ? "Enter dollars and cents up to $100,000, e.g. 25 or 12.50."
                  : "Dollars and cents, up to $100,000. $0 turns AI off for this hotel."}
              </span>
            </span>
          </label>

          <label
            className={`flex gap-3 rounded-[10px] px-4 py-3.5 cursor-pointer ${
              choice === "default" ? "border-[1.5px] border-gray-900" : "border border-gray-200"
            }`}
          >
            <input
              type="radio"
              name="ai-budget-choice"
              checked={choice === "default"}
              onChange={() => setChoice("default")}
              className="mt-0.5 h-4 w-4 shrink-0 accent-gray-900"
            />
            <span className="flex-1 space-y-1">
              <span className="block text-sm font-semibold text-gray-900">Use the default</span>
              <span className="block text-[12px] text-gray-500">{defaultLabel}</span>
            </span>
          </label>

          <label className="block space-y-1.5">
            <span className="block text-sm font-medium text-gray-700">Reason</span>
            <textarea
              required
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900"
            />
            <span className="block text-[12px] text-gray-500">
              Required. Saved with your name in the audit log; the hotel doesn&apos;t see it.
            </span>
          </label>

          <p className="rounded-lg bg-gray-50 px-3 py-2.5 text-[12px] text-gray-600">
            Takes effect at once, also for the rest of this month. What was already used stays
            counted.
          </p>

          {error && (
            <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
              {error}
            </p>
          )}
        </form>

        <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!ready || saving}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save budget"}
          </button>
        </div>
      </div>
    </div>
  );
}
