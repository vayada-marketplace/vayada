"use client";

import { firstRunBeds, isFirstRunBedChoice } from "@vayada/domain-booking";
import type { SharedHotelSetupApi } from "@vayada/product-onboarding";
import { useEffect, useState, type ReactNode } from "react";

import {
  HotelFirstRunError,
  type HotelFirstRunClient,
  type HotelFirstRunState,
} from "@/services/api/hotelFirstRunClient";
import type { RoomAuthoringClient } from "@/services/api/roomAuthoringClient";
import {
  ROOM_MEDIA_MAX_FILE_SIZE,
  type RoomAuthoringDraft,
} from "../adaptive/rooms/roomAuthoringState";
import { currencySymbol } from "../quick/quickHotelCurrency";
import { SetupFrame, type SetupFooterProps, type SetupStepId } from "./SetupFrame";
import { SetupPaymentsStep } from "./SetupPaymentsStep";
import { SetupRoomAmenities } from "./SetupRoomAmenities";
import { SetupRoomBasics } from "./SetupRoomBasics";
import { SetupRoomChoice, type SetupRoomChoiceValue } from "./SetupRoomChoice";
import { SETUP_PHOTO_TYPES, SetupRoomPhotos } from "./SetupRoomPhotos";
import {
  newSetupRoom,
  roomBasicsHint,
  SAME_AS_PROPERTY,
  setupRoomFromSaved,
  SETUP_ROOM_DRAFT_ID,
  type SetupRoomLocation,
} from "./setupRoom";
import { hotelDetailsStepToFinish, setupDraftFromProfile } from "./setupDraft";

/** The server's FIRST_RUN_PLACEHOLDER_PRICE_PER_NIGHT, in the hotel's currency. */
const PLACEHOLDER_PRICE = "100";

export type FourStepHotelStepsProps = {
  propertyId: string;
  setup: Pick<SharedHotelSetupApi, "getPropertyProfile">;
  firstRun: Pick<HotelFirstRunClient, "read" | "run">;
  rooms: Pick<
    RoomAuthoringClient,
    "loadWorkspace" | "saveRoom" | "uploadRoomPhotos" | "loadPhotoPlan"
  >;
  /** Saves where guests see the room (the PMS room type update Rooms & Rates uses). */
  saveRoomLocation: (
    propertyId: string,
    roomTypeId: string,
    location: SetupRoomLocation,
  ) => Promise<void>;
  /** The hotel's pricing currency (saved with the hotel at step 2). */
  readCurrency: (propertyId: string) => Promise<string | null>;
  /**
   * The step the URL asks for (?step=, a dashboard tile); otherwise where setup stopped. A finished setup
   * always leaves (`onAlreadyFinished`, else the dashboard).
   */
  initialStep?: SetupStepId | null;
  /** Steps 1 and 2 of this hotel, in the same frame (Back, the rail, and a hotel that lacks them). */
  onEditHotel?: ((step: "property" | "location") => void) | null;
  /** Where a finished setup goes instead (an old "Fix in setup" link's page); the dashboard by default. */
  onAlreadyFinished?: (() => void) | null;
  /** Whether a Fixed Fee checkout the 7-step setup started is still open in Stripe. */
  readCheckoutPending?: ((propertyId: string) => Promise<boolean>) | null;
  /** This device's storage: the 7-step setup kept its room answers there. */
  storage?: Pick<Storage, "getItem"> | null;
  onSaveAndExit: () => void;
  /** After Finish setup: to the dashboard, which says setup is complete. */
  onFinished: () => void;
};

type View =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "room"; part: "choose" | "basics" | "photos" | "amenities" }
  | { kind: "payments" };

/**
 * The first room the 7-step setup kept on this device for the hotel (VAY-2247, `vayada.quickSetup.v1.room.<id>`):
 * a hotel that started there continues with the same name, rooms, guests and bed. Its price isn't used (the
 * first run sets the placeholder; prices are set in Rooms & Rates).
 */
export function roomFromQuickSetup(
  storage: Pick<Storage, "getItem"> | null | undefined,
  propertyId: string,
): RoomAuthoringDraft | null {
  try {
    const value = JSON.parse(storage?.getItem(`vayada.quickSetup.v1.room.${propertyId}`) ?? "null");
    const first = value?.rooms?.[0];
    const name = typeof first?.name === "string" ? first.name.trim() : "";
    if (!name) return null;
    const whole = (raw: unknown, min: number, max: number) => {
      const count = Number(raw);
      return Number.isInteger(count) && count >= min && count <= max ? String(count) : null;
    };
    const room = newSetupRoom();
    const guests = whole(first.maxGuests, 1, 50) ?? room.maxGuests;
    const beds = isFirstRunBedChoice(value?.bed) ? firstRunBeds(value.bed) : null;
    return {
      ...room,
      name,
      unitCount: whole(first.numberOfRooms, 1, 500) ?? room.unitCount,
      maxGuests: guests,
      maxAdults: guests,
      beds: beds
        ? beds.map((bed, index) => ({
            id: `${SETUP_ROOM_DRAFT_ID}:bed:${index + 1}`,
            type: bed.type,
            quantity: String(bed.quantity),
          }))
        : room.beds,
    };
  } catch {
    return null;
  }
}

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
  saveRoomLocation,
  readCurrency,
  initialStep = null,
  onEditHotel = null,
  onAlreadyFinished = null,
  readCheckoutPending = null,
  storage = null,
  onSaveAndExit,
  onFinished,
}: FourStepHotelStepsProps) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [name, setName] = useState("Your property");
  const [currency, setCurrency] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomAuthoringDraft>(newSetupRoom);
  const [choice, setChoice] = useState<SetupRoomChoiceValue>("now");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [maxPhotos, setMaxPhotos] = useState(10);
  const [location, setLocation] = useState<SetupRoomLocation>(SAME_AS_PROPERTY);
  const [locationChanged, setLocationChanged] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [checkoutPending, setCheckoutPending] = useState(false);

  useEffect(() => {
    let active = true;
    setView({ kind: "loading" });
    void (async () => {
      try {
        const profile = await setup.getPropertyProfile(propertyId, { cache: "no-store" });
        const state = await firstRun.read(propertyId);
        // Every active room type comes back; setup edits only the one it made.
        const workspace = await rooms.loadWorkspace(propertyId, [SETUP_ROOM_DRAFT_ID], {
          cache: "no-store",
        });
        const saved = workspace.find((item) => item.draftRoomId === SETUP_ROOM_DRAFT_ID) ?? null;
        const code = await readCurrency(propertyId).catch(() => null);
        // The plan's photo limit (10 on Commission); 10 when it can't be read.
        const plan = await rooms.loadPhotoPlan(propertyId).catch(() => null);
        const pending = (await readCheckoutPending?.(propertyId).catch(() => false)) ?? false;
        if (!active) return;
        if (plan) setMaxPhotos(plan.maxRoomPhotosPerType);
        setName(profile.profile.displayName || "Your property");
        setCurrency(code);
        setCheckoutPending(pending);
        if (saved) setRoom(setupRoomFromSaved(saved));
        else {
          const started = roomFromQuickSetup(storage, propertyId);
          if (started) setRoom(started);
        }
        // Old links (?step=payments from "Fix in setup") must not run a finished first run again.
        if (finishedSetup(state)) return (onAlreadyFinished ?? onSaveAndExit)();
        // A hotel an older setup made without its address or contacts finishes them first.
        const details = onEditHotel
          ? hotelDetailsStepToFinish(setupDraftFromProfile(profile.profile, code))
          : null;
        if (details) return onEditHotel?.(details);
        if (initialStep === "payments") return setView({ kind: "payments" });
        if (initialStep === "room")
          return setView({ kind: "room", part: saved ? "basics" : "choose" });
        // A room without a photo can't be sold: its next part is the photos.
        if (saved && !saved.photos.length) return setView({ kind: "room", part: "photos" });
        // A hotel with rooms made elsewhere (Rooms & Rates, an import) needs no first room.
        setView(
          saved || workspace.length ? { kind: "payments" } : { kind: "room", part: "choose" },
        );
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
  /** Steps 1 and 2 open again when the host can show them. */
  const canPickStep = (step: SetupStepId) =>
    Boolean(onEditHotel) || step === "room" || step === "payments";

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

  /** Saves the room's location when the owner changed it (a separate one needs its address). */
  const saveLocation = async () => {
    if (!locationChanged || !room.roomTypeId) return;
    if (location.source === "custom" && !location.address.trim()) return;
    await saveRoomLocation(propertyId, room.roomTypeId, location);
    setLocationChanged(false);
  };
  /**
   * Saves the room as it stands (facts, rooms, uploaded photos, amenities) and its location, then `then`; a
   * failure stays on the screen with its message.
   */
  const saveRoomThen = async (then: () => void, draft = room) => {
    setBusy(true);
    setError(null);
    try {
      const photos = draft.photos.filter((photo) => photo.uploadState === "ready");
      setRoom(setupRoomFromSaved(await rooms.saveRoom({ propertyId, room: { ...draft, photos } })));
      await saveLocation();
      then();
    } catch (caught) {
      setError(roomError(caught));
    } finally {
      setBusy(false);
    }
  };
  /** While photos upload, nothing leaves the screen: they'd never be attached to the room. */
  const uploading = room.photos.some((photo) => photo.uploadState === "uploading");
  /**
   * Leaving the room's parts (Save & exit, Skip for now) keeps the owner's work: a room that exists is saved
   * as it stands, and Save & exit also creates it once its basics are complete.
   */
  const keepRoomThen = (then: () => void, create: boolean) => {
    const editing = view.kind === "room" && view.part !== "choose";
    if (!editing || roomBasicsHint(room) || (!room.roomTypeId && !create)) return then();
    void saveRoomThen(then);
  };

  const frame = (
    step: "room" | "payments",
    footer: SetupFooterProps,
    children: ReactNode,
    subStep?: string,
  ) => (
    <SetupFrame
      step={step}
      reached={step === "room" ? 2 : 3}
      propertyName={name}
      subStep={subStep}
      onPickStep={busy || uploading ? null : pick}
      canPickStep={canPickStep}
      onSaveAndExit={() => keepRoomThen(onSaveAndExit, true)}
      saveAndExitDisabled={busy || uploading}
      footer={{ backDisabled: busy || uploading, ...footer }}
    >
      {children}
      {error ? (
        <p role="alert" className="mt-5 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </SetupFrame>
  );
  const skip = {
    onSkip: () => keepRoomThen(() => go({ kind: "payments" }), false),
    // Photos still uploading would be lost.
    skipDisabled: busy || uploading,
  };

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

  if (view.kind === "room" && view.part === "photos") {
    const ready = room.photos.filter((photo) => photo.uploadState === "ready").length;
    const hint =
      ready === 0
        ? "Add at least one photo to continue"
        : uploading
          ? "Wait for the photos to finish uploading"
          : room.photos.some((photo) => photo.uploadState === "failed")
            ? "Remove the photos that didn't upload"
            : location.source === "custom" && !location.address.trim()
              ? "Add the room's address, or choose Same as property"
              : null;
    const addFiles = async (files: File[]) => {
      const { roomTypeId } = room;
      if (!roomTypeId) return;
      setPhotoError(null);
      const space = Math.max(0, maxPhotos - room.photos.length);
      const accepted = files.filter(
        (file) =>
          SETUP_PHOTO_TYPES.split(",").includes(file.type) && file.size <= ROOM_MEDIA_MAX_FILE_SIZE,
      );
      if (accepted.length < files.length)
        setPhotoError("Use JPG, PNG or WebP photos of up to 10 MB.");
      const chosen = accepted.slice(0, space);
      if (accepted.length > space) setPhotoError(`Up to ${maxPhotos} photos per room type.`);
      if (!chosen.length) return;
      const placeholders = chosen.map((file, index) => ({
        mediaObjectId: `pending:${Date.now()}:${index}`,
        previewUrl: URL.createObjectURL(file),
        uploadState: "uploading" as const,
        errorMessage: null,
      }));
      setRoom((current) => ({ ...current, photos: [...current.photos, ...placeholders] }));
      try {
        const uploaded = await rooms.uploadRoomPhotos({
          propertyId,
          roomTypeId,
          draftRoomId: SETUP_ROOM_DRAFT_ID,
          files: chosen,
        });
        setRoom((current) => ({
          ...current,
          photos: current.photos.map((photo) => {
            const at = placeholders.findIndex((item) => item.mediaObjectId === photo.mediaObjectId);
            return at < 0
              ? photo
              : {
                  ...photo,
                  mediaObjectId: uploaded[at]!.mediaObjectId,
                  uploadState: "ready" as const,
                };
          }),
        }));
      } catch {
        setPhotoError("The photos didn't upload. Remove them and try again.");
        setRoom((current) => ({
          ...current,
          photos: current.photos.map((photo) =>
            placeholders.some((item) => item.mediaObjectId === photo.mediaObjectId)
              ? { ...photo, uploadState: "failed" as const }
              : photo,
          ),
        }));
      }
    };
    return frame(
      "room",
      {
        onBack: () => go({ kind: "room", part: "basics" }),
        primaryLabel: "Continue",
        onPrimary: () => void saveRoomThen(() => go({ kind: "room", part: "amenities" })),
        primaryDisabled: Boolean(hint),
        primaryBusy: busy,
        primaryBusyLabel: "Saving…",
        hint,
        ...skip,
      },
      <SetupRoomPhotos
        room={room}
        onChange={setRoom}
        maxPhotos={maxPhotos}
        onAddFiles={(files) => void addFiles(files)}
        location={location}
        onLocationChange={(next) => {
          setLocation(next);
          setLocationChanged(true);
        }}
        photoError={photoError}
      />,
      "Photos & location, 2 of 3",
    );
  }

  if (view.kind === "room" && view.part === "amenities") {
    return frame(
      "room",
      {
        onBack: () => go({ kind: "room", part: "photos" }),
        primaryLabel: "Continue",
        onPrimary: () =>
          void saveRoomThen(() => go({ kind: "payments" }), {
            ...room,
            reviewedEmptyAmenities: true,
          }),
        primaryBusy: busy,
        primaryBusyLabel: "Saving…",
        ...skip,
      },
      <SetupRoomAmenities room={room} onChange={setRoom} />,
      "Amenities, 3 of 3",
    );
  }

  if (view.kind === "room") {
    const hint = roomBasicsHint(room);
    const save = () => saveRoomThen(() => go({ kind: "room", part: "photos" }));
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
      onBack: () => go({ kind: "room", part: room.roomTypeId ? "amenities" : "choose" }),
      primaryLabel: "Finish setup",
      onPrimary: () => void finish(),
      primaryBusy: busy,
      primaryBusyLabel: "Finishing…",
    },
    <SetupPaymentsStep checkoutPending={checkoutPending} />,
  );
}
