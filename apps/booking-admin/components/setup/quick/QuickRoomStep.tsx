"use client";

import { CheckIcon, MoonIcon, PlusIcon, ShieldCheckIcon } from "@heroicons/react/24/outline";
import { useState, type ComponentType, type FormEvent, type SVGProps } from "react";

import { QuickBedIcon } from "./QuickBedIcon";
import { QuickBookingPagePreview } from "./QuickBookingPagePreview";
import { QuickSetupField, QuickSetupFieldError } from "./QuickSetupField";
import { QuickSetupPreviewCard } from "./QuickSetupPreviewCard";
import { QuickSetupShell } from "./QuickSetupShell";
import { QuickSetupStepLayout } from "./QuickSetupStepLayout";
import {
  QUICK_TAXES_ERROR,
  quickPreviewRooms,
  quickRoomErrors,
  quickRoomLabelsHint,
  type QuickRoomDraft,
  type QuickRoomErrors,
  type QuickRoomsDraft,
} from "./quickRoomDraft";

const FORM_ID = "quick-setup-first-room";

export type QuickRoomStepProps = {
  /** The hotel's room types and the taxes tick; this step edits the first room type (1.12b adds more). */
  draft: QuickRoomsDraft;
  onChange: (next: QuickRoomsDraft) => void;
  currency: { code: string; symbol: string };
  hotel: { name: string; place: string; url: string };
  onSubmit: (draft: QuickRoomsDraft) => Promise<void>;
  /** Back to "Your hotel" once it can edit a hotel that exists (follow-up); hidden until then. */
  onBack?: (() => void) | null;
  onSaveAndExit: () => void;
  /** VAY-2247 follow-up: shown once the first run takes these choices (multi-room, cancellation, bed). */
  onAddRoomType?: (() => void) | null;
  onChangeCancellation?: (() => void) | null;
  onChangeBed?: (() => void) | null;
};

function DefaultLine({
  icon: Icon,
  title,
  note,
  onChange,
  tone = "gray",
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  note: string;
  onChange?: (() => void) | null;
  tone?: "gray" | "green";
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-gray-50 px-3 py-3.5">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          tone === "green" ? "bg-green-50 text-green-600" : "bg-white text-gray-600"
        }`}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-950">{title}</p>
        <p className="mt-0.5 text-[13px] leading-5 text-gray-500">{note}</p>
      </div>
      {onChange ? (
        <button
          type="button"
          onClick={onChange}
          className="rounded text-sm font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600"
        >
          Change
        </button>
      ) : null}
    </div>
  );
}

/**
 * VAY-2247 step 3, "Your first room and price" (Paper rev 4): one room type with its rooms, guests and
 * price, the taxes confirmation the price needs, and the defaults the first run uses for it.
 */
export function QuickRoomStep({
  draft,
  onChange,
  currency,
  hotel,
  onSubmit,
  onBack,
  onSaveAndExit,
  onAddRoomType,
  onChangeCancellation,
  onChangeBed,
}: QuickRoomStepProps) {
  const [errors, setErrors] = useState<QuickRoomErrors & { taxes?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const room = draft.rooms[0]!;
  const change = (patch: Partial<QuickRoomDraft>, cleared: keyof QuickRoomErrors) => {
    onChange({ ...draft, rooms: [{ ...room, ...patch }, ...draft.rooms.slice(1)] });
    setErrors((current) => ({ ...current, [cleared]: undefined }));
  };
  const tick = (pricesIncludeMandatoryCharges: boolean) => {
    onChange({ ...draft, pricesIncludeMandatoryCharges });
    setErrors((current) => ({ ...current, taxes: undefined }));
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    const found = {
      ...quickRoomErrors(room, currency.code),
      ...(draft.pricesIncludeMandatoryCharges ? {} : { taxes: QUICK_TAXES_ERROR }),
    };
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
    <QuickSetupShell step={3} onSaveAndExit={onSaveAndExit} saveAndExitDisabled={submitting}>
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
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
              <QuickBedIcon className="h-4 w-4" aria-hidden="true" />
            </span>
            <h2 className="text-lg font-semibold text-gray-950">Your first room type</h2>
          </div>
          <QuickSetupField
            label="Room type name"
            required
            value={room.name}
            error={errors.name}
            helper="Guests see this name when they choose a room."
            inputProps={{ placeholder: "e.g. Classic Double", maxLength: 120 }}
            onChange={(name) => change({ name }, "name")}
          />
          <div className="grid gap-6 lg:grid-cols-2 lg:gap-4">
            <QuickSetupField
              label="Rooms of this type"
              required
              value={room.numberOfRooms}
              error={errors.numberOfRooms}
              helper={quickRoomLabelsHint(room.numberOfRooms)}
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
          </div>
          <QuickSetupField
            label="Price per night"
            required
            value={room.pricePerNight}
            error={errors.pricePerNight}
            suffix={currency.code}
            helper="Includes taxes and fees. Seasons and weekday prices come later in Rooms & Rates."
            inputProps={{ inputMode: "decimal", placeholder: "e.g. 145" }}
            onChange={(pricePerNight) => change({ pricePerNight }, "pricePerNight")}
          />
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
          <DefaultLine
            icon={ShieldCheckIcon}
            tone="green"
            title="Free cancellation until 3 days before arrival"
            note="Our default. After that, the full stay is charged."
            onChange={onChangeCancellation}
          />
          <DefaultLine
            icon={MoonIcon}
            title="One double bed per room"
            note="Our default. Add more beds later with your photos."
            onChange={onChangeBed}
          />
          {onAddRoomType ? (
            <button
              type="button"
              onClick={onAddRoomType}
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
