"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import { ConfirmDialog, FeedbackAlert } from "@/components/ui";
import { useTranslation } from "@/lib/i18n";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import {
  getSelectedBookingHotelId,
  SELECTED_HOTEL_CHANGED_EVENT,
} from "@/services/api/bookingHotelScope";
import { ApiErrorResponse } from "@/services/api/client";
import {
  partnerConnectionsClient,
  type PartnerConnection,
} from "@/services/api/partnerConnectionsClient";
import { settingsService } from "@/services/settings";

/** Settings › Connected apps (VAY-2436): the partner apps this hotel allowed, such as Creator Links,
 * and Disconnect, which stops the app's access to the hotel at once. */
export function ConnectedAppsPage({
  client = partnerConnectionsClient,
}: {
  client?: typeof partnerConnectionsClient;
}) {
  const { t, locale } = useTranslation();
  const [state, setState] = useState<"loading" | "failed" | "noAccess" | "ready">("loading");
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [connections, setConnections] = useState<PartnerConnection[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [confirming, setConfirming] = useState<PartnerConnection | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );
  // The latest load wins: an older hotel's answer must never replace the current one.
  const loadVersion = useRef(0);
  const loadingHotelId = useRef<string | null>(null);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const current = () => version === loadVersion.current;
    setState("loading");
    setFeedback(null);
    try {
      const hotelId =
        getSelectedBookingHotelId() || (await settingsService.getPropertySettings()).id || null;
      if (!hotelId) throw new Error("No booking hotel selected");
      if (!current()) return;
      loadingHotelId.current = hotelId;
      const { propertyId } = await getBookingHotelPropertyLink({ hotelId });
      const loaded = await client.list(propertyId);
      if (!current()) return;
      setPropertyId(propertyId);
      setConnections(loaded.connections);
      setCanManage(loaded.canManage);
      setState("ready");
    } catch (error) {
      if (!current()) return;
      setState(error instanceof ApiErrorResponse && error.status === 403 ? "noAccess" : "failed");
    }
  }, [client]);

  useEffect(() => {
    void load();
    const onHotelSelected = () => {
      if (getSelectedBookingHotelId() !== loadingHotelId.current) void load();
    };
    window.addEventListener(SELECTED_HOTEL_CHANGED_EVENT, onHotelSelected);
    return () => {
      loadVersion.current += 1;
      window.removeEventListener(SELECTED_HOTEL_CHANGED_EVENT, onHotelSelected);
    };
  }, [load]);

  async function disconnect() {
    if (!confirming || !propertyId || disconnecting) return;
    setDisconnecting(true);
    try {
      await client.disconnect(propertyId, confirming.connectionId);
      setConnections((list) => list.filter((c) => c.connectionId !== confirming.connectionId));
      setFeedback({
        type: "success",
        message: t("settings.connectedApps.disconnected", { app: confirming.appName }),
      });
    } catch {
      setFeedback({ type: "error", message: t("settings.connectedApps.disconnectError") });
    } finally {
      setDisconnecting(false);
      setConfirming(null);
    }
  }

  const title = t("settings.cards.connectedApps.title");
  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));

  return (
    <SettingsSubPage title={title} subtitle={t("settings.connectedApps.subtitle")}>
      <div className="mt-5 space-y-4">
        {feedback && <FeedbackAlert type={feedback.type} message={feedback.message} />}
        {state === "loading" && (
          <div className="flex justify-center py-10" role="status" aria-label={t("common.loading")}>
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
          </div>
        )}
        {(state === "failed" || state === "noAccess") && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-white p-5"
          >
            <p className="text-sm text-red-700">
              {t(
                state === "noAccess"
                  ? "settings.connectedApps.noAccess"
                  : "settings.feedback.loadError",
              )}
            </p>
            {state === "failed" && (
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-gray-400"
              >
                {t("auth.chooseProperty.retry")}
              </button>
            )}
          </div>
        )}
        {state === "ready" &&
          (connections.length === 0 ? (
            <p className="rounded-xl border border-gray-200 bg-white p-5 text-sm text-gray-600">
              {t("settings.connectedApps.empty")}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-200 bg-white">
              {connections.map((connection) => (
                <li
                  key={connection.connectionId}
                  className="flex flex-wrap items-start justify-between gap-3 px-5 py-4"
                >
                  <div className="min-w-0">
                    <p className="text-[14px] font-semibold text-gray-900">{connection.appName}</p>
                    <ul className="mt-1 space-y-0.5 text-[13px] text-gray-600">
                      {connection.scopes.includes("promo_codes") && (
                        <li>{t("partner.authorize.scopePromoCodes")}</li>
                      )}
                      {connection.scopes.includes("bookings") && (
                        <li>{t("partner.authorize.scopeBookings")}</li>
                      )}
                    </ul>
                    <p className="mt-1 text-[12px] text-gray-500">
                      {connection.approvedByName
                        ? t("settings.connectedApps.connectedBy", {
                            date: date(connection.approvedAt),
                            name: connection.approvedByName,
                          })
                        : t("settings.connectedApps.connectedOn", {
                            date: date(connection.approvedAt),
                          })}
                    </p>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => setConfirming(connection)}
                      className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:border-red-400"
                    >
                      {t("settings.connectedApps.disconnect")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ))}
      </div>
      <ConfirmDialog
        open={confirming !== null}
        title={t("settings.connectedApps.confirmTitle", { app: confirming?.appName ?? "" })}
        message={t("settings.connectedApps.confirmMessage", { app: confirming?.appName ?? "" })}
        confirmLabel={t("settings.connectedApps.disconnect")}
        cancelLabel={t("partner.authorize.cancel")}
        onConfirm={() => void disconnect()}
        onCancel={() => setConfirming(null)}
        loading={disconnecting}
        tone="danger"
      />
    </SettingsSubPage>
  );
}
