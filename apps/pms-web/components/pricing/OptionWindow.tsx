"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import * as ui from "./pricingStyles";

/** A booking option's "Edit" window. It stays mounted while closed (hidden), so its editors keep an unapplied entry
 * and the Save guard that entry holds. While such an entry is open (`closable` false) it cannot be closed. */
export function OptionWindow({
  open,
  title,
  closable,
  onClose,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  closable: boolean;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  const close = () => {
    if (closable) onClose();
  };
  return (
    // The wrapper carries `hidden`: Tailwind's display utilities would override it on the overlay itself.
    <div hidden={!open}>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/40" onClick={close} />
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
          className="relative flex h-[100dvh] w-full flex-col bg-white shadow-xl sm:mx-4 sm:h-auto sm:max-h-[90dvh] sm:max-w-2xl sm:rounded-xl"
        >
          <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-6 py-4">
            <h2 className={ui.stepTitle}>{title}</h2>
            <button
              type="button"
              aria-label={t("pricing.steps.option.close")}
              disabled={!closable}
              onClick={close}
              className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-40"
            >
              <XMarkIcon aria-hidden="true" className="h-5 w-5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-5">{children}</div>
          <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 px-6 py-4">
            {footer}
            {!closable && <p className={ui.help}>{t("pricing.steps.option.applyFirst")}</p>}
            <button
              type="button"
              disabled={!closable}
              onClick={close}
              className={`ml-auto ${ui.primaryButton}`}
            >
              {t("pricing.steps.option.done")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
