"use client";

import { useEffect, useRef, useState } from "react";
import type { BookingGuestPolicyChoices } from "@vayada/domain-booking";
import { SettingsCard } from "@vayada/settings-ui";
import {
  getPmsPropertyFacts,
  resolveSelectedPmsPropertyId,
} from "@/services/api/pmsPropertyClient";
import { arrivalTimesService } from "@/services/settings/arrivalTimes";
import {
  guestRulesRefusal,
  guestRulesService,
  type GuestRules,
  type GuestRulesRefusal,
} from "@/services/settings/guestRules";
import { useTranslation } from "@/lib/i18n";
import { localizedErrorText } from "@/lib/i18n/localizedErrorText";
import { forgetGuestStayTimes } from "@/lib/settings/useGuestStayTimes";
import { humanizeApiError } from "./constants";
import {
  adultAge,
  checkForm,
  choicesFromForm,
  formFromChoices,
  isDirty,
  saveStatus,
  type ArrivalDraft,
  type ArrivalForm,
} from "./arrivalTimes/arrivalTimesForm";
import { timeZoneLabel } from "./arrivalTimes/arrivalTimesText";
import { BookingPagePreview } from "./arrivalTimes/BookingPagePreview";
import { BookingFormCard, GuestsCard } from "./arrivalTimes/GuestsCard";
import { ReviewDialog, SaveBar, SetupBanner } from "./arrivalTimes/ReviewAndSave";
import { TimesCard } from "./arrivalTimes/TimesCard";

type Loaded = {
  propertyId: string;
  /** Null while the property has no guest rules: its first save confirms its guest policy. */
  rules: GuestRules | null;
  saved: ArrivalForm;
  /** The property's name, town and time zone; null when its profile can't be read. */
  facts: { name: string; city: string; timeZone: string } | null;
};

/** A property without guest rules starts from the PMS guest policy it saved before VAY-2455, else from that policy's
 * catalog times, else from nothing chosen. */
async function firstDraft(signal: AbortSignal): Promise<ArrivalDraft> {
  try {
    const setup = await arrivalTimesService.load(signal);
    return setup.current?.bundle.choices ?? setup.draft ?? {};
  } catch {
    return {};
  }
}

/** Settings → Property → Check-in & check-out (VAY-2455, Timo's redesign): the guest rules the booking page shows —
 * arrival and departure times, who can stay and the booking form — reviewed in a dialog and saved in one go. */
export function ArrivalTimesSection() {
  const { t, locale } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [form, setForm] = useState<ArrivalForm | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [review, setReview] = useState<BookingGuestPolicyChoices | null>(null);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<GuestRulesRefusal | "failed" | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  // One key per reviewed set of choices: a retry after a lost answer replays the save instead of repeating it.
  const attempt = useRef<{ choices: string; key: string } | null>(null);
  // The dialog gives focus back to "Review & save", which a save disables: keyboard users land on the status.
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (justSaved) statusRef.current?.focus();
  }, [justSaved]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setLoaded(null);
    setForm(null);
    setLoadError(null);
    void (async () => {
      const propertyId = await resolveSelectedPmsPropertyId("loading arrival times");
      const [rules, facts] = await Promise.all([
        guestRulesService.load(signal, propertyId),
        getPmsPropertyFacts(propertyId, signal).catch(() => null),
      ]);
      const saved = formFromChoices(rules ? rules.choices : await firstDraft(signal));
      return { propertyId, rules, saved, facts };
    })().then(
      (value) => {
        if (signal.aborted) return;
        setLoaded(value);
        setForm(value.saved);
      },
      (cause) => {
        if (!signal.aborted) setLoadError(cause);
      },
    );
    return () => controller.abort();
  }, [reload]);

  const reloadSaved = () => {
    attempt.current = null;
    setRefusal(null);
    setJustSaved(false);
    setReload((value) => value + 1);
  };

  if (!loaded || !form)
    return (
      <SettingsCard>
        {loadError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-red-700">
              {localizedErrorText(
                loadError,
                humanizeApiError(loadError, t("settings.arrivalTimes.loadError")),
                t,
              )}
            </p>
            <button type="button" onClick={reloadSaved} className="text-sm font-medium underline">
              {t("settings.arrivalTimes.retry")}
            </button>
          </div>
        ) : (
          <p role="status" className="text-sm text-gray-600">
            {t("settings.arrivalTimes.loading")}
          </p>
        )}
      </SettingsCard>
    );

  const check = checkForm(form);
  const dirty = isDirty(form, loaded.saved);
  const status = saveStatus(check, dirty, loaded.rules !== null, justSaved);
  const change = (patch: Partial<ArrivalForm>) => {
    setForm((current) => current && { ...current, ...patch });
    setJustSaved(false);
    setRefusal(null);
  };
  const openReview = () => {
    const choices = choicesFromForm(form, adultAge(loaded.saved.adultAge));
    if (!choices) {
      setRefusal("invalid_guest_choices");
      return;
    }
    const text = JSON.stringify(choices);
    if (attempt.current?.choices !== text)
      attempt.current = { choices: text, key: `arrival-times:${crypto.randomUUID()}` };
    setRefusal(null);
    setReview(choices);
  };
  const confirmSave = async () => {
    if (!review || !attempt.current) return;
    setSaving(true);
    try {
      const revision = await guestRulesService.save(
        loaded.propertyId,
        loaded.rules?.revision ?? null,
        review,
        attempt.current.key,
      );
      attempt.current = null;
      // The dashboard, the booking and the check-in show the new times next.
      forgetGuestStayTimes();
      const saved = formFromChoices(review);
      setLoaded({ ...loaded, rules: { revision, choices: review }, saved });
      setForm(saved);
      setJustSaved(true);
    } catch (cause) {
      const code = guestRulesRefusal(cause);
      // A refusal is final; only an unanswered save may be retried under the same key.
      if (code) attempt.current = null;
      setRefusal(code ?? "failed");
    } finally {
      setSaving(false);
      setReview(null);
    }
  };
  const refusalText = {
    guest_choices_stale: t("settings.arrivalTimes.saveError.stale"),
    guest_choices_idempotency_conflict: t("settings.arrivalTimes.saveError.conflict"),
    guest_choices_denied: t("settings.arrivalTimes.saveError.denied"),
    invalid_guest_choices: t("settings.arrivalTimes.saveError.invalid"),
    failed: t("settings.arrivalTimes.saveError.failed"),
  };

  return (
    <div className="space-y-6">
      {!loaded.rules && (
        <SetupBanner
          check={check}
          prefilled={Boolean(loaded.saved.checkInTime || loaded.saved.checkOutTime)}
        />
      )}
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_540px] flex-col gap-5">
          <TimesCard
            form={form}
            check={check}
            timeZone={timeZoneLabel(loaded.facts?.timeZone ?? "", locale)}
            onChange={change}
          />
          <GuestsCard form={form} check={check} onChange={change} />
          <BookingFormCard form={form} onChange={change} />
          {refusal && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              <span>{refusalText[refusal]}</span>
              {/* A refused save, or one whose answer was lost, may have left other values saved. */}
              {refusal !== "guest_choices_denied" && refusal !== "invalid_guest_choices" && (
                <button type="button" onClick={reloadSaved} className="font-medium underline">
                  {t("settings.arrivalTimes.reload")}
                </button>
              )}
            </div>
          )}
          <SaveBar
            status={status}
            missing={check.missing}
            dirty={dirty}
            statusRef={statusRef}
            onDiscard={() => change(loaded.saved)}
            onReview={openReview}
          />
        </div>
        <BookingPagePreview form={form} check={check} hotel={loaded.facts} />
      </div>
      {review && (
        <ReviewDialog
          choices={review}
          saving={saving}
          onBack={() => setReview(null)}
          onConfirm={confirmSave}
        />
      )}
    </div>
  );
}
