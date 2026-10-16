"use client";
import { useTranslation } from "@/lib/i18n";

import { useEffect, useRef, type ComponentType, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { Button, FeedbackAlert } from "@/components/ui";

/**
 * The create/edit window shared by promo codes and promotions (VAY-2233): icon header, scrolling
 * body, error above the footer, and the Active switch on the left of Cancel and Save.
 * It traps focus, closes on Escape or a backdrop click, and gives focus back when it unmounts.
 */
export function EditorModal({
  idPrefix,
  title,
  description,
  icon: Icon,
  initialFocusId,
  busy,
  error,
  active,
  activeDescription,
  onActiveChange,
  closeLabel,
  submitLabel,
  onClose,
  onSubmit,
  noValidate,
  children,
}: {
  idPrefix: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  initialFocusId: string;
  busy: boolean;
  error: string | null;
  active: boolean;
  activeDescription: string;
  onActiveChange: () => void;
  closeLabel: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** Skip the browser's own validation bubbles when the caller validates and shows the error. */
  noValidate?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>(`#${initialFocusId}`)?.focus();
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, input, select, summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
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
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [initialFocusId]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/45 p-0 sm:p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${idPrefix}-title`}
        aria-describedby={`${idPrefix}-description${error ? ` ${idPrefix}-error` : ""}`}
        onSubmit={onSubmit}
        noValidate={noValidate}
        className="flex h-[100dvh] w-full max-w-[920px] flex-col overflow-hidden bg-white shadow-2xl sm:h-auto sm:max-h-[92dvh] sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-gray-200 px-5 py-5 sm:px-7">
          <div className="flex min-w-0 items-start gap-3.5">
            <span className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 sm:flex">
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <h2 id={`${idPrefix}-title`} className="text-xl font-semibold text-gray-950">
                {title}
              </h2>
              <p id={`${idPrefix}-description`} className="mt-1 max-w-2xl text-sm text-gray-600">
                {description}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={closeLabel}
            className="-mr-2 shrink-0 rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50/70 px-4 py-5 sm:px-7 sm:py-6">
          {children}
        </div>

        {error && (
          <div id={`${idPrefix}-error`} role="alert" className="shrink-0 px-5 pt-4 sm:px-7">
            <FeedbackAlert type="error" message={error} />
          </div>
        )}
        <div className="flex shrink-0 flex-col gap-3 border-t border-gray-200 bg-white px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <div className="flex items-center gap-3">
            <button
              id={`${idPrefix}-active`}
              type="button"
              role="switch"
              aria-checked={active}
              aria-labelledby={`${idPrefix}-active-label`}
              aria-describedby={`${idPrefix}-active-help`}
              disabled={busy}
              onClick={onActiveChange}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${active ? "bg-primary-600" : "bg-gray-300"}`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${active ? "translate-x-5" : "translate-x-0"}`}
              />
            </button>
            <label htmlFor={`${idPrefix}-active`} className="min-w-0 cursor-pointer">
              <span
                id={`${idPrefix}-active-label`}
                className="block text-sm font-medium text-gray-900"
              >
                {t("promos.status.Active")}
              </span>
              <span id={`${idPrefix}-active-help`} className="block text-xs text-gray-600">
                {activeDescription}
              </span>
            </label>
          </div>
          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={onClose}
              disabled={busy}
              className="h-11"
            >
              {t("settings.totp.cancel")}
            </Button>
            <Button type="submit" size="lg" disabled={busy} className="h-11 flex-1 sm:flex-none">
              {submitLabel}
            </Button>
          </div>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** Card title inside the editor body: tinted icon and a small heading. */
export function EditorSectionHeading({
  id,
  icon: Icon,
  children,
}: {
  id: string;
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-gray-100 pb-4">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50 text-primary-700">
        <Icon className="h-4 w-4" />
      </span>
      <h3 id={id} className="text-sm font-semibold text-gray-950">
        {children}
      </h3>
    </div>
  );
}
