"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslation } from "@/lib/i18n";
import { useHasPmsPermission } from "@/lib/settings/PmsAccessContext";
import { formatGuestDate, localToday } from "@/lib/guests/guestDisplay";
import { guestsService, type GuestNote } from "@/services/guests";

type NotesUpdate = (notes: GuestNote[]) => GuestNote[];

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
  compact = false,
}: {
  guestProfileId: string;
  firstName: string;
  notes: GuestNote[];
  /** Applied to the latest list, so a save landing in between isn't lost. */
  onNotesChange: (update: NotesUpdate) => void;
  /** The property a note was written at, when this user may open it. */
  propertyName?: (propertyId: string) => string | null;
  /** On a reservation: a link to the guest's profile. */
  profileHref?: string;
  /** The reservation page's card style instead of the profile's. */
  compact?: boolean;
}) {
  const { locale, t } = useTranslation();
  const canWrite = useHasPmsPermission("pms.operations.manage");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const confirmButton = useRef<HTMLButtonElement>(null);
  // Focus follows the confirmation: onto it when it opens, back to the note's Delete when cancelled.
  const [returnFocusTo, setReturnFocusTo] = useState<string | null>(null);

  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (!returnFocusTo) return;
    deleteButtons.current.get(returnFocusTo)?.focus();
    setReturnFocusTo(null);
  }, [returnFocusTo]);

  const run = async (work: () => Promise<void>, failure: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch {
      setError(t(failure));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const add = () =>
    run(async () => {
      const body = draft.trim();
      if (!body) return;
      const note = await guestsService.addNote(guestProfileId, body);
      onNotesChange((current) => [note, ...current]);
      setDraft("");
    }, "guests.noteAddFailed");

  const remove = (noteId: string) =>
    run(async () => {
      try {
        await guestsService.deleteNote(guestProfileId, noteId);
      } catch (err) {
        // Already gone (deleted elsewhere, or merged away): the list catches up.
        if ((err as { status?: number })?.status !== 404) throw err;
      }
      onNotesChange((current) => current.filter((note) => note.noteId !== noteId));
      setConfirming(null);
      heading.current?.focus();
    }, "guests.noteDeleteFailed");

  const cancel = (noteId: string) => {
    setConfirming(null);
    setReturnFocusTo(noteId);
  };

  return (
    <section
      className={
        compact
          ? "bg-white border border-gray-200 rounded-xl p-5 sm:p-6"
          : "bg-white border border-[#E4E7EC] rounded-2xl px-6 py-5"
      }
      aria-labelledby={`guest-notes-${guestProfileId}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          ref={heading}
          tabIndex={-1}
          id={`guest-notes-${guestProfileId}`}
          className={
            compact
              ? "text-sm font-semibold text-gray-900 outline-none"
              : "text-[17px] font-semibold text-[#101828] outline-none"
          }
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
          {t(canWrite ? "guests.notesEmpty" : "guests.notesEmptyReadOnly", { name: firstName })}
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
                    {[formatGuestDate(localToday(new Date(note.createdAt)), locale), property]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {canWrite &&
                    (confirming === note.noteId ? (
                      <span
                        className="flex items-center gap-3"
                        onKeyDown={(event) => event.key === "Escape" && cancel(note.noteId)}
                      >
                        <span role="status">{t("guests.noteDeleteConfirm")}</span>
                        <button
                          ref={confirmButton}
                          type="button"
                          disabled={busy}
                          onClick={() => remove(note.noteId)}
                          className="min-h-[24px] px-1 font-semibold text-red-600 hover:underline"
                        >
                          {t("guests.noteDelete")}
                        </button>
                        <button
                          type="button"
                          onClick={() => cancel(note.noteId)}
                          className="min-h-[24px] px-1 font-semibold text-[#344054] hover:underline"
                        >
                          {t("common.cancel")}
                        </button>
                      </span>
                    ) : (
                      <button
                        ref={(element) => {
                          if (element) deleteButtons.current.set(note.noteId, element);
                          else deleteButtons.current.delete(note.noteId);
                        }}
                        type="button"
                        onClick={() => setConfirming(note.noteId)}
                        className="min-h-[24px] px-1 font-semibold text-[#344054] hover:underline"
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
