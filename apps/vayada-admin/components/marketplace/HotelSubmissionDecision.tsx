"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "@/components/ui/Modal";
import {
  HOTEL_NOTE_MAX_LENGTH,
  createDecisionKey,
  decisionErrorMessage,
  hotelNoteError,
  hotelSubmissionsService,
  marketplaceProfileUrl,
  readApiError,
  type HotelSubmissionReview,
} from "@/services/api/hotelSubmissions";

export type HotelSubmissionDecided =
  | { kind: "approved"; hotelName: string; publicUrl: string | null }
  | { kind: "changes_requested"; hotelName: string };

type Props = {
  review: HotelSubmissionReview;
  hotelName: string;
  onDecided: (decided: HotelSubmissionDecided) => void;
  /** The queue is out of date (decided elsewhere, superseded or gone). */
  onStale: () => void;
  /** True while a decision request is in flight, so the review dialog can stay open. */
  onBusyChange?: (busy: boolean) => void;
};

/** "Approve and publish" or "Request changes" for one pending submission. */
export function HotelSubmissionDecision({
  review,
  hotelName,
  onDecided,
  onStale,
  onBusyChange,
}: Props) {
  const [busy, setBusy] = useState<"approve" | "request_changes" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  // A retry after a lost response reuses its key, so the server replays instead of deciding twice.
  const keys = useRef<{ approve?: string; request_changes?: string }>({});

  if (review.status !== "pending")
    return (
      <p className="border-t border-gray-200 pt-4 text-sm text-gray-600">
        This submission has already been decided.
      </p>
    );

  async function decide(decision: "approve" | "request_changes") {
    if (busy) return;
    const trimmed = note.trim();
    if (decision === "request_changes") {
      const invalid = hotelNoteError(note);
      setNoteError(invalid);
      if (invalid) return;
    }
    const key = (keys.current[decision] ??= createDecisionKey(review.revisionId, decision));
    setBusy(decision);
    onBusyChange?.(true);
    setError(null);
    try {
      const result = await hotelSubmissionsService.decide(
        review.revisionId,
        decision === "approve" ? { decision } : { decision, note: trimmed },
        key,
      );
      setRequesting(false);
      onDecided(
        result.status === "approved"
          ? {
              kind: "approved",
              hotelName,
              publicUrl: result.publicPath ? marketplaceProfileUrl(result.publicPath) : null,
            }
          : { kind: "changes_requested", hotelName },
      );
    } catch (cause) {
      const failure = decisionErrorMessage(cause);
      // Only a definite 4xx answer retires the key; a lost response or a 5xx may have committed.
      const status = readApiError(cause).status;
      if (status !== undefined && status < 500) delete keys.current[decision];
      setError(failure.message);
      if (failure.refresh) onStale();
    } finally {
      setBusy(null);
      onBusyChange?.(false);
    }
  }

  return (
    <>
      {error && !requesting && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-3 border-t border-gray-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-gray-500 sm:max-w-[250px]">
          {review.preview
            ? "Approving makes this version public right away. The hotel sees “Live” in setup."
            : "This version can’t be published until its public preview can be shown."}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!!busy || requesting}
            onClick={() => {
              setError(null);
              setNoteError(null);
              setRequesting(true);
            }}
            className="rounded-lg border-2 border-red-300 px-4 py-2 text-base font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Request changes
          </button>
          <button
            type="button"
            disabled={!!busy || requesting || !review.preview}
            onClick={() => void decide("approve")}
            className="rounded-lg bg-primary-600 px-4 py-2.5 text-base font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {busy === "approve" ? "Publishing…" : "Approve and publish"}
          </button>
        </div>
      </div>
      {/* Portalled: the review dialog's panel is transformed, which would trap a fixed overlay. */}
      {requesting &&
        createPortal(
          <Modal
            isOpen={requesting}
            onClose={() => {
              if (!busy) setRequesting(false);
            }}
            title="Request changes"
            size="sm"
          >
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void decide("request_changes");
              }}
            >
              <p className="text-sm text-gray-600">
                {hotelName} can edit the profile and submit it again.
              </p>
              <label
                htmlFor="hotel-review-note"
                className="block pt-2 text-sm font-semibold text-gray-700"
              >
                Note to the hotel <span className="text-red-500">*</span>
              </label>
              <textarea
                id="hotel-review-note"
                rows={4}
                value={note}
                autoFocus
                readOnly={!!busy}
                maxLength={HOTEL_NOTE_MAX_LENGTH}
                aria-invalid={!!noteError}
                aria-describedby="hotel-review-note-help"
                onChange={(event) => {
                  setNote(event.target.value);
                  setNoteError(null);
                  delete keys.current.request_changes;
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-base text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p id="hotel-review-note-help" className="text-sm text-gray-500">
                The hotel sees this note in setup. It is also kept in the audit log.
              </p>
              <p className="text-right text-xs text-gray-500">
                {note.trim().length.toLocaleString("en-US")}/1,000
              </p>
              {(noteError ?? error) && (
                <p role="alert" className="text-sm text-red-700">
                  {noteError ?? error}
                </p>
              )}
              <div className="flex justify-end gap-3 border-t border-gray-200 pt-4">
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => setRequesting(false)}
                  className="rounded-lg border-2 border-gray-300 px-4 py-2 text-base font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!!busy}
                  className="rounded-lg bg-red-600 px-4 py-2.5 text-base font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {busy === "request_changes" ? "Sending…" : "Send to hotel"}
                </button>
              </div>
            </form>
          </Modal>,
          document.body,
        )}
    </>
  );
}
