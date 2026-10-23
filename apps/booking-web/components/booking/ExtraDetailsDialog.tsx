"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

/** VAY-2231: an extra's details, a popup from md up and a bottom sheet below. The native dialog
 * keeps focus inside and closes on Escape; a click on the backdrop closes it too. */
export default function ExtraDetailsDialog({
  closeLabel,
  onClose,
  children,
}: {
  closeLabel: string;
  onClose: () => void;
  children: (dialog: { titleId: string; closeButton: ReactNode; close: () => void }) => ReactNode;
}) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, [dialog]);
  // Escape ends in onClose through the dialog's close event; the buttons call it directly too.
  const close = () => {
    dialog?.close?.();
    onClose();
  };
  return (
    <dialog
      ref={setDialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-[680px] overflow-hidden rounded-[20px] bg-white p-0 shadow-2xl backdrop:bg-gray-900/55 open:flex open:flex-col max-md:mb-0 max-md:max-h-[92dvh] max-md:w-full max-md:max-w-none max-md:rounded-b-none"
    >
      {children({
        titleId,
        close,
        closeButton: (
          <button
            type="button"
            aria-label={closeLabel}
            onClick={close}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-gray-700 shadow hover:text-gray-900"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeWidth={2.25} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        ),
      })}
    </dialog>
  );
}
