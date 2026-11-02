"use client";

import type { PropertyProfileResponse } from "@vayada/domain-hotels";
import type { SharedHotelSetupApi, SharedPropertyTypeOption } from "@vayada/product-onboarding";
import { useEffect, useMemo, useState } from "react";

import { ApiErrorResponse } from "@/services/api/client";
import { mapsLinkApi } from "@/services/api/sharedHotelSetupClient";
import { QuickHotelAddress } from "../quick/QuickHotelAddress";
import { quickHotelCurrency } from "../quick/quickHotelCurrency";
import type { QuickHotelDraft } from "../quick/quickHotelDraft";
import { SetupFrame, type SetupStepId } from "./SetupFrame";
import { SetupLocationStep } from "./SetupLocationStep";
import { SetupPropertyStep } from "./SetupPropertyStep";
import {
  locationStepHint,
  propertyStepHint,
  setupDraftFromProfile,
  setupProfilePatch,
} from "./setupDraft";

export type FourStepHotelDetailsProps = {
  propertyId: string;
  setup: Pick<
    SharedHotelSetupApi,
    "getPropertyProfile" | "updatePropertyProfile" | "uploadPropertyLogo" | "assignPropertyLogo"
  >;
  propertyTypes: readonly SharedPropertyTypeOption[];
  readCurrency: (propertyId: string) => Promise<string | null>;
  saveCurrency: (propertyId: string, currency: string) => Promise<void>;
  googleMapsApiKey?: string | null;
  initialStep: "property" | "location";
  /** After step 2's Continue, or the rail's room step: setup goes on there. */
  onDone: (step: "room") => void;
  onSaveAndExit: () => void;
};

type Loaded = { profile: PropertyProfileResponse; savedCurrency: string | null };

const editError = (error: unknown) =>
  error instanceof ApiErrorResponse && error.status === 409
    ? "Someone else changed this property meanwhile. Reload the page, then try again."
    : error instanceof Error && error.message
      ? error.message
      : "We couldn't save your property. Try again in a moment.";

/**
 * VAY-2451 steps 1 and 2 of a hotel that exists, in the four-step frame: a hotel an older setup made (to
 * finish what it lacks), Back from the room step, or a "Fix in setup" link for the address. Filled in from
 * the hotel's profile; Continue on step 2, Save & exit or the rail save what changed (the profile, a new
 * logo, the currency). Its social links stay in Settings › Booking page.
 */
export function FourStepHotelDetails({
  propertyId,
  setup,
  propertyTypes,
  readCurrency,
  saveCurrency,
  googleMapsApiKey,
  initialStep,
  onDone,
  onSaveAndExit,
}: FourStepHotelDetailsProps) {
  const [step, setStep] = useState<"property" | "location">(initialStep);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<QuickHotelDraft | null>(null);
  const [logo, setLogo] = useState<{ file: File; url: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      setup.getPropertyProfile(propertyId, { cache: "no-store" }),
      readCurrency(propertyId).catch(() => null),
    ])
      .then(([profile, savedCurrency]) => {
        if (!active) return;
        setLoaded({ profile, savedCurrency });
        setDraft(setupDraftFromProfile(profile.profile, savedCurrency));
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
    // Loaded once per hotel: the host passes new function identities on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId]);

  useEffect(() => {
    if (!logo) return;
    return () => URL.revokeObjectURL(logo.url);
  }, [logo]);

  const currency = useMemo(
    () => (draft ? quickHotelCurrency(draft.countryCode, draft.currency) : null),
    [draft],
  );

  if (!loaded || !draft) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-gray-50 px-6">
        <p role={failed ? "alert" : "status"} className="text-sm font-medium text-gray-600">
          {failed
            ? "We couldn't load your property. Try again in a minute."
            : "Loading your property…"}
        </p>
      </main>
    );
  }

  const change = (patch: Partial<QuickHotelDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));
  // Where a pin came from (a pasted link) isn't saved, so it isn't an edit by itself.
  const dirty =
    logo !== null ||
    JSON.stringify({ ...draft, pinFromLink: undefined }) !==
      JSON.stringify(setupDraftFromProfile(loaded.profile.profile, loaded.savedCurrency));

  /** The one save: the profile, a new logo, and the currency (the four-step setup always keeps one). */
  const save = async () => {
    if (!currency) throw new Error("Add your address to continue");
    const { profile, savedCurrency } = loaded;
    const saved = await setup.updatePropertyProfile(
      propertyId,
      {
        expectedProfileRevision: profile.profileRevision,
        patch: setupProfilePatch(draft, profile.profile),
      },
      `four-step:edit:${propertyId}:${profile.profileRevision}`,
    );
    // A later save (after a failed logo or currency step) continues from the saved revision.
    setLoaded((current) => (current ? { ...current, profile: saved } : current));
    if (logo) {
      try {
        const mediaObjectId = await setup.uploadPropertyLogo(
          propertyId,
          logo.file,
          `four-step:edit-logo:${propertyId}:${saved.profileRevision}`,
        );
        await setup.assignPropertyLogo(
          propertyId,
          { expectedProfileRevision: saved.profileRevision, mediaObjectId, altText: null },
          `four-step:edit-logo-assign:${propertyId}:${saved.profileRevision}`,
        );
        setLogo(null);
      } catch {
        // The logo is optional: it can be added in Design Studio.
      }
    }
    if (savedCurrency !== currency.code) {
      await saveCurrency(propertyId, currency.code);
      setLoaded((current) => (current ? { ...current, savedCurrency: currency.code } : current));
    }
  };
  /** Saves what changed (nothing changed: no write), then `then`; a failure stays with its message. */
  const saveThen = async (then: () => void) => {
    if (!dirty) return then();
    setSaving(true);
    setError(null);
    try {
      await save();
      then();
    } catch (caught) {
      setError(editError(caught));
    } finally {
      setSaving(false);
    }
  };

  const propertyName = draft.displayName.trim() || "Your property";
  const pick = (next: SetupStepId) => {
    if (next === "property" || next === "location") {
      setError(null);
      setStep(next);
    } else if (
      next === "room" &&
      !propertyStepHint(draft) &&
      !locationStepHint(draft, Boolean(currency))
    )
      void saveThen(() => onDone("room"));
  };
  const frame = {
    reached: 2,
    propertyName,
    onPickStep: saving ? null : pick,
    onSaveAndExit: () => {
      // An unfinished edit can't be saved; leaving keeps the hotel as it was.
      if (propertyStepHint(draft) || locationStepHint(draft, Boolean(currency)))
        return onSaveAndExit();
      void saveThen(onSaveAndExit);
    },
    saveAndExitDisabled: saving,
  };

  if (step === "property") {
    const hint = propertyStepHint(draft);
    return (
      <SetupFrame
        step="property"
        {...frame}
        footer={{
          onBack: null,
          primaryLabel: "Continue",
          onPrimary: () => setStep("location"),
          primaryDisabled: Boolean(hint),
          hint,
        }}
      >
        <SetupPropertyStep
          draft={draft}
          onChange={change}
          propertyTypes={propertyTypes}
          logoPreviewUrl={logo?.url ?? null}
          onLogoSelected={(file) => setLogo({ file, url: URL.createObjectURL(file) })}
        />
        {error ? (
          <p role="alert" className="mt-5 text-sm text-red-700">
            {error}
          </p>
        ) : null}
      </SetupFrame>
    );
  }

  const hint = locationStepHint(draft, Boolean(currency));
  return (
    <SetupFrame
      step="location"
      {...frame}
      footer={{
        onBack: () => setStep("property"),
        backDisabled: saving,
        primaryLabel: "Continue",
        onPrimary: () => void saveThen(() => onDone("room")),
        primaryDisabled: Boolean(hint),
        primaryBusy: saving,
        primaryBusyLabel: "Saving…",
        hint,
      }}
    >
      <SetupLocationStep
        draft={draft}
        onChange={change}
        error={error}
        socials={false}
        address={
          <QuickHotelAddress
            compact
            draft={draft}
            onChange={change}
            apiKey={googleMapsApiKey}
            currency={currency}
            onCurrencyChange={(code) => change({ currency: code })}
            hotelName={draft.displayName}
            resolveShortLink={mapsLinkApi.resolveShortLink}
          />
        }
      />
    </SetupFrame>
  );
}
