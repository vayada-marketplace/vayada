"use client";

import {
  normalizeFinanceExpenseAmount,
  type FinanceExpenseCategory,
  type FinanceExpenseWrite,
  type FinanceExpenseCadence,
} from "@vayada/domain-finance";
import { useState, type MutableRefObject } from "react";

import Modal from "@/components/Modal";
import { ApiErrorResponse } from "@/services/api/client";
import { createExpense } from "@/services/finance/financialExpenses";

const input =
  "h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100";
const label = "grid gap-1 text-sm font-medium text-gray-700";

export function ExpenseEntryDialog({
  propertyId,
  currency,
  today,
  categories,
  attempt,
  onClose,
  onSaved,
}: {
  propertyId: string;
  currency: string;
  today: string;
  categories: FinanceExpenseCategory[];
  attempt: MutableRefObject<{ fingerprint: string; id: string } | undefined>;
  onClose: () => void;
  onSaved: (recurring: boolean) => void;
}) {
  const [incurredOn, setIncurredOn] = useState(today);
  const [vendor, setVendor] = useState("");
  const [categoryId, setCategoryId] = useState(categories.find((item) => !item.archived)?.id ?? "");
  const [amount, setAmount] = useState("");
  const [paymentStatus, setPaymentStatus] = useState<"paid" | "unpaid">("unpaid");
  const [paidOn, setPaidOn] = useState(today);
  const [notes, setNotes] = useState("");
  const [cadence, setCadence] = useState<FinanceExpenseCadence | "">("");
  const [endsOn, setEndsOn] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const normalizedAmount = normalizeFinanceExpenseAmount(amount.trim());
    if (!incurredOn || !vendor.trim() || !categoryId || !normalizedAmount) {
      setError("Enter a date, vendor, active category, and positive amount.");
      return;
    }
    if (paymentStatus === "paid" && !cadence && !paidOn) {
      setError("Enter the payment date for a paid expense.");
      return;
    }
    if (endsOn && (!cadence || endsOn < incurredOn)) {
      setError("The recurrence end date must be on or after the expense date.");
      return;
    }
    const fields: Omit<FinanceExpenseWrite, "commandId" | "idempotencyKey"> = {
      incurredOn,
      vendor: vendor.trim(),
      categoryId,
      amount: { amount: normalizedAmount, currency },
      ...(paymentStatus === "paid"
        ? { paymentStatus, paidOn: cadence ? incurredOn : paidOn }
        : { paymentStatus, paidOn: null }),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(cadence
        ? { recurrence: { cadence, startsOn: incurredOn, ...(endsOn ? { endsOn } : {}) } }
        : {}),
    };
    setError("");
    setSaving(true);
    try {
      const fingerprint = JSON.stringify(fields);
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, id: crypto.randomUUID() };
      await createExpense(propertyId, fields, attempt.current.id);
      attempt.current = undefined;
      onSaved(Boolean(cadence));
    } catch (cause) {
      setError(writeError(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      maxWidth="lg"
      ariaLabel="Log expense"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="log-expense-form"
            disabled={saving || !categories.some((item) => !item.archived)}
            className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : cadence ? "Save recurring expense" : "Log expense"}
          </button>
        </div>
      }
    >
      <h2 className="text-lg font-semibold text-gray-900">Log expense</h2>
      <p className="mt-1 text-sm text-gray-600">
        Record a manual cost or set a recurring schedule.
      </p>
      <form
        id="log-expense-form"
        className="mt-5 grid gap-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className={label}>
          Expense date
          <input
            className={input}
            type="date"
            required
            value={incurredOn}
            onChange={(event) => setIncurredOn(event.target.value)}
          />
        </label>
        <label className={label}>
          Vendor
          <input
            className={input}
            required
            maxLength={200}
            value={vendor}
            onChange={(event) => setVendor(event.target.value)}
          />
        </label>
        <label className={label}>
          Category
          <select
            className={input}
            required
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            <option value="">Choose category</option>
            {categories
              .filter((item) => !item.archived)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
        <label className={label}>
          Amount ({currency})
          <input
            className={input}
            required
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className={label}>
          Paid state
          <select
            className={input}
            value={paymentStatus}
            onChange={(event) => setPaymentStatus(event.target.value as "paid" | "unpaid")}
          >
            <option value="unpaid">Unpaid</option>
            <option value="paid">Paid</option>
          </select>
        </label>
        {paymentStatus === "paid" && !cadence && (
          <label className={label}>
            Paid on
            <input
              className={input}
              type="date"
              required
              value={paidOn}
              onChange={(event) => setPaidOn(event.target.value)}
            />
          </label>
        )}
        <label className={`${label} sm:col-span-2`}>
          Notes (optional)
          <textarea
            className={`${input} h-20 py-2`}
            maxLength={2000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <label className={label}>
          Repeat
          <select
            className={input}
            value={cadence}
            onChange={(event) => setCadence(event.target.value as FinanceExpenseCadence | "")}
          >
            <option value="">One-off</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </label>
        {cadence && (
          <p className="self-end text-xs text-gray-600">
            Paid recurring entries use each occurrence date as their payment date.
          </p>
        )}
        {cadence && (
          <label className={label}>
            Repeat until (optional)
            <input
              className={input}
              type="date"
              min={incurredOn}
              value={endsOn}
              onChange={(event) => setEndsOn(event.target.value)}
            />
          </label>
        )}
        {error && (
          <p className="text-sm text-red-700 sm:col-span-2" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function writeError(error: unknown) {
  if (error instanceof ApiErrorResponse) {
    if (error.status === 403) return "You do not have permission to manage expenses.";
    if (error.data.code === "currency_mismatch")
      return "The amount must use the property's currency. Refresh and try again.";
    if (error.data.code === "evidence_mismatch")
      return "The category or receipt does not match this property. Check it and try again.";
    if (error.data.code === "write_unavailable")
      return "Expense entry is temporarily unavailable for this property.";
    if (error.status === 409)
      return "This expense could not be saved because it conflicts with a recent change. Try again.";
  }
  return "Expense could not be saved. Check the fields and try again.";
}
