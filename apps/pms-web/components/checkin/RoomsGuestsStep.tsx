"use client";

import { Fragment, useState } from "react";
import type { CheckinSettings } from "@/services/settings";
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
  onSaveGuest: (guest: RegistrationGuest, values: GuestFormValues) => Promise<void>;
  loadRoomOptions: (room: CheckinRoom) => Promise<RoomGroups>;
  onMoveRoom: (room: CheckinRoom, option: RoomOption) => Promise<void>;
}) {
  const { locale, t } = useTranslation();
  const [openGuest, setOpenGuest] = useState<string | null>(null);
  const [savingGuest, setSavingGuest] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);
  const [pickerRoom, setPickerRoom] = useState<string | null>(null);
  const [pickerGroups, setPickerGroups] = useState<RoomGroups | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const unitLabel = (room: CheckinRoom) =>
    room.unit
      ? t("dashboard.popup.roomNumber", { number: room.unit })
      : t("dashboard.popup.noRoom");
  const number = (guest: RegistrationGuest) => guests.indexOf(guest) + 1;
  const name = (guest: RegistrationGuest) => guestDisplayName(guest, number(guest), t);

  const openPicker = (room: CheckinRoom) => {
    setOpenGuest(null);
    setPickerRoom(room.key);
    setPickerGroups(null);
    setPickerError(null);
    loadRoomOptions(room)
      .then(setPickerGroups)
      .catch((err) =>
        setPickerError(localizedErrorText(err, t("checkIn.flow.picker.loadError"), t)),
      );
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
  const save = async (guest: RegistrationGuest, values: GuestFormValues) => {
    // The booker's name comes from the booking; everyone else needs both names to be listed.
    if (guest.role !== "booker" && (!values.firstName.trim() || !values.lastName.trim())) {
      setGuestError(t("checkIn.flow.form.namesRequired"));
      return;
    }
    setSavingGuest(true);
    setGuestError(null);
    try {
      await onSaveGuest(guest, values);
      setOpenGuest(null);
    } catch (err) {
      setGuestError(localizedErrorText(err, t("checkIn.flow.form.saveError"), t));
    } finally {
      setSavingGuest(false);
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
                        onClick={() => (open ? setPickerRoom(null) : openPicker(room))}
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
          const sleeping = placement.get(room.key) ?? [];
          if (!sleeping.length) return null;
          return (
            <div key={room.key} className="flex flex-col gap-2.5">
              <h4 className="mt-2 text-xs font-bold uppercase tracking-wider text-gray-500">
                {unitLabel(room)} · {stayRangeLabel(locale, room.checkIn, room.checkOut)}
              </h4>
              {sleeping.map((guest) => {
                const open = openGuest === guest.key;
                const named = Boolean(`${guest.firstName}${guest.lastName}`.trim());
                return (
                  <div
                    key={guest.key}
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
                          {t(`checkIn.flow.status.${guest.status}`)}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => {
                          setGuestError(null);
                          setPickerRoom(null);
                          setOpenGuest(open ? null : guest.key);
                        }}
                        className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-semibold ${
                          guest.status === "registered" || open
                            ? "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
                            : "bg-primary-50 text-primary-800 hover:bg-primary-100"
                        }`}
                      >
                        {open
                          ? t("common.close")
                          : guest.status === "registered"
                            ? t("checkIn.flow.guests.view")
                            : t("checkIn.flow.guests.complete")}
                        <span className="sr-only"> {name(guest)}</span>
                      </button>
                    </div>
                    {open && (
                      <GuestForm
                        title={name(guest)}
                        initial={formInitial(guest)}
                        settings={settings}
                        rooms={rooms}
                        lockedFields={lockedFields(guest)}
                        canReadIdentity={canReadIdentity}
                        saving={savingGuest}
                        error={guestError}
                        onSave={(values) => void save(guest, values)}
                        onCancel={() => setOpenGuest(null)}
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
