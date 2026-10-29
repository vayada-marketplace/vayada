"use client";

import { useEffect, useRef, useState } from "react";

export type ToastMessage = {
  id: number;
  message: string;
  /** One action, such as Undo (VAY-2393); it closes the toast. */
  action?: { label: string; onClick: () => void };
  /** Move focus to the action (the guest used the keyboard), so it can be reached in time. */
  focusAction?: boolean;
  /** How long it stays, in ms. */
  duration?: number;
};

/** A short confirmation at the bottom of the screen (VAY-2393), read out by screen readers: the
 * live region stays on the page (without a status role while it is empty) so each new message is
 * announced. It closes itself, but never while it is hovered or focused; a new toast (another
 * id) starts its own time. */
export default function Toast({
  toast,
  onClose,
}: {
  toast: ToastMessage | null;
  onClose: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const action = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!toast || paused) return;
    const timer = setTimeout(onClose, toast.duration ?? 4000);
    return () => clearTimeout(timer);
    // Only a new toast, or the guest leaving it, restarts the time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.id, paused]);
  useEffect(() => {
    setPaused(false);
    if (toast?.focusAction) action.current?.focus({ preventScroll: true });
  }, [toast?.id, toast?.focusAction]);
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      // Above the privacy settings pill and the floating Map button on a phone, and over any
      // open dialog.
      className="pointer-events-none fixed inset-x-4 bottom-[calc(7.5rem+var(--fixed-bottom-bar,0px))] z-[110] flex justify-center lg:bottom-8"
    >
      {toast && (
        <div
          role="status"
          data-testid="toast"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
          className="pointer-events-auto flex min-h-[48px] max-w-md items-center gap-4 rounded-xl bg-gray-900 py-2 pl-5 pr-2 text-sm font-medium text-white shadow-lg"
        >
          <p className="py-1.5">{toast.message}</p>
          {toast.action && (
            <button
              ref={action}
              type="button"
              onClick={() => {
                toast.action!.onClick();
                onClose();
              }}
              className="min-h-[36px] shrink-0 rounded-full bg-white px-4 font-bold text-gray-900 hover:bg-gray-100"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
