"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { authService } from "@/services/auth";
import { apiClient, omitHotelContext } from "@/services/api/client";
import {
  PartnerAuthorizationRequestError,
  partnerConnectionsClient,
  type PartnerAuthorizationRequest,
} from "@/services/api/partnerConnectionsClient";
import { useTranslation } from "@/lib/i18n";

type Client = typeof partnerConnectionsClient;

const goTo = (url: string) => window.location.assign(url);

/** Switches on the hotel's Promos (Feature Hub, VAY-2200): partner codes can't work without it. */
async function switchOnPromos(propertyId: string) {
  await apiClient.patch(
    `/api/pms/properties/${encodeURIComponent(propertyId)}/booking-modules/promos`,
    { moduleId: "promos", isActive: true },
    omitHotelContext,
  );
}

/**
 * VAY-2436: a partner app (Creator Links first) sends the hotel here once (OAuth 2.0 authorization code
 * flow with PKCE). The hotel signs in as usual, picks a hotel when it runs several, and allows or
 * cancels. Either way the browser goes back to the app's registered address.
 */
export function PartnerAuthorizePage({
  client = partnerConnectionsClient,
  enablePromos = switchOnPromos,
  navigate = goTo,
}: {
  client?: Client;
  enablePromos?: (propertyId: string) => Promise<void>;
  navigate?: (url: string) => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = useMemo(() => new URLSearchParams(searchParams.toString()), [searchParams]);
  const [request, setRequest] = useState<PartnerAuthorizationRequest | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [turnOnPromos, setTurnOnPromos] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!(await authService.ensureSession())) {
        router.replace(`/login?returnTo=${encodeURIComponent(`${pathname}?${query.toString()}`)}`);
        return;
      }
      try {
        const loaded = await client.loadAuthorization(query);
        if (cancelled) return;
        setRequest(loaded);
        setPropertyId(loaded.properties[0]?.propertyId ?? null);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof PartnerAuthorizationRequestError && error.redirectTo) {
          navigate(error.redirectTo);
          return;
        }
        setPageError(
          error instanceof PartnerAuthorizationRequestError
            ? t("partner.authorize.invalidRequest")
            : t("partner.authorize.loadError"),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, navigate, pathname, query, router, t]);

  const selected = request?.properties.find((p) => p.propertyId === propertyId) ?? null;

  async function decide(decision: "allow" | "deny") {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (
        decision === "allow" &&
        selected &&
        !selected.promoCodesEnabled &&
        request?.scopes.includes("promo_codes") &&
        turnOnPromos
      ) {
        try {
          await enablePromos(selected.propertyId);
        } catch {
          setSubmitError(t("partner.authorize.promosError"));
          setSubmitting(false);
          return;
        }
      }
      navigate(await client.decide(query, decision, decision === "allow" ? propertyId : null));
    } catch {
      setSubmitError(t("partner.authorize.submitError"));
      setSubmitting(false);
    }
  }

  if (pageError)
    return (
      <Shell>
        <p role="alert" className="text-[14px] text-red-600">
          {pageError}
        </p>
      </Shell>
    );

  if (!request)
    return (
      <Shell>
        <div className="flex justify-center" role="status" aria-label={t("common.loading")}>
          <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </Shell>
    );

  const appName = request.app.name;
  return (
    <Shell>
      <h1 className="text-xl font-bold text-gray-900 text-center">
        {t("partner.authorize.title", { app: appName })}
      </h1>
      <p className="text-[14px] text-gray-700 mt-3 text-center">
        {t("partner.authorize.question", { app: appName })}
      </p>
      <ul className="mt-5 space-y-2 text-[13px] text-gray-700 list-disc pl-5">
        {request.scopes.includes("promo_codes") && (
          <li>{t("partner.authorize.scopePromoCodes")}</li>
        )}
        {request.scopes.includes("bookings") && <li>{t("partner.authorize.scopeBookings")}</li>}
        <li>{t("partner.authorize.disconnectHint")}</li>
      </ul>

      {request.properties.length === 0 ? (
        <p role="alert" className="mt-5 text-[13px] text-amber-700 bg-amber-50 rounded-lg p-3">
          {t("partner.authorize.noHotels")}
        </p>
      ) : (
        <div className="mt-5">
          {request.properties.length > 1 ? (
            <label className="block text-[13px] font-medium text-gray-900">
              {t("partner.authorize.chooseHotel")}
              <select
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-[14px]"
                value={propertyId ?? ""}
                onChange={(event) => setPropertyId(event.target.value)}
              >
                {request.properties.map((p) => (
                  <option key={p.propertyId} value={p.propertyId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-[13px] text-gray-900">
              {t("partner.authorize.forHotel", { hotel: request.properties[0]!.name })}
            </p>
          )}
          {selected && !selected.promoCodesEnabled && request.scopes.includes("promo_codes") && (
            <label className="mt-4 flex items-start gap-2 text-[13px] text-gray-700">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={turnOnPromos}
                onChange={(event) => setTurnOnPromos(event.target.checked)}
              />
              <span>{t("partner.authorize.turnOnPromos", { app: appName })}</span>
            </label>
          )}
        </div>
      )}

      {submitError && (
        <p role="alert" className="mt-4 text-[13px] text-red-600">
          {submitError}
        </p>
      )}

      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={() => decide("deny")}
          disabled={submitting}
          className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-[14px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          {t("partner.authorize.cancel")}
        </button>
        <button
          type="button"
          onClick={() => decide("allow")}
          disabled={submitting || !selected}
          className="flex-1 rounded-lg bg-primary-600 px-4 py-2 text-[14px] font-medium text-white hover:bg-primary-700 disabled:opacity-60"
        >
          {t("partner.authorize.allow")}
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
      <div className="w-full max-w-md bg-white rounded-lg shadow-lg p-8">{children}</div>
    </main>
  );
}
