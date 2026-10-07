"use client";

import type { FinanceExpenseCategory } from "@vayada/domain-finance";
import { useState, type MutableRefObject } from "react";

import Modal from "@/components/Modal";
import { ApiErrorResponse } from "@/services/api/client";
import {
  archiveExpenseCategory,
  createExpenseCategory,
  updateExpenseCategory,
} from "@/services/finance/financialExpenses";

const input =
  "h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100";

export function ExpenseCategoriesDialog({
  propertyId,
  categories,
  attempt,
  onClose,
  onConflict,
  onChanged,
}: {
  propertyId: string;
  categories: FinanceExpenseCategory[];
  attempt: MutableRefObject<{ fingerprint: string; id: string } | undefined>;
  onClose: () => void;
  onConflict: () => void;
  onChanged: () => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState("#1D4ED8");
  const [sortOrder, setSortOrder] = useState(
    String(Math.max(0, ...categories.map((item) => item.sortOrder)) + 1),
  );
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const selected = categories.find((item) => item.id === selectedId);

  const choose = (id: string) => {
    const category = categories.find((item) => item.id === id);
    setSelectedId(id);
    setName(category?.name ?? "");
    setColor(category?.color ?? "#1D4ED8");
    setSortOrder(
      String(category?.sortOrder ?? Math.max(0, ...categories.map((item) => item.sortOrder)) + 1),
    );
    setConfirmArchive(false);
    setError("");
  };
  const save = async (archive = false) => {
    if (
      !archive &&
      (!name.trim() ||
        name.trim().length > 120 ||
        !Number.isSafeInteger(Number(sortOrder)) ||
        Number(sortOrder) < 0)
    ) {
      setError("Enter a category name and a non-negative whole-number order.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const fields = { name: name.trim(), color, sortOrder: Number(sortOrder) };
      const fingerprint = JSON.stringify({
        categoryId: selected?.id,
        revision: selected?.revision,
        archive,
        fields,
      });
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, id: crypto.randomUUID() };
      if (archive && selected)
        await archiveExpenseCategory(propertyId, selected, attempt.current.id);
      else if (selected)
        await updateExpenseCategory(propertyId, selected, fields, attempt.current.id);
      else await createExpenseCategory(propertyId, fields, attempt.current.id);
      attempt.current = undefined;
      onChanged();
    } catch (cause) {
      if (
        cause instanceof ApiErrorResponse &&
        ["revision_conflict", "already_archived"].includes(cause.data.code ?? "")
      ) {
        attempt.current = undefined;
        onConflict();
        return;
      }
      setError(categoryError(cause));
      setConfirmArchive(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      maxWidth="lg"
      ariaLabel="Manage expense categories"
      footer={
        <div className="flex flex-wrap justify-between gap-2">
          {selected && !selected.archived ? (
            confirmArchive ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-red-800">Archive this category?</span>
                <button
                  type="button"
                  className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-800"
                  disabled={saving}
                  onClick={() => void save(true)}
                >
                  Confirm
                </button>
                <button type="button" className="text-sm" onClick={() => setConfirmArchive(false)}>
                  Keep
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="text-sm text-red-700"
                onClick={() => setConfirmArchive(true)}
              >
                Archive category
              </button>
            )
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="expense-category-form"
              disabled={saving || selected?.archived}
              className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : selected ? "Save changes" : "Create category"}
            </button>
          </div>
        </div>
      }
    >
      <h2 className="text-lg font-semibold text-gray-900">Expense categories</h2>
      <p className="mt-1 text-sm text-gray-600">
        Create a category, edit its display, or archive one no longer in use.
      </p>
      <form
        id="expense-category-form"
        className="mt-5 grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Category
          <select
            className={input}
            value={selectedId}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">New category</option>
            {categories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.archived ? " (archived)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Name
          <input
            className={input}
            required
            maxLength={120}
            disabled={selected?.archived}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1 text-sm font-medium text-gray-700">
            Color
            <input
              className={`${input} p-1`}
              type="color"
              disabled={selected?.archived}
              value={color}
              onChange={(event) => setColor(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-gray-700">
            Order
            <input
              className={input}
              type="number"
              min="0"
              step="1"
              disabled={selected?.archived}
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </label>
        </div>
        {selected?.archived && (
          <p className="text-sm text-gray-600">
            Archived categories remain visible in historical expenses but cannot be edited.
          </p>
        )}
        {error && (
          <p className="text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function categoryError(error: unknown) {
  if (error instanceof ApiErrorResponse) {
    if (error.status === 403) return "You do not have permission to manage categories.";
    if (error.data.code === "active_recurring_rule")
      return "This category has an active recurring expense. Stop the recurrence before archiving it.";
    if (error.data.code === "revision_conflict")
      return "This category changed elsewhere. Close and reopen to refresh it.";
    if (error.data.code === "already_archived")
      return "This category was already archived. Close and reopen to refresh it.";
    if (error.status === 409)
      return "The category could not be saved because of a conflict. Refresh and try again.";
  }
  return "Category could not be saved. Check the fields and try again.";
}
