"use client";

import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";

import { ChannelManagerView } from "@/components/channel-manager/ChannelManagerView";
import { useTranslation } from "@/lib/i18n";
import { useHasPmsPermission } from "@/lib/settings/PmsAccessContext";
import { ApiErrorResponse } from "@/services/api/client";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";
import {
  getChannelManagerView,
  markChannelProblemSeen,
  type ChannelManagerView as View,
} from "@/services/channelManager";

type State =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error" }
  | { kind: "ready"; propertyId: string; view: View };

/**
 * VAY-2606: the Channel manager, view only. Account admins and staff with the Channel manager permission open it
 * for the hotels they work for; only account admins (pms.operations.manage) can mark a problem as seen.
 */
export default function ChannelManagerPage() {
  const { t } = useTranslation();
  const canMarkSeen = useHasPmsPermission("pms.operations.manage");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [markingSeen, setMarkingSeen] = useState<string | null>(null);
  const [markSeenFailed, setMarkSeenFailed] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const propertyId = await resolveSelectedPmsPropertyId("loading the Channel manager");
      const view = await getChannelManagerView(propertyId, signal);
      if (!signal?.aborted) setState({ kind: "ready", propertyId, view });
    } catch (error) {
      if (signal?.aborted) return;
      setState(
        error instanceof ApiErrorResponse && (error.status === 401 || error.status === 403)
          ? { kind: "forbidden" }
          : { kind: "error" },
      );
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const markSeen = async (alertId: string) => {
    if (state.kind !== "ready") return;
    setMarkingSeen(alertId);
    setMarkSeenFailed(false);
    try {
      await markChannelProblemSeen(state.propertyId, alertId);
      await load();
    } catch {
      setMarkSeenFailed(true);
    } finally {
      setMarkingSeen(null);
    }
  };

  if (state.kind === "loading")
    return (
      <div className="p-4 md:p-6" role="status" aria-label={t("channelManager.loading")}>
        <div className="flex max-w-[1080px] animate-pulse flex-col gap-5">
          <div className="h-7 w-48 rounded bg-gray-200" />
          <div className="h-4 w-96 max-w-full rounded bg-gray-100" />
          <div className="h-48 rounded-xl bg-white" />
          <div className="h-48 rounded-xl bg-white" />
        </div>
      </div>
    );

  if (state.kind !== "ready")
    return (
      <div className="p-4 md:p-6">
        <h1 className="text-xl font-bold text-gray-900">{t("channelManager.title")}</h1>
        <div
          className="mt-5 max-w-[640px] rounded-xl border border-gray-200 bg-white p-6"
          role="alert"
        >
          <ExclamationTriangleIcon aria-hidden="true" className="h-6 w-6 text-amber-600" />
          <p className="mt-3 text-sm leading-[22px] text-gray-700">
            {t(
              state.kind === "forbidden" ? "channelManager.forbidden" : "channelManager.loadError",
            )}
          </p>
          {state.kind === "error" && (
            <button
              type="button"
              onClick={() => {
                setState({ kind: "loading" });
                void load();
              }}
              className="mt-4 inline-flex h-9 items-center rounded-lg bg-gray-900 px-3.5 text-[13px] font-semibold text-white hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
            >
              {t("channelManager.retry")}
            </button>
          )}
        </div>
      </div>
    );

  return (
    <ChannelManagerView
      view={state.view}
      canMarkSeen={canMarkSeen}
      markingSeen={markingSeen}
      markSeenFailed={markSeenFailed}
      onMarkSeen={(alertId) => void markSeen(alertId)}
    />
  );
}
