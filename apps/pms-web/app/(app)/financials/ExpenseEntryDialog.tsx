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
import { uploadFinanceExpenseReceipt } from "@/services/platform-media";

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
  attempt: MutableRefObject<
    { fingerprint: string; id: string; file: File | null; mediaId?: string } | undefined
  >;
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
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [entryType, setEntryType] = useState<"manual" | "supplier_bill">("manual");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
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
    if (entryType === "supplier_bill" && !supplierInvoiceNumber.trim()) {
      setError("Enter the supplier bill reference.");
      return;
    }
    if (endsOn && (!cadence || endsOn < incurredOn)) {
      setError("The recurrence end date must be on or after the expense date.");
      return;
    }
    if (receiptFile && !["image/jpeg", "image/png", "image/webp"].includes(receiptFile.type)) {
      setError("Choose a JPEG, PNG, or WebP receipt image.");
      return;
    }
    if (receiptFile && receiptFile.size > 20 * 1024 * 1024) {
      setError("Receipt images must be 20 MB or smaller.");
      return;
    }
    if (cadence && receiptFile) {
      setError("Receipts can be attached to one-off expenses only.");
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
      ...(entryType === "supplier_bill"
        ? { supplierInvoiceNumber: supplierInvoiceNumber.trim() }
        : {}),
      ...(cadence
        ? { recurrence: { cadence, startsOn: incurredOn, ...(endsOn ? { endsOn } : {}) } }
        : {}),
    };
    setError("");
    setSaving(true);
    let uploadingReceipt = false;
    try {
      const fingerprint = JSON.stringify([propertyId, fields]);
      if (attempt.current?.fingerprint !== fingerprint || attempt.current.file !== receiptFile)
        attempt.current = { fingerprint, id: crypto.randomUUID(), file: receiptFile };
      const write = attempt.current;
      if (receiptFile && !write.mediaId) {
        uploadingReceipt = true;
        write.mediaId = await uploadFinanceExpenseReceipt({
          propertyId,
          expenseId: write.id,
          file: receiptFile,
        });
        uploadingReceipt = false;
      }
      if (attempt.current !== write) return;
      await createExpense(
        propertyId,
        {
          ...fields,
          ...(write.mediaId ? { receiptMediaId: write.mediaId } : {}),
        },
        write.id,
      );
      attempt.current = undefined;
      onSaved(Boolean(cadence));
    } catch (cause) {
      setError(
        uploadingReceipt &&
          !(cause instanceof ApiErrorResponse && [401, 403].includes(cause.status))
          ? "Receipt upload failed. Check the image and try again."
          : writeError(cause),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={() => {
        if (!saving) onClose();
      }}
      maxWidth="lg"
      ariaLabel="Log expense"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
            disabled={saving}
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
            {saving
              ? "Saving…"
              : cadence
                ? "Save recurring expense"
                : entryType === "supplier_bill"
                  ? "Log supplier bill"
                  : "Log expense"}
          </button>
        </div>
      }
    >
      <h2 className="text-lg font-semibold text-gray-900">Log expense</h2>
      <p className="mt-1 text-sm text-gray-600">
        Record a manual cost, supplier bill, or recurring schedule.
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
          Entry type
          <select
            disabled={saving}
            className={input}
            value={entryType}
            onChange={(event) => {
              const next = event.target.value as "manual" | "supplier_bill";
              setEntryType(next);
              if (next === "supplier_bill") {
                setCadence("");
                setEndsOn("");
              } else {
                setSupplierInvoiceNumber("");
              }
            }}
          >
            <option value="manual">Manual expense</option>
            <option value="supplier_bill">Supplier bill</option>
          </select>
        </label>
        {entryType === "supplier_bill" && (
          <label className={label}>
            Supplier bill reference
            <input
              disabled={saving}
              className={input}
              required
              maxLength={200}
              value={supplierInvoiceNumber}
              onChange={(event) => setSupplierInvoiceNumber(event.target.value)}
            />
          </label>
        )}
        <label className={label}>
          Expense date
          <input
            disabled={saving}
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
            disabled={saving}
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
            disabled={saving}
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
            disabled={saving}
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
            disabled={saving}
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
              disabled={saving}
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
            disabled={saving}
            className={`${input} h-20 py-2`}
            maxLength={2000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        {!cadence && (
          <label className={`${label} sm:col-span-2`}>
            Receipt image (optional)
            <input
              disabled={saving}
              className={input}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => setReceiptFile(event.target.files?.[0] ?? null)}
              aria-describedby="receipt-help"
            />
            <span id="receipt-help" className="text-xs font-normal text-gray-500">
              JPEG, PNG, or WebP up to 20 MB.
            </span>
          </label>
        )}
        {entryType === "manual" && (
          <label className={label}>
            Repeat
            <select
              disabled={saving}
              className={input}
              value={cadence}
              onChange={(event) => {
                const nextCadence = event.target.value as FinanceExpenseCadence | "";
                if (nextCadence) setReceiptFile(null);
                setCadence(nextCadence);
              }}
            >
              <option value="">One-off</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </label>
        )}
        {cadence && (
          <p className="self-end text-xs text-gray-600">
            Paid recurring entries use each occurrence date as their payment date.
          </p>
        )}
        {cadence && (
          <label className={label}>
            Repeat until (optional)
            <input
              disabled={saving}
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
    if (error.status === 401) return "Your session expired. Sign in again to save this expense.";
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
