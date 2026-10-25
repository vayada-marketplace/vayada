"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { trapFocus } from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";

/** Linked inventory in a drawer over Rooms & Rates (VAY-2338). Escape, the backdrop and × close it; the focus moves
 * in, and back to the ☰ button when it closes. */
export default function LinkedInventoryDrawer({
  onClose,
  returnFocus,
  children,
}: {
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
    const button = returnFocus.current;
    return () => button?.focus();
  }, [returnFocus]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-gray-900/40" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="linked-inventory-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          // A confirmation opened in the drawer handles its own keys.
          if ((event.target as HTMLElement).closest('[role="dialog"]') !== panel.current) return;
          trapFocus(event, panel.current, onClose);
        }}
        className="relative flex h-[100dvh] w-full flex-col bg-white shadow-2xl focus:outline-none sm:w-[440px]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-4 py-5 sm:px-6">
          <div>
            <h2 id="linked-inventory-title" className="text-xl font-bold text-gray-900">
              {t("rooms.linkedInventory")}
            </h2>
            <p className="mt-1.5 text-sm text-gray-500">{t("rooms.linkedInventoryDescription")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5 sm:px-6">
          {children}
        </div>
      </div>
    </div>
  );
}
