"use client";

import {
  isSharedAccountDetailsComplete,
  normalizeSharedAccountName,
  splitSharedAccountName,
  type SharedAccountDetailsInput,
  type SharedHotelSetupApi,
  type SharedPropertyTypeOption,
} from "@vayada/product-onboarding";
import {
  ArrowPathIcon,
  InformationCircleIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import { LANGUAGE_OPTIONS } from "@vayada/locale-constants";
import type { AdaptiveHotelSetupStatus } from "@vayada/domain-hotels";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  quickSetupStepForFirstRun,
  type HotelFirstRunClient,
} from "@/services/api/hotelFirstRunClient";
import { QuickAboutYouStep } from "./QuickAboutYouStep";
import { QuickContactsFromAccountNote, QuickUseMyDetails } from "./QuickHotelDetails";
import { QuickHotelAddress } from "./QuickHotelAddress";
import { QuickHotelStep } from "./QuickHotelStep";
import { QuickPropertySetup, type QuickSetupPage } from "./QuickPropertySetup";
import { QuickSetupShell } from "./QuickSetupShell";
import { quickHotelCurrency } from "./quickHotelCurrency";
import { EMPTY_QUICK_HOTEL_DRAFT, type QuickHotelDraft } from "./quickHotelDraft";
import { saveQuickHotel } from "./quickHotelSave";
import type { QuickPublicationClient } from "./useQuickPublication";

const DRAFT_STORAGE_KEY = "vayada.quickSetup.v1.hotel";

export type QuickSetupFlowProps = {
  account: { email: string; name: string | null; phone: string | null };
  saveAccount: (input: SharedAccountDetailsInput) => Promise<void>;
  setup: SharedHotelSetupApi;
  firstRun: HotelFirstRunClient;
  saveCurrency: (propertyId: string, currency: string) => Promise<void>;
  /** The hotel's saved pricing currency, or null before the first run sets it. */
  readCurrency: (propertyId: string) => Promise<string | null>;
  /** Whether a Fixed Fee checkout is already open in Stripe (null when unknown). */
  readCheckoutPending: (propertyId: string) => Promise<boolean | null>;
  /** Opens Stripe's checkout for the Fixed Fee (a full-page redirect). */
  openCheckout: (url: string) => void;
  /** The hotel in the URL (?propertyId=), when setup resumes for one. */
  propertyId: string | null;
  onPropertyCreated: (propertyId: string) => void;
  onSaveAndExit: (propertyId: string | null) => void;
  googleMapsApiKey?: string | null;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** Steps 3–5 (first room and price, how guests pay, go live) for a hotel that exists. */
  renderHotelStep?: (step: 3 | 4 | 5, propertyId: string) => ReactNode;
  /** Step 5: the setup "Booking Engine" card's review and publish API. */
  publication: QuickPublicationClient;
  organizationId: string;
  /** Where step 5 keeps its publish request for recovery (the browser's local storage). */
  publicationStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** Opens a page setup hands over to, for this hotel. */
  openPage: (page: QuickSetupPage, propertyId: string) => void;
};

/** The hotel draft kept on this device, and whether its contacts came from "Use my details". */
type Stored = { draft: QuickHotelDraft; draftKey: string; contactsFromAccount?: boolean };
type View =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "about_you" }
  | { kind: "hotel"; resumed: boolean }
  | { kind: "property"; step: 3 | 4 | 5; propertyId: string };

function readStored(storage: QuickSetupFlowProps["storage"]): Stored | null {
  try {
    const value = JSON.parse(storage?.getItem(DRAFT_STORAGE_KEY) ?? "null") as Stored | null;
    return value && typeof value.draftKey === "string" && value.draft
      ? {
          draftKey: value.draftKey,
          draft: { ...EMPTY_QUICK_HOTEL_DRAFT, ...value.draft },
          contactsFromAccount: value.contactsFromAccount === true,
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

/** The booking page's first language: the browser's, when the booking page offers it. */
export function quickSetupLanguage(browser: readonly string[] | undefined): string {
  for (const tag of browser ?? []) {
    const code = tag.toLowerCase().split("-")[0];
    if (code && LANGUAGE_OPTIONS.some((option) => option.code === code)) return code;
  }
  return "en";
}

/**
 * VAY-2247: the new first run in Booking Admin (behind ONBOARDING_V2). About you when the account's
 * name or phone is missing, then Your hotel, then the hotel's own steps, resumed from the server's
 * first-run state. The hotel draft is kept on this device as the owner types.
 */
export function QuickSetupFlow(props: QuickSetupFlowProps) {
  const { account, setup, firstRun, storage = null } = props;
  const [view, setView] = useState<View>({ kind: "loading" });
  const [status, setStatus] = useState<AdaptiveHotelSetupStatus | null>(null);
  const [types, setTypes] = useState<readonly SharedPropertyTypeOption[]>([]);
  const [accountDone, setAccountDone] = useState(() =>
    isSharedAccountDetailsComplete({ name: account.name, phone: account.phone }),
  );
  const [name, setName] = useState(account.name);
  const [phone, setPhone] = useState(account.phone);
  // The draft kept on this device; "Welcome back" when there was one.
  const [resumedDraft] = useState(() => readStored(storage));
  const [stored, setStored] = useState<Stored>(
    () => resumedDraft ?? { draft: EMPTY_QUICK_HOTEL_DRAFT, draftKey: newKey() },
  );
  const [logo, setLogo] = useState<{ file: File; url: string } | null>(null);
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
        if (!propertyId) return setView({ kind: "hotel", resumed: Boolean(resumedDraft) });
        const state = await firstRun.read(propertyId);
        if (active)
          setView({ kind: "property", step: quickSetupStepForFirstRun(state), propertyId });
      } catch {
        if (active) setView({ kind: "unavailable" });
      }
    })();
    return () => {
      active = false;
    };
    // accountDone only matters for the first decision; later changes move the view directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, firstRun, props.propertyId, reload]);

  useEffect(() => {
    if (!logo) return;
    return () => URL.revokeObjectURL(logo.url);
  }, [logo]);

  const changeDraft = useCallback(
    (patch: Partial<QuickHotelDraft>, contactsFromAccount?: boolean) =>
      setStored((current) => {
        const next = {
          ...current,
          draft: { ...current.draft, ...patch },
          ...(contactsFromAccount === undefined ? {} : { contactsFromAccount }),
        };
        try {
          storage?.setItem(DRAFT_STORAGE_KEY, JSON.stringify(next));
        } catch {
          // A full or blocked storage only loses the resume, never the setup.
        }
        return next;
      }),
    [storage],
  );

  const currency = useMemo(
    () => quickHotelCurrency(stored.draft.countryCode, stored.draft.currency),
    [stored.draft.countryCode, stored.draft.currency],
  );
  const exit = () =>
    props.onSaveAndExit(view.kind === "property" ? view.propertyId : props.propertyId);

  if (view.kind === "loading") {
    return (
      <QuickSetupShell step={null}>
        <p role="status" className="mt-24 text-center text-sm font-medium text-gray-600">
          Loading your setup…
        </p>
      </QuickSetupShell>
    );
  }

  if (view.kind === "unavailable") {
    return (
      <QuickSetupShell step={2} onSaveAndExit={exit}>
        <div className="mx-auto mt-14 w-full max-w-[640px] px-4 lg:mt-24">
          <div role="alert" className="rounded-2xl border border-gray-200 bg-white p-6 lg:p-[30px]">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
              <WrenchScrewdriverIcon className="h-5 w-5" aria-hidden="true" />
            </span>
            <h1 className="mt-4 text-lg font-semibold text-gray-950">
              Setup is temporarily unavailable
            </h1>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              Something on our side isn&apos;t answering. Your progress is saved — try again in a
              minute.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setReload((value) => value + 1)}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-primary-600 px-5 text-base font-semibold text-white hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
              >
                <ArrowPathIcon className="h-5 w-5" aria-hidden="true" />
                Try again
              </button>
              <button
                type="button"
                onClick={exit}
                className="inline-flex h-11 items-center rounded-full border border-gray-300 bg-white px-5 text-base font-semibold text-gray-950 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
              >
                Back to dashboard
              </button>
            </div>
          </div>
        </div>
      </QuickSetupShell>
    );
  }

  if (view.kind === "about_you") {
    return (
      <QuickAboutYouStep
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

  if (view.kind === "property") {
    return (
      props.renderHotelStep?.(view.step, view.propertyId) ?? (
        <QuickPropertySetup
          key={view.propertyId}
          propertyId={view.propertyId}
          initialStep={view.step}
          setup={setup}
          readCurrency={props.readCurrency}
          firstRun={firstRun}
          readCheckoutPending={props.readCheckoutPending}
          openCheckout={props.openCheckout}
          storage={storage}
          onSaveAndExit={exit}
          publication={props.publication}
          organizationId={props.organizationId}
          publicationStorage={props.publicationStorage}
          openPage={(page) => props.openPage(page, view.propertyId)}
        />
      )
    );
  }

  const firstName = splitSharedAccountName(name).firstName;
  return (
    <QuickHotelStep
      draft={stored.draft}
      onChange={changeDraft}
      propertyTypes={types}
      currencySymbol={currency?.symbol}
      banner={
        view.resumed ? (
          <p className="flex gap-3 rounded-xl border border-primary-100 bg-primary-50 px-4 py-3 text-[13px] leading-5 text-primary-800">
            <InformationCircleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {`Welcome back${firstName ? `, ${firstName}` : ""}. Everything you entered is saved — you're on step 2 of 5.`}
          </p>
        ) : null
      }
      address={(error) => (
        <QuickHotelAddress
          draft={stored.draft}
          onChange={changeDraft}
          error={error}
          apiKey={props.googleMapsApiKey}
          currency={currency}
          onCurrencyChange={(code) => changeDraft({ currency: code })}
        />
      )}
      contactsAction={
        !stored.contactsFromAccount && !stored.draft.contactEmail && !stored.draft.phone ? (
          <QuickUseMyDetails
            email={account.email}
            phone={phone}
            onUse={() => changeDraft({ contactEmail: account.email, phone: phone ?? "" }, true)}
          />
        ) : null
      }
      contactsNote={stored.contactsFromAccount ? <QuickContactsFromAccountNote /> : null}
      logoPreviewUrl={logo?.url ?? null}
      onLogoSelected={(file) => setLogo({ file, url: URL.createObjectURL(file) })}
      onSubmit={async (draft) => {
        if (!status || !currency)
          throw new Error("Choose your address from the list, or enter it manually.");
        const saved = await saveQuickHotel(
          {
            draft,
            currency,
            language: quickSetupLanguage(
              typeof navigator === "undefined" ? [] : navigator.languages,
            ),
            logo: logo?.file ?? null,
            organization: status.organization,
            draftKey: stored.draftKey,
          },
          { setup, saveCurrency: props.saveCurrency },
        );
        try {
          storage?.removeItem(DRAFT_STORAGE_KEY);
        } catch {
          // Nothing to clean up.
        }
        props.onPropertyCreated(saved.propertyId);
      }}
      onSaveAndExit={exit}
    />
  );
}
