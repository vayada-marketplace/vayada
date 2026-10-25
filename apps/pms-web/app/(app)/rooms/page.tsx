"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  PlusIcon,
  ChevronDownIcon,
  Cog6ToothIcon,
  DocumentDuplicateIcon,
  PencilIcon,
  CheckIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  roomsService,
  individualRoomsService,
  linkedInventoryGroupsService,
  type LinkedInventoryGroup,
  type RoomType,
  type Room,
} from "@/services/rooms";
import { ApiErrorResponse } from "@/services/api/client";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  RoomPriceSummary,
  RoomPricesLink,
  RoomsPricesStrip,
  usePropertyPrices,
  type PropertyPrices,
} from "@/components/pricing/RoomsPrices";
import { airbnbImportHref } from "@/components/settings/airbnbImportHref";
import { useTranslation } from "@/lib/i18n";
import { imageReferenceUrl } from "@/services/upload";
import LinkedInventoryDrawer from "./LinkedInventoryDrawer";
import LinkedInventoryGroupsPanel from "./LinkedInventoryGroupsPanel";
import RoomsMenu from "./RoomsMenu";

const CATEGORY_STYLES: Record<string, string> = {
  suite: "bg-blue-50 text-blue-600 border border-blue-200",
  villa: "bg-green-50 text-green-600 border border-green-200",
  standard: "bg-gray-50 text-gray-600 border border-gray-200",
  deluxe: "bg-purple-50 text-purple-600 border border-purple-200",
  bungalow: "bg-amber-50 text-amber-600 border border-amber-200",
  residence: "bg-teal-50 text-teal-600 border border-teal-200",
};

function getCategoryFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("suite")) return "suite";
  if (lower.includes("villa")) return "villa";
  if (lower.includes("deluxe")) return "deluxe";
  if (lower.includes("bungalow")) return "bungalow";
  if (lower.includes("residence")) return "residence";
  return "standard";
}

function getCategoryLabel(name: string): string {
  const cat = getCategoryFromName(name);
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

function isDuplicateRoomNumberError(error: unknown): boolean {
  return (
    error instanceof ApiErrorResponse &&
    error.status === 409 &&
    error.data.code === "operational_label_conflict"
  );
}

function RoomTypeCard({
  room,
  rooms,
  onRoomsChange,
  onDuplicate,
  duplicating,
  linkedGroup,
  prices,
}: {
  room: RoomType;
  rooms: Room[];
  onRoomsChange: () => void;
  onDuplicate: (id: string) => Promise<void>;
  duplicating: boolean;
  linkedGroup?: LinkedInventoryGroup;
  /** The property's published prices; null until read. */
  prices: PropertyPrices["prices"];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [addingRoom, setAddingRoom] = useState(false);
  const [newRoomNumber, setNewRoomNumber] = useState("");
  const [newRoomNumberError, setNewRoomNumberError] = useState<string | null>(null);
  const [newRoomFloor, setNewRoomFloor] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [editingRoomNumber, setEditingRoomNumber] = useState("");
  const [editingRoomNumberError, setEditingRoomNumberError] = useState<string | null>(null);
  const category = room.category ? room.category.toLowerCase() : getCategoryFromName(room.name);
  const categoryStyle = CATEGORY_STYLES[category] || CATEGORY_STYLES["standard"];

  const typeRooms = rooms.filter((r) => r.roomTypeId === room.id);
  const thumbnailUrl = imageReferenceUrl(room.images?.[0]);
  const facts = [
    t(typeRooms.length === 1 ? "rooms.roomCount.one" : "rooms.roomCount.other", {
      count: typeRooms.length,
    }),
    ...(room.maxOccupancy > 0
      ? [
          t(room.maxOccupancy === 1 ? "rooms.guestCount.one" : "rooms.guestCount.other", {
            count: room.maxOccupancy,
          }),
        ]
      : []),
    ...(room.size > 0 ? [t("rooms.sizeSqm", { size: room.size })] : []),
  ];

  const handleAddRoom = async () => {
    const trimmed = newRoomNumber.trim();
    if (!trimmed) return;
    if (
      rooms.some((candidate) => candidate.roomNumber.trim().toLowerCase() === trimmed.toLowerCase())
    ) {
      setNewRoomNumberError(t("rooms.duplicateRoomNumber"));
      return;
    }
    setActionError(null);
    try {
      await individualRoomsService.create({
        roomTypeId: room.id,
        roomNumber: trimmed,
        floor: newRoomFloor.trim(),
      });
      setNewRoomNumber("");
      setNewRoomFloor("");
      setAddingRoom(false);
      onRoomsChange();
    } catch (err: any) {
      if (isDuplicateRoomNumberError(err)) {
        setNewRoomNumberError(t("rooms.duplicateRoomNumber"));
        return;
      }
      setActionError(err.message || t("rooms.failedToAddRoom"));
    }
  };

  const handleDeleteRoom = (roomId: string) => {
    setConfirmDelete(roomId);
  };

  const doDeleteRoom = async () => {
    if (!confirmDelete) return;
    setConfirmDelete(null);
    setActionError(null);
    const room = rooms.find((candidate) => candidate.id === confirmDelete)!;
    try {
      await individualRoomsService.delete(room);
      onRoomsChange();
    } catch (err: any) {
      // The calendar needs every room type to keep a room. Where Delete on the room type does the
      // cleanup (VAY-2132), that is the way to remove it.
      const blockers =
        err instanceof ApiErrorResponse ? (err.data as { blockers?: unknown }).blockers : undefined;
      const lastRoom =
        Array.isArray(blockers) &&
        blockers.includes("operating_calendar") &&
        (await roomsService
          .deleteImpact(room.roomTypeId)
          .then((impact) => !!impact.cleanup)
          .catch(() => false));
      setActionError(
        lastRoom ? t("rooms.lastUnitDelete") : err.message || t("rooms.cannotDeleteRoom"),
      );
    }
  };

  const startRenameRoom = (roomId: string, currentNumber: string) => {
    setEditingRoomId(roomId);
    setEditingRoomNumber(currentNumber);
    setEditingRoomNumberError(null);
  };

  const cancelRenameRoom = () => {
    setEditingRoomId(null);
    setEditingRoomNumber("");
    setEditingRoomNumberError(null);
  };

  const saveRenameRoom = async (roomId: string, currentNumber: string) => {
    const trimmed = editingRoomNumber.trim();
    if (!trimmed || trimmed === currentNumber) {
      cancelRenameRoom();
      return;
    }
    if (
      rooms.some(
        (candidate) =>
          candidate.id !== roomId &&
          candidate.roomNumber.trim().toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      setEditingRoomNumberError(t("rooms.duplicateRoomNumber"));
      return;
    }
    setActionError(null);
    try {
      await individualRoomsService.update(rooms.find((room) => room.id === roomId)!, {
        roomNumber: trimmed,
      });
      cancelRenameRoom();
      onRoomsChange();
    } catch (err: any) {
      if (isDuplicateRoomNumberError(err)) {
        setEditingRoomNumberError(t("rooms.duplicateRoomNumber"));
        return;
      }
      setActionError(err.message || t("rooms.failedToRenameRoom"));
    }
  };

  const handleStatusChange = async (roomId: string, status: string) => {
    setActionError(null);
    try {
      await individualRoomsService.update(rooms.find((room) => room.id === roomId)!, { status });
      onRoomsChange();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("rooms.failedToChangeStatus"));
    }
  };

  return (
    <div className="border-b border-gray-100 last:border-b-0">
      {/* One line from lg; narrower screens stack the rates and actions under the name (VAY-2338). */}
      <div
        className={`flex cursor-pointer flex-col gap-3 px-3.5 py-3.5 transition-colors lg:flex-row lg:items-center lg:gap-4 lg:px-5 ${expanded ? "bg-gray-50/60" : "hover:bg-gray-50/50"}`}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3 lg:gap-4">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            aria-expanded={expanded}
            aria-controls={`rooms-of-${room.id}`}
            aria-label={t(expanded ? "rooms.hideRooms" : "rooms.showRooms", { name: room.name })}
            className="order-last flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 lg:order-first lg:h-6 lg:w-5"
          >
            <ChevronDownIcon
              className={`h-4 w-4 transition-transform ${expanded ? "rotate-180 lg:rotate-0" : "lg:-rotate-90"}`}
            />
          </button>

          {/* Room type thumbnail or fallback icon */}
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={room.name}
              className="h-12 w-12 shrink-0 rounded-[10px] object-cover lg:h-14 lg:w-14"
            />
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[10px] bg-blue-50 lg:h-14 lg:w-14">
              <svg
                className="h-5 w-5 text-blue-500"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 21V7a2 2 0 0 1 2-2h6v16" />
                <path d="M13 21V3h6a2 2 0 0 1 2 2v16" />
                <path d="M3 21h18" />
                <path d="M7 9h2" />
                <path d="M7 13h2" />
                <path d="M15 9h2" />
                <path d="M15 13h2" />
              </svg>
            </div>
          )}

          {/* Name + facts */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-base font-semibold text-gray-900">{room.name}</span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${categoryStyle}`}
              >
                {room.category || getCategoryLabel(room.name)}
              </span>
              {linkedGroup && (
                <span
                  title={t("rooms.linkedInventoryNamed", { name: linkedGroup.name })}
                  className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
                >
                  {t("rooms.linked")}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-sm text-gray-500">{facts.join(" · ")}</p>
          </div>
        </div>

        {/* Rates and actions: their own columns from lg, one line under the name below it. */}
        <div className="flex items-center gap-2 lg:contents">
          <div className="min-w-0 flex-1 lg:w-[200px] lg:flex-none">
            {prices && <RoomPriceSummary roomTypeId={room.id} publication={prices.publication} />}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2 lg:w-[200px]">
            {prices && <RoomPricesLink roomTypeId={room.id} publication={prices.publication} />}
            <button
              onClick={(e) => {
                e.stopPropagation();
                void onDuplicate(room.id);
              }}
              disabled={duplicating}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              title={duplicating ? t("rooms.duplicatingRoomType") : t("rooms.duplicateRoomType")}
              aria-label={duplicating ? t("rooms.duplicatingRoomType") : t("rooms.duplicateRoomType")}
            >
              <DocumentDuplicateIcon className="h-4 w-4" />
            </button>
            {/* A document navigation, so the room page's unsaved-prices warning also covers the browser's back button. */}
            <a
              href={`/rooms/${room.id}`}
              onClick={(e) => e.stopPropagation()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 transition-colors hover:bg-gray-50"
              title={t("rooms.configure")}
              aria-label={t("rooms.configureNamed", { name: room.name })}
            >
              <Cog6ToothIcon className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>

      {/* Expanded: the room type's rooms */}
      {expanded && (
        <div id={`rooms-of-${room.id}`} className="bg-gray-50/60 px-3.5 pb-4 lg:pl-32 lg:pr-5">
          {/* Individual rooms */}
          {typeRooms.length > 0 ? (
            typeRooms.map((r) => {
              const statusStyles: Record<string, string> = {
                available: "bg-green-50 text-green-600 border-green-200",
                maintenance: "bg-amber-50 text-amber-600 border-amber-200",
                out_of_order: "bg-red-50 text-red-600 border-red-200",
              };
              const isEditing = editingRoomId === r.id;
              return (
                <div
                  key={r.id}
                  className="flex items-center py-2.5 border-l-2 border-gray-200 pl-4 ml-1 hover:border-primary-400 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] text-gray-400">#</span>
                        <input
                          type="text"
                          autoFocus
                          value={editingRoomNumber}
                          onChange={(e) => {
                            setEditingRoomNumber(e.target.value);
                            setEditingRoomNumberError(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveRenameRoom(r.id, r.roomNumber);
                            else if (e.key === "Escape") cancelRenameRoom();
                          }}
                          aria-invalid={editingRoomNumberError ? true : undefined}
                          aria-describedby={
                            editingRoomNumberError ? `room-number-error-${r.id}` : undefined
                          }
                          className={`text-[13px] font-medium text-gray-800 px-2 py-1 border rounded-md focus:outline-none min-w-0 w-40 ${editingRoomNumberError ? "border-red-500 focus:border-red-500" : "border-primary-300 focus:border-primary-500"}`}
                        />
                        {editingRoomNumberError && (
                          <p
                            id={`room-number-error-${r.id}`}
                            role="alert"
                            className="basis-full text-xs text-red-600"
                          >
                            {editingRoomNumberError}
                          </p>
                        )}
                        {r.floor && (
                          <span className="text-gray-400 text-[11px]">
                            {t("rooms.floorNumber", { floor: r.floor })}
                          </span>
                        )}
                      </div>
                    ) : (
                      <p className="text-[13px] font-medium text-gray-800">
                        #{r.roomNumber}
                        {r.floor && (
                          <span className="text-gray-400 ml-1.5 text-[11px]">
                            {t("rooms.floorNumber", { floor: r.floor })}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  {isEditing ? (
                    <>
                      <button
                        onClick={() => saveRenameRoom(r.id, r.roomNumber)}
                        className="p-1 text-green-500 hover:text-green-600 transition-colors"
                        title={t("rooms.saveRename")}
                      >
                        <CheckIcon className="w-4 h-4" />
                      </button>
                      <button
                        onClick={cancelRenameRoom}
                        className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                        title={t("rooms.cancelRename")}
                      >
                        <XMarkIcon className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <select
                        value={r.status}
                        onChange={(e) => handleStatusChange(r.id, e.target.value)}
                        aria-label={t("rooms.statusLabel")}
                        className={`text-[11px] font-medium px-2.5 py-1 rounded-full border appearance-none cursor-pointer mr-2 disabled:cursor-not-allowed ${statusStyles[r.status] || statusStyles.available}`}
                      >
                        <option value="available">{t("rooms.statusAvailable")}</option>
                        <option value="maintenance">{t("rooms.statusMaintenance")}</option>
                        <option value="out_of_order">{t("rooms.statusOutOfOrder")}</option>
                      </select>
                      <button
                        onClick={() => startRenameRoom(r.id, r.roomNumber)}
                        className="p-1 text-gray-300 hover:text-primary-500 transition-colors disabled:cursor-not-allowed"
                        aria-label={t("rooms.renameRoom")}
                      >
                        <PencilIcon className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteRoom(r.id)}
                        className="p-1 text-gray-300 hover:text-red-500 transition-colors disabled:cursor-not-allowed"
                        aria-label={t("rooms.deleteRoom")}
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              );
            })
          ) : (
            <p className="text-[12px] text-gray-400 py-2">{t("rooms.noRoomsYet")}</p>
          )}

          {/* Add room form */}
          {addingRoom ? (
            <div className="flex flex-wrap items-center gap-2 mt-2 pl-4 ml-1 border-l-2 border-primary-300 py-2">
              <input
                type="text"
                value={newRoomNumber}
                onChange={(e) => {
                  setNewRoomNumber(e.target.value);
                  setNewRoomNumberError(null);
                }}
                placeholder={t("rooms.roomNumberPlaceholder")}
                aria-invalid={newRoomNumberError ? true : undefined}
                aria-describedby={newRoomNumberError ? "new-room-number-error" : undefined}
                className={`flex-1 min-w-[120px] md:flex-initial md:w-32 px-2.5 py-1.5 text-[12px] border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 ${newRoomNumberError ? "border-red-500" : "border-gray-200"}`}
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleAddRoom()}
              />
              {newRoomNumberError && (
                <p
                  id="new-room-number-error"
                  role="alert"
                  className="basis-full text-xs text-red-600"
                >
                  {newRoomNumberError}
                </p>
              )}
              <input
                type="text"
                value={newRoomFloor}
                onChange={(e) => setNewRoomFloor(e.target.value)}
                placeholder={t("rooms.floorPlaceholder")}
                className="w-20 px-2.5 py-1.5 text-[12px] border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                onKeyDown={(e) => e.key === "Enter" && handleAddRoom()}
              />
              <button
                onClick={handleAddRoom}
                className="px-3 py-1.5 text-[11px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
              >
                {t("common.add")}
              </button>
              <button
                onClick={() => {
                  setAddingRoom(false);
                  setNewRoomNumber("");
                  setNewRoomNumberError(null);
                  setNewRoomFloor("");
                }}
                className="px-2 py-1.5 text-[11px] text-gray-500 hover:text-gray-700"
              >
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAddingRoom(true)}
              className="mt-2 ml-5 inline-flex items-center gap-1.5 text-[11px] text-gray-500 font-medium hover:text-primary-600 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PlusIcon className="w-3.5 h-3.5" /> {t("rooms.addRoom")}
            </button>
          )}
          {actionError && (
            <p role="alert" className="mt-2 ml-5 text-[12px] text-red-600">
              {actionError}
            </p>
          )}
        </div>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t("rooms.deleteRoom")}
          message={t("rooms.deleteRoomConfirm")}
          confirmLabel={t("rooms.deleteRoom")}
          cancelLabel={t("common.cancel")}
          variant="danger"
          onConfirm={doDeleteRoom}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

import { PreparedHotelImportPanel } from "@vayada/product-onboarding/PreparedHotelImportPanel";
import { sharedSetupClient } from "@/services/api/sharedHotelSetupClient";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";

export default function RoomsPage() {
  const { t } = useTranslation();
  const [importPropertyId, setImportPropertyId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void resolveSelectedPmsPropertyId()
      .then((id) => {
        if (active) setImportPropertyId(id);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const [rooms, setRooms] = useState<RoomType[]>([]);
  const [individualRooms, setIndividualRooms] = useState<Room[]>([]);
  const [linkedGroups, setLinkedGroups] = useState<LinkedInventoryGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const loadRevision = useRef(0);
  const [linkedOpen, setLinkedOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [duplicatingRoomTypeIds, setDuplicatingRoomTypeIds] = useState<Set<string>>(new Set());
  const [duplicateError, setDuplicateError] = useState("");
  const propertyPrices = usePropertyPrices();

  const loadData = () => {
    const revision = ++loadRevision.current;
    setRefreshing(true);
    Promise.allSettled([
      roomsService.list(),
      individualRoomsService.list(),
      linkedInventoryGroupsService.list(),
    ])
      .then(([types, indRooms, groups]) => {
        if (revision !== loadRevision.current) return;
        setLoadFailed([types, indRooms, groups].some((result) => result.status === "rejected"));
        if (types.status === "fulfilled") setRooms(types.value);
        else console.error(types.reason);
        if (indRooms.status === "fulfilled") setIndividualRooms(indRooms.value);
        else console.error(indRooms.reason);
        if (groups.status === "fulfilled") setLinkedGroups(groups.value);
        else console.error(groups.reason);
      })
      .finally(() => {
        if (revision !== loadRevision.current) return;
        setLoading(false);
        setRefreshing(false);
      });
  };

  useEffect(() => {
    loadData();
    return () => {
      loadRevision.current++;
    };
  }, []);

  const refreshRooms = () => {
    loadData();
  };

  const handleDuplicate = async (id: string) => {
    setDuplicatingRoomTypeIds((current) => new Set(current).add(id));
    setDuplicateError("");
    try {
      await roomsService.duplicate(id);
      loadData();
    } catch (err: any) {
      setDuplicateError(err.message || t("rooms.failedToDuplicate"));
    } finally {
      setDuplicatingRoomTypeIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  // The subtitle carries the counts and the currency (VAY-2338).
  const publication = propertyPrices.prices?.publication;
  const summary = [
    t(rooms.length === 1 ? "rooms.roomTypeCount.one" : "rooms.roomTypeCount.other", {
      count: rooms.length,
    }),
    t(individualRooms.length === 1 ? "rooms.roomCount.one" : "rooms.roomCount.other", {
      count: individualRooms.length,
    }),
    ...(publication ? [t("rooms.pricesIn", { currency: publication.currency })] : []),
  ].join(" · ");

  return (
    <div className="p-4 md:p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-4 md:mb-5">
        <div className="min-w-0">
          <h1 className="text-2xl md:text-[26px] font-bold tracking-tight text-gray-900">
            {t("rooms.title")}
          </h1>
          {!loading && !(loadFailed && rooms.length === 0) && (
            <p className="mt-1 text-[13px] md:text-sm text-gray-500">{summary}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/rooms/new"
            className="inline-flex h-10 items-center gap-1.5 px-3 md:px-4 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 transition-colors"
          >
            <PlusIcon className="w-4 h-4" />
            <span className="hidden md:inline">{t("rooms.addRoomType")}</span>
            <span className="md:hidden">{t("common.add")}</span>
          </Link>
          {/* Set up once and rarely touched: the Airbnb import, linked inventory and room order (VAY-2338). */}
          <RoomsMenu
            buttonRef={menuButton}
            airbnbHref={importPropertyId ? airbnbImportHref(importPropertyId) : null}
            canReorder={individualRooms.length > 1}
            onLinkedInventory={() => setLinkedOpen(true)}
          />
        </div>
      </div>

      <RoomsPricesStrip {...propertyPrices} />

      {loadFailed && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <p>{t("rooms.loadFailed")}</p>
          <button
            type="button"
            onClick={refreshRooms}
            disabled={refreshing}
            className="mt-2 font-semibold underline disabled:opacity-50"
          >
            {t(refreshing ? "common.loading" : "common.retry")}
          </button>
        </div>
      )}
      {duplicateError && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {duplicateError}
        </p>
      )}
      {/* Shown only while an Airbnb import has rooms to review. */}
      {importPropertyId && (
        <PreparedHotelImportPanel
          key={`prepared-${importPropertyId}`}
          client={sharedSetupClient}
          propertyId={importPropertyId}
          roomsOnly
          onSaved={refreshRooms}
        />
      )}

      {/* Room Type List */}
      {loading ? (
        <div className="animate-pulse space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-20 bg-gray-50 rounded-xl" />
          ))}
        </div>
      ) : loadFailed && rooms.length === 0 ? null : rooms.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-16 text-center">
          <div className="w-14 h-14 bg-gray-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-7 h-7 text-gray-300"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 21V7a2 2 0 0 1 2-2h6v16" />
              <path d="M13 21V3h6a2 2 0 0 1 2 2v16" />
              <path d="M3 21h18" />
            </svg>
          </div>
          <p className="text-gray-500 text-sm mb-4">{t("rooms.noRoomTypes")}</p>
          <Link
            href="/rooms/new"
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors"
          >
            <PlusIcon className="w-4 h-4" />
            {t("rooms.addRoomType")}
          </Link>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          {/* Column labels; each row names its own content, so assistive tech skips them. */}
          <div
            aria-hidden="true"
            className="hidden lg:flex items-center gap-4 border-b border-gray-200 bg-gray-50 px-5 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500"
          >
            <span className="w-5 shrink-0" />
            <span className="flex-1">{t("rooms.columnRoomType")}</span>
            <span className="w-[200px] shrink-0">{t("rooms.columnRates")}</span>
            <span className="w-[200px] shrink-0 text-right">{t("rooms.columnActions")}</span>
          </div>
          {rooms.map((room) => (
            <RoomTypeCard
              key={room.id}
              room={room}
              rooms={individualRooms}
              onRoomsChange={refreshRooms}
              onDuplicate={handleDuplicate}
              duplicating={duplicatingRoomTypeIds.has(room.id)}
              linkedGroup={linkedGroups?.find((group) => group.memberRoomTypeIds.includes(room.id))}
              prices={propertyPrices.prices}
            />
          ))}
        </div>
      )}

      {linkedOpen && (
        <LinkedInventoryDrawer onClose={() => setLinkedOpen(false)} returnFocus={menuButton}>
          {linkedGroups ? (
            <LinkedInventoryGroupsPanel
              groups={linkedGroups}
              roomTypes={rooms}
              onChange={(update) => setLinkedGroups((groups) => (groups ? update(groups) : groups))}
            />
          ) : (
            <p role="status" className="text-sm text-gray-500">
              {t(loading || refreshing ? "common.loading" : "rooms.loadFailed")}
            </p>
          )}
        </LinkedInventoryDrawer>
      )}
    </div>
  );
}
