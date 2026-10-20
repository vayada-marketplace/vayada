"use client";

import type { SharedHotelSetupApi } from "@vayada/product-onboarding";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { QuickRoomStep } from "./QuickRoomStep";
import { QuickSetupShell } from "./QuickSetupShell";
import { currencySymbol, quickHotelCurrency } from "./quickHotelCurrency";
import { previewBookingHost } from "./quickHotelDraft";
import { EMPTY_QUICK_ROOM_DRAFT, type QuickRoomDraft } from "./quickRoomDraft";

export type QuickPropertySetupProps = {
  propertyId: string;
  /** Where the server's first-run state says the hotel stands. */
  initialStep: 3 | 4 | 5;
  setup: Pick<SharedHotelSetupApi, "getPropertyProfile">;
  /** The hotel's pricing currency once saved (null before the first run sets it). */
  readCurrency: (propertyId: string) => Promise<string | null>;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  onSaveAndExit: () => void;
  /** Steps 4 and 5 (how guests pay, go live) until their own PRs. */
  renderStep?: (step: 4 | 5, room: QuickRoomDraft) => ReactNode;
};

type Hotel = {
  name: string;
  place: string;
  url: string;
  currency: { code: string; symbol: string };
};

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
  storage = null,
  onSaveAndExit,
  renderStep,
}: QuickPropertySetupProps) {
  const [step, setStep] = useState(initialStep);
  const [hotel, setHotel] = useState<Hotel | null>(null);
  const [failed, setFailed] = useState(false);
  const [room, setRoom] = useState(() => readRoom(storage, propertyId));

  useEffect(() => {
    let active = true;
    void Promise.all([setup.getPropertyProfile(propertyId), readCurrency(propertyId)])
      .then(([response, savedCurrency]) => {
        if (!active) return;
        const { displayName, location } = response.profile;
        const code = savedCurrency ?? quickHotelCurrency(location.countryCode, "")?.code ?? "EUR";
        setHotel({
          name: displayName,
          place: [location.streetAddress, location.city].filter(Boolean).join(", "),
          url: previewBookingHost(displayName),
          currency: { code, symbol: currencySymbol(code) },
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

  return (
    renderStep?.(step, room) ?? (
      <QuickSetupShell step={step} onSaveAndExit={onSaveAndExit}>
        <p role="status" className="mt-24 text-center text-sm font-medium text-gray-600">
          {`Step ${step} comes next.`}
        </p>
      </QuickSetupShell>
    )
  );
}
