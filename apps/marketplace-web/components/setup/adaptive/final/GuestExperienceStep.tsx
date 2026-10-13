"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  parseBookingGuestPolicyChoices,
  type BookingGuestPolicyChoices,
} from "@vayada/domain-booking";
import type { PropertySetupDraftPayload } from "@vayada/domain-hotels";
import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
import {
  AdaptiveSaveError,
  AdaptiveStepCard,
  AdaptiveStepSkeleton,
  adaptivePrimaryButtonClass,
  adaptiveSecondaryButtonClass,
} from "../AdaptiveStepPrimitives";
import {
  bookingGuestRulesClient,
  guestRulesErrorMessage,
  type GuestRules,
} from "@/services/api/bookingGuestRulesClient";
import { DEFAULT_GUEST_TERMS } from "./defaultGuestTerms";
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
  type Data = PropertySetupDraftPayload<"guest_experience">;
  const canonical = useRef<GuestRules | null>(null);
  const values = useRef<Data>({});
  const dirty = useRef(false),
    busy = useRef(false),
    continuing = useRef(false),
    generation = useRef(0);
  const retryCommand = useRef<{ fingerprint: string; key: string } | null>(null);
  const [data, setData] = useState<Data>({});
  // Guest terms are saved separately from the rules; null means the hotel has none (VAY-2176).
  // "starting" pre-fills the default text; "unavailable" hides the terms but keeps the rules usable.
  const terms = useRef(""),
    savedTerms = useRef<string | null>(null),
    termsDirty = useRef(false);
  const [termsText, setTermsText] = useState("");
  const [savedTermsText, setSavedTermsText] = useState<string | null>(null);
  const [termsMode, setTermsMode] = useState<"unavailable" | "own" | "starting">("unavailable");
  const termsIds = useId();
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [loaded, setLoaded] = useState(false);
  const [confirmed, setConfirmed] = useState(false),
    [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const [bounds, setBounds] = useState<
    Pick<BookingGuestPolicyChoices, "checkInUntil" | "checkOutFrom">
  >({});
  const { propertyId, organizationId } = props.route.scope;
  const { registerBeforeLeave } = props;
  useEffect(
    () =>
      registerBeforeLeave(async () => {
        if (busy.current && !continuing.current)
          throw new Error("Wait for guest rules to finish saving.");
        if (dirty.current) throw new Error("Save your guest rules before leaving this step.");
        if (termsDirty.current)
          throw new Error("Save your terms & conditions before leaving this step.");
      }),
    [registerBeforeLeave],
  );
  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setSaving(false);
    setLoading(true);
    setLoaded(false);
    setError(null);
    setConfirmed(false);
    setSaved(false);
    dirty.current = false;
    termsDirty.current = false;
    busy.current = false;
    continuing.current = false;
    retryCommand.current = null;
    void Promise.all([
      bookingGuestRulesClient.load(propertyId, controller.signal),
      // The rules don't depend on the terms: a failed terms read only hides the terms card.
      bookingGuestRulesClient.loadTerms(propertyId, controller.signal).catch(() => undefined),
    ])
      .then(([value, storedTerms]) => {
        if (controller.signal.aborted) return;
        savedTerms.current = storedTerms?.trim() || null;
        setSavedTermsText(savedTerms.current);
        terms.current =
          storedTerms === undefined ? "" : (savedTerms.current ?? DEFAULT_GUEST_TERMS);
        setTermsText(terms.current);
        setTermsMode(
          storedTerms === undefined ? "unavailable" : savedTerms.current ? "own" : "starting",
        );
        canonical.current = value;
        const choices = value?.choices ?? {
          defaultGuestLanguage: null,
          childrenEnabled: null,
          adultAgeThreshold: null,
          phoneRequired: true,
          arrivalTimeEnabled: false,
          specialRequestsEnabled: true,
          checkInTime: null,
          checkOutTime: null,
        };
        const initial = Object.fromEntries(
          Object.entries(fields).map(([key, field]) => [
            field,
            choices[key as keyof typeof fields],
          ]),
        );
        values.current = initial;
        setData(initial);
        setBounds(
          value
            ? { checkInUntil: value.choices.checkInUntil, checkOutFrom: value.choices.checkOutFrom }
            : {},
        );
        setLoaded(true);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(guestRulesErrorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      generation.current = current + 1;
    };
  }, [propertyId, organizationId, retry]);
  function update(field: keyof Data, value: Data[keyof Data]) {
    if (busy.current) return;
    values.current = { ...values.current, [field]: value };
    setData(values.current);
    dirty.current = true;
    setConfirmed(false);
    setSaved(false);
    setError(null);
  }
  function updateTerms(value: string) {
    if (busy.current) return;
    terms.current = value;
    setTermsText(value);
    termsDirty.current = true;
    setConfirmed(false);
    setError(null);
  }
  async function submit() {
    if (busy.current || !loaded) return;
    const base = canonical.current?.choices;
    const choices = parseBookingGuestPolicyChoices({
      ...Object.fromEntries(
        Object.entries(fields).map(([key, field]) => [key, values.current[field]]),
      ),
      ...(base?.checkInUntil ? { checkInUntil: base.checkInUntil } : {}),
      ...(base?.checkOutFrom ? { checkOutFrom: base.checkOutFrom } : {}),
    });
    if (!choices || !confirmed) {
      setError(
        "Choose a language, child policy and valid arrival times, then confirm your guest rules.",
      );
      return;
    }
    const expectedRevision = canonical.current?.revision ?? null;
    const fingerprint = JSON.stringify({ propertyId, organizationId, expectedRevision, choices });
    if (retryCommand.current?.fingerprint !== fingerprint)
      retryCommand.current = { fingerprint, key: crypto.randomUUID() };
    const current = generation.current;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      if (!saved) {
        const result = await bookingGuestRulesClient.save(
          propertyId,
          expectedRevision,
          choices,
          retryCommand.current.key,
        );
        if (current !== generation.current) return;
        canonical.current = result;
        dirty.current = false;
        retryCommand.current = null;
        setSaved(true);
      }
      const nextTerms = terms.current.trim() || null;
      if (termsMode !== "unavailable" && nextTerms !== savedTerms.current) {
        const stored = await bookingGuestRulesClient.saveTerms(
          propertyId,
          nextTerms,
          savedTerms.current,
        );
        if (current !== generation.current) return;
        savedTerms.current = stored;
        setSavedTermsText(stored);
      }
      termsDirty.current = false;
      continuing.current = true;
      await props.saveAndContinue({ recheckBeforeLeaveOnRetry: true });
    } catch (cause) {
      if (current === generation.current) setError(guestRulesErrorMessage(cause));
    } finally {
      if (current === generation.current) {
        busy.current = false;
        continuing.current = false;
        setSaving(false);
      }
    }
  }
  const termsPending = termsMode !== "unavailable" && (termsText.trim() || null) !== savedTermsText;
  if (loading) return <AdaptiveStepSkeleton columns />;
  if (!loaded)
    return (
      <AdaptiveSaveError
        message={error ?? "Guest rules are unavailable."}
        onRetry={() => setRetry((v) => v + 1)}
      />
    );
  return (
    <form
      className="mx-auto max-w-5xl"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {error && <AdaptiveSaveError message={error} />}
      {saved && (
        <p role="status" className="mb-5 rounded-xl bg-green-50 p-4 text-sm text-green-800">
          Guest rules saved.
        </p>
      )}
      <fieldset disabled={saving} className="grid gap-6 lg:grid-cols-2">
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
          <h2 className="text-lg font-semibold">Arrival times</h2>
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
            Cancellation and payment terms are configured with your rates.
          </p>
        </AdaptiveStepCard>
        {termsMode !== "unavailable" && (
          <AdaptiveStepCard className="lg:col-span-2">
            <h2 id={`${termsIds}-title`} className="text-lg font-semibold">
              Terms & Conditions
            </h2>
            <p id={`${termsIds}-help`} className="mt-2 text-sm text-gray-600">
              Guests see these on your booking page before they book.
              {termsMode === "starting" &&
                " We've added a starting text. Edit it to match how you work."}
            </p>
            <textarea
              aria-labelledby={`${termsIds}-title`}
              aria-describedby={`${termsIds}-help${termsText.trim() ? "" : ` ${termsIds}-empty`}`}
              className={inputClass}
              rows={12}
              maxLength={20_000}
              value={termsText}
              onChange={(event) => updateTerms(event.target.value)}
            />
            {!termsText.trim() && (
              <p
                id={`${termsIds}-empty`}
                role="status"
                className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
              >
                Without terms & conditions, guests won&apos;t see any terms when they book. We
                recommend keeping at least the starting text.
              </p>
            )}
          </AdaptiveStepCard>
        )}
        <label className="flex items-start gap-3 text-sm lg:col-span-2">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {termsMode === "unavailable"
            ? "I confirm these guest rules and arrival times."
            : "I confirm these guest rules, arrival times and terms & conditions."}
        </label>
      </fieldset>
      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          className={adaptiveSecondaryButtonClass}
          disabled={saving}
          onClick={() => {
            if (
              !(dirty.current || termsDirty.current) ||
              window.confirm("Discard your unsaved changes and reload saved guest rules?")
            )
              setRetry((v) => v + 1);
          }}
        >
          Reload saved rules
        </button>
        <button
          type="submit"
          className={adaptivePrimaryButtonClass}
          disabled={saving || !confirmed}
        >
          {saving ? "Please wait…" : saved && !termsPending ? "Continue" : "Save and continue"}
        </button>
      </div>
    </form>
  );
}
