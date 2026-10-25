"use client";

import { useState, useEffect, use } from "react";
import { ArrowLeftIcon, TrashIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  roomsService,
  roomTypeUpdateForm,
  RoomType,
  RoomTypeUpdate,
  type PropertyPlan,
  type RoomTypeRetirementImpact,
} from "@/services/rooms";
import RoomTypeForm, { RoomTabBar, type RoomTab } from "@/components/rooms/RoomTypeForm";
import { RoomPricesTab } from "@/components/pricing/RoomPricesTab";
import { RoomsPricesStrip, usePropertyPrices } from "@/components/pricing/RoomsPrices";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  roomTypeDeleteBlockedMessage,
  roomTypeDeleteErrorText,
  roomTypeDeleteMessage,
} from "@/components/rooms/roomTypeDeleteText";
import { useTranslation } from "@/lib/i18n";
import { localizedErrorText } from "@/lib/i18n/localizedErrorText";

export default function EditRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useTranslation();
  const router = useRouter();
  const pricesFirst = useSearchParams().get("tab") === "prices";
  // The Prices tab mounts once opened and stays mounted, so switching tabs or saving room details keeps
  // unsaved prices.
  const [tab, setTab] = useState<RoomTab>(pricesFirst ? "prices" : "details");
  const [pricesOpened, setPricesOpened] = useState(pricesFirst);
  const showTab = (next: RoomTab) => {
    setTab(next);
    if (next === "prices") setPricesOpened(true);
  };
  const [room, setRoom] = useState<RoomType | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ cause: unknown; message: string } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // What Delete would do, read before the confirmation (VAY-2132).
  const [deleteImpact, setDeleteImpact] = useState<RoomTypeRetirementImpact | null>(null);
  const [checkingDelete, setCheckingDelete] = useState(false);
  // Shown under the tab bar on every tab: the form's own banner is hidden on the Prices tab.
  const [deleteError, setDeleteError] = useState("");
  const [propertyPlan, setPropertyPlan] = useState<PropertyPlan | null>(null);
  const [pricesNeedPublishing, setPricesNeedPublishing] = useState(false);
  const propertyPrices = usePropertyPrices();
  // Room details or republished prices changed what the Prices tab shows: it re-reads unless it holds edits.
  const [pricesRefresh, setPricesRefresh] = useState(0);
  const refreshPrices = () => setPricesRefresh((value) => value + 1);
  const stalePrices = !!propertyPrices.prices?.publication?.stale;
  useEffect(() => {
    // Once stale prices were seen the strip stays, so the outcome of "Save prices again" remains visible.
    if (stalePrices) setPricesNeedPublishing(true);
  }, [stalePrices]);
  // A details save changed what published prices pin: re-read them, so the one-click republish appears.
  const pricesChanged = () => {
    setPricesNeedPublishing(true);
    void propertyPrices.reload();
    refreshPrices();
  };

  const [form, setForm] = useState<RoomTypeUpdate>({});
  // The form keeps local input state; a new key re-reads every input from the saved room.
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    roomsService.getPropertyPlan().then(setPropertyPlan).catch(console.error);
    roomsService
      .get(id)
      .then((r) => {
        setRoom(r);
        setForm(roomTypeUpdateForm(r));
      })
      .catch((cause) => {
        console.error(cause);
        setLoadError({ cause, message: cause instanceof Error ? cause.message : "" });
      })
      .finally(() => setLoading(false));
  }, [id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!room) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const saved = await roomsService.update(id, form, room);
      setRoom(saved.roomType);
      setForm(roomTypeUpdateForm(saved.roomType));
      setFormKey((key) => key + 1);
      if (saved.pricesNeedPublishing) pricesChanged();
      refreshPrices();
      setSuccess(t("rooms.edit.success"));
    } catch (error) {
      setError(error instanceof Error ? error.message : t("rooms.edit.failedToUpdate"));
      // Keep the room the form was loaded from, so a retry still refuses a change made
      // elsewhere. Part of this edit may have saved what published prices pin.
      roomsService
        .get(id)
        .then((current) => {
          if (
            current.version !== room.version ||
            current.locationAddress !== room.locationAddress ||
            current.latitude !== room.latitude ||
            current.longitude !== room.longitude ||
            current.locationSource !== room.locationSource ||
            current.locationPrecision !== room.locationPrecision ||
            current.locationArea !== room.locationArea ||
            current.showMapInDetails !== room.showMapInDetails
          ) {
            pricesChanged();
          }
        })
        .catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  const openDelete = async () => {
    setDeleteError("");
    setSuccess("");
    setCheckingDelete(true);
    try {
      const impact = await roomsService.deleteImpact(id);
      if (impact.cleanup && !impact.canRetire) {
        setDeleteError(roomTypeDeleteBlockedMessage(t, impact));
        return;
      }
      setDeleteImpact(impact);
      setShowDeleteConfirm(true);
    } catch (error) {
      setDeleteError(roomTypeDeleteErrorText(t, error, t("rooms.edit.failedToRetire")));
    } finally {
      setCheckingDelete(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError("");
    try {
      // The Delete uses the impact the confirmation showed, including its version.
      await roomsService.delete(id, deleteImpact ?? undefined);
      router.push("/rooms");
    } catch (error) {
      setShowDeleteConfirm(false);
      setDeleteError(roomTypeDeleteErrorText(t, error, t("rooms.edit.failedToRetire")));
      setDeleting(false);
    }
  };
  const deleteCleanup = deleteImpact?.cleanup;

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-96 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="p-6">
        <p className={loadError !== null ? "text-red-600" : "text-gray-500"}>
          {loadError !== null
            ? localizedErrorText(
                loadError.cause,
                loadError.message || t("rooms.edit.failedToLoad"),
                t,
              )
            : t("rooms.edit.notFound")}
        </p>
        {loadError !== null && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {t("rooms.edit.retry")}
          </button>
        )}
      </div>
    );
  }

  return (
    // The Prices tab has two columns (VAY-2125), so it gets more width than the other tabs.
    <div className={`p-4 md:p-6 ${tab === "prices" ? "max-w-6xl" : "max-w-5xl"}`}>
      <div className="flex items-center justify-between gap-3 mb-5 md:mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/rooms" className="text-gray-400 hover:text-gray-600 shrink-0">
            <ArrowLeftIcon className="w-5 h-5" />
          </Link>
          <h1 className="text-xl font-bold text-gray-900 truncate">
            {t("rooms.edit.title", { name: room.name })}
          </h1>
        </div>
        <button
          onClick={() => void openDelete()}
          disabled={deleting || checkingDelete}
          aria-label={t("common.delete")}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 shrink-0"
        >
          <TrashIcon className="w-4 h-4" />
          <span className="hidden md:inline">{t("common.delete")}</span>
        </button>
      </div>

      <RoomTabBar tab={tab} onTabChange={showTab} />
      {deleteError && (
        <p
          role="alert"
          className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-[11px] text-red-700 font-medium"
        >
          {deleteError}
        </p>
      )}

      {pricesNeedPublishing && (
        <RoomsPricesStrip {...propertyPrices} staleOnly onSaved={refreshPrices} />
      )}

      <RoomTypeForm
        key={formKey}
        form={form}
        onChange={setForm}
        onSubmit={handleSubmit}
        saving={saving}
        error={error}
        success={success}
        submitLabel={t("rooms.edit.submitLabel")}
        cancelLabel={t("common.cancel")}
        cancelHref="/rooms"
        mode="edit"
        roomTypeId={id}
        propertyPlan={propertyPlan}
        tab={tab}
        onTabChange={showTab}
      />
      {pricesOpened && (
        <div hidden={tab !== "prices"}>
          <RoomPricesTab
            roomTypeId={id}
            refresh={pricesRefresh}
            // The strip shows the stale-prices banner only while its own read succeeds.
            staleShown={pricesNeedPublishing && stalePrices && !propertyPrices.error}
            onAttention={() => {
              setTab("prices");
              setPricesOpened(true);
            }}
            onPublished={() => void propertyPrices.reload()}
          />
        </div>
      )}
      {showDeleteConfirm && (
        <ConfirmDialog
          title={t("rooms.edit.deleteTitle")}
          message={
            deleteCleanup
              ? roomTypeDeleteMessage(t, room.name, deleteCleanup)
              : t("rooms.edit.deleteMessage")
          }
          confirmLabel={
            deleteCleanup
              ? deleting
                ? t("rooms.edit.deleting")
                : t("common.delete")
              : deleting
                ? t("rooms.edit.retiring")
                : t("rooms.edit.retire")
          }
          cancelLabel={t("common.cancel")}
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
