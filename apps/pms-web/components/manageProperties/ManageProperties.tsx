"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircleIcon } from "@heroicons/react/24/outline";

import { PageTitle } from "@/components/layout/PageHeader";
import { useTranslation } from "@/lib/i18n";
import { usePmsAccess } from "@/lib/settings/PmsAccessContext";
import {
  getStoredPmsPropertyId,
  listPmsProperties,
  storeSelectedPmsPropertyId,
  type PmsPropertySummary,
} from "@/services/api/pmsPropertyClient";

import DeletePropertyDialog from "./DeletePropertyDialog";

/** The deleted property's name, shown once after the page reloads with the new property list. */
export const DELETED_PROPERTY_NOTICE_KEY = "pms.manageProperties.deletedName";

/**
 * VAY-2493: account menu › Manage Properties. The account admin sees every property of the account and
 * can delete one, as long as another one stays. Deleting reloads the PMS, so the switcher drops the
 * property and, when it was the open one, the PMS switches to the first remaining property.
 */
export default function ManageProperties({
  reload = () => window.location.assign("/manage-properties"),
}: {
  reload?: () => void;
}) {
  const { t } = useTranslation();
  const isAccountAdmin = usePmsAccess().roleKey === "hotel_owner";
  const [properties, setProperties] = useState<PmsPropertySummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [deleting, setDeleting] = useState<PmsPropertySummary | null>(null);
  const [deletedName, setDeletedName] = useState("");
  const [currentId, setCurrentId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      setProperties(await listPmsProperties());
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    setCurrentId(getStoredPmsPropertyId());
    try {
      const name = globalThis.sessionStorage?.getItem(DELETED_PROPERTY_NOTICE_KEY);
      if (name) {
        setDeletedName(name);
        globalThis.sessionStorage.removeItem(DELETED_PROPERTY_NOTICE_KEY);
      }
    } catch {
      // Storage can be unavailable (private mode); the notice is only a courtesy.
    }
    if (isAccountAdmin) void load();
  }, [isAccountAdmin, load]);

  const lastProperty = properties !== null && properties.length < 2;

  function onDeleted(propertyId: string, name: string) {
    const remaining = (properties ?? []).filter((property) => property.id !== propertyId);
    if (remaining[0] && (currentId === propertyId || currentId === null)) {
      storeSelectedPmsPropertyId(remaining[0].id);
    }
    try {
      globalThis.sessionStorage?.setItem(DELETED_PROPERTY_NOTICE_KEY, name);
    } catch {
      // See above.
    }
    reload();
  }

  return (
    <div className="p-4 md:p-6">
      <div className="max-w-3xl">
        <PageTitle>{t("manageProperties.title")}</PageTitle>
        <p className="mt-1 text-[13px] text-gray-500">{t("manageProperties.description")}</p>

        {deletedName && (
          <p
            role="status"
            className="mt-6 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800"
          >
            <CheckCircleIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
            {t("manageProperties.deleted", { name: deletedName })}
          </p>
        )}

        {!isAccountAdmin ? (
          <p
            role="note"
            className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600"
          >
            {t("manageProperties.adminOnly")}
          </p>
        ) : loadFailed ? (
          <div role="alert" className="mt-6 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            <p>{t("manageProperties.loadFailed")}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-2 font-medium underline"
            >
              {t("common.retry")}
            </button>
          </div>
        ) : properties === null ? (
          <p role="status" className="mt-6 text-sm text-gray-500">
            {t("common.loading")}
          </p>
        ) : (
          <>
            <ul className="mt-6 divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
              {properties.map((property) => (
                <li key={property.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                      <span className="truncate">{property.name}</span>
                      {property.id === currentId && (
                        <span className="shrink-0 rounded-full bg-primary-50 px-2 py-0.5 text-[11px] font-medium text-primary-700">
                          {t("manageProperties.current")}
                        </span>
                      )}
                    </p>
                    {property.location && (
                      <p className="truncate text-xs text-gray-500">{property.location}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={lastProperty}
                    aria-label={t("manageProperties.deleteNamed", { name: property.name })}
                    aria-describedby={lastProperty ? "manage-properties-last-hint" : undefined}
                    onClick={() => setDeleting(property)}
                    className="shrink-0 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400 disabled:hover:bg-transparent"
                  >
                    {t("common.delete")}
                  </button>
                </li>
              ))}
            </ul>
            {lastProperty && (
              <p id="manage-properties-last-hint" className="mt-3 text-xs text-gray-500">
                {t("manageProperties.lastPropertyHint")}
              </p>
            )}
          </>
        )}
      </div>

      {deleting && (
        <DeletePropertyDialog
          property={{ id: deleting.id, name: deleting.name }}
          onClose={() => setDeleting(null)}
          onDeleted={(check) => onDeleted(check.propertyId, check.displayName)}
        />
      )}
    </div>
  );
}
