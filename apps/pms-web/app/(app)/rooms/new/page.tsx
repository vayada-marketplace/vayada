"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeftIcon, CheckIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { roomsService, RoomTypeCreate, type PropertyPlan } from "@/services/rooms";
import RoomTypeForm from "@/components/rooms/RoomTypeForm";
import { useTranslation } from "@/lib/i18n";

export default function NewRoomPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const onboarding = searchParams.get("onboarding");
  const isOnboarding = onboarding === "pms-activation" || onboarding === "booking-readiness";
  const [saving, setSaving] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);
  const [createdRoomTypeId, setCreatedRoomTypeId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [propertyPlan, setPropertyPlan] = useState<PropertyPlan | null>(null);
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

  useEffect(() => {
    roomsService.getPropertyPlan().then(setPropertyPlan).catch(console.error);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name) {
      setError(t("rooms.new.nameRequired"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const created = await roomsService.create(form);
      if (isOnboarding) {
        setCreatedRoomTypeId(created.id);
        setSetupComplete(true);
      } else {
        router.push("/rooms");
      }
    } catch (err: any) {
      setError(err.message || t("rooms.new.failedToCreate"));
    } finally {
      setSaving(false);
    }
  };

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
          <p className="mt-3 leading-7 text-gray-600">{t("rooms.new.firstRoomReadyDescription")}</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            {createdRoomTypeId && (
              // A document navigation, so the Prices tab's leave warning also covers the browser's back button.
              <a
                href={`/rooms/${encodeURIComponent(createdRoomTypeId)}?tab=prices`}
                className="rounded-xl bg-primary-600 px-5 py-3 text-center text-sm font-semibold text-white transition-colors hover:bg-primary-700"
              >
                {t("rooms.new.setPrices")}
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
    <div className="max-w-5xl p-4 md:p-6">
      {isOnboarding && (
        <section className="mb-6 rounded-2xl border border-indigo-200 bg-indigo-50 p-5 sm:p-6">
          <p className="text-sm font-semibold text-indigo-700">{t("rooms.new.pmsSetup")}</p>
          <h1 className="mt-1 text-2xl font-bold text-gray-950">
            {t("rooms.new.setupRoomsAndRates")}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
            {t("rooms.new.setupDescription")}
          </p>
          <ol className="mt-5 grid gap-3 sm:grid-cols-2">
            {[
              ["1", t("rooms.new.stepDetails")],
              ["2", t("rooms.new.stepMedia")],
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

      <RoomTypeForm
        form={form}
        onChange={setForm}
        onSubmit={handleSubmit}
        saving={saving}
        error={error}
        submitLabel={isOnboarding ? t("rooms.new.finishSetup") : t("rooms.new.submitLabel")}
        cancelLabel={t("common.cancel")}
        cancelHref="/rooms"
        mode="create"
        propertyPlan={propertyPlan}
      />
    </div>
  );
}
