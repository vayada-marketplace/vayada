"use client";

import type { PropertyProfileResponse } from "@vayada/domain-hotels";
import type { SharedHotelSetupApi, SharedPropertyTypeOption } from "@vayada/product-onboarding";
import { useEffect, useMemo, useState } from "react";

import { QuickHotelAddress } from "./QuickHotelAddress";
import { QuickHotelStep } from "./QuickHotelStep";
import { QuickSetupShell } from "./QuickSetupShell";
import { quickHotelCurrency } from "./quickHotelCurrency";
import type { QuickHotelDraft } from "./quickHotelDraft";
import {
  quickHotelCurrencyToSave,
  quickHotelDraftFromProfile,
  quickHotelProfilePatch,
} from "./quickHotelEdit";

export type QuickHotelEditProps = {
  propertyId: string;
  setup: Pick<
    SharedHotelSetupApi,
    "getPropertyProfile" | "updatePropertyProfile" | "uploadPropertyLogo" | "assignPropertyLogo"
  >;
  propertyTypes: readonly SharedPropertyTypeOption[];
  readCurrency: (propertyId: string) => Promise<string | null>;
  saveCurrency: (propertyId: string, currency: string) => Promise<void>;
  googleMapsApiKey?: string | null;
  /** Back to step 3, after saving or without. */
  onDone: () => void;
  onSaveAndExit: () => void;
};

type Loaded = { profile: PropertyProfileResponse; savedCurrency: string | null };

/**
 * VAY-2247 "Your hotel" for a hotel that exists, opened with Back from step 3: the same form as step 2,
 * filled in from the hotel, saving what changed to its profile (and its currency, and a new logo).
 */
export function QuickHotelEdit({
  propertyId,
  setup,
  propertyTypes,
  readCurrency,
  saveCurrency,
  googleMapsApiKey,
  onDone,
  onSaveAndExit,
}: QuickHotelEditProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<QuickHotelDraft | null>(null);
  const [logo, setLogo] = useState<{ file: File; url: string } | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([setup.getPropertyProfile(propertyId), readCurrency(propertyId)])
      .then(([profile, savedCurrency]) => {
        if (!active) return;
        setLoaded({ profile, savedCurrency });
        setDraft(quickHotelDraftFromProfile(profile.profile, savedCurrency));
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
      <QuickSetupShell step={2} onSaveAndExit={onSaveAndExit}>
        <p
          role={failed ? "alert" : "status"}
          className="mt-24 text-center text-sm font-medium text-gray-600"
        >
          {failed ? "We couldn't load your hotel. Try again in a minute." : "Loading your hotel…"}
        </p>
      </QuickSetupShell>
    );
  }

  const change = (patch: Partial<QuickHotelDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  return (
    <QuickHotelStep
      draft={draft}
      onChange={change}
      propertyTypes={propertyTypes}
      currencySymbol={currency?.symbol}
      address={(error) => (
        <QuickHotelAddress
          draft={draft}
          onChange={change}
          error={error}
          apiKey={googleMapsApiKey}
          currency={currency}
          onCurrencyChange={(code) => change({ currency: code })}
        />
      )}
      logoPreviewUrl={logo?.url ?? null}
      onLogoSelected={(file) => setLogo({ file, url: URL.createObjectURL(file) })}
      // Back from the rooms step lands on the last of the three hotel screens.
      initialPart="contacts"
      onBack={onDone}
      onSaveAndExit={onSaveAndExit}
      onSubmit={async (next) => {
        if (!currency) throw new Error("Choose your address from the list, or enter it manually.");
        const { profile, savedCurrency } = loaded;
        const saved = await setup.updatePropertyProfile(
          propertyId,
          {
            expectedProfileRevision: profile.profileRevision,
            patch: quickHotelProfilePatch(next, profile.profile),
          },
          `quick-setup:edit:${propertyId}:${profile.profileRevision}`,
        );
        if (logo) {
          try {
            const mediaObjectId = await setup.uploadPropertyLogo(
              propertyId,
              logo.file,
              `quick-setup:edit-logo:${propertyId}:${saved.profileRevision}`,
            );
            await setup.assignPropertyLogo(
              propertyId,
              { expectedProfileRevision: saved.profileRevision, mediaObjectId, altText: null },
              `quick-setup:edit-logo-assign:${propertyId}:${saved.profileRevision}`,
            );
          } catch {
            // The logo is optional: it can be added in Design Studio.
          }
        }
        const currencyToSave = quickHotelCurrencyToSave(currency, savedCurrency);
        if (currencyToSave) await saveCurrency(propertyId, currencyToSave);
        onDone();
      }}
    />
  );
}
