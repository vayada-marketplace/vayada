"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeftIcon, CheckIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { roomsService, RoomTypeCreate, type PropertyPlan, type RoomType } from "@/services/rooms";
import { roomOccupancyFromForm } from "@/services/rooms/roomFacts";
import { createReplacementPricingClient } from "@/services/api/replacementPricingClient";
import RoomTypeForm, { RoomTabBar, type RoomTab } from "@/components/rooms/RoomTypeForm";
import { keepNewRoomPrices } from "@/components/pricing/keptNewRoomPrices";
import { NewRoomPricesTab } from "@/components/pricing/NewRoomPricesTab";
import {
  pricesForRoom,
  publishNewRoomPrices,
  type NewRoomPrices,
} from "@/components/pricing/newRoomPrices";
import { errorText } from "@/components/pricing/pricingAmounts";
import { useTranslation } from "@/lib/i18n";

/** The guest numbers the room is created with, or null while the form's are not valid. */
function formCapacity(form: RoomTypeCreate) {
  try {
    const { maxGuests, maxAdults, maxChildren } = roomOccupancyFromForm(form);
    return [maxGuests, maxAdults, maxChildren].every(Number.isSafeInteger)
      ? { total: maxGuests, adults: maxAdults, children: maxChildren }
      : null;
  } catch {
    return null;
  }
}

export default function NewRoomPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const onboarding = searchParams.get("onboarding");
  const isOnboarding = onboarding === "pms-activation" || onboarding === "booking-readiness";
  // "Create Room Type" creates the room, then saves the prices typed on the Prices tab (VAY-2147).
  const [step, setStep] = useState<"room" | "prices" | null>(null);
  // A second press before the button disables must not create a second room or save the prices twice.
  const working = useRef(false);
  const [setupComplete, setSetupComplete] = useState(false);
  const [createdRoomTypeId, setCreatedRoomTypeId] = useState<string | null>(null);
  const [pricesSaved, setPricesSaved] = useState(false);
  const [error, setError] = useState("");
  const [propertyPlan, setPropertyPlan] = useState<PropertyPlan | null>(null);
  // As on a room's page, the Prices tab mounts once opened and stays mounted, so switching tabs keeps typed prices.
  const [tab, setTab] = useState<RoomTab>("details");
  const [pricesOpened, setPricesOpened] = useState(false);
  const [pricesEntered, setPricesEntered] = useState(false);
  const takePrices = useRef<(() => NewRoomPrices | null) | null>(null);
  // The prices' room until the server gives it its id.
  const [temporaryId] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState<RoomTypeCreate>({
    name: "",
    description: "",
    shortDescription: "",
    maxOccupancy: 2,
    maxAdults: null,
    maxChildren: null,
    bathroomType: "private",
    size: 0,
    locationAddress: "",
    latitude: null,
    longitude: null,
    bedType: "",
    totalRooms: 2,
    amenities: [],
    features: [],
    images: [],
    isActive: true,
    sortOrder: 0,
  });
  // Guest numbers are briefly invalid while being typed: the Prices tab keeps the last valid ones, and
  // "Create Room Type" checks the prices against the final ones.
  const capacity = formCapacity(form);
  const [lastCapacity, setLastCapacity] = useState(
    capacity ?? { total: 2, adults: 2, children: 2 },
  );
  if (capacity && JSON.stringify(capacity) !== JSON.stringify(lastCapacity))
    setLastCapacity(capacity);

  useEffect(() => {
    roomsService.getPropertyPlan().then(setPropertyPlan).catch(console.error);
  }, []);

  const showTab = (next: RoomTab) => {
    setTab(next);
    if (next === "prices") setPricesOpened(true);
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (working.current) return;
    if (!form.name) {
      setError(t("rooms.new.nameRequired"));
      setTab("details");
      return;
    }
    let prices: NewRoomPrices | null;
    try {
      prices = takePrices.current?.() ?? null;
      // Prices per number of guests must fit the final guest numbers; invalid ones the create refuses itself.
      if (prices && capacity) prices = pricesForRoom(prices, prices.room.roomTypeId, capacity);
    } catch (cause) {
      // Prices are optional: say how to create the room without them.
      setError(
        `${errorText(cause, t, "pricing.setup.errorCheck")} ${t("rooms.new.removePricesHint")}`,
      );
      showTab("prices");
      return;
    }
    working.current = true;
    setStep("room");
    setError("");
    let created: RoomType;
    try {
      created = await roomsService.create(form);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("rooms.new.failedToCreate"));
      working.current = false;
      setStep(null);
      return;
    }
    if (prices) {
      setStep("prices");
      let forRoom: NewRoomPrices | undefined;
      try {
        // The guest numbers were checked above; only the id changes.
        forRoom = pricesForRoom(prices, created.id, prices.room.capacity);
        await publishNewRoomPrices(createReplacementPricingClient(created.hotelId), forRoom);
      } catch (cause) {
        // The room exists: its Prices tab opens on these prices and says why they were not saved.
        if (forRoom) keepNewRoomPrices(forRoom, cause);
        router.replace(`/rooms/${encodeURIComponent(created.id)}?tab=prices`);
        return;
      }
    }
    if (isOnboarding) {
      setCreatedRoomTypeId(created.id);
      setPricesSaved(!!prices);
      setSetupComplete(true);
      working.current = false;
      setStep(null);
    } else {
      router.push("/rooms");
    }
  };

  const createLabel = isOnboarding ? t("rooms.new.finishSetup") : t("rooms.new.submitLabel");
  const busyLabel = t(step === "prices" ? "rooms.new.savingPrices" : "rooms.new.creatingRoom");

  if (setupComplete) {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-2xl items-center p-4 md:p-6">
        <section className="w-full rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-10">
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
            <CheckIcon className="h-7 w-7 text-emerald-700" aria-hidden="true" />
          </div>
          <p className="mb-2 text-sm font-semibold text-emerald-700">
            {t("rooms.new.setupComplete")}
          </p>
          <h1 className="text-2xl font-bold text-gray-950 sm:text-3xl">
            {t("rooms.new.firstRoomReady")}
          </h1>
          <p className="mt-3 leading-7 text-gray-600">
            {t(
              pricesSaved
                ? "rooms.new.firstRoomPricedDescription"
                : "rooms.new.firstRoomReadyDescription",
            )}
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            {createdRoomTypeId && (
              // A document navigation, so the Prices tab's leave warning also covers the browser's back button.
              <a
                href={`/rooms/${encodeURIComponent(createdRoomTypeId)}?tab=prices`}
                className="rounded-xl bg-primary-600 px-5 py-3 text-center text-sm font-semibold text-white transition-colors hover:bg-primary-700"
              >
                {t(pricesSaved ? "rooms.new.editPrices" : "rooms.new.setPrices")}
              </a>
            )}
            <button
              type="button"
              onClick={() => router.push("/rooms")}
              className="rounded-xl border border-gray-300 bg-white px-5 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
            >
              {t("rooms.new.continueToPms")}
            </button>
            <button
              type="button"
              onClick={() => {
                setForm((current) => ({
                  ...current,
                  name: "",
                  description: "",
                  shortDescription: "",
                  totalRooms: 2,
                  images: [],
                }));
                // The next room starts on Details with an empty Prices tab.
                setTab("details");
                setPricesOpened(false);
                setPricesEntered(false);
                setPricesSaved(false);
                setSetupComplete(false);
              }}
              className="rounded-xl border border-gray-300 bg-white px-5 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
            >
              {t("rooms.new.addAnotherRoomType")}
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    // The Prices tab has two columns (VAY-2125), so it gets more width than the other tabs.
    <div className={`p-4 md:p-6 ${tab === "prices" ? "max-w-6xl" : "max-w-5xl"}`}>
      {isOnboarding && (
        <section className="mb-6 rounded-2xl border border-indigo-200 bg-indigo-50 p-5 sm:p-6">
          <p className="text-sm font-semibold text-indigo-700">{t("rooms.new.pmsSetup")}</p>
          <h1 className="mt-1 text-2xl font-bold text-gray-950">
            {t("rooms.new.setupRoomsAndRates")}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
            {t("rooms.new.setupDescription")}
          </p>
          <ol className="mt-5 grid gap-3 sm:grid-cols-3">
            {[
              ["1", t("rooms.new.stepDetails")],
              ["2", t("rooms.new.stepPricing")],
              ["3", t("rooms.new.stepMedia")],
            ].map(([number, label]) => (
              <li
                key={number}
                className="flex items-center gap-3 rounded-xl border border-indigo-100 bg-white px-4 py-3 text-sm font-medium text-gray-800"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">
                  {number}
                </span>
                {label}
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="flex items-center gap-3 mb-5 md:mb-6">
        <Link
          href="/rooms"
          aria-label={t("rooms.new.backToRooms")}
          className="text-gray-400 hover:text-gray-600 shrink-0"
        >
          <ArrowLeftIcon className="w-5 h-5" />
        </Link>
        <h2 className="truncate text-xl font-bold text-gray-900">
          {isOnboarding ? t("rooms.new.firstRoomType") : t("rooms.new.title")}
        </h2>
      </div>

      <RoomTabBar tab={tab} onTabChange={showTab} />
      <RoomTypeForm
        form={form}
        onChange={setForm}
        onSubmit={handleSubmit}
        saving={!!step}
        savingLabel={busyLabel}
        error={error}
        submitLabel={createLabel}
        cancelLabel={t("common.cancel")}
        cancelHref="/rooms"
        mode="create"
        propertyPlan={propertyPlan}
        tab={tab}
        onTabChange={showTab}
        // Pressing "Create Room Type" saves typed prices too, which declares their mandatory charges.
        actionNote={pricesEntered ? t("pricing.newRoom.declaration") : undefined}
      />
      {pricesOpened && (
        <div hidden={tab !== "prices"}>
          {error && (
            <p
              role="alert"
              className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-[11px] font-medium text-red-700"
            >
              {error}
            </p>
          )}
          <NewRoomPricesTab
            room={{
              roomTypeId: temporaryId,
              name: form.name.trim() || t("rooms.new.title"),
              capacity: lastCapacity,
            }}
            facts={{ size: form.size && form.size > 0 ? form.size : null, photo: null }}
            take={takePrices}
            locked={!!step}
            onPrices={setPricesEntered}
            onAttention={() => showTab("prices")}
            actions={
              <>
                <Link
                  href="/rooms"
                  className="flex-1 md:flex-initial text-center px-4 py-2.5 md:py-2 text-[13px] md:text-[12px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 bg-white transition-colors"
                >
                  {t("common.cancel")}
                </Link>
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!!step}
                  className="flex-1 md:flex-initial px-6 py-2.5 md:py-2 bg-primary-600 text-white text-[13px] md:text-[12px] font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
                >
                  {step ? busyLabel : createLabel}
                </button>
              </>
            }
          />
        </div>
      )}
    </div>
  );
}
