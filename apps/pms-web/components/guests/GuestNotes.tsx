"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslation } from "@/lib/i18n";
import { useHasPmsPermission } from "@/lib/settings/PmsAccessContext";
import { formatGuestDate } from "@/lib/guests/guestDisplay";
import { guestsService, type GuestNote } from "@/services/guests";

/**
 * VAY-2420: staff-only notes on a guest record, kept across all of the guest's stays, so the profile
 * and every reservation of the guest show the same list (Timo's mockup, "Guest notes").
 */
export function GuestNotes({
  guestProfileId,
  firstName,
  notes,
  onNotesChange,
  propertyName,
  profileHref,
  className = "",
}: {
  guestProfileId: string;
  firstName: string;
  notes: GuestNote[];
  onNotesChange: (notes: GuestNote[]) => void;
  /** The property a note was written at, when this user may open it. */
  propertyName?: (propertyId: string) => string | null;
  /** On a reservation: a link to the guest's profile. */
  profileHref?: string;
  className?: string;
}) {
  const { locale, t } = useTranslation();
  const canWrite = useHasPmsPermission("pms.operations.manage");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  const add = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError("");
    try {
      const note = await guestsService.addNote(guestProfileId, body);
      onNotesChange([note, ...notes]);
      setDraft("");
    } catch {
      setError(t("guests.noteAddFailed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (noteId: string) => {
    setBusy(true);
    setError("");
    try {
      await guestsService.deleteNote(guestProfileId, noteId);
      onNotesChange(notes.filter((note) => note.noteId !== noteId));
      setConfirming(null);
    } catch {
      setError(t("guests.noteDeleteFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={`bg-white border border-[#E4E7EC] rounded-2xl px-6 py-5 ${className}`}
      aria-labelledby={`guest-notes-${guestProfileId}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id={`guest-notes-${guestProfileId}`}
          className="text-[17px] font-semibold text-[#101828]"
        >
          {t("guests.notesTitle")}
        </h2>
        <span className="flex flex-wrap items-baseline gap-x-3 text-[13px] text-[#5B6474]">
          {t("guests.notesHelper")}
          {profileHref && (
            <Link href={profileHref} className="font-semibold text-[#2D3FD3] hover:text-[#1F2DA3]">
              {t("guests.openProfile")}
            </Link>
          )}
        </span>
      </div>
      {canWrite && (
        <>
          <label className="mt-3.5 flex flex-col">
            <span className="sr-only">{t("guests.newNote")}</span>
            <textarea
              rows={3}
              maxLength={2000}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("guests.notePlaceholder")}
              className="resize-y rounded-[10px] border border-[#D0D5DD] bg-white px-3.5 py-3 text-sm text-[#101828] outline-none focus:border-[#2D3FD3]"
            />
          </label>
          <div className="mt-2.5 flex justify-end">
            <button
              type="button"
              onClick={add}
              disabled={busy || !draft.trim()}
              className="h-10 px-4 rounded-[10px] bg-[#2D3FD3] text-sm font-semibold text-white hover:bg-[#1F2DA3] disabled:opacity-50"
            >
              {t("guests.addNote")}
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {notes.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-[#D0D5DD] p-5 text-center text-sm text-[#5B6474]">
          {t("guests.notesEmpty", { name: firstName })}
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2.5">
          {notes.map((note) => {
            const property = propertyName?.(note.propertyId);
            return (
              <li key={note.noteId} className="rounded-xl bg-[#F9FAFB] px-4 py-3">
                <p className="text-sm text-[#101828] whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {note.body}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#5B6474]">
                  <span>
                    {[formatGuestDate(note.createdAt.slice(0, 10), locale), property]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {canWrite &&
                    (confirming === note.noteId ? (
                      <span className="flex items-center gap-2">
                        {t("guests.noteDeleteConfirm")}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => remove(note.noteId)}
                          className="font-semibold text-red-600 hover:underline"
                        >
                          {t("guests.noteDelete")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirming(null)}
                          className="font-semibold text-[#344054] hover:underline"
                        >
                          {t("common.cancel")}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirming(note.noteId)}
                        className="font-semibold text-[#344054] hover:underline"
                        aria-label={t("guests.noteDeleteLabel")}
                      >
                        {t("guests.noteDelete")}
                      </button>
                    ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
