"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Header from "@/components/layout/Header";
import Sidebar from "@/components/layout/Sidebar";
import InboxHiddenNotice from "@/components/layout/InboxHiddenNotice";
import { hotelAccountAgreementsMessages } from "@/components/layout/hotelAccountAgreementsMessages";
import HotelAccountAgreementsBanner from "@vayada/product-onboarding/HotelAccountAgreementsBanner";
import { hotelAccountAgreementsApi } from "@/services/api/hotelAccountAgreementsClient";
import { authService } from "@/services/auth";
import { resolvePmsSetupGuard } from "@/lib/utils/sharedSetupGuard";
import {
  chooseLinkedPmsProperty,
  linkedPmsPropertyId,
  withoutLinkedPmsProperty,
} from "@/lib/utils/linkedProperty";
import { pmsSetupExitPropertyId } from "@vayada/product-onboarding";
import { useTranslation } from "@/lib/i18n";
import { PmsAccessProvider } from "@/lib/settings/PmsAccessContext";
import { getPmsSelfAccess, type PmsSelfAccess } from "@/services/api/pmsStaffClient";
import { AssistantDrawer, AssistantProvider } from "@vayada/assistant-ui";
import { pmsOperationsClient } from "@/services/api/pmsOperationsClient";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { t, locale } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [setupGuardError, setSetupGuardError] = useState(false);
  const [access, setAccess] = useState<PmsSelfAccess | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsAuthorized(false);
    setSetupGuardError(false);
    setAccess(null);
    async function authorize() {
      let authorized = false;
      try {
        authorized = await authService.ensureSession();
      } catch (error) {
        console.error("Failed to verify PMS session:", error);
        if (!cancelled) router.replace(loginPathForCurrentRoute("/dashboard"));
        return;
      }
      if (cancelled) return;
      if (!authorized || !authService.isHotelAdmin()) {
        router.replace(loginPathForCurrentRoute("/dashboard"));
        return;
      }
      // VAY-2099: a link that names its hotel (the booking request email) opens that hotel.
      const linkedPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (linkedPmsPropertyId(linkedPath)) {
        await chooseLinkedPmsProperty(linkedPath);
        if (cancelled) return;
        window.history.replaceState(null, "", withoutLinkedPmsProperty(linkedPath));
      }
      let liveAccess: PmsSelfAccess;
      try {
        liveAccess = await getPmsSelfAccess();
      } catch (error) {
        console.error("Failed to load PMS access:", error);
        if (!cancelled) setSetupGuardError(true);
        return;
      }

      const returnTo =
        typeof window === "undefined"
          ? "/dashboard"
          : `${window.location.pathname}${window.location.search}`;
      const setupExitPropertyId = pmsSetupExitPropertyId(returnTo);
      let decision: Awaited<ReturnType<typeof resolvePmsSetupGuard>>;
      try {
        decision = await resolvePmsSetupGuard(returnTo, undefined, undefined, undefined, {
          propertyId: setupExitPropertyId,
        });
      } catch (error) {
        console.error("Failed to verify PMS setup:", error);
        if (!cancelled) {
          setSetupGuardError(true);
        }
        return;
      }
      if (cancelled) return;
      setSetupGuardError(false);
      if (decision.action === "redirect_to_setup") {
        window.location.replace(decision.redirectPath);
        return;
      }
      setAccess(liveAccess);
      setIsAuthorized(true);
    }
    void authorize();
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  if (setupGuardError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-sm rounded-lg border border-amber-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-base font-semibold text-gray-950">{t("layout.setupGuardError")}</h1>
          <p className="mt-2 text-sm text-gray-600">{t("layout.refreshToRetry")}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-md bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            {t("auth.chooseProperty.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (!isAuthorized || !access) {
    return null;
  }

  return (
    // 100dvh (not 100vh): on iOS Safari 100vh ignores the URL bar, so the
    // shell's bottom — and any sticky footers anchored to it — sit behind
    // the browser chrome until Safari collapses it mid-scroll.
    <PmsAccessProvider access={access}>
      <AssistantProvider app="pms" http={pmsOperationsClient} locale={locale}>
        <div className="h-[100dvh] flex overflow-x-hidden">
          {/* Mobile overlay */}
          {sidebarOpen && (
            <div
              className="fixed inset-0 bg-black/40 z-40 lg:hidden"
              onClick={() => setSidebarOpen(false)}
            />
          )}
          {/* Sidebar: hidden on mobile, shown as overlay when open */}
          <div
            className={`fixed inset-y-0 left-0 z-50 lg:static lg:z-auto transition-transform duration-200 ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}
          >
            <Sidebar permissions={access.permissions} onNavigate={() => setSidebarOpen(false)} />
          </div>
          <div className="flex-1 flex flex-col min-w-0">
            <Header onMenuToggle={() => setSidebarOpen(!sidebarOpen)} />
            <InboxHiddenNotice permissions={access.permissions} />
            {/* VAY-2519: the assistant's panel sits beside the page and pushes it aside. */}
            <div className="flex min-h-0 flex-1">
              <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain bg-gray-50">
                {/* VAY-2246: until the hotel account accepts the hotel terms and DPA, its account admin sees this. */}
                <HotelAccountAgreementsBanner
                  client={hotelAccountAgreementsApi}
                  messages={hotelAccountAgreementsMessages(t)}
                  locale={locale}
                  frameClassName="px-4 pt-4 md:px-6 md:pt-6 [&>*]:max-w-6xl"
                />
                {children}
              </main>
              <AssistantDrawer />
            </div>
          </div>
        </div>
      </AssistantProvider>
    </PmsAccessProvider>
  );
}

function loginPathForCurrentRoute(fallbackReturnTo: string): string {
  const returnTo =
    typeof window === "undefined"
      ? fallbackReturnTo
      : `${window.location.pathname}${window.location.search}`;
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}
