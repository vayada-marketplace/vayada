"use client";

import { useState } from "react";
import { PlusIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/24/outline";
import { ToggleSwitch } from "@/components/ui";
import type { AddonItem, AddonSettings } from "@/services/settings";
import { getCurrencySymbol } from "@/lib/utils";

const CATEGORY_COLORS: Record<string, string> = {
  transport: "bg-blue-100 text-blue-700",
  wellness: "bg-purple-100 text-purple-700",
  dining: "bg-orange-100 text-orange-700",
  experience: "bg-green-100 text-green-700",
};

function AddonsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

interface AddonsTabProps {
  addons: AddonItem[];
  addonSettings: AddonSettings;
  propertyCurrency: string;
  itemManagementUnavailable: string;
  handleToggleAddonSetting: (key: keyof AddonSettings) => void;
}

export default function AddonsTab({
  addons,
  addonSettings,
  propertyCurrency,
  itemManagementUnavailable,
  handleToggleAddonSetting,
}: AddonsTabProps) {
  const [filterCategory, setFilterCategory] = useState("all");
  const categories = Array.from(new Set(addons.map((a) => a.category).filter(Boolean)));
  const filteredAddons =
    filterCategory === "all" ? addons : addons.filter((a) => a.category === filterCategory);

  return (
    <div className="max-w-2xl space-y-4">
      {/* Guest Experiences */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[14px] font-semibold text-gray-900">Guest Experiences</h2>
            <p className="text-[12px] text-gray-500 mt-0.5">
              Upsells and add-ons shown during the booking flow
            </p>
          </div>
          <button
            disabled
            aria-label={itemManagementUnavailable}
            className="inline-flex items-center gap-1 px-3 py-1.5 bg-gray-200 text-gray-500 text-[12px] font-medium rounded-lg cursor-not-allowed"
          >
            <PlusIcon className="w-3.5 h-3.5" />
            Add Experience
          </button>
        </div>

        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          {itemManagementUnavailable}
        </div>

        {/* Category filter pills */}
        {categories.length > 1 && (
          <div className="flex items-center gap-1.5 mb-4 flex-wrap">
            <button
              onClick={() => setFilterCategory("all")}
              className={`px-3 py-1 rounded-full text-[11px] font-medium border transition-colors ${filterCategory === "all" ? "border-gray-900 text-gray-900 bg-gray-50" : "border-gray-200 text-gray-500 hover:border-gray-300"}`}
            >
              All ({addons.length})
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setFilterCategory(cat)}
                className={`px-3 py-1 rounded-full text-[11px] font-medium border transition-colors ${filterCategory === cat ? "border-gray-900 text-gray-900 bg-gray-50" : "border-gray-200 text-gray-500 hover:border-gray-300"}`}
              >
                {cat.charAt(0).toUpperCase() + cat.slice(1)} (
                {addons.filter((a) => a.category === cat).length})
              </button>
            ))}
          </div>
        )}

        {addons.length === 0 ? (
          <div className="bg-gray-50 rounded-lg border border-dashed border-gray-300 p-6 text-center">
            <div className="w-10 h-10 bg-gray-200 rounded-full mx-auto flex items-center justify-center mb-2">
              <AddonsIcon className="w-5 h-5 text-gray-400" />
            </div>
            <p className="text-[13px] font-medium text-gray-600">No add-ons yet</p>
            <p className="text-[12px] text-gray-400 mt-0.5">
              Create your first guest experience to show during booking
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredAddons.map((addon) => (
              <div
                key={addon.id}
                className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
              >
                {/* Drag handle icon */}
                <div className="text-gray-300 shrink-0">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="9" cy="6" r="1.5" />
                    <circle cx="15" cy="6" r="1.5" />
                    <circle cx="9" cy="12" r="1.5" />
                    <circle cx="15" cy="12" r="1.5" />
                    <circle cx="9" cy="18" r="1.5" />
                    <circle cx="15" cy="18" r="1.5" />
                  </svg>
                </div>

                {/* Image thumbnail */}
                {addon.image ? (
                  <img
                    src={addon.image}
                    alt={addon.name}
                    className="w-10 h-10 rounded-md object-cover shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-md bg-gray-100 flex items-center justify-center shrink-0">
                    <AddonsIcon className="w-4 h-4 text-gray-400" />
                  </div>
                )}

                {/* Name and category */}
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-gray-900 truncate">{addon.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${CATEGORY_COLORS[addon.category] || "bg-gray-100 text-gray-600"}`}
                    >
                      {addon.category.charAt(0).toUpperCase() + addon.category.slice(1)}
                    </span>
                    {addon.duration && (
                      <span className="text-[11px] text-gray-400">{addon.duration}</span>
                    )}
                  </div>
                </div>

                {/* Price */}
                <div className="text-right shrink-0">
                  <p className="text-[13px] font-semibold text-gray-900">
                    {getCurrencySymbol(propertyCurrency)}
                    {addon.price.toFixed(2)}
                  </p>
                  {addon.perPerson && <p className="text-[10px] text-gray-400">per person</p>}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    disabled
                    aria-label={itemManagementUnavailable}
                    className="p-1.5 text-gray-300 rounded-md cursor-not-allowed"
                  >
                    <PencilSquareIcon className="w-4 h-4" />
                  </button>
                  <button
                    disabled
                    aria-label={itemManagementUnavailable}
                    className="p-1.5 text-gray-300 rounded-md cursor-not-allowed"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Display Settings */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h2 className="text-[14px] font-semibold text-gray-900">Display Settings</h2>
        <p className="text-[12px] text-gray-500 mt-0.5 mb-4">
          Control how add-ons appear in the booking flow
        </p>

        <div className="space-y-2">
          <ToggleSwitch
            size="sm"
            enabled={addonSettings.showAddonsStep}
            onChange={() => handleToggleAddonSetting("showAddonsStep")}
            label="Show Add-ons Step"
            description="Display the add-ons step in the booking flow"
          />
          <ToggleSwitch
            size="sm"
            enabled={addonSettings.groupAddonsByCategory}
            onChange={() => handleToggleAddonSetting("groupAddonsByCategory")}
            label="Group by Category"
            description="Organize add-ons by category (Transport, Wellness, etc.)"
          />
        </div>
      </div>
    </div>
  );
}
