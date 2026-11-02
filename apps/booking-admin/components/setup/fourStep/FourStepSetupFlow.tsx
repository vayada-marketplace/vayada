"use client";

import {
  isSharedAccountDetailsComplete,
  normalizeSharedAccountName,
  type SharedAccountDetailsInput,
  type SharedHotelSetupApi,
  type SharedPropertyTypeOption,
} from "@vayada/product-onboarding";
import type { AdaptiveHotelSetupStatus } from "@vayada/domain-hotels";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { mapsLinkApi } from "@/services/api/sharedHotelSetupClient";
import { QuickAboutYouStep } from "../quick/QuickAboutYouStep";
import { QuickBookingPagePreview } from "../quick/QuickBookingPagePreview";
import { QuickUseMyDetails } from "../quick/QuickHotelDetails";
import { QuickHotelAddress } from "../quick/QuickHotelAddress";
import { quickSetupLanguage } from "../quick/QuickSetupFlow";
import { QuickSetupPreviewCard } from "../quick/QuickSetupPreviewCard";
import { quickHotelCurrency } from "../quick/quickHotelCurrency";
import {
  EMPTY_QUICK_HOTEL_DRAFT,
  previewBookingHost,
  type QuickHotelDraft,
} from "../quick/quickHotelDraft";
import { saveQuickHotel } from "../quick/quickHotelSave";
import { FourStepHotelSteps, type FourStepHotelStepsProps } from "./FourStepHotelSteps";
import { SetupFrame, type SetupStepId } from "./SetupFrame";
import { SetupLocationStep } from "./SetupLocationStep";
import { SetupPropertyStep } from "./SetupPropertyStep";
import { SetupWelcome } from "./SetupWelcome";
import { locationStepHint, propertyStepHint } from "./setupDraft";

/** The same draft as the 7-step setup keeps, so switching setups never loses what the owner typed. */
const DRAFT_STORAGE_KEY = "vayada.quickSetup.v1.hotel";

export type FourStepSetupFlowProps = {
  account: { email: string; name: string | null; phone: string | null };
  saveAccount: (input: SharedAccountDetailsInput) => Promise<void>;
  setup: SharedHotelSetupApi;
  /** Saves the pricing currency: always at step 2, so the hotel's PMS (rooms) is open for step 3. */
  saveCurrency: (propertyId: string, currency: string) => Promise<void>;
  /** The hotel in the URL (?propertyId=), when setup resumes for one. */
  propertyId: string | null;
  onPropertyCreated: (propertyId: string) => void;
  onSaveAndExit: (propertyId: string | null) => void;
  googleMapsApiKey?: string | null;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** Steps 3 and 4 for a hotel that exists: the server's first run, the PMS room commands, its currency. */
  firstRun: FourStepHotelStepsProps["firstRun"];
  rooms: FourStepHotelStepsProps["rooms"];
  readCurrency: (propertyId: string) => Promise<string | null>;
  /** The step the URL asks for (?step=). */
  initialStep?: SetupStepId | null;
  /** After Finish setup. */
  onFinished: (propertyId: string) => void;
  /** Tests: in place of steps 3 and 4. */
  renderHotelSteps?: (propertyId: string) => ReactNode;
};

/** What this device keeps before the hotel exists: the draft, its create key and the step it was on. */
type Stored = {
  draft: QuickHotelDraft;
  draftKey: string;
  contactsFromAccount?: boolean;
  step?: "property" | "location";
};
type View =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "about_you" }
  | { kind: "welcome" }
  | { kind: "draft"; step: "property" | "location" }
  | { kind: "hotel"; propertyId: string };

function readStored(storage: FourStepSetupFlowProps["storage"]): Stored | null {
  try {
    const value = JSON.parse(storage?.getItem(DRAFT_STORAGE_KEY) ?? "null") as Stored | null;
    return value && typeof value.draftKey === "string" && value.draft
      ? {
          draftKey: value.draftKey,
          draft: { ...EMPTY_QUICK_HOTEL_DRAFT, ...value.draft },
          contactsFromAccount: value.contactsFromAccount === true,
          step: value.step === "location" ? "location" : "property",
        }
      : null;
  } catch {
    return null;
  }
}

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * VAY-2451: the four-step setup (behind FOUR_STEP_SETUP_ENABLED with ONBOARDING_V2). About you when the
 * account's name or phone is missing, the welcome card, then "Your property" and "Location & contact" kept
 * on this device until the last one's Continue creates the hotel; steps 3 and 4 follow for the hotel.
 */
export function FourStepSetupFlow(props: FourStepSetupFlowProps) {
  const { account, setup, storage = null } = props;
  const [view, setView] = useState<View>({ kind: "loading" });
  const [status, setStatus] = useState<AdaptiveHotelSetupStatus | null>(null);
  const [types, setTypes] = useState<readonly SharedPropertyTypeOption[]>([]);
  const [accountDone, setAccountDone] = useState(() =>
    isSharedAccountDetailsComplete({ name: account.name, phone: account.phone }),
  );
  const [name, setName] = useState(account.name);
  const [phone, setPhone] = useState(account.phone);
  const [resumed] = useState(() => readStored(storage));
  const [stored, setStored] = useState<Stored>(
    () => resumed ?? { draft: EMPTY_QUICK_HOTEL_DRAFT, draftKey: newKey() },
  );
  const [logo, setLogo] = useState<{ file: File; url: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setView({ kind: "loading" });
    void (async () => {
      try {
        const [nextStatus, catalog] = await Promise.all([
          setup.getStatus({ entryProduct: "booking", propertyId: props.propertyId }),
          setup.getPropertyTypes(),
        ]);
        if (!active) return;
        setStatus(nextStatus);
        setTypes(catalog.propertyTypes);
        const propertyId =
          props.propertyId ??
          (nextStatus.propertySelection.availableProperties.length === 1
            ? nextStatus.propertySelection.selectedPropertyId
            : null);
        if (!accountDone) return setView({ kind: "about_you" });
        if (propertyId) return setView({ kind: "hotel", propertyId });
        setView(
          resumed ? { kind: "draft", step: resumed.step ?? "property" } : { kind: "welcome" },
        );
      } catch {
        if (active) setView({ kind: "unavailable" });
      }
    })();
    return () => {
      active = false;
    };
    // accountDone only matters for the first decision; later changes move the view directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, props.propertyId, reload]);

  useEffect(() => {
    if (!logo) return;
    return () => URL.revokeObjectURL(logo.url);
  }, [logo]);

  const keep = useCallback(
    (update: (current: Stored) => Stored) =>
      setStored((current) => {
        const next = update(current);
        try {
          storage?.setItem(DRAFT_STORAGE_KEY, JSON.stringify(next));
        } catch {
          // A full or blocked storage only loses the resume, never the setup.
        }
        return next;
      }),
    [storage],
  );
  const changeDraft = useCallback(
    (patch: Partial<QuickHotelDraft>, contactsFromAccount?: boolean) =>
      keep((current) => ({
        ...current,
        draft: { ...current.draft, ...patch },
        ...(contactsFromAccount === undefined ? {} : { contactsFromAccount }),
      })),
    [keep],
  );
  const goTo = (step: "property" | "location") => {
    keep((current) => ({ ...current, step }));
    setSaveError(null);
    setView({ kind: "draft", step });
  };

  const currency = useMemo(
    () => quickHotelCurrency(stored.draft.countryCode, stored.draft.currency),
    [stored.draft.countryCode, stored.draft.currency],
  );
  const exit = () =>
    props.onSaveAndExit(view.kind === "hotel" ? view.propertyId : props.propertyId);

  if (view.kind === "loading" || view.kind === "unavailable") {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-gray-50 px-6">
        {view.kind === "loading" ? (
          <p role="status" className="text-sm font-medium text-gray-600">
            Loading your setup…
          </p>
        ) : (
          <div role="alert" className="max-w-md rounded-2xl border border-gray-200 bg-white p-6">
            <h1 className="text-lg font-semibold text-gray-950">
              Setup is temporarily unavailable
            </h1>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              Something on our side isn&apos;t answering. Your progress is saved — try again in a
              minute.
            </p>
            <button
              type="button"
              onClick={() => setReload((value) => value + 1)}
              className="mt-4 inline-flex h-11 items-center rounded-xl bg-primary-600 px-5 text-base font-semibold text-white hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
            >
              Try again
            </button>
          </div>
        )}
      </main>
    );
  }

  if (view.kind === "about_you") {
    return (
      <QuickAboutYouStep
        step={null}
        email={account.email}
        organizationName={status?.organization.displayName ?? null}
        initialName={name}
        initialPhone={phone}
        onSubmit={async (input) => {
          await props.saveAccount(input);
          setName(normalizeSharedAccountName(input.firstName, input.lastName));
          setPhone(input.phone);
          setAccountDone(true);
          setReload((value) => value + 1);
        }}
        onSaveAndExit={exit}
      />
    );
  }

  if (view.kind === "welcome") return <SetupWelcome onStart={() => goTo("property")} />;

  if (view.kind === "hotel") {
    return (
      props.renderHotelSteps?.(view.propertyId) ?? (
        <FourStepHotelSteps
          key={view.propertyId}
          propertyId={view.propertyId}
          setup={setup}
          firstRun={props.firstRun}
          rooms={props.rooms}
          readCurrency={props.readCurrency}
          initialStep={props.initialStep ?? null}
          onSaveAndExit={exit}
          onFinished={() => props.onFinished(view.propertyId)}
        />
      )
    );
  }

  const { draft } = stored;
  const propertyName = draft.displayName.trim() || "Your property";
  if (view.step === "property") {
    const hint = propertyStepHint(draft);
    return (
      <SetupFrame
        step="property"
        reached={0}
        propertyName={propertyName}
        onSaveAndExit={exit}
        footer={{
          onBack: () => setView({ kind: "welcome" }),
          primaryLabel: "Continue",
          onPrimary: () => goTo("location"),
          primaryDisabled: Boolean(hint),
          hint,
        }}
        aside={
          <QuickSetupPreviewCard caption="Your booking page, updating as you type">
            <QuickBookingPagePreview
              url={previewBookingHost(draft.displayName)}
              hotelName={propertyName}
              place={
                [draft.city.trim(), draft.countryCode].filter(Boolean).join(", ") ||
                "Your address comes next"
              }
              rooms={[]}
              currencySymbol={currency?.symbol}
            />
          </QuickSetupPreviewCard>
        }
      >
        <SetupPropertyStep
          draft={draft}
          onChange={changeDraft}
          propertyTypes={types}
          logoPreviewUrl={logo?.url ?? null}
          onLogoSelected={(file) => setLogo({ file, url: URL.createObjectURL(file) })}
        />
      </SetupFrame>
    );
  }

  const hint = locationStepHint(draft, Boolean(currency));
  const create = async () => {
    if (!status || !currency || hint) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveQuickHotel(
        {
          // WhatsApp is the phone until the owner unticks "Same as phone" (the box starts ticked).
          draft: { ...draft, whatsappSameAsPhone: draft.whatsappSameAsPhone !== false },
          currency,
          language: quickSetupLanguage(typeof navigator === "undefined" ? [] : navigator.languages),
          logo: logo?.file ?? null,
          organization: status.organization,
          draftKey: stored.draftKey,
          alwaysSaveCurrency: true,
        },
        { setup, saveCurrency: props.saveCurrency },
      );
      try {
        storage?.removeItem(DRAFT_STORAGE_KEY);
      } catch {
        // Nothing to clean up.
      }
      props.onPropertyCreated(saved.propertyId);
    } catch (error) {
      setSaveError(
        error instanceof Error && error.message
          ? error.message
          : "We couldn't save your property. Try again in a moment.",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <SetupFrame
      step="location"
      reached={1}
      propertyName={propertyName}
      onPickStep={(step) => {
        if (step === "property") goTo("property");
      }}
      onSaveAndExit={exit}
      saveAndExitDisabled={saving}
      footer={{
        onBack: () => goTo("property"),
        primaryLabel: "Continue",
        onPrimary: () => void create(),
        primaryDisabled: Boolean(hint),
        primaryBusy: saving,
        primaryBusyLabel: "Saving…",
        hint,
      }}
    >
      <SetupLocationStep
        draft={draft}
        onChange={changeDraft}
        error={saveError}
        contactsAction={
          !stored.contactsFromAccount && !draft.contactEmail && !draft.phone ? (
            <QuickUseMyDetails
              email={account.email}
              phone={phone}
              onUse={() => changeDraft({ contactEmail: account.email, phone: phone ?? "" }, true)}
            />
          ) : null
        }
        address={
          <QuickHotelAddress
            compact
            draft={draft}
            onChange={changeDraft}
            apiKey={props.googleMapsApiKey}
            currency={currency}
            onCurrencyChange={(code) => changeDraft({ currency: code })}
            hotelName={draft.displayName}
            resolveShortLink={mapsLinkApi.resolveShortLink}
          />
        }
      />
    </SetupFrame>
  );
}
