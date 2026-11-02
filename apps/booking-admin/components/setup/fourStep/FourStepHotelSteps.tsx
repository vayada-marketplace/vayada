"use client";

import type { SharedHotelSetupApi } from "@vayada/product-onboarding";
import { useEffect, useState, type ReactNode } from "react";

import {
  HotelFirstRunError,
  type HotelFirstRunClient,
  type HotelFirstRunState,
} from "@/services/api/hotelFirstRunClient";
import type { RoomAuthoringClient } from "@/services/api/roomAuthoringClient";
import type { RoomAuthoringDraft } from "../adaptive/rooms/roomAuthoringState";
import { currencySymbol } from "../quick/quickHotelCurrency";
import { SetupFrame, type SetupFooterProps, type SetupStepId } from "./SetupFrame";
import { SetupPaymentsStep, type SetupPaymentChoices } from "./SetupPaymentsStep";
import { SetupRoomBasics } from "./SetupRoomBasics";
import { SetupRoomChoice, type SetupRoomChoiceValue } from "./SetupRoomChoice";
import { newSetupRoom, roomBasicsHint, setupRoomFromSaved, SETUP_ROOM_DRAFT_ID } from "./setupRoom";

/** The server's FIRST_RUN_PLACEHOLDER_PRICE_PER_NIGHT, in the hotel's currency. */
const PLACEHOLDER_PRICE = "100";

export type FourStepHotelStepsProps = {
  propertyId: string;
  setup: Pick<SharedHotelSetupApi, "getPropertyProfile">;
  firstRun: Pick<HotelFirstRunClient, "read" | "run">;
  rooms: Pick<RoomAuthoringClient, "loadWorkspace" | "saveRoom">;
  /** The hotel's pricing currency (saved with the hotel at step 2). */
  readCurrency: (propertyId: string) => Promise<string | null>;
  /** The step the URL asks for (?step=, e.g. a dashboard tile); otherwise where setup stopped. */
  initialStep?: SetupStepId | null;
  /** Steps 1 and 2 of a hotel that exists, edited in place; without it they can't be reopened here. */
  onEditHotel?: ((step: "property" | "location") => void) | null;
  onSaveAndExit: () => void;
  /** After Finish setup: to the dashboard, which says setup is complete. */
  onFinished: () => void;
};

type View =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "room"; part: "choose" | "basics" }
  | { kind: "payments" };

const finishedSetup = (state: HotelFirstRunState) =>
  state.steps.every(
    (step) => !["payments", "plan", "guest_rules"].includes(step.id) || step.state === "done",
  );

const roomError = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : "We couldn't save your room. Try again in a moment.";

const finishError = (error: unknown) =>
  error instanceof HotelFirstRunError && error.code === "first_run_in_progress"
    ? "Setup is still finishing from a moment ago. Try again in a few seconds."
    : "We couldn't finish setup. Everything is saved; try again in a moment.";

/**
 * VAY-2451 steps 3 and 4 for a hotel that exists: the first room type (optional; made under the first run's
 * draft id through the PMS room commands, as Rooms & Rates makes rooms) and how guests pay, whose
 * "Finish setup" runs the server's first run: the placeholder price, payments, calendar, guest rules, the
 * Commission plan, and the hotel goes live. Where to start is read from the hotel's data, so a resume on any
 * device lands on the right step.
 */
export function FourStepHotelSteps({
  propertyId,
  setup,
  firstRun,
  rooms,
  readCurrency,
  initialStep = null,
  onEditHotel,
  onSaveAndExit,
  onFinished,
}: FourStepHotelStepsProps) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [name, setName] = useState("Your property");
  const [currency, setCurrency] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [room, setRoom] = useState<RoomAuthoringDraft>(newSetupRoom);
  const [choice, setChoice] = useState<SetupRoomChoiceValue>("now");
  const [payments, setPayments] = useState<SetupPaymentChoices>({ card: false, bank: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setView({ kind: "loading" });
    void (async () => {
      try {
        const profile = await setup.getPropertyProfile(propertyId, { cache: "no-store" });
        const state = await firstRun.read(propertyId);
        const [saved] = await rooms.loadWorkspace(propertyId, [SETUP_ROOM_DRAFT_ID], {
          cache: "no-store",
        });
        const code = await readCurrency(propertyId).catch(() => null);
        if (!active) return;
        setName(profile.profile.displayName || "Your property");
        setCurrency(code);
        if (saved) setRoom(setupRoomFromSaved(saved));
        const done = finishedSetup(state);
        setFinished(done);
        if (done && !initialStep) return onSaveAndExit();
        if (initialStep === "payments") return setView({ kind: "payments" });
        if (initialStep === "room")
          return setView({ kind: "room", part: saved ? "basics" : "choose" });
        setView(saved ? { kind: "payments" } : { kind: "room", part: "choose" });
      } catch {
        if (active) setView({ kind: "unavailable" });
      }
    })();
    return () => {
      active = false;
    };
    // The URL's step only picks where to open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, setup, firstRun, rooms, reload]);

  const go = (next: View) => {
    setError(null);
    setView(next);
  };
  const pick = (step: SetupStepId) => {
    if (step === "property" || step === "location") onEditHotel?.(step);
    else if (step === "room") go({ kind: "room", part: room.roomTypeId ? "basics" : "choose" });
    else go({ kind: "payments" });
  };

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

  const frame = (
    step: "room" | "payments",
    footer: SetupFooterProps,
    children: ReactNode,
    subStep?: string,
  ) => (
    <SetupFrame
      step={step}
      reached={step === "room" ? 2 : 3}
      finished={finished}
      propertyName={name}
      subStep={subStep}
      onPickStep={pick}
      canPickStep={(step) => Boolean(onEditHotel) || (step !== "property" && step !== "location")}
      onSaveAndExit={onSaveAndExit}
      saveAndExitDisabled={busy}
      footer={footer}
    >
      {children}
      {error ? (
        <p role="alert" className="mt-5 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </SetupFrame>
  );
  const skip = { onSkip: () => go({ kind: "payments" }), skipDisabled: busy };

  if (view.kind === "room" && view.part === "choose") {
    const symbol = currency ? currencySymbol(currency) : "";
    return frame(
      "room",
      {
        onBack: onEditHotel ? () => onEditHotel("location") : null,
        primaryLabel: "Continue",
        onPrimary: () =>
          go(choice === "skip" ? { kind: "payments" } : { kind: "room", part: "basics" }),
        ...skip,
      },
      <SetupRoomChoice
        value={choice}
        onChange={setChoice}
        placeholderPrice={`${symbol ? `${symbol} ` : ""}${PLACEHOLDER_PRICE}`}
      />,
    );
  }

  if (view.kind === "room") {
    const hint = roomBasicsHint(room);
    const save = async () => {
      setBusy(true);
      setError(null);
      try {
        setRoom(setupRoomFromSaved(await rooms.saveRoom({ propertyId, room })));
        go({ kind: "payments" });
      } catch (caught) {
        setError(roomError(caught));
      } finally {
        setBusy(false);
      }
    };
    return frame(
      "room",
      {
        onBack: () => go({ kind: "room", part: "choose" }),
        primaryLabel: "Continue",
        onPrimary: () => void save(),
        primaryDisabled: Boolean(hint),
        primaryBusy: busy,
        primaryBusyLabel: "Saving…",
        hint,
        ...skip,
      },
      <SetupRoomBasics room={room} onChange={setRoom} />,
      "Room basics, 1 of 3",
    );
  }

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await firstRun.run(propertyId, { guestPayment: "pay_at_property" });
      onFinished();
    } catch (caught) {
      setError(finishError(caught));
      setBusy(false);
    }
  };
  return frame(
    "payments",
    {
      onBack: () => go({ kind: "room", part: room.roomTypeId ? "basics" : "choose" }),
      primaryLabel: "Finish setup",
      onPrimary: () => void finish(),
      primaryBusy: busy,
      primaryBusyLabel: "Finishing…",
    },
    <SetupPaymentsStep choices={payments} onChange={setPayments} />,
  );
}
