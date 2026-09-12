"use client";
import { useEffect, useRef, useState } from "react";
import {
  parseBookingGuestPolicyChoices,
  type BookingGuestPolicyChoices,
  type BookingGuestPolicyComposition,
} from "@vayada/domain-booking";
import { parseRoomTypeFactsSnapshot } from "@vayada/domain-pms";
import { targetApiClient } from "@/services/api/targetClient";
import type { PropertySetupDraftPayload } from "@vayada/domain-hotels";
import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
import {
  AdaptiveSaveError,
  AdaptiveStepCard,
  AdaptiveStepSkeleton,
  adaptivePrimaryButtonClass,
  adaptiveSecondaryButtonClass,
} from "../AdaptiveStepPrimitives";
import { adaptiveStepErrorMessage } from "../adaptiveSetupStepState";
import {
  bookingGuestPolicyClient,
  type GuestPolicySetup,
} from "@/services/api/bookingGuestPolicyClient";
import { useFinalStepDraft } from "./useFinalStepDraft";

const fields = {
  defaultGuestLanguage: "guest.default_language",
  childrenEnabled: "guest.children_enabled",
  adultAgeThreshold: "guest.adult_age_threshold",
  phoneRequired: "guest.phone_required",
  arrivalTimeEnabled: "guest.arrival_time_enabled",
  specialRequestsEnabled: "guest.special_requests_enabled",
  checkInTime: "policy.check_in_time",
  checkOutTime: "policy.check_out_time",
} as const;
const inputClass =
  "mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm";
const languages = {
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  id: "Indonesian",
  nl: "Dutch",
};

export function GuestExperienceStep(props: AdaptiveSetupStepComponentProps) {
  const draft = useFinalStepDraft(props, "guest_experience");
  const canonical = useRef<GuestPolicySetup | null>(null);
  const saved = useRef(false);
  const [hasSaved, setHasSaved] = useState(false);
  const [bounds, setBounds] = useState<
    Pick<BookingGuestPolicyChoices, "checkInUntil" | "checkOutFrom">
  >({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<BookingGuestPolicyComposition | null>(null);
  const [roomNames, setRoomNames] = useState<Record<string, string>>({});
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const { initialize } = draft;
  const { organizationId, propertyId } = props.route.scope;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setPreview(null);
    void bookingGuestPolicyClient
      .load({ organizationId, propertyId }, { signal: controller.signal, cache: "no-store" })
      .then((value) => {
        if (controller.signal.aborted) return;
        canonical.current = value;
        setBounds({
          checkInUntil: value.choices.checkInUntil,
          checkOutFrom: value.choices.checkOutFrom,
        });
        saved.current = false;
        setHasSaved(false);
        initialize(
          Object.fromEntries(
            Object.entries(fields).map(([key, field]) => [
              field,
              value.choices[key as keyof typeof fields],
            ]),
          ),
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(adaptiveStepErrorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [organizationId, propertyId, initialize, draft.reload, retry]);

  function choices() {
    const base = canonical.current?.choices;
    return parseBookingGuestPolicyChoices({
      ...Object.fromEntries(
        Object.entries(fields).map(([key, field]) => [key, draft.values.current[field]]),
      ),
      ...(base && Object.hasOwn(base, "checkInUntil") ? { checkInUntil: base.checkInUntil } : {}),
      ...(base && Object.hasOwn(base, "checkOutFrom") ? { checkOutFrom: base.checkOutFrom } : {}),
    });
  }
  function update(
    field: keyof PropertySetupDraftPayload<"guest_experience">,
    value: PropertySetupDraftPayload<"guest_experience">[typeof field],
  ) {
    draft.change(field, value);
    saved.current = false;
    setHasSaved(false);
    if (field !== "policy.cancellation_bundle_confirmation") {
      draft.change("policy.cancellation_bundle_confirmation", false);
      setPreview(null);
    }
  }
  async function review() {
    const value = choices();
    if (!value) {
      setPreviewError(
        "Choose a guest language, child policy, valid adult age and check-in/check-out times first.",
      );
      return;
    }
    setPreviewBusy(true);
    setPreviewError(null);
    setPreview(null);
    draft.change("policy.cancellation_bundle_confirmation", false);
    try {
      const [policy, raw] = await Promise.all([
        bookingGuestPolicyClient.preview({ organizationId, propertyId }, value, {
          cache: "no-store",
        }),
        targetApiClient.get<{ propertyId: string; items: unknown[] }>(
          `/api/pms/setup/properties/${encodeURIComponent(propertyId)}/room-types`,
          { cache: "no-store" },
        ),
      ]);
      if (raw?.propertyId !== propertyId || !Array.isArray(raw.items))
        throw new Error("Room details are unavailable. Refresh and review again.");
      const rooms = raw.items.map(parseRoomTypeFactsSnapshot);
      if (rooms.some((room) => !room || room.propertyId !== propertyId))
        throw new Error("Room details are invalid. Refresh and review again.");
      if (
        policy.outcome === "ready" &&
        policy.bundle.rates.some(
          (rate) =>
            !rooms.some(
              (room) =>
                room?.roomTypeId === rate.roomTypeId &&
                room.roomFactsRevision === rate.roomFactsRevision,
            ),
        )
      )
        throw new Error("Room details changed. Review the cancellation policy again.");
      setRoomNames(Object.fromEntries(rooms.map((room) => [room!.roomTypeId, room!.facts.name])));
      setPreview(policy);
    } catch (error) {
      setPreviewError(adaptiveStepErrorMessage(error));
    } finally {
      setPreviewBusy(false);
    }
  }
  async function submit() {
    await draft.commit(async () => {
      if (saved.current) return;
      const value = choices();
      if (
        !value ||
        preview?.outcome !== "ready" ||
        !draft.values.current["policy.cancellation_bundle_confirmation"]
      )
        throw new Error("Review and confirm the current cancellation policy before saving.");
      const expectedRevision = canonical.current?.revision ?? 0;
      const source = draft.revision.current.baseRevisions?.["booking.guest_experience"];
      if (
        source !== (expectedRevision ? `guest-policy:${expectedRevision}` : "guest-policy:absent")
      ) {
        props.reportRevisionConflict();
        throw new Error(
          "This guest-policy draft is based on older settings. Refresh before saving.",
        );
      }
      canonical.current = await bookingGuestPolicyClient.save(
        { organizationId, propertyId },
        {
          expectedRevision,
          expectedSourceFingerprint: preview.bundle.sourceFingerprint,
          choices: value,
          confirmPolicyBundle: true,
        },
        preview.bundle,
      );
      saved.current = true;
      setHasSaved(true);
    });
  }
  if (loading) return <AdaptiveStepSkeleton columns />;
  if (loadError)
    return <AdaptiveSaveError message={loadError} onRetry={() => setRetry((value) => value + 1)} />;
  const data = draft.data;
  return (
    <form
      className="mx-auto max-w-5xl"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {draft.error && <AdaptiveSaveError message={draft.error} />}
      <fieldset disabled={draft.saving || previewBusy} className="grid gap-6 lg:grid-cols-2">
        <AdaptiveStepCard>
          <h2 className="text-lg font-semibold">Guest experience</h2>
          <p className="mt-2 text-sm text-gray-600">
            Choose what guests see and provide when booking.
          </p>
          <label className="mt-5 block text-sm font-medium">
            Guest language
            <select
              className={inputClass}
              value={String(data["guest.default_language"] ?? "")}
              onChange={(event) => update("guest.default_language", event.target.value || null)}
            >
              <option value="">Choose a language</option>
              {Object.entries(languages).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-5 block text-sm font-medium">
            Are children welcome?
            <select
              className={inputClass}
              value={
                data["guest.children_enabled"] == null ? "" : String(data["guest.children_enabled"])
              }
              onChange={(event) => {
                update(
                  "guest.children_enabled",
                  event.target.value === "" ? null : event.target.value === "true",
                );
                if (event.target.value === "true" && data["guest.adult_age_threshold"] == null)
                  update("guest.adult_age_threshold", 18);
              }}
            >
              <option value="">Choose a child policy</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>
          {data["guest.children_enabled"] === true && (
            <label className="mt-5 block text-sm font-medium">
              Adult age starts at
              <input
                type="number"
                min={1}
                max={21}
                className={inputClass}
                value={
                  data["guest.adult_age_threshold"] == null
                    ? ""
                    : Number(data["guest.adult_age_threshold"])
                }
                onChange={(event) =>
                  update(
                    "guest.adult_age_threshold",
                    event.target.value === "" ? null : Number(event.target.value),
                  )
                }
              />
            </label>
          )}
          <div className="mt-5 space-y-4">
            {(
              [
                ["guest.phone_required", "Require a phone number"],
                ["guest.arrival_time_enabled", "Ask for expected arrival time"],
                ["guest.special_requests_enabled", "Allow special requests"],
              ] as const
            ).map(([field, label]) => (
              <label key={field} className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={data[field] === true}
                  onChange={(event) => update(field, event.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>
        </AdaptiveStepCard>
        <AdaptiveStepCard>
          <h2 className="text-lg font-semibold">Arrival and cancellation</h2>
          {(
            [
              ["policy.check_in_time", "Check-in from"],
              ["policy.check_out_time", "Check-out by"],
            ] as const
          ).map(([field, label]) => (
            <fieldset key={field} className="mt-5 block text-sm font-medium">
              <legend>{label}</legend>
              <span className="mt-2 flex gap-2">
                <select
                  aria-label={`${label} hour`}
                  className={inputClass}
                  value={String(data[field] ?? "").slice(0, 2)}
                  onChange={(event) =>
                    update(
                      field,
                      event.target.value
                        ? `${event.target.value}:${String(data[field] ?? "00:00").slice(3) || "00"}`
                        : null,
                    )
                  }
                >
                  <option value="">Hour</option>
                  {Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")).map(
                    (hour) => (
                      <option key={hour}>{hour}</option>
                    ),
                  )}
                </select>
                <select
                  aria-label={`${label} minute`}
                  className={inputClass}
                  disabled={!data[field]}
                  value={String(data[field] ?? "00:00").slice(3)}
                  onChange={(event) =>
                    update(field, `${String(data[field]).slice(0, 2)}:${event.target.value}`)
                  }
                >
                  {Array.from({ length: 60 }, (_, minute) => String(minute).padStart(2, "0")).map(
                    (minute) => (
                      <option key={minute}>{minute}</option>
                    ),
                  )}
                </select>
              </span>
            </fieldset>
          ))}
          {(bounds.checkInUntil || bounds.checkOutFrom) && (
            <p className="mt-3 text-sm text-gray-600">
              Existing arrival bounds are retained:{" "}
              {bounds.checkInUntil ? `check-in until ${bounds.checkInUntil}. ` : ""}
              {bounds.checkOutFrom ? `Check-out from ${bounds.checkOutFrom}.` : ""}
            </p>
          )}
          <p className="mt-5 text-sm text-gray-600">
            Cancellation terms come from your room rates. Review them before confirming.
          </p>
          <button
            type="button"
            className={`${adaptiveSecondaryButtonClass} mt-4`}
            onClick={() => void review()}
          >
            {previewBusy ? "Loading policy…" : "Review cancellation policy"}
          </button>
          {previewError && (
            <p role="alert" className="mt-3 text-sm text-red-700">
              {previewError}
            </p>
          )}
          {preview?.outcome === "blocked" && (
            <div role="status" className="mt-4 rounded-lg bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-semibold">Policy review is not ready</p>
              <p className="mt-2">
                Complete the required pricing, room and property settings, then review again. Your
                answers can be saved as a draft.
              </p>
              <ul className="mt-2 list-disc pl-5">
                {preview.blockers.map((blocker, index) => (
                  <li key={index}>{blocker.code.replaceAll("_", " ")}</li>
                ))}
              </ul>
            </div>
          )}
          {preview?.outcome === "ready" && (
            <div className="mt-5 space-y-4 text-sm">
              <p>
                Policy currency: {preview.bundle.pricingCurrency}. Times use{" "}
                {preview.bundle.propertyTimeZone}.
              </p>
              {preview.bundle.rates.map((rate) => (
                <div key={rate.roomTypeId} className="rounded-lg border border-gray-200 p-4">
                  <h3 className="font-semibold">{roomNames[rate.roomTypeId]}</h3>
                  <p className="mt-2">
                    Free cancellation until {rate.flexible.freeCancellationDeadlineDays} days before
                    arrival at {rate.flexible.cutoff.localTime}. Later cancellation or a no-show
                    costs the full booking amount.
                  </p>
                  {rate.nonRefundable && (
                    <p className="mt-2">
                      Non-refundable rate: full prepayment, no refunds, and the full booking amount
                      for a no-show. Offering this rate requires a ready online card payment method.
                    </p>
                  )}
                  {rate.additionalGuest && (
                    <p className="mt-2">
                      Includes {rate.additionalGuest.includedGuestsPerRoom} guests per room. Each
                      additional {rate.additionalGuest.countedGuestTypes.join(" or ")} guest costs{" "}
                      {rate.additionalGuest.amountDecimal} {rate.additionalGuest.currency} per
                      night.
                    </p>
                  )}
                </div>
              ))}
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={data["policy.cancellation_bundle_confirmation"] === true}
                  onChange={(event) =>
                    update("policy.cancellation_bundle_confirmation", event.target.checked)
                  }
                />
                I have reviewed and confirm these cancellation terms.
              </label>
            </div>
          )}
        </AdaptiveStepCard>
      </fieldset>
      <div className="mt-6 flex justify-end">
        <button
          type="submit"
          className={adaptivePrimaryButtonClass}
          disabled={
            draft.saving ||
            previewBusy ||
            (!hasSaved &&
              (preview?.outcome !== "ready" ||
                data["policy.cancellation_bundle_confirmation"] !== true))
          }
        >
          {draft.saving ? "Saving…" : "Save and continue"}
        </button>
      </div>
    </form>
  );
}
