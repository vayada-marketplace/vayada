"use client";

import type { SharedHotelSetupApi } from "@vayada/product-onboarding";

import { HotelFirstRunError, type HotelFirstRunClient } from "@/services/api/hotelFirstRunClient";
import { useCallback, useEffect, useState } from "react";

import type { QuickPreviewRoom } from "./QuickBookingPagePreview";
import { QuickGoLiveStep } from "./QuickGoLiveStep";
import { QuickLiveScreen } from "./QuickLiveScreen";
import { QuickPayStep, type QuickPlanChoice } from "./QuickPayStep";
import { QuickRoomStep } from "./QuickRoomStep";
import { QuickSetupShell } from "./QuickSetupShell";
import { currencySymbol, quickHotelCurrency } from "./quickHotelCurrency";
import { previewBookingHost } from "./quickHotelDraft";
import {
  EMPTY_QUICK_ROOM_DRAFT,
  quickRoomErrors,
  quickRoomRequest,
  type QuickRoomDraft,
} from "./quickRoomDraft";
import { useQuickPublication, type QuickPublicationClient } from "./useQuickPublication";

/** The pages setup hands over to: the defaults to review, and the next steps after going live. */
export type QuickSetupPage = "review" | "rooms_and_rates" | "design_studio" | "payment_settings";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type QuickPropertySetupProps = {
  propertyId: string;
  /** Where the server's first-run state says the hotel stands. */
  initialStep: 3 | 4 | 5;
  setup: Pick<SharedHotelSetupApi, "getPropertyProfile">;
  /** The hotel's pricing currency once saved (null before the first run sets it). */
  readCurrency: (propertyId: string) => Promise<string | null>;
  firstRun: Pick<HotelFirstRunClient, "run">;
  /** Whether a Fixed Fee checkout is already open in Stripe (null when unknown). */
  readCheckoutPending: (propertyId: string) => Promise<boolean | null>;
  /** Opens the Stripe checkout for the Fixed Fee. */
  openCheckout: (url: string) => void;
  storage?: Store | null;
  onSaveAndExit: () => void;
  /** The setup "Booking Engine" card's review and publish API, for step 5. */
  publication: QuickPublicationClient;
  organizationId: string;
  /** Where the publish request is kept for recovery (the browser's local storage). */
  publicationStorage: Store;
  openPage: (page: QuickSetupPage) => void;
  /** Copies the booking page link (the clipboard by default). */
  copyLink?: (url: string) => Promise<void>;
};

type Hotel = {
  name: string;
  place: string;
  url: string;
  currency: { code: string; symbol: string };
  checkoutPending: boolean;
};

/** What a stopped first run means for the owner. */
export function quickFirstRunErrorMessage(error: unknown): string {
  if (error instanceof HotelFirstRunError) {
    if (error.code === "first_run_in_progress")
      return "Your hotel is being set up in another tab. Try again in a moment.";
    if (error.code === "mandatory_charges_declaration_required")
      return "Confirm that your prices include taxes and fees.";
  }
  return "We couldn't finish setting up your hotel. Try again in a minute.";
}

export const quickRoomStorageKey = (propertyId: string) =>
  `vayada.quickSetup.v1.room.${propertyId}`;

function readRoom(storage: QuickPropertySetupProps["storage"], propertyId: string): QuickRoomDraft {
  try {
    const value = JSON.parse(storage?.getItem(quickRoomStorageKey(propertyId)) ?? "null");
    return value && typeof value === "object"
      ? { ...EMPTY_QUICK_ROOM_DRAFT, ...(value as Partial<QuickRoomDraft>) }
      : EMPTY_QUICK_ROOM_DRAFT;
  } catch {
    return EMPTY_QUICK_ROOM_DRAFT;
  }
}

/**
 * VAY-2247: the setup steps of a hotel that exists. "First room and price" keeps its answers on this
 * device; the first run is sent once "How guests pay" is answered (3.7), so nothing is written here.
 */
export function QuickPropertySetup({
  propertyId,
  initialStep,
  setup,
  readCurrency,
  firstRun,
  readCheckoutPending,
  openCheckout,
  storage = null,
  onSaveAndExit,
  publication,
  organizationId,
  publicationStorage,
  openPage,
  copyLink = (url) => navigator.clipboard.writeText(url),
}: QuickPropertySetupProps) {
  const [step, setStep] = useState(initialStep);
  const [hotel, setHotel] = useState<Hotel | null>(null);
  const [failed, setFailed] = useState(false);
  const [room, setRoom] = useState(() => readRoom(storage, propertyId));

  useEffect(() => {
    let active = true;
    void Promise.all([
      setup.getPropertyProfile(propertyId),
      readCurrency(propertyId),
      readCheckoutPending(propertyId).catch(() => null),
    ])
      .then(([response, savedCurrency, checkoutPending]) => {
        if (!active) return;
        const { displayName, location } = response.profile;
        const code = savedCurrency ?? quickHotelCurrency(location.countryCode, "")?.code ?? "EUR";
        setHotel({
          name: displayName,
          place: [location.streetAddress, location.city].filter(Boolean).join(", "),
          url: previewBookingHost(displayName),
          currency: { code, symbol: currencySymbol(code) },
          checkoutPending: checkoutPending === true,
        });
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

  const changeRoom = useCallback(
    (patch: Partial<QuickRoomDraft>) =>
      setRoom((current) => {
        const next = { ...current, ...patch };
        try {
          storage?.setItem(quickRoomStorageKey(propertyId), JSON.stringify(next));
        } catch {
          // A full or blocked storage only loses the resume.
        }
        return next;
      }),
    [propertyId, storage],
  );

  if (failed || !hotel) {
    return (
      <QuickSetupShell step={step} onSaveAndExit={onSaveAndExit}>
        <p
          role={failed ? "alert" : "status"}
          className="mt-24 text-center text-sm font-medium text-gray-600"
        >
          {failed ? "We couldn't load your hotel. Try again in a minute." : "Loading your hotel…"}
        </p>
      </QuickSetupShell>
    );
  }

  if (step === 3) {
    return (
      <QuickRoomStep
        draft={room}
        onChange={changeRoom}
        currency={hotel.currency}
        hotel={hotel}
        onSubmit={async () => setStep(4)}
        onSaveAndExit={onSaveAndExit}
      />
    );
  }

  if (step === 4) {
    return (
      <QuickPayStep
        hotel={hotel}
        currency={hotel.currency}
        room={previewRoom(room, hotel.currency.symbol)}
        checkoutPending={hotel.checkoutPending}
        initialPlan={hotel.checkoutPending ? "fixed_fee" : "commission"}
        onBack={() => setStep(3)}
        onSaveAndExit={onSaveAndExit}
        onSubmit={async (plan: QuickPlanChoice) => {
          // The room travels with the first run; without it on this device, ask for it again.
          if (Object.keys(quickRoomErrors(room, hotel.currency.code)).length > 0) {
            setStep(3);
            return;
          }
          let result;
          try {
            result = await firstRun.run(propertyId, {
              room: quickRoomRequest(room),
              pricesIncludeMandatoryCharges: room.pricesIncludeMandatoryCharges,
              guestPayment: "pay_at_property",
              plan,
            });
          } catch (error) {
            throw new Error(quickFirstRunErrorMessage(error));
          }
          if (result.checkoutUrl) {
            openCheckout(result.checkoutUrl);
            return;
          }
          setStep(5);
        }}
      />
    );
  }

  return (
    <QuickPublishSteps
      propertyId={propertyId}
      organizationId={organizationId}
      publication={publication}
      storage={publicationStorage}
      hotel={hotel}
      room={previewRoom(room, hotel.currency.symbol)}
      openPage={openPage}
      copyLink={copyLink}
      onSaveAndExit={onSaveAndExit}
    />
  );
}

/** The room as the preview shows it, once it has a name and a price. */
function previewRoom(room: QuickRoomDraft, symbol: string): QuickPreviewRoom | null {
  const name = room.name.trim();
  const price = room.pricePerNight.trim();
  if (!name || !price) return null;
  const guests = Number(room.maxGuests) || 1;
  return {
    name,
    details: `Up to ${guests} guest${guests === 1 ? "" : "s"} · Free cancellation until 3 days before`,
    price: `${symbol}${price}`,
  };
}

/** Step 5, "Does this look right?", and "You're live" once the booking page is published. */
function QuickPublishSteps({
  propertyId,
  organizationId,
  publication,
  storage,
  hotel,
  room,
  openPage,
  copyLink,
  onSaveAndExit,
}: {
  propertyId: string;
  organizationId: string;
  publication: QuickPublicationClient;
  storage: Store;
  hotel: Hotel;
  room: QuickPreviewRoom | null;
  openPage: (page: QuickSetupPage) => void;
  copyLink: (url: string) => Promise<void>;
  onSaveAndExit: () => void;
}) {
  const { state, publish, retry } = useQuickPublication({
    propertyId,
    organizationId,
    client: publication,
    storage,
  });
  if (state.kind === "live") {
    return (
      <QuickLiveScreen
        hotel={hotel}
        currency={hotel.currency}
        room={room}
        url={state.url}
        previewHost={hotel.url}
        copy={copyLink}
        onRoomsAndRates={() => openPage("rooms_and_rates")}
        onDesignStudio={() => openPage("design_studio")}
        onPaymentSettings={() => openPage("payment_settings")}
        onDashboard={onSaveAndExit}
      />
    );
  }
  return (
    <QuickGoLiveStep
      hotel={hotel}
      currency={hotel.currency}
      room={room}
      status={state}
      onPublish={() => void publish()}
      onRetry={() => void retry()}
      onDashboard={onSaveAndExit}
      onReview={() => openPage("review")}
      onSaveAndExit={onSaveAndExit}
    />
  );
}
