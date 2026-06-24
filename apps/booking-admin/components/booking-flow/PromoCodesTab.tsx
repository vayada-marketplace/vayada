"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { PlusIcon, PencilSquareIcon, TicketIcon, TrashIcon } from "@heroicons/react/24/outline";
import type { PromoCodeItem } from "@/services/settings";

export interface PromoCodeFormValues {
  code: string;
  discountType: "percentage" | "fixed";
  discountValue: string;
  currency: string;
  validFrom: string;
  validUntil: string;
  maxUses: string;
  isActive: boolean;
}

interface PromoCodesTabProps {
  promoCodes: PromoCodeItem[];
  propertyCurrency: string;
  onCreatePromoCode: (values: PromoCodeFormValues) => Promise<void>;
  onUpdatePromoCode: (promoCodeId: string, values: PromoCodeFormValues) => Promise<void>;
  onDeletePromoCode: (promoCodeId: string) => Promise<void>;
}

function emptyDraft(currency: string): PromoCodeFormValues {
  return {
    code: "",
    discountType: "percentage",
    discountValue: "",
    currency,
    validFrom: "",
    validUntil: "",
    maxUses: "",
    isActive: true,
  };
}

function toDraft(promo: PromoCodeItem, fallbackCurrency: string): PromoCodeFormValues {
  return {
    code: promo.code,
    discountType: promo.discountType,
    discountValue: String(promo.discountValue),
    currency: promo.currency || fallbackCurrency,
    validFrom: promo.validFrom ?? "",
    validUntil: promo.validUntil ?? "",
    maxUses: promo.maxUses == null ? "" : String(promo.maxUses),
    isActive: promo.isActive,
  };
}

export default function PromoCodesTab({
  promoCodes,
  propertyCurrency,
  onCreatePromoCode,
  onUpdatePromoCode,
  onDeletePromoCode,
}: PromoCodesTabProps) {
  const [draft, setDraft] = useState<PromoCodeFormValues>(() => emptyDraft(propertyCurrency));
  const [editingPromo, setEditingPromo] = useState<PromoCodeItem | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [savingPromo, setSavingPromo] = useState(false);
  const [deletingPromoId, setDeletingPromoId] = useState<string | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  const openCreateEditor = () => {
    lastFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingPromo(null);
    setDraft(emptyDraft(propertyCurrency));
    setPromoError(null);
    setIsEditorOpen(true);
  };

  const openEditEditor = (promo: PromoCodeItem) => {
    lastFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingPromo(promo);
    setDraft(toDraft(promo, propertyCurrency));
    setPromoError(null);
    setIsEditorOpen(true);
  };

  const closeEditor = useCallback(() => {
    if (savingPromo) return;
    setIsEditorOpen(false);
    setEditingPromo(null);
    setPromoError(null);
    lastFocusRef.current?.focus();
  }, [savingPromo]);

  useEffect(() => {
    if (!isEditorOpen) return;
    const dialog = dialogRef.current;
    const firstInput = dialog?.querySelector<HTMLElement>("input, select, textarea");
    const firstButton = dialog?.querySelector<HTMLElement>("button");
    (firstInput ?? firstButton)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled") && element.tabIndex !== -1);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeEditor, isEditorOpen]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = draft.code.trim().toUpperCase();
    const discountValue = Number(draft.discountValue);
    const currency = draft.currency.trim().toUpperCase();
    const maxUses = draft.maxUses.trim();

    if (!code) {
      setPromoError("Code is required.");
      return;
    }
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      setPromoError("Discount value must be greater than zero.");
      return;
    }
    if (draft.discountType === "percentage" && discountValue > 100) {
      setPromoError("Percentage discounts cannot exceed 100.");
      return;
    }
    if (draft.discountType === "fixed" && !currency) {
      setPromoError("Currency is required for fixed discounts.");
      return;
    }
    if (draft.validFrom && draft.validUntil && draft.validUntil < draft.validFrom) {
      setPromoError("Valid until must be on or after valid from.");
      return;
    }
    if (maxUses && (!Number.isInteger(Number(maxUses)) || Number(maxUses) <= 0)) {
      setPromoError("Max uses must be a whole number greater than zero.");
      return;
    }

    const normalized: PromoCodeFormValues = {
      ...draft,
      code,
      discountValue: discountValue.toFixed(2),
      currency,
      validFrom: draft.validFrom.trim(),
      validUntil: draft.validUntil.trim(),
      maxUses,
    };

    setSavingPromo(true);
    setPromoError(null);
    try {
      if (editingPromo) {
        await onUpdatePromoCode(editingPromo.id, normalized);
      } else {
        await onCreatePromoCode(normalized);
      }
      setIsEditorOpen(false);
      setEditingPromo(null);
      setPromoError(null);
      lastFocusRef.current?.focus();
    } catch (error) {
      setPromoError(error instanceof Error ? error.message : "Failed to save promo code.");
    } finally {
      setSavingPromo(false);
    }
  };

  const handleDelete = async (promo: PromoCodeItem) => {
    if (!window.confirm(`Delete ${promo.code}?`)) return;
    setDeletingPromoId(promo.id);
    setPromoError(null);
    try {
      await onDeletePromoCode(promo.id);
    } catch (error) {
      setPromoError(error instanceof Error ? error.message : "Failed to delete promo code.");
    } finally {
      setDeletingPromoId(null);
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[14px] font-semibold text-gray-900">Promo Codes</h2>
            <p className="text-[12px] text-gray-500 mt-0.5">
              Create discount codes guests can apply during booking
            </p>
          </div>
          <button
            onClick={openCreateEditor}
            className="inline-flex items-center gap-1 px-3 py-1.5 bg-gray-900 text-white text-[12px] font-medium rounded-lg hover:bg-gray-800"
          >
            <PlusIcon className="w-3.5 h-3.5" />
            Add Promo Code
          </button>
        </div>

        {promoError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
            {promoError}
          </div>
        )}

        {promoCodes.length === 0 ? (
          <div className="bg-gray-50 rounded-lg border border-dashed border-gray-300 p-6 text-center">
            <div className="w-10 h-10 bg-gray-200 rounded-full mx-auto flex items-center justify-center mb-2">
              <TicketIcon className="w-5 h-5 text-gray-400" />
            </div>
            <p className="text-[13px] font-medium text-gray-600">No promo codes yet</p>
            <p className="text-[12px] text-gray-400 mt-0.5">
              Create your first promo code to offer discounts to guests
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {promoCodes.map((promo) => (
              <div
                key={promo.id}
                className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
              >
                <div className="shrink-0">
                  <span className="inline-flex items-center px-2.5 py-1 rounded-md bg-gray-100 text-[12px] font-mono font-semibold text-gray-800 tracking-wide">
                    {promo.code}
                  </span>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                        promo.discountType === "percentage"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-green-100 text-green-700"
                      }`}
                    >
                      {promo.discountType === "percentage"
                        ? `${promo.discountValue}% off`
                        : `${promo.discountValue} ${promo.currency || propertyCurrency} off`}
                    </span>
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                        promo.isActive
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {promo.isActive ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    {(promo.validFrom || promo.validUntil) && (
                      <span className="text-[11px] text-gray-400">
                        {promo.validFrom && promo.validUntil
                          ? `${promo.validFrom} - ${promo.validUntil}`
                          : promo.validFrom
                            ? `From ${promo.validFrom}`
                            : `Until ${promo.validUntil}`}
                      </span>
                    )}
                    {promo.maxUses != null && (
                      <span className="text-[11px] text-gray-400">
                        {promo.useCount}/{promo.maxUses} uses
                      </span>
                    )}
                    {promo.maxUses == null && promo.useCount > 0 && (
                      <span className="text-[11px] text-gray-400">{promo.useCount} uses</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => openEditEditor(promo)}
                    aria-label={`Edit ${promo.code}`}
                    className="p-1.5 text-gray-500 hover:text-gray-900 rounded-md hover:bg-gray-100"
                  >
                    <PencilSquareIcon className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(promo)}
                    disabled={deletingPromoId === promo.id}
                    aria-label={`Delete ${promo.code}`}
                    className="p-1.5 text-gray-500 hover:text-red-600 rounded-md hover:bg-red-50 disabled:opacity-50"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {isEditorOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          role="presentation"
        >
          <form
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={editingPromo ? "Edit promo" : "Create promo"}
            onSubmit={handleSubmit}
            className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl space-y-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-[15px] font-semibold text-gray-900">
                  {editingPromo ? "Edit Promo Code" : "Create Promo Code"}
                </h3>
              </div>
              <button
                type="button"
                onClick={closeEditor}
                className="text-[12px] font-medium text-gray-500 hover:text-gray-900"
              >
                Cancel
              </button>
            </div>

            {promoError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                {promoError}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[12px] font-medium text-gray-700">
                Code
                <input
                  value={draft.code}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, code: event.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] uppercase text-gray-900 outline-none focus:border-gray-900"
                  placeholder="SUMMER20"
                />
              </label>
              <label className="text-[12px] font-medium text-gray-700">
                Discount Type
                <select
                  value={draft.discountType}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      discountType: event.target.value as PromoCodeFormValues["discountType"],
                    }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-gray-900"
                >
                  <option value="percentage">Percentage</option>
                  <option value="fixed">Fixed</option>
                </select>
              </label>
              <label className="text-[12px] font-medium text-gray-700">
                Discount Value
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={draft.discountValue}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, discountValue: event.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-gray-900"
                />
              </label>
              <label className="text-[12px] font-medium text-gray-700">
                Currency
                <input
                  value={draft.currency}
                  maxLength={3}
                  disabled={draft.discountType === "percentage"}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, currency: event.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] uppercase text-gray-900 outline-none focus:border-gray-900 disabled:bg-gray-50 disabled:text-gray-400"
                />
              </label>
              <label className="text-[12px] font-medium text-gray-700">
                Valid From
                <input
                  type="date"
                  value={draft.validFrom}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, validFrom: event.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-gray-900"
                />
              </label>
              <label className="text-[12px] font-medium text-gray-700">
                Valid Until
                <input
                  type="date"
                  value={draft.validUntil}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, validUntil: event.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-gray-900"
                />
              </label>
              <label className="text-[12px] font-medium text-gray-700">
                Max Uses
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={draft.maxUses}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, maxUses: event.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-gray-900"
                />
              </label>
              <label className="flex items-center gap-2 self-end rounded-md border border-gray-200 px-3 py-2 text-[12px] text-gray-700">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, isActive: event.target.checked }))
                  }
                />
                Active
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeEditor}
                className="px-3 py-2 text-[12px] font-medium text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingPromo}
                className="rounded-lg bg-gray-900 px-3 py-2 text-[12px] font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {savingPromo ? "Saving..." : editingPromo ? "Save Changes" : "Create Promo Code"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
