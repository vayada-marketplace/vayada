"use client";

import { CheckIcon, MoonIcon, PlusIcon, ShieldCheckIcon } from "@heroicons/react/24/outline";
import {
  useId,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
  type SVGProps,
} from "react";

import { QuickBedIcon } from "./QuickBedIcon";
import { QuickBookingPagePreview } from "./QuickBookingPagePreview";
import { QuickSetupField, QuickSetupFieldError } from "./QuickSetupField";
import { QuickSetupPreviewCard } from "./QuickSetupPreviewCard";
import { QuickSetupShell } from "./QuickSetupShell";
import { QuickSetupStepLayout } from "./QuickSetupStepLayout";
import {
  EMPTY_QUICK_ROOM_DRAFT,
  QUICK_BED_OPTIONS,
  QUICK_CANCELLATION_OPTIONS,
  QUICK_MAX_ROOM_TYPES,
  QUICK_NON_REFUNDABLE_NOTE,
  QUICK_TAXES_ERROR,
  quickBedTitle,
  quickCancellationTitle,
  quickPreviewRooms,
  quickRoomChoices,
  quickRoomErrors,
  quickRoomFirstNumbers,
  quickRoomLabelsHint,
  quickRoomsFirstError,
  type QuickRoomDraft,
  type QuickRoomErrors,
  type QuickRoomsDraft,
} from "./quickRoomDraft";

const FORM_ID = "quick-setup-first-room";

export type QuickRoomStepProps = {
  /** The hotel's room types and the taxes tick for all their prices. */
  draft: QuickRoomsDraft;
  onChange: (next: QuickRoomsDraft) => void;
  currency: { code: string; symbol: string };
  hotel: { name: string; place: string; url: string };
  onSubmit: (draft: QuickRoomsDraft) => Promise<void>;
  /** Back to "Your hotel" for this hotel; hidden when not passed. */
  onBack?: (() => void) | null;
  onSaveAndExit: () => void;
};

/** A default the first run uses, with Change opening its choices underneath (1.12b). */
function DefaultLine({
  icon: Icon,
  title,
  note,
  open,
  onToggle,
  tone = "gray",
  children,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  note: string;
  open: boolean;
  onToggle: () => void;
  tone?: "gray" | "green";
  children: ReactNode;
}) {
  const choicesId = useId();
  return (
    <div className="px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <Icon
          className={`h-[18px] w-[18px] shrink-0 ${tone === "green" ? "text-green-600" : "text-gray-500"}`}
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 text-sm font-medium text-gray-950">{title}</p>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={choicesId}
          className="rounded text-sm font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600"
        >
          {open ? "Done" : "Change"}
        </button>
      </div>
      {open ? (
        <div id={choicesId} className="mt-3 sm:pl-7">
          <p className="mb-2 text-[13px] leading-5 text-gray-500">{note}</p>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** One choice of a picker: a radio row, or a row that is shown but can't be picked yet, with why. */
function Choice({
  name,
  label,
  checked,
  onPick,
  unavailable,
}: {
  name: string;
  label: string;
  checked: boolean;
  onPick?: () => void;
  unavailable?: string;
}) {
  const noteId = useId();
  return (
    <label
      className={`flex items-start gap-3 rounded-lg border bg-white px-3 py-2.5 text-sm ${
        unavailable
          ? "cursor-not-allowed border-gray-200 text-gray-400"
          : checked
            ? "cursor-pointer border-primary-600 text-gray-950 ring-1 ring-primary-600"
            : "cursor-pointer border-gray-200 text-gray-800 hover:border-gray-300"
      }`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={Boolean(unavailable)}
        onChange={() => onPick?.()}
        aria-describedby={unavailable ? noteId : undefined}
        className="mt-0.5 h-4 w-4 accent-primary-600"
      />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        {unavailable ? (
          <span id={noteId} className="mt-0.5 block text-[13px] leading-5 text-gray-500">
            {unavailable}
          </span>
        ) : null}
      </span>
    </label>
  );
}

const isEmptyRoom = (room: QuickRoomDraft) =>
  !room.name.trim() && !room.numberOfRooms.trim() && !room.pricePerNight.trim();

/** A room type that isn't being edited: its name, rooms, guests and price, with Edit (a05-1). */
function QuickRoomLine({
  room,
  symbol,
  onEdit,
}: {
  room: QuickRoomDraft;
  symbol: string;
  onEdit: () => void;
}) {
  const rooms = Number(room.numberOfRooms) || 0;
  const guests = Number(room.maxGuests) || 0;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3.5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
        <QuickBedIcon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold text-gray-950">{room.name.trim()}</p>
        <p className="mt-0.5 text-[13px] text-gray-500">
          {`${rooms} room${rooms === 1 ? "" : "s"} · up to ${guests} guest${guests === 1 ? "" : "s"} · ${symbol}${room.pricePerNight.trim()} / night`}
        </p>
      </div>
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${room.name.trim()}`}
        className="rounded text-sm font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600"
      >
        Edit
      </button>
    </div>
  );
}

/**
 * VAY-2247 step 3, "Your first room and price" (Paper rev 4 a05): the room types with their rooms,
 * guests and price, one at a time (the others show as a line with Edit), the taxes confirmation the
 * prices need, and the defaults the first run uses for them. Up to ten room types.
 */
export function QuickRoomStep({
  draft,
  onChange,
  currency,
  hotel,
  onSubmit,
  onBack,
  onSaveAndExit,
}: QuickRoomStepProps) {
  const [errors, setErrors] = useState<QuickRoomErrors & { taxes?: string }>({});
  // The cancellation and bed choices for all room types (1.12b); one picker open at a time.
  const [picker, setPicker] = useState<"cancellation" | "bed" | null>(null);
  const choices = quickRoomChoices(draft);
  const toggle = (which: "cancellation" | "bed") =>
    setPicker((current) => (current === which ? null : which));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The room type being edited; the others show as one line with Edit (Paper rev 4 a05-1).
  const [active, setActive] = useState(() => Math.max(0, draft.rooms.length - 1));
  const index = Math.min(active, draft.rooms.length - 1);
  const room = draft.rooms[index]!;
  const otherNames = (at: number) =>
    draft.rooms.filter((_, other) => other !== at).map((other) => other.name);
  const firstNumbers = quickRoomFirstNumbers(draft.rooms);

  const change = (patch: Partial<QuickRoomDraft>, cleared: keyof QuickRoomErrors) => {
    onChange({
      ...draft,
      rooms: draft.rooms.map((other, at) => (at === index ? { ...other, ...patch } : other)),
    });
    setErrors((current) => ({ ...current, [cleared]: undefined }));
  };
  /** Checks the room type being edited before leaving it; true when it can be left. */
  const leave = () => {
    const found = quickRoomErrors(room, currency.code, otherNames(index));
    setErrors(found);
    return Object.keys(found).length === 0;
  };
  const addRoomType = () => {
    if (!leave()) return;
    onChange({ ...draft, rooms: [...draft.rooms, EMPTY_QUICK_ROOM_DRAFT] });
    setActive(draft.rooms.length);
  };
  const removeRoomType = () => {
    onChange({ ...draft, rooms: draft.rooms.filter((_, at) => at !== index) });
    setActive(index - 1);
    setErrors({});
  };
  const editRoomType = (at: number) => {
    // A room type just added and left empty goes away rather than blocking the switch.
    if (index > 0 && isEmptyRoom(room)) {
      onChange({ ...draft, rooms: draft.rooms.filter((_, other) => other !== index) });
      setActive(at > index ? at - 1 : at);
      setErrors({});
      return;
    }
    if (!leave()) return;
    setActive(at);
  };
  const tick = (pricesIncludeMandatoryCharges: boolean) => {
    onChange({ ...draft, pricesIncludeMandatoryCharges });
    setErrors((current) => ({ ...current, taxes: undefined }));
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    // Every room type must be complete: open the first one that isn't, with what to fix.
    const first = quickRoomsFirstError(draft, currency.code);
    const taxes = draft.pricesIncludeMandatoryCharges ? {} : { taxes: QUICK_TAXES_ERROR };
    if (first) setActive(first.index);
    const found = { ...(first?.errors ?? {}), ...taxes };
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    try {
      await onSubmit(draft);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "We couldn't save your room.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <QuickSetupShell step={5} onSaveAndExit={onSaveAndExit} saveAndExitDisabled={submitting}>
      <QuickSetupStepLayout
        title="Your first room and price"
        subtitle="Start with one room type. Add the rest whenever you like."
        footer={{
          note: "Saved as you type",
          onBack: onBack ?? null,
          backDisabled: submitting,
          formId: FORM_ID,
          primaryLabel: "Continue",
          primaryBusy: submitting,
          primaryBusyLabel: "Saving…",
        }}
        preview={
          <QuickSetupPreviewCard>
            <QuickBookingPagePreview
              url={hotel.url}
              hotelName={hotel.name}
              place={hotel.place}
              currencySymbol={currency.symbol}
              rooms={quickPreviewRooms(draft, currency.symbol)}
            />
          </QuickSetupPreviewCard>
        }
      >
        <form id={FORM_ID} noValidate onSubmit={handleSubmit} className="flex flex-col gap-6">
          {draft.rooms.slice(0, index).map((other, at) => (
            <QuickRoomLine
              key={at}
              room={other}
              symbol={currency.symbol}
              onEdit={() => editRoomType(at)}
            />
          ))}
          {index > 0 ? (
            <div className="-mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">
                New room type
              </p>
              <button
                type="button"
                onClick={removeRoomType}
                className="rounded text-[13px] font-semibold text-gray-600 outline-none hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-primary-600"
              >
                Remove
              </button>
            </div>
          ) : null}
          <QuickSetupField
            label="Room type name"
            required
            value={room.name}
            error={errors.name}
            helper="Guests see this name when they choose a room."
            inputProps={{ placeholder: "e.g. Classic Double", maxLength: 120 }}
            onChange={(name) => change({ name }, "name")}
          />
          {/* Rooms, guests and price in one row on desktop, one note under it (approved 2026-10-21). */}
          <div>
            <div className="grid gap-6 lg:grid-cols-3 lg:gap-4">
              <QuickSetupField
                label="Rooms of this type"
                required
                value={room.numberOfRooms}
                error={errors.numberOfRooms}
                inputProps={{ inputMode: "numeric", placeholder: "e.g. 8", maxLength: 3 }}
                onChange={(numberOfRooms) => change({ numberOfRooms }, "numberOfRooms")}
              />
              <QuickSetupField
                label="Max guests"
                required
                value={room.maxGuests}
                error={errors.maxGuests}
                inputProps={{ inputMode: "numeric", maxLength: 2 }}
                onChange={(maxGuests) => change({ maxGuests }, "maxGuests")}
              />
              <QuickSetupField
                label="Price per night"
                required
                value={room.pricePerNight}
                error={errors.pricePerNight}
                suffix={currency.code}
                inputProps={{ inputMode: "decimal", placeholder: "e.g. 145" }}
                onChange={(pricePerNight) => change({ pricePerNight }, "pricePerNight")}
              />
            </div>
            <p className="mt-2 text-[13px] leading-5 text-gray-500">
              {[
                quickRoomLabelsHint(room.numberOfRooms, firstNumbers[index]),
                "Prices include taxes and fees. Seasons and weekday prices come later in Rooms & Rates.",
              ]
                .filter(Boolean)
                .join(" ")}
            </p>
          </div>
          {draft.rooms.slice(index + 1).map((other, offset) => (
            <QuickRoomLine
              key={index + 1 + offset}
              room={other}
              symbol={currency.symbol}
              onEdit={() => editRoomType(index + 1 + offset)}
            />
          ))}
          <div>
            <label
              className={`flex cursor-pointer items-start gap-3 rounded-xl px-4 py-3.5 ${
                errors.taxes ? "bg-red-50 ring-1 ring-red-200" : "bg-gray-50"
              }`}
            >
              <input
                type="checkbox"
                className="peer sr-only"
                checked={draft.pricesIncludeMandatoryCharges}
                onChange={(event) => tick(event.target.checked)}
              />
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border peer-focus-visible:ring-2 peer-focus-visible:ring-primary-600 peer-focus-visible:ring-offset-2 ${
                  draft.pricesIncludeMandatoryCharges
                    ? "border-primary-600 bg-primary-600 text-white"
                    : "border-gray-400 bg-white"
                }`}
              >
                {draft.pricesIncludeMandatoryCharges ? <CheckIcon className="h-3.5 w-3.5" /> : null}
              </span>
              <span>
                <span className="block text-sm font-semibold text-gray-950">
                  My prices include all mandatory taxes and fees
                </span>
                <span className="mt-0.5 block text-[13px] text-gray-500">
                  Required before you can publish.
                </span>
                <QuickSetupFieldError message={errors.taxes} />
              </span>
            </label>
          </div>
          <div className="divide-y divide-gray-200 rounded-xl border border-gray-200">
            <DefaultLine
              icon={ShieldCheckIcon}
              tone="green"
              title={quickCancellationTitle(choices.freeCancellationDays)}
              note={`${choices.freeCancellationDays === 3 ? "Our default. " : ""}After that, the full stay is charged.`}
              open={picker === "cancellation"}
              onToggle={() => toggle("cancellation")}
            >
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">Free cancellation</legend>
                {QUICK_CANCELLATION_OPTIONS.map((option) => (
                  <Choice
                    key={option.value}
                    name="quick-cancellation"
                    label={option.label}
                    checked={choices.freeCancellationDays === option.value}
                    onPick={() => onChange({ ...draft, freeCancellationDays: option.value })}
                  />
                ))}
                <Choice
                  name="quick-cancellation"
                  label="Non-refundable"
                  checked={false}
                  unavailable={QUICK_NON_REFUNDABLE_NOTE}
                />
              </fieldset>
            </DefaultLine>
            <DefaultLine
              icon={MoonIcon}
              title={quickBedTitle(choices.bed)}
              note={`${choices.bed === "double" ? "Our default. " : ""}For every room type. Add more beds later with your photos.`}
              open={picker === "bed"}
              onToggle={() => toggle("bed")}
            >
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">Beds per room</legend>
                {QUICK_BED_OPTIONS.map((option) => (
                  <Choice
                    key={option.value}
                    name="quick-bed"
                    label={option.label}
                    checked={choices.bed === option.value}
                    onPick={() => onChange({ ...draft, bed: option.value })}
                  />
                ))}
              </fieldset>
            </DefaultLine>
          </div>
          {draft.rooms.length < QUICK_MAX_ROOM_TYPES ? (
            <button
              type="button"
              onClick={addRoomType}
              className="flex w-fit items-center gap-2 rounded text-sm font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600"
            >
              <PlusIcon className="h-4 w-4" aria-hidden="true" />
              Add another room type
            </button>
          ) : null}
          {submitError ? (
            <p role="alert" className="text-sm text-red-700">
              {submitError}
            </p>
          ) : null}
        </form>
      </QuickSetupStepLayout>
    </QuickSetupShell>
  );
}
