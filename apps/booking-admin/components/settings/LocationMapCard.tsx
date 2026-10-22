"use client";

import { useEffect, useState } from "react";
import { ArrowRightIcon, ExclamationTriangleIcon, MapIcon } from "@heroicons/react/24/outline";
import { locationMapPins } from "@vayada/domain-hotels";
import { crossAppReauthenticationUrl } from "@vayada/product-onboarding";
import { useTranslation } from "@/lib/i18n";
import {
  bookingLocationMapClient,
  type LocationMapSummary,
} from "@/services/api/bookingLocationMapClient";

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || "https://pms.vayada.com";

/** "Location map on your booking page" (VAY-2126): off by default; on, guests see the rooms' pins (or the
 * property's) below the room list. The switch saves at once and guests read it live. */
export function LocationMapCard({
  propertyId,
  client = bookingLocationMapClient,
}: {
  propertyId: string;
  client?: typeof bookingLocationMapClient;
}) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<LocationMapSummary | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoadFailed(false);
    client
      .load(propertyId, controller.signal)
      .then(setSummary)
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    return () => controller.abort();
  }, [client, propertyId, attempt]);

  async function toggle() {
    if (!summary || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      const enabled = await client.save(propertyId, !summary.enabled);
      setSummary({ ...summary, enabled });
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }

  if (!summary) {
    return (
      <section
        aria-label={t("settings.locationMap.title")}
        className="rounded-2xl border border-gray-200 bg-white p-5"
      >
        {loadFailed ? (
          <p role="alert" className="text-sm text-red-700">
            {t("settings.locationMap.loadFailed")}{" "}
            <button
              type="button"
              className="ml-1 font-medium underline"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t("settings.locationMap.retry")}
            </button>
          </p>
        ) : (
          <div className="h-10 animate-pulse rounded-lg bg-gray-100" aria-busy="true" />
        )}
      </section>
    );
  }

  const { pins, unpinnedRooms } = locationMapPins(summary.rooms, summary.property);
  const pmsLink = (path: string) => crossAppReauthenticationUrl(PMS_FRONTEND_URL, path);
  const indent = "md:pl-[54px]";

  return (
    <section
      aria-label={t("settings.locationMap.title")}
      className={`space-y-3 rounded-2xl border bg-white p-4 md:p-5 ${
        summary.enabled ? "border-primary-200" : "border-gray-200"
      }`}
    >
      <div className="flex items-start gap-3.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-primary-50">
          <MapIcon className="h-5 w-5 text-primary-600" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-gray-900">
            {t("settings.locationMap.title")}
          </h2>
          <p className="text-[13px] text-gray-500">{t("settings.locationMap.description")}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={summary.enabled}
          aria-label={t("settings.locationMap.title")}
          disabled={saving || !summary.canSwitch}
          onClick={() => void toggle()}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
            summary.enabled ? "bg-primary-600" : "bg-gray-200"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
              summary.enabled ? "translate-x-5" : ""
            }`}
          />
        </button>
      </div>

      {saveFailed && (
        <p role="alert" className={`text-[13px] text-red-700 ${indent}`}>
          {t("settings.locationMap.saveFailed")}
        </p>
      )}

      {!summary.canSwitch ? (
        <p className={`text-xs text-gray-500 ${indent}`}>{t("settings.locationMap.needsSetup")}</p>
      ) : !summary.enabled ? (
        <p className={`text-xs text-gray-500 ${indent}`}>{t("settings.locationMap.off")}</p>
      ) : (
        <>
          <div className={`space-y-2 border-t border-gray-100 pt-3.5 ${indent}`}>
            {pins.length === 0 ? (
              <Warning text={t("settings.locationMap.noPins")} />
            ) : (
              <>
                <p className="text-[13px] font-semibold text-gray-700">
                  {pins[0].kind === "property"
                    ? t("settings.locationMap.onePropertyPin")
                    : pins.length === 1
                      ? t("settings.locationMap.oneRoomPin")
                      : t("settings.locationMap.roomPins", { count: pins.length })}
                </p>
                <ol className="space-y-1.5">
                  {pins.map((pin, index) => (
                    <li
                      key={pin.roomTypeIds.join()}
                      className="flex min-h-[26px] items-center gap-2.5"
                    >
                      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-primary-600 text-xs font-bold text-white">
                        {index + 1}
                      </span>
                      <span className="shrink-0 text-[13px] font-medium text-gray-900">
                        {pin.label}
                      </span>
                      {pin.address && (
                        <span className="min-w-0 truncate text-[13px] text-gray-500">
                          {pin.address}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
                {pins[0].kind === "property" && (
                  <p className="text-xs text-gray-500">
                    {t("settings.locationMap.onePropertyPinHint")}
                  </p>
                )}
              </>
            )}
            {unpinnedRooms.length > 0 && (
              <Warning
                text={
                  unpinnedRooms.length === 1
                    ? t("settings.locationMap.unpinnedOne", { name: unpinnedRooms[0].name })
                    : t("settings.locationMap.unpinnedMany", {
                        count: unpinnedRooms.length,
                        names: unpinnedRooms.map((room) => room.name).join(", "),
                      })
                }
                link={{
                  href: pmsLink(
                    unpinnedRooms.length === 1 ? `/rooms/${unpinnedRooms[0].roomTypeId}` : "/rooms",
                  ),
                  label:
                    unpinnedRooms.length === 1
                      ? t("settings.locationMap.addInRooms")
                      : t("settings.locationMap.addInRoomsMany"),
                }}
              />
            )}
          </div>
          <p className={`text-xs text-gray-400 ${indent}`}>{t("settings.locationMap.footer")}</p>
        </>
      )}
    </section>
  );
}

function Warning({ text, link }: { text: string; link?: { href: string; label: string } }) {
  return (
    <div className="mt-1 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
      <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
      <div className="space-y-0.5">
        <p className="text-[13px] font-medium text-amber-800">{text}</p>
        {link && (
          <a
            href={link.href}
            className="inline-flex items-center gap-1 text-[13px] font-semibold text-primary-600 hover:text-primary-700"
          >
            {link.label}
            <ArrowRightIcon className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}
