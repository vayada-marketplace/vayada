"use client";

import { Fragment, useRef, useState, type MutableRefObject } from "react";
import type { CheckinSettings } from "@/services/settings";
import { forAdditionalGuests } from "@/lib/settings/checkinSettings";
import type { RegistrationGuest } from "@/lib/checkin/registration";
import type { CheckinRoom, RoomOption } from "@/lib/checkin/rooms";
import { countLabel, guestDisplayName, stayRangeLabel } from "@/lib/checkin/labels";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";
import { localizedErrorText } from "@/lib/i18n/localizedErrorText";
import { GuestForm, statusTone, type GuestFormValues, type GuestLockableField } from "./GuestForm";
import { RoomPicker } from "./RoomPicker";

type RoomGroups = Array<{ roomTypeId: string; roomTypeName: string; options: RoomOption[] }>;

/** Step 2: who sleeps where, room changes, and each guest's details (VAY-2373). */
export function RoomsGuestsStep({
  rooms,
  guests,
  placement,
  settings,
  canReadIdentity,
  movedFrom,
  formInitial,
  lockedFields,
  onSaveGuest,
  guestFlush,
  onGuestUnsaved,
  loadRoomOptions,
  onMoveRoom,
}: {
  rooms: CheckinRoom[];
  guests: RegistrationGuest[];
  placement: Map<string, RegistrationGuest[]>;
  settings: CheckinSettings;
  canReadIdentity: boolean;
  /** Room key → the unit it was booked as, for rooms moved during this check-in. */
  movedFrom: Record<string, string>;
  formInitial: (guest: RegistrationGuest) => GuestFormValues;
  lockedFields: (guest: RegistrationGuest) => ReadonlySet<GuestLockableField>;
  /** Saves what changed since `saved`; `listed` gets a new guest's id as soon as it is listed. */
  onSaveGuest: (
    guest: RegistrationGuest,
    values: GuestFormValues,
    saved: GuestFormValues,
    guestId: string | null,
    listed: (id: string) => void,
  ) => Promise<void>;
  /** The open guest form's save (VAY-2418). */
  guestFlush: MutableRefObject<(() => Promise<boolean>) | null>;
  onGuestUnsaved: (unsaved: boolean) => void;
  loadRoomOptions: (room: CheckinRoom) => Promise<RoomGroups>;
  onMoveRoom: (room: CheckinRoom, option: RoomOption) => Promise<void>;
}) {
  const { locale, t } = useTranslation();
  // The open guest's card keeps the room it was opened under, and a key of its own, until Done
  // (VAY-2418): a save that lists the guest or moves their room doesn't rebuild the form being
  // typed in, and each opening builds a new one.
  const [openGuest, setOpenGuest] = useState<{
    key: string;
    room: string;
    opening: number;
  } | null>(null);
  const openings = useRef(0);
  const [pickerRoom, setPickerRoom] = useState<string | null>(null);
  const [pickerGroups, setPickerGroups] = useState<RoomGroups | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  // Only the latest picker's calendar read may fill it: rooms can have different dates.
  const pickerRequest = useRef(0);

  const unitLabel = (room: CheckinRoom) =>
    room.unit
      ? t("dashboard.popup.roomNumber", { number: room.unit })
      : t("dashboard.popup.noRoom");
  const number = (guest: RegistrationGuest) => guests.indexOf(guest) + 1;
  const name = (guest: RegistrationGuest) => guestDisplayName(guest, number(guest), t);
  // Email and phone are required of the lead guest only (VAY-2420, Settings › Guest data).
  const othersSettings = forAdditionalGuests(settings);
  const settingsFor = (guest: RegistrationGuest) =>
    guest.role === "booker" ? settings : othersSettings;
  const requiredCount = (guest: RegistrationGuest) =>
    2 + settingsFor(guest).guestFields.filter((entry) => entry.show && entry.required).length;
  /** "Details missing · 4 required fields", "… 2 required fields left", "Registered". */
  const statusText = (guest: RegistrationGuest) => {
    const status = t(`checkIn.flow.status.${guest.status}`);
    if (guest.status === "registered") return status;
    const count = guest.missing.length;
    const left = count < requiredCount(guest) ? "Left" : "";
    return `${status} · ${t(`checkIn.flow.guests.required${left}${count === 1 ? "One" : "Many"}`, { count })}`;
  };
  const shown = new Map(placement);
  if (openGuest)
    for (const [roomKey, list] of Array.from(placement)) {
      const moved = list.find((guest) => guest.key === openGuest.key);
      if (!moved || roomKey === openGuest.room || !shown.has(openGuest.room)) continue;
      shown.set(
        roomKey,
        list.filter((guest) => guest !== moved),
      );
      shown.set(openGuest.room, [...shown.get(openGuest.room)!, moved]);
    }
  /** The open guest form saves before it closes; it stays open when it can't. */
  const closeGuest = async (then: () => void) => {
    if (guestFlush.current && !(await guestFlush.current())) return;
    then();
  };
  const saveGuest =
    (guest: RegistrationGuest) =>
    (
      values: GuestFormValues,
      saved: GuestFormValues,
      guestId: string | null,
      listed: (id: string) => void,
    ) =>
      onSaveGuest(guest, values, saved, guestId, (id) => {
        listed(id);
        // A guest just listed keeps the open card, under their new id.
        setOpenGuest((open) => (open?.key === guest.key ? { ...open, key: id } : open));
      });

  const openPicker = (room: CheckinRoom) => {
    setPickerRoom(room.key);
    setPickerGroups(null);
    setPickerError(null);
    const request = ++pickerRequest.current;
    loadRoomOptions(room)
      .then((groups) => {
        if (request === pickerRequest.current) setPickerGroups(groups);
      })
      .catch((err) => {
        if (request === pickerRequest.current)
          setPickerError(localizedErrorText(err, t("checkIn.flow.picker.loadError"), t));
      });
  };
  const move = async (room: CheckinRoom, option: RoomOption) => {
    setMoving(true);
    setPickerError(null);
    try {
      await onMoveRoom(room, option);
      setPickerRoom(null);
    } catch (err) {
      setPickerError(localizedErrorText(err, t("checkIn.flow.picker.moveError"), t));
    } finally {
      setMoving(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h3 className="text-lg font-bold text-gray-900">{t("checkIn.flow.rooms.heading")}</h3>
        {rooms.map((room) => {
          const sleeping = (placement.get(room.key) ?? []).map(name);
          const open = pickerRoom === room.key;
          return (
            <Fragment key={room.key}>
              <div
                className={`flex flex-col gap-3 rounded-2xl bg-white px-4 py-4 md:flex-row md:items-center md:gap-6 md:px-5 ${
                  open ? "shadow-[inset_0_0_0_2px] shadow-primary-600" : "border border-gray-200"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="text-lg font-bold text-gray-900">{unitLabel(room)}</span>
                    {room.departsEarlier && (
                      <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                        {t("checkIn.flow.rooms.departsEarlier")}
                      </span>
                    )}
                    {movedFrom[room.key] && (
                      <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-700">
                        {t("checkIn.flow.rooms.bookedAs", {
                          room: t("dashboard.popup.roomNumber", { number: movedFrom[room.key]! }),
                        })}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[15px] text-gray-600">
                    {[
                      room.type,
                      new Intl.ListFormat(locale, { type: "conjunction" }).format(sleeping),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <dl className="hidden gap-8 md:flex">
                  <div>
                    <dt className="text-sm text-gray-600">{t("checkIn.flow.rooms.dates")}</dt>
                    <dd className="font-bold text-gray-900">
                      {stayRangeLabel(locale, room.checkIn, room.checkOut)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-gray-600">{t("checkIn.flow.rooms.nights")}</dt>
                    <dd className="font-bold text-gray-900">{room.nights}</dd>
                  </div>
                </dl>
                <div className="flex items-center justify-between gap-3 md:contents">
                  <p className="text-[15px] font-bold text-gray-900 md:hidden">
                    {stayRangeLabel(locale, room.checkIn, room.checkOut)} ·{" "}
                    {countLabel(t, "nights", room.nights)}
                  </p>
                  {settings.allowRoomChanges &&
                    room.unit &&
                    (room.assignmentId || rooms.length === 1) && (
                      <button
                        type="button"
                        onClick={() =>
                          open
                            ? setPickerRoom(null)
                            : void closeGuest(() => {
                                setOpenGuest(null);
                                openPicker(room);
                              })
                        }
                        aria-expanded={open}
                        className="text-[15px] font-semibold text-primary-700 md:rounded-xl md:border md:border-gray-300 md:px-4 md:py-2.5 md:text-gray-800 md:hover:bg-gray-50"
                      >
                        {t("checkIn.flow.rooms.change")}
                        <span className="sr-only"> {unitLabel(room)}</span>
                      </button>
                    )}
                </div>
              </div>
              {open && (
                <RoomPicker
                  title={t("checkIn.flow.picker.title", {
                    room: unitLabel(room),
                    dates: stayRangeLabel(locale, room.checkIn, room.checkOut),
                  })}
                  rateNote={
                    room.nightlyRate != null && room.currency
                      ? t("checkIn.flow.picker.rateNoteAmount", {
                          amount: formatCurrency(room.nightlyRate, room.currency),
                        })
                      : t("checkIn.flow.picker.rateNote")
                  }
                  groups={pickerGroups}
                  loading={!pickerGroups && !pickerError}
                  error={pickerError}
                  moving={moving}
                  onMove={(option) => void move(room, option)}
                  onCancel={() => setPickerRoom(null)}
                />
              )}
            </Fragment>
          );
        })}
      </section>

      <section className="flex flex-col gap-3 border-t border-gray-200 pt-8">
        <h3 className="text-lg font-bold text-gray-900">{t("checkIn.flow.guests.title")}</h3>
        {rooms.map((room) => {
          const sleeping = shown.get(room.key) ?? [];
          if (!sleeping.length) return null;
          return (
            <div key={room.key} className="flex flex-col gap-2.5">
              <h4 className="mt-2 text-xs font-bold uppercase tracking-wider text-gray-500">
                {unitLabel(room)} · {stayRangeLabel(locale, room.checkIn, room.checkOut)}
              </h4>
              {sleeping.map((guest) => {
                const open = openGuest?.key === guest.key;
                const named = Boolean(`${guest.firstName}${guest.lastName}`.trim());
                return (
                  <div
                    key={open ? `open-${openGuest?.opening}` : guest.key}
                    className="overflow-hidden rounded-2xl border border-gray-200 bg-white"
                  >
                    <div className="flex items-center gap-3.5 px-4 py-3.5">
                      <span
                        aria-hidden="true"
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                          named
                            ? "bg-primary-50 text-primary-800"
                            : "border-2 border-dashed border-gray-300 text-gray-600"
                        }`}
                      >
                        {named
                          ? `${guest.firstName[0] ?? ""}${guest.lastName[0] ?? ""}`.toUpperCase()
                          : number(guest)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-bold text-gray-900">
                          {name(guest)}
                        </p>
                        <p className={`text-sm font-semibold ${statusTone[guest.status]}`}>
                          {statusText(guest)}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() =>
                          void closeGuest(() => {
                            setPickerRoom(null);
                            setOpenGuest(
                              open
                                ? null
                                : { key: guest.key, room: room.key, opening: ++openings.current },
                            );
                          })
                        }
                        className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-semibold ${
                          guest.status === "registered" || open
                            ? "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
                            : "bg-primary-50 text-primary-800 hover:bg-primary-100"
                        }`}
                      >
                        {open
                          ? t("checkIn.flow.guests.done")
                          : guest.status === "registered"
                            ? t("checkIn.flow.guests.edit")
                            : t("checkIn.flow.guests.addDetails")}
                        <span className="sr-only"> {name(guest)}</span>
                      </button>
                    </div>
                    {open && (
                      <GuestForm
                        title={name(guest)}
                        initial={formInitial(guest)}
                        guestId={guest.guestId}
                        requireNames={guest.role !== "booker"}
                        settings={settingsFor(guest)}
                        rooms={rooms}
                        lockedFields={lockedFields(guest)}
                        canReadIdentity={canReadIdentity}
                        savedFilledFields={guest.registration?.filledFields ?? []}
                        onSave={saveGuest(guest)}
                        flush={guestFlush}
                        onUnsaved={onGuestUnsaved}
                        onDone={() => void closeGuest(() => setOpenGuest(null))}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </section>
    </div>
  );
}
