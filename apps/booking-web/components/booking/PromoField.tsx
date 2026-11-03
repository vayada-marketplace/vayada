"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";

function PromoPopover({
  open,
  onClose,
  value,
  onChange,
  onApply,
  loading,
  error,
}: {
  open: boolean;
  onClose: () => void;
  value: string;
  onChange: (v: string) => void;
  onApply: () => void;
  loading: boolean;
  error: string;
}) {
  const t = useTranslations("home");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-2 bg-white rounded-xl shadow-xl border border-gray-100 p-4 z-50 w-64"
    >
      <p className="text-sm font-semibold text-gray-900 mb-2.5">{t("promoTitle")}</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          placeholder={t("enterCode")}
          className="flex-1 min-w-0 px-3 py-1.5 rounded-full border border-gray-300 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
        />
        <button
          onClick={onApply}
          disabled={loading || !value.trim()}
          className="px-4 py-1.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-xs disabled:opacity-50"
        >
          {loading ? "..." : t("apply")}
        </button>
      </div>
      {error && <p className="text-[11px] text-red-500 mt-1.5">{error}</p>}
    </div>
  );
}

/**
 * The search card's promo field: "Add promo code" with its popover, or the applied code as a chip
 * with a remove button. What a code does is the page's (`onApply`, `onRemove`). Shared by a
 * hotel's page and an agency's (VAY-2459).
 */
export default function PromoField({
  applied,
  onRemove,
  open,
  onOpen,
  onClose,
  value,
  onChange,
  onApply,
  loading,
  error,
}: {
  /** The applied code and what it takes off (" (-10%)"), or none. */
  applied: { code: string; discount: string } | null;
  onRemove: () => void;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  value: string;
  onChange: (value: string) => void;
  onApply: () => void;
  loading: boolean;
  error: string;
}) {
  const t = useTranslations("home");
  return (
    <div className="relative flex justify-center md:justify-start w-full md:w-auto">
      {applied ? (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary-50 text-primary-700 rounded-full text-xs font-semibold">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            {applied.code}
            {applied.discount}
          </span>
          <button
            onClick={onRemove}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      ) : (
        <>
          <button
            onClick={() => (open ? onClose() : onOpen())}
            className="flex items-center gap-2 text-gray-500 hover:text-primary-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
              />
            </svg>
            <span className="text-sm font-medium">{t("addPromo")}</span>
          </button>
          {open && (
            <PromoPopover
              open={open}
              onClose={onClose}
              value={value}
              onChange={onChange}
              onApply={onApply}
              loading={loading}
              error={error}
            />
          )}
        </>
      )}
    </div>
  );
}
