"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { XMarkIcon, PlusIcon, CheckIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import { RoomTypeCreate, RoomTypeUpdate, type PropertyPlan } from "@/services/rooms";
import ImageUpload from "@/components/ImageUpload";
import { pmsRoomMediaResource } from "@/services/upload";
import { parseBookingAmenities } from "@/lib/parseBookingAmenities";
import { SELECTED_PMS_PROPERTY_ID_KEY } from "@/lib/utils/pmsPropertySelectionKeys";
import { useTranslation } from "@/lib/i18n";

const BED_TYPES = [
  "King Bed",
  "Queen Bed",
  "Double Bed",
  "Twin Bed",
  "Single Bed",
  "Bunk Bed",
  "Sofa Bed",
];

const ROOM_CATEGORIES = [
  "Standard",
  "Deluxe",
  "Superior",
  "Suite",
  "Villa",
  "Bungalow",
  "Studio",
  "Penthouse",
];

const AMENITY_CATEGORIES = [
  {
    name: "Internet & Tech",
    items: [
      "Free WiFi",
      "Flat-screen TV",
      "Smart TV",
      "Netflix / Streaming",
      "Work desk",
      "Laptop-friendly workspace",
    ],
  },
  {
    name: "Kitchen",
    items: [
      "Minibar",
      "Refrigerator",
      "Microwave",
      "Kitchenware",
      "Electric kettle",
      "Stovetop",
      "Dining table",
    ],
  },
  {
    name: "Bathroom",
    items: [
      "Private Bathroom",
      "Bathtub",
      "Shower",
      "Free toiletries",
      "Hairdryer",
      "Toilet",
      "Toilet paper",
      "Hot Tub",
      "Towels",
      "Slippers",
      "Bathrobe",
    ],
  },
  {
    name: "Climate & Comfort",
    items: ["Air conditioning", "Heating", "Fan", "Fireplace"],
  },
  {
    name: "Bedroom",
    items: ["Extra pillows", "Blackout curtains", "Wardrobe", "Bed linen"],
  },
  {
    name: "Laundry",
    items: ["Washing machine", "Dryer", "Iron/Ironing board", "Clothes rack"],
  },
  {
    name: "Safety & Access",
    items: ["Safe", "Smoke detector", "First aid kit", "Fire extinguisher"],
  },
  {
    // Services such as parking or room service are property facts, not room amenities.
    name: "Services",
    items: ["Non-smoking"],
  },
];

const roomOptionMessageKey = (value: string): string =>
  `rooms.form.option.${value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")}`;

// Clamp a raw string from a number input to [min, max], treating empty/NaN as min.
// Used by inputs that allow a transient empty display string while typing.
const clampNumberInput = (raw: string, min: number, max?: number): number => {
  let n = Number(raw);
  if (!Number.isFinite(n) || raw === "") n = min;
  if (n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return n;
};

export type RoomTab = "details" | "prices" | "media";
const ROOM_TABS: { key: RoomTab; labelKey: string }[] = [
  { key: "details", labelKey: "rooms.form.tabDetails" },
  { key: "prices", labelKey: "rooms.form.tabPricing" },
  { key: "media", labelKey: "rooms.form.tabMedia" },
];

const SELECT_ARROW_STYLE = {
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
  backgroundRepeat: "no-repeat" as const,
  backgroundPosition: "right 12px center",
};

interface RoomTypeFormProps {
  form: RoomTypeCreate | RoomTypeUpdate;
  onChange: (form: any) => void;
  onSubmit: (e: React.FormEvent) => void;
  saving: boolean;
  error?: string;
  success?: string;
  submitLabel?: string;
  cancelHref?: string;
  cancelLabel?: string;
  onCancel?: () => void;
  // 'create' seeds how many physical rooms get auto-created. 'edit' lets
  // the user nudge the count up or down: the backend reconciles the
  // generated room units to match (VAY-406). The DB trigger keeps
  // total_rooms truthful so the VAY-402 oversell invariant still holds.
  mode?: "create" | "edit";
  roomTypeId?: string;
  propertyPlan: PropertyPlan | null;
  // With these the page owns the tab and adds the Prices tab (an existing room only). Its content has its own
  // save, so the page renders it outside this form, where remounting the form cannot drop unsaved prices.
  tab?: RoomTab;
  onTabChange?: (tab: RoomTab) => void;
}

function bedsToSummary(beds: { type: string; count: number }[]): string {
  return beds.map((b) => `${b.count} ${b.type}`).join(", ");
}

function parseBedType(bedType: string): { type: string; count: number }[] {
  if (!bedType || !bedType.trim()) return [{ type: "King Bed", count: 1 }];
  const parts = bedType
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((part) => {
    const match = part.match(/^(\d+)\s+(.+)$/);
    if (match) return { type: match[2], count: parseInt(match[1]) };
    return { type: part, count: 1 };
  });
}

export default function RoomTypeForm({
  form,
  onChange,
  onSubmit,
  saving,
  error,
  success,
  submitLabel,
  cancelHref = "/rooms",
  cancelLabel,
  onCancel,
  mode = "create",
  roomTypeId,
  propertyPlan,
  tab,
  onTabChange,
}: RoomTypeFormProps) {
  const { t } = useTranslation();
  const translateRoomOption = (value: string): string => {
    const key = roomOptionMessageKey(value);
    const translated = t(key);
    return translated === key ? value : translated;
  };
  const [ownTab, setOwnTab] = useState<RoomTab>("details");
  const activeTab = tab ?? ownTab;
  const setActiveTab = onTabChange ?? setOwnTab;
  const tabs = ROOM_TABS.filter((item) => item.key !== "prices" || onTabChange);
  const [latitudeInput, setLatitudeInput] = useState<string>(
    form.latitude != null ? String(form.latitude) : "",
  );
  const [longitudeInput, setLongitudeInput] = useState<string>(
    form.longitude != null ? String(form.longitude) : "",
  );
  const [amenityInput, setAmenityInput] = useState("");
  const [expandedAmenityCategories, setExpandedAmenityCategories] = useState<string[]>([
    "Internet & Tech",
  ]);
  const [customAmenityInputs, setCustomAmenityInputs] = useState<Record<string, string>>({});
  const [customAmenitiesByCategory, setCustomAmenitiesByCategory] = useState<
    Record<string, string[]>
  >({});
  const [bookingImportOpen, setBookingImportOpen] = useState(false);
  const [bookingImportText, setBookingImportText] = useState("");
  const [bookingImportResult, setBookingImportResult] = useState<{
    matchedCount: number;
    addedCount: number;
    fuzzy: { original: string; amenity: string }[];
    unmatched: string[];
  } | null>(null);
  const [beds, setBeds] = useState<{ type: string; count: number }[]>(() =>
    parseBedType(form.bedType || ""),
  );
  const [category, setCategory] = useState(form.category || "");
  const [bedrooms, setBedrooms] = useState(form.bedrooms ?? 1);
  const [bathrooms, setBathrooms] = useState(form.bathrooms ?? 1);
  // Display strings for the number inputs in the room-details grid. Held separately from
  // the committed numeric values so the user can fully clear a field before typing a new
  // number — onChange writes the raw string, onBlur clamps to [min, max] and rewrites it.
  const [maxOccupancyInput, setMaxOccupancyInput] = useState(String(form.maxOccupancy ?? 2));
  const [maxAdultsInput, setMaxAdultsInput] = useState(
    form.maxAdults == null ? "" : String(form.maxAdults),
  );
  const [maxChildrenInput, setMaxChildrenInput] = useState(
    form.maxChildren == null ? "" : String(form.maxChildren),
  );
  const [bedroomsInput, setBedroomsInput] = useState(String(form.bedrooms ?? 1));
  const [bathroomsInput, setBathroomsInput] = useState(String(form.bathrooms ?? 1));
  const [sizeInput, setSizeInput] = useState(String(form.size ?? 1));
  const [totalRoomsInput, setTotalRoomsInput] = useState(String(form.totalRooms ?? 2));

  // Sync beds -> form.bedType
  useEffect(() => {
    const summary = bedsToSummary(beds);
    onChange((prev: any) => (prev.bedType === summary ? prev : { ...prev, bedType: summary }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beds]);

  // Sync bedrooms/bathrooms -> form
  useEffect(() => {
    onChange((prev: any) =>
      prev.bedrooms === bedrooms && prev.bathrooms === bathrooms
        ? prev
        : { ...prev, bedrooms, bathrooms },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bedrooms, bathrooms]);

  const updateForm = (updates: Partial<RoomTypeCreate>) => {
    const updated = { ...form, ...updates };
    onChange(updated);
  };

  return (
    <form onSubmit={onSubmit}>
      {error && activeTab !== "prices" && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-[11px] text-red-700 font-medium">
          {error}
        </div>
      )}
      {success && activeTab !== "prices" && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-[11px] text-green-700 font-medium">
          {success}
        </div>
      )}

      {!onTabChange && (
        <p className="mb-4 rounded-lg border border-gray-200 bg-white p-3 text-[11px] text-gray-600">
          {t("rooms.form.pricingPointer")}{" "}
          <Link href="/pricing" className="font-semibold text-primary-600 hover:text-primary-700">
            {t("rooms.form.openPricing")}
          </Link>
        </p>
      )}

      {/* Tabs */}
      <div className="relative border-b border-gray-200 mb-5 md:mb-6">
        <div className="flex gap-5 md:gap-6 overflow-x-auto scrollbar-hide -mx-4 px-4 md:mx-0 md:px-0">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setActiveTab(item.key)}
              className={`shrink-0 whitespace-nowrap pb-2.5 text-[12px] font-medium transition-colors relative ${
                activeTab === item.key ? "text-gray-900" : "text-gray-400 hover:text-gray-600"
              }`}
            >
              {t(item.labelKey)}
              {activeTab === item.key && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gray-900 rounded-full" />
              )}
            </button>
          ))}
        </div>
        <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-gray-50 to-transparent pointer-events-none lg:hidden" />
      </div>

      {/* Tab 1: Room Details */}
      {activeTab === "details" && (
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-5 md:px-6 md:py-6 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">
              {t("rooms.form.roomTypeBasics")}
            </h3>
            <span className="text-[11px] font-medium text-red-500">
              {t("rooms.form.requiredLabel")}
            </span>
          </div>

          {/* Room Type Name */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-[12px] font-semibold text-gray-900">
                {t("rooms.form.roomTypeName")} <span className="text-red-500">*</span>
              </label>
            </div>
            <input
              type="text"
              value={form.name || ""}
              onChange={(e) => updateForm({ name: e.target.value })}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              placeholder={t("rooms.form.roomTypeNamePlaceholder")}
            />
            <p className="text-[10px] text-gray-400 mt-1">{t("rooms.form.roomTypeNameHint")}</p>
          </div>

          {/* Beds */}
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <label className="text-[12px] font-semibold text-gray-900">
                {t("rooms.form.beds")}
              </label>
            </div>
            <p className="text-[10px] text-gray-400 mb-2">{t("rooms.form.bedsHint")}</p>
            <div className="space-y-2">
              {beds.map((bed, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select
                    value={bed.type}
                    onChange={(e) => {
                      const updated = [...beds];
                      updated[idx] = { ...updated[idx], type: e.target.value };
                      setBeds(updated);
                    }}
                    className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 appearance-none"
                    style={SELECT_ARROW_STYLE}
                  >
                    {BED_TYPES.map((bt) => (
                      <option key={bt} value={bt}>
                        {t(`rooms.form.bedType${bt.split(" ")[0]}`)}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    value={bed.count}
                    onChange={(e) => {
                      const updated = [...beds];
                      updated[idx] = {
                        ...updated[idx],
                        count: Math.max(1, Number(e.target.value)),
                      };
                      setBeds(updated);
                    }}
                    className="w-16 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                  />
                  {beds.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setBeds(beds.filter((_, i) => i !== idx))}
                      className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <XMarkIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setBeds([...beds, { type: "King Bed", count: 1 }])}
              className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-gray-700 font-medium px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <PlusIcon className="w-3.5 h-3.5" /> {t("rooms.form.addBed")}
            </button>
          </div>

          {/* Occupancy */}
          <div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="text-[12px] font-semibold text-gray-900">
                    {t("rooms.form.totalMaxOccupancy")} <span className="text-red-500">*</span>
                  </label>
                </div>
                <input
                  type="number"
                  min={1}
                  value={maxOccupancyInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setMaxOccupancyInput(v);
                    if (v !== "") {
                      const n = Number(v);
                      if (Number.isFinite(n) && n >= 1) updateForm({ maxOccupancy: n });
                    }
                  }}
                  onBlur={() => {
                    const n = clampNumberInput(maxOccupancyInput, 1);
                    setMaxOccupancyInput(String(n));
                    updateForm({ maxOccupancy: n });
                  }}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                />
              </div>

              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="text-[12px] font-semibold text-gray-900">
                    {t("rooms.form.maxAdults")}
                  </label>
                </div>
                <input
                  type="number"
                  min={1}
                  placeholder={t("rooms.form.any")}
                  value={maxAdultsInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setMaxAdultsInput(v);
                    if (v === "") {
                      updateForm({ maxAdults: null });
                      return;
                    }
                    const n = Number(v);
                    if (Number.isFinite(n) && n >= 1) updateForm({ maxAdults: n });
                  }}
                  onBlur={() => {
                    if (maxAdultsInput === "") {
                      updateForm({ maxAdults: null });
                      return;
                    }
                    const n = clampNumberInput(maxAdultsInput, 1);
                    setMaxAdultsInput(String(n));
                    updateForm({ maxAdults: n });
                  }}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                />
              </div>

              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="text-[12px] font-semibold text-gray-900">
                    {t("rooms.form.maxChildren")}
                  </label>
                </div>
                <input
                  type="number"
                  min={0}
                  placeholder={t("rooms.form.any")}
                  value={maxChildrenInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setMaxChildrenInput(v);
                    if (v === "") {
                      updateForm({ maxChildren: null });
                      return;
                    }
                    const n = Number(v);
                    if (Number.isFinite(n) && n >= 0) updateForm({ maxChildren: n });
                  }}
                  onBlur={() => {
                    if (maxChildrenInput === "") {
                      updateForm({ maxChildren: null });
                      return;
                    }
                    const n = clampNumberInput(maxChildrenInput, 0);
                    setMaxChildrenInput(String(n));
                    updateForm({ maxChildren: n });
                  }}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                />
              </div>
            </div>
            <p className="text-[10px] text-gray-400 mt-1">{t("rooms.form.occupancyLimitsHint")}</p>
          </div>

          {/* Bedrooms, Bathrooms, Room Size, Total Rooms */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 items-start">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">
                  {t("rooms.form.bedrooms")}
                </label>
              </div>
              <input
                type="number"
                min={0}
                value={bedroomsInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setBedroomsInput(v);
                  if (v !== "") {
                    const n = Number(v);
                    if (Number.isFinite(n) && n >= 0) setBedrooms(n);
                  }
                }}
                onBlur={() => {
                  const n = clampNumberInput(bedroomsInput, 0);
                  setBedroomsInput(String(n));
                  setBedrooms(n);
                }}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">
                  {t("rooms.form.privateBathrooms")}
                </label>
              </div>
              <input
                type="number"
                min={0}
                // A shared-bathroom room stores no private bathroom count.
                disabled={form.bathroomType === "shared"}
                value={bathroomsInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setBathroomsInput(v);
                  if (v !== "") {
                    const n = Number(v);
                    if (Number.isFinite(n) && n >= 0) setBathrooms(n);
                  }
                }}
                onBlur={() => {
                  const n = clampNumberInput(bathroomsInput, 0);
                  setBathroomsInput(String(n));
                  setBathrooms(n);
                }}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">
                  {t("rooms.form.roomSize")} <span className="text-red-500">*</span>
                </label>
              </div>
              <input
                type="number"
                min={1}
                max={15000}
                value={sizeInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setSizeInput(v);
                  if (v !== "") {
                    const n = parseInt(v, 10);
                    if (Number.isFinite(n) && n >= 1 && n <= 15000) updateForm({ size: n });
                  }
                }}
                onBlur={() => {
                  const n = clampNumberInput(sizeInput, 1, 15000);
                  setSizeInput(String(n));
                  updateForm({ size: n });
                }}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                placeholder="50"
              />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">
                  {t("rooms.form.totalRooms")} <span className="text-red-500">*</span>
                </label>
              </div>
              <input
                type="number"
                min={1}
                value={totalRoomsInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setTotalRoomsInput(v);
                  if (v !== "") {
                    const n = Number(v);
                    if (Number.isFinite(n) && n >= 1) updateForm({ totalRooms: n });
                  }
                }}
                onBlur={() => {
                  const n = clampNumberInput(totalRoomsInput, 1);
                  setTotalRoomsInput(String(n));
                  updateForm({ totalRooms: n });
                }}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              />
              <p className="text-[10px] text-gray-400 mt-1 pl-3">
                {mode === "edit"
                  ? t("rooms.form.totalRoomsEditHint")
                  : t("rooms.form.totalRoomsCreateHint")}
              </p>
            </div>
          </div>

          {/* Room Description */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-[12px] font-semibold text-gray-900">
                {t("rooms.form.roomDescription")}
              </label>
            </div>
            <textarea
              value={form.description || ""}
              onChange={(e) => updateForm({ description: e.target.value })}
              rows={3}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 resize-vertical"
              placeholder={t("rooms.form.roomDescriptionPlaceholder")}
            />
            <p className="text-[10px] text-gray-400 mt-1">{t("rooms.form.roomDescriptionHint")}</p>
          </div>

          {/* Room Category Tag */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-[12px] font-semibold text-gray-900">
                {t("rooms.form.roomCategoryTag")}
              </label>
              <span className="text-[10px] text-gray-400">
                {t("rooms.form.roomCategoryTagHint")}
              </span>
            </div>
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                updateForm({ category: e.target.value });
              }}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 appearance-none"
              style={SELECT_ARROW_STYLE}
            >
              <option value="">{t("rooms.form.selectCategory")}</option>
              {ROOM_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {t(`rooms.form.category${cat}`)}
                </option>
              ))}
            </select>
          </div>

          {/* Location */}
          <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50/60 p-4">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-2 mb-3">
              <div>
                <h3 className="text-[12px] font-bold text-gray-900 uppercase tracking-widest">
                  {t("rooms.form.location")}
                </h3>
                <p className="text-[11px] text-gray-500 mt-1">
                  {t("rooms.form.locationDescription")}
                </p>
              </div>
              {!(form.latitude != null && form.longitude != null) && (
                <span className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                  {t("rooms.form.noLocation")}
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              <div className="lg:col-span-3 space-y-3">
                <div>
                  <label className="block text-[12px] font-semibold text-gray-900 mb-1.5">
                    {t("rooms.form.searchAddress")}
                  </label>
                  <input
                    type="text"
                    value={form.locationAddress || ""}
                    onChange={(e) => updateForm({ locationAddress: e.target.value })}
                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                    placeholder={t("rooms.form.addressPlaceholder")}
                  />
                  <p className="text-[10px] text-gray-400 mt-1">
                    {t("rooms.form.geocodingDescription")}
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[12px] font-semibold text-gray-900 mb-1.5">
                      {t("rooms.form.latitude")}
                    </label>
                    <input
                      type="number"
                      step="0.000001"
                      min={-90}
                      max={90}
                      value={latitudeInput}
                      onChange={(e) => setLatitudeInput(e.target.value)}
                      onBlur={() => {
                        if (latitudeInput === "") {
                          updateForm({ latitude: null });
                        } else {
                          const v = Math.max(-90, Math.min(90, Number(latitudeInput)));
                          setLatitudeInput(String(v));
                          updateForm({ latitude: v });
                        }
                      }}
                      className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                      placeholder="-8.670458"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] font-semibold text-gray-900 mb-1.5">
                      {t("rooms.form.longitude")}
                    </label>
                    <input
                      type="number"
                      step="0.000001"
                      min={-180}
                      max={180}
                      value={longitudeInput}
                      onChange={(e) => setLongitudeInput(e.target.value)}
                      onBlur={() => {
                        if (longitudeInput === "") {
                          updateForm({ longitude: null });
                        } else {
                          const v = Math.max(-180, Math.min(180, Number(longitudeInput)));
                          setLongitudeInput(String(v));
                          updateForm({ longitude: v });
                        }
                      }}
                      className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                      placeholder="115.212629"
                    />
                  </div>
                </div>
              </div>

              <div className="lg:col-span-2 min-h-[180px] rounded-xl border border-gray-200 bg-white relative overflow-hidden">
                <div className="absolute inset-0 opacity-70 bg-[linear-gradient(90deg,#e5e7eb_1px,transparent_1px),linear-gradient(0deg,#e5e7eb_1px,transparent_1px)] bg-[size:28px_28px]" />
                <div className="absolute inset-0 bg-gradient-to-br from-emerald-50 via-white to-sky-50" />
                {form.latitude != null && form.longitude != null ? (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="relative">
                      <div className="absolute -inset-5 rounded-full bg-primary-500/10 animate-pulse" />
                      <div className="relative rounded-full bg-primary-600 text-white text-[11px] font-bold px-3 py-1.5 shadow-lg">
                        {t("rooms.form.pinPreview")}
                      </div>
                    </div>
                    <div className="absolute bottom-3 left-3 right-3 rounded-lg bg-white/90 border border-gray-200 px-3 py-2 text-[11px] text-gray-600 shadow-sm">
                      {Number(form.latitude).toFixed(5)}, {Number(form.longitude).toFixed(5)}
                    </div>
                  </div>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
                    <p className="text-[12px] font-medium text-gray-500">
                      {t("rooms.form.enterCoordinates")}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "media" && (
        <div className="space-y-4">
          {/* Room Images Section */}
          <div className="bg-white rounded-xl border border-gray-200 px-4 py-5 md:px-6 md:py-6">
            <ImageUpload
              images={form.images || []}
              onChange={(images) => updateForm({ images })}
              mediaResource={pmsRoomMediaResource(
                typeof window !== "undefined"
                  ? localStorage.getItem(SELECTED_PMS_PROPERTY_ID_KEY) || "pms_property_current"
                  : "pms_property_current",
                roomTypeId,
              )}
              maxImages={propertyPlan?.limits.maxRoomPhotosPerType ?? null}
              plan={propertyPlan?.plan ?? null}
              label={t("rooms.form.roomImages")}
            />
          </div>

          {/* Amenities Section */}
          <div className="bg-white rounded-xl border border-gray-200 px-4 py-5 md:px-6 md:py-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 md:gap-3 flex-wrap min-w-0">
                <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">
                  {t("rooms.form.amenities")}
                </h3>
                <span className="hidden md:inline-block text-[10px] text-gray-400 px-2 py-0.5 bg-gray-100 rounded-full">
                  &rarr; {t("rooms.form.modalFullList")}
                </span>
              </div>
              <span className="shrink-0 text-[11px] font-medium text-primary-600">
                {t("rooms.form.selectedCount", { count: (form.amenities || []).length })}
              </span>
            </div>
            <p className="text-[10px] text-gray-400">{t("rooms.form.amenitiesDescription")}</p>

            {/* Booking.com paste-import helper */}
            <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50/60 px-3 py-2.5">
              <button
                type="button"
                onClick={() => setBookingImportOpen((o) => !o)}
                className="w-full flex items-center justify-between text-left"
              >
                <span className="text-[11px] font-semibold text-gray-700">
                  {t("rooms.form.bookingAmenitiesPaste")}
                </span>
                <ChevronDownIcon
                  className={`w-3.5 h-3.5 text-gray-400 transition-transform ${bookingImportOpen ? "" : "-rotate-90"}`}
                />
              </button>
              {bookingImportOpen && (
                <div className="mt-2 space-y-2">
                  <p className="text-[10px] text-gray-500">
                    {t("rooms.form.bookingAmenitiesDescription")}
                  </p>
                  <textarea
                    value={bookingImportText}
                    onChange={(e) => setBookingImportText(e.target.value)}
                    rows={5}
                    placeholder={t("rooms.form.bookingAmenitiesPlaceholder")}
                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 font-mono"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!bookingImportText.trim()}
                      onClick={() => {
                        const result = parseBookingAmenities(bookingImportText, AMENITY_CATEGORIES);
                        const current = form.amenities || [];
                        const before = current.length;
                        const merged = Array.from(
                          new Set([...current, ...result.matched.map((m) => m.amenity)]),
                        );
                        updateForm({ amenities: merged });
                        // Expand every category that received a new amenity, so users can see what was applied.
                        const touched = Array.from(new Set(result.matched.map((m) => m.category)));
                        setExpandedAmenityCategories((prev) =>
                          Array.from(new Set([...prev, ...touched])),
                        );
                        setBookingImportResult({
                          matchedCount: result.matched.length,
                          addedCount: merged.length - before,
                          fuzzy: result.matched
                            .filter((m) => m.source === "fuzzy")
                            .map((m) => ({ original: m.original, amenity: m.amenity })),
                          unmatched: result.unmatched,
                        });
                      }}
                      className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-[11px] font-medium rounded-lg transition-colors"
                    >
                      {t("rooms.form.parseAndAdd")}
                    </button>
                    {(bookingImportText || bookingImportResult) && (
                      <button
                        type="button"
                        onClick={() => {
                          setBookingImportText("");
                          setBookingImportResult(null);
                        }}
                        className="px-2 py-1.5 text-[11px] text-gray-500 hover:text-gray-700"
                      >
                        {t("common.clear")}
                      </button>
                    )}
                  </div>
                  {bookingImportResult && (
                    <div className="space-y-2 text-[11px]">
                      {bookingImportResult.matchedCount === 0 ? (
                        <p className="text-amber-700 font-medium">
                          {t("rooms.form.noAmenitiesMatched")}
                        </p>
                      ) : (
                        <p className="text-gray-700">
                          {t("rooms.form.amenitiesMatched", {
                            count: bookingImportResult.matchedCount,
                          })}
                          {bookingImportResult.addedCount !== bookingImportResult.matchedCount && (
                            <>
                              {" "}
                              &middot;{" "}
                              <span className="font-semibold">
                                {bookingImportResult.addedCount}
                              </span>{" "}
                              {t("rooms.form.newlyAdded", {
                                count: bookingImportResult.addedCount,
                              })}
                            </>
                          )}
                          {bookingImportResult.fuzzy.length > 0 && (
                            <>
                              {" "}
                              &middot;{" "}
                              <span className="font-semibold text-blue-700">
                                {bookingImportResult.fuzzy.length}
                              </span>{" "}
                              {t("rooms.form.fuzzyCount", {
                                count: bookingImportResult.fuzzy.length,
                              })}
                            </>
                          )}
                          {bookingImportResult.unmatched.length > 0 && (
                            <>
                              {" "}
                              &middot;{" "}
                              <span className="font-semibold text-amber-700">
                                {bookingImportResult.unmatched.length}
                              </span>{" "}
                              {t("rooms.form.unmatchedCount", {
                                count: bookingImportResult.unmatched.length,
                              })}
                            </>
                          )}
                        </p>
                      )}

                      {bookingImportResult.fuzzy.length > 0 && (
                        <div>
                          <p className="text-[10px] text-gray-500 mb-1">
                            {t("rooms.form.fuzzyMatchesDescription")}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {bookingImportResult.fuzzy.map((f) => {
                              const stillSelected = (form.amenities || []).includes(f.amenity);
                              return (
                                <span
                                  key={f.original + f.amenity}
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full border ${stillSelected ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-gray-50 text-gray-400 border-gray-200 line-through"}`}
                                >
                                  <span className="opacity-70">{f.original}</span>
                                  <span aria-hidden>&asymp;</span>
                                  {f.amenity}
                                  {stillSelected && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateForm({
                                          amenities: (form.amenities || []).filter(
                                            (a) => a !== f.amenity,
                                          ),
                                        })
                                      }
                                      className="text-blue-400 hover:text-blue-600"
                                    >
                                      <XMarkIcon className="w-3 h-3" />
                                    </button>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {bookingImportResult.unmatched.length > 0 && (
                        <div>
                          <p className="text-[10px] text-gray-500 mb-1">
                            {t("rooms.form.unmatchedAmenitiesDescription")}
                          </p>
                          <div className="space-y-1.5">
                            {bookingImportResult.unmatched.map((label) => {
                              const amenities = form.amenities || [];
                              const dropLabel = () =>
                                setBookingImportResult((r) =>
                                  r
                                    ? { ...r, unmatched: r.unmatched.filter((u) => u !== label) }
                                    : r,
                                );
                              return (
                                <div key={label} className="flex items-center gap-2 flex-wrap">
                                  <span className="text-[11px] text-gray-700 font-medium">
                                    {label}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const fallbackCategory =
                                        AMENITY_CATEGORIES[AMENITY_CATEGORIES.length - 1].name;
                                      if (
                                        !amenities.some(
                                          (a) => a.toLowerCase() === label.toLowerCase(),
                                        )
                                      ) {
                                        updateForm({ amenities: [...amenities, label] });
                                        setCustomAmenitiesByCategory((prev) => ({
                                          ...prev,
                                          [fallbackCategory]: [
                                            ...(prev[fallbackCategory] || []),
                                            label,
                                          ],
                                        }));
                                        setExpandedAmenityCategories((prev) =>
                                          Array.from(new Set([...prev, fallbackCategory])),
                                        );
                                      }
                                      dropLabel();
                                    }}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full border bg-white text-amber-800 border-amber-300 hover:bg-amber-50"
                                  >
                                    <PlusIcon className="w-3 h-3" />
                                    {t("common.custom")}
                                  </button>
                                  <select
                                    defaultValue=""
                                    onChange={(e) => {
                                      const amenity = e.target.value;
                                      if (!amenity) return;
                                      const cat = AMENITY_CATEGORIES.find((c) =>
                                        c.items.includes(amenity),
                                      );
                                      updateForm({
                                        amenities: Array.from(new Set([...amenities, amenity])),
                                      });
                                      if (cat)
                                        setExpandedAmenityCategories((prev) =>
                                          Array.from(new Set([...prev, cat.name])),
                                        );
                                      dropLabel();
                                    }}
                                    className="px-2 py-0.5 text-[11px] bg-white border border-gray-200 rounded-full text-gray-600 focus:outline-none focus:ring-2 focus:ring-primary-500"
                                  >
                                    <option value="">{t("rooms.form.mapTo")}</option>
                                    {AMENITY_CATEGORIES.map((c) => (
                                      <optgroup key={c.name} label={translateRoomOption(c.name)}>
                                        {c.items.map((it) => (
                                          <option key={it} value={it}>
                                            {translateRoomOption(it)}
                                          </option>
                                        ))}
                                      </optgroup>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    onClick={dropLabel}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-gray-500 hover:text-gray-700"
                                  >
                                    {t("common.ignore")}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-1">
              {AMENITY_CATEGORIES.map((cat) => {
                const amenities = form.amenities || [];
                const customInCat = (customAmenitiesByCategory[cat.name] || []).filter((a) =>
                  amenities.includes(a),
                );
                const selectedCount =
                  cat.items.filter((item) => amenities.includes(item)).length + customInCat.length;
                const isExpanded = expandedAmenityCategories.includes(cat.name);
                const allSelected = selectedCount === cat.items.length;

                return (
                  <div key={cat.name} className="border border-gray-200 rounded-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => {
                        if (isExpanded) {
                          setExpandedAmenityCategories((prev) =>
                            prev.filter((c) => c !== cat.name),
                          );
                        } else {
                          setExpandedAmenityCategories((prev) => [...prev, cat.name]);
                        }
                      }}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <ChevronDownIcon
                          className={`w-3.5 h-3.5 text-gray-400 transition-transform ${isExpanded ? "" : "-rotate-90"}`}
                        />
                        <span className="text-[12px] font-semibold text-gray-900">
                          {translateRoomOption(cat.name)}
                        </span>
                      </div>
                      <span className="text-[11px] text-gray-400">
                        {t("rooms.form.selectedCount", { count: selectedCount })}
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="px-4 pb-4 space-y-2">
                        <button
                          type="button"
                          onClick={() => {
                            if (allSelected) {
                              updateForm({
                                amenities: amenities.filter((a) => !cat.items.includes(a)),
                              });
                            } else {
                              updateForm({
                                amenities: Array.from(new Set([...amenities, ...cat.items])),
                              });
                            }
                          }}
                          className="text-[11px] text-primary-600 font-medium hover:text-primary-700"
                        >
                          {allSelected ? t("common.deselectAll") : t("common.selectAll")}
                        </button>

                        <div className="space-y-1.5">
                          {cat.items.map((item) => {
                            const isSelected = amenities.includes(item);
                            return (
                              <button
                                key={item}
                                type="button"
                                onClick={() => {
                                  if (isSelected) {
                                    updateForm({ amenities: amenities.filter((a) => a !== item) });
                                  } else {
                                    updateForm({ amenities: [...amenities, item] });
                                  }
                                }}
                                className="flex items-center gap-3 w-full text-left"
                              >
                                <div
                                  className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors ${
                                    isSelected
                                      ? "border-primary-500 bg-primary-500"
                                      : "border-gray-300"
                                  }`}
                                >
                                  {isSelected && <CheckIcon className="w-2.5 h-2.5 text-white" />}
                                </div>
                                <span className="text-[12px] text-gray-700">
                                  {translateRoomOption(item)}
                                </span>
                              </button>
                            );
                          })}
                        </div>

                        {/* Custom amenities in this category */}
                        {(customAmenitiesByCategory[cat.name] || []).filter((a) =>
                          amenities.includes(a),
                        ).length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-1">
                            {(customAmenitiesByCategory[cat.name] || [])
                              .filter((a) => amenities.includes(a))
                              .map((a) => (
                                <span
                                  key={a}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary-50 text-primary-700 text-[11px] font-medium rounded-full border border-primary-200"
                                >
                                  {a}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      updateForm({ amenities: amenities.filter((x) => x !== a) });
                                      setCustomAmenitiesByCategory((prev) => ({
                                        ...prev,
                                        [cat.name]: (prev[cat.name] || []).filter((x) => x !== a),
                                      }));
                                    }}
                                    className="text-primary-400 hover:text-primary-600"
                                  >
                                    <XMarkIcon className="w-3 h-3" />
                                  </button>
                                </span>
                              ))}
                          </div>
                        )}

                        {/* Custom amenity input */}
                        <div className="flex gap-2 mt-2">
                          <input
                            type="text"
                            value={customAmenityInputs[cat.name] || ""}
                            onChange={(e) =>
                              setCustomAmenityInputs((prev) => ({
                                ...prev,
                                [cat.name]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                const trimmed = (customAmenityInputs[cat.name] || "").trim();
                                if (
                                  trimmed &&
                                  !amenities.some((a) => a.toLowerCase() === trimmed.toLowerCase())
                                ) {
                                  updateForm({ amenities: [...amenities, trimmed] });
                                  setCustomAmenitiesByCategory((prev) => ({
                                    ...prev,
                                    [cat.name]: [...(prev[cat.name] || []), trimmed],
                                  }));
                                  setCustomAmenityInputs((prev) => ({ ...prev, [cat.name]: "" }));
                                }
                              }
                            }}
                            className="flex-1 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                            placeholder={t("rooms.form.addCustomAmenity")}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const trimmed = (customAmenityInputs[cat.name] || "").trim();
                              if (
                                trimmed &&
                                !amenities.some((a) => a.toLowerCase() === trimmed.toLowerCase())
                              ) {
                                updateForm({ amenities: [...amenities, trimmed] });
                                setCustomAmenitiesByCategory((prev) => ({
                                  ...prev,
                                  [cat.name]: [...(prev[cat.name] || []), trimmed],
                                }));
                                setCustomAmenityInputs((prev) => ({ ...prev, [cat.name]: "" }));
                              }
                            }}
                            className="px-2 py-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
                          >
                            <PlusIcon className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Custom amenities not assigned to any category */}
            {(() => {
              const allPredefined = AMENITY_CATEGORIES.flatMap((c) => c.items);
              const allCustomTracked = Object.values(customAmenitiesByCategory).flat();
              const untracked = (form.amenities || []).filter(
                (a) => !allPredefined.includes(a) && !allCustomTracked.includes(a),
              );
              if (untracked.length === 0) return null;
              return (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {untracked.map((a) => (
                    <span
                      key={a}
                      className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary-50 text-primary-700 text-[11px] font-medium rounded-full border border-primary-200"
                    >
                      {a}
                      <button
                        type="button"
                        onClick={() =>
                          updateForm({ amenities: (form.amenities || []).filter((x) => x !== a) })
                        }
                        className="text-primary-400 hover:text-primary-600"
                      >
                        <XMarkIcon className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              );
            })()}

            <p className="text-[10px] text-gray-400">
              {t("rooms.form.amenitySelectionSummary", {
                count: (form.amenities || []).length,
              })}
            </p>
          </div>
        </div>
      )}

      {/* Submit / Cancel — sticky on mobile, inline on desktop */}
      {activeTab !== "prices" && (
        <div className="mt-6 flex items-center justify-end gap-3 sticky bottom-0 -mx-4 md:mx-0 px-4 md:px-0 py-3 md:py-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:pb-0 bg-gray-50/95 md:bg-transparent backdrop-blur md:backdrop-blur-none border-t border-gray-200 md:border-t-0 z-10">
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 md:flex-initial text-center px-4 py-2.5 md:py-2 text-[13px] md:text-[12px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 bg-white transition-colors"
            >
              {cancelLabel ?? t("common.cancel")}
            </button>
          ) : (
            <Link
              href={cancelHref}
              className="flex-1 md:flex-initial text-center px-4 py-2.5 md:py-2 text-[13px] md:text-[12px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 bg-white transition-colors"
            >
              {cancelLabel ?? t("common.cancel")}
            </Link>
          )}
          <button
            type="submit"
            disabled={saving}
            className="flex-1 md:flex-initial px-6 py-2.5 md:py-2 bg-primary-600 text-white text-[13px] md:text-[12px] font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {saving ? t("common.saving") : (submitLabel ?? t("common.save"))}
          </button>
        </div>
      )}
    </form>
  );
}
