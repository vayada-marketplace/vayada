"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  SharedAccountDetailsStep,
  SharedFirstRunPropertySetupWizard,
  createBrowserAuthHandoff,
  crossAppReauthenticationUrl,
  isSetupExitPath,
  isSharedAccountDetailsComplete,
  normalizeSharedAccountName,
  parseSharedHotelSetupEntryProduct,
  safeSharedHotelSetupReturnTo,
  setupExitPath,
  type SharedHotelSetupEntryProduct,
} from "@vayada/product-onboarding";

import { RoomImportRevisionContext } from "./RoomImportRevisionContext";
import { ROUTES } from "@/lib/constants";
import { authService } from "@/services/auth";
import {
  sharedAccountProfileImageUploader,
  sharedHotelSetupApi,
  sharedSetupClient,
} from "@/services/api/sharedHotelSetupClient";
import { hotelOperationsSetupApi } from "@/services/api/hotelOperationsSetupClient";
import {
  getAuthCsrfToken,
  getAuthOrganizationId,
  getAuthSessionUser,
  getAuthWorkosOrganizationId,
} from "@/services/auth/sessionStore";
import { AdaptiveRoomAuthoringSetupController } from "./adaptive/rooms/AdaptiveRoomAuthoringSetupController";
import { productHandoffReturnTo } from "./productHandoffReturnTo";

import {
  PreparedHotelImportPanel,
  type PreparedImportResponse,
} from "@vayada/product-onboarding/PreparedHotelImportPanel";

export { productHandoffReturnTo };

// Copied from apps/marketplace-web/components/setup/SharedHotelSetupPage.tsx (VAY-2261).
// Booking Admin hosts the wizard: a hotel that arrived from the PMS (returnProduct or entryProduct
// "pms") still hands off to pms-web on exit; every other hotel exits to this app's dashboard.
const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || "https://pms.vayada.com";
// Booking Admin offers the Hotel Operations track only (the Creator Marketplace is being removed).
const BOOKING_ADMIN_SETUP_TRACKS = ["hotel_operations"] as const;
const PROPERTY_LAUNCH_SETTINGS_API = {
  get: (propertyId: string, options?: RequestInit) =>
    hotelOperationsSetupApi.getPropertyLaunchSettings(propertyId, options?.signal ?? undefined),
  update: hotelOperationsSetupApi.updatePropertyLaunchSettings,
};

export function SharedHotelSetupPage({
  defaultEntryProduct,
  airbnbImportEnabled = false,
}: {
  defaultEntryProduct: SharedHotelSetupEntryProduct;
  airbnbImportEnabled?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [roomImportRevision, setRoomImportRevision] = useState(0);
  const [preparedSource, setPreparedSource] = useState<PreparedImportResponse["import"]>(null);
  const [checkingPrepared, setCheckingPrepared] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [accountContactEmail, setAccountContactEmail] = useState<string | null>(null);
  const [accountContactPhone, setAccountContactPhone] = useState<string | null>(null);
  const [accountProfilePictureUrl, setAccountProfilePictureUrl] = useState<string | null>(null);
  const [accountProfilePictureMediaObjectId, setAccountProfilePictureMediaObjectId] = useState<
    string | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    void authService
      .ensureSession()
      .then((ok) => {
        if (cancelled) return;
        if (!ok || !authService.isHotelAdmin() || authService.isSuperAdmin()) {
          router.replace(loginPathForSetup());
          return;
        }
        const user = getAuthSessionUser();
        setAccountName(user?.name ?? localStorage.getItem("userName"));
        setAccountContactEmail(user?.email ?? null);
        setAccountContactPhone(user?.phone ?? null);
        setAccountProfilePictureUrl(user?.profilePictureUrl ?? null);
        setAccountProfilePictureMediaObjectId(user?.profilePictureMediaObjectId ?? null);
        setAuthorized(true);
      })
      .catch(() => {
        if (!cancelled) router.replace(loginPathForSetup());
      })
      .finally(() => {
        if (!cancelled) setCheckingAuth(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!authorized) return;
    let active = true;
    void sharedSetupClient
      .get<PreparedImportResponse>("/api/hotel-setup/imports/prepared", {
        signal: AbortSignal.timeout(5000),
      })
      .then((response) => {
        if (active) setPreparedSource(response.import);
      })
      .catch(() => {
        /* Optional suggestions never prevent manual setup. */
      })
      .finally(() => {
        if (active) setCheckingPrepared(false);
      });
    return () => {
      active = false;
    };
  }, [authorized]);

  const entryProduct = useMemo(() => {
    const requested =
      parseSharedHotelSetupEntryProduct(searchParams.get("entryProduct")) ?? defaultEntryProduct;
    // Booking Admin has no Marketplace track: an old Marketplace link sets up booking.
    return requested === "marketplace" ? "booking" : requested;
  }, [defaultEntryProduct, searchParams]);
  const initialAddProperty = searchParams.get("mode") === "add";
  const initialPropertyId = searchParams.get("propertyId");

  const handlePropertySelected = (propertyId: string) => {
    localStorage.setItem("selectedSharedPropertyId", propertyId);
    router.replace(setupPathForSelectedProperty(searchParams.toString(), propertyId), {
      scroll: false,
    });
  };

  const handoffToPms = async (targetPath: string, propertyId: string | null) => {
    setHandoffError(null);
    const csrfToken = getAuthCsrfToken();
    if (csrfToken) {
      try {
        window.location.replace(
          await createBrowserAuthHandoff({
            csrfToken,
            routingHints: propertyId ? { propertyId } : undefined,
            sourceSurface: "booking-admin",
            targetPath,
            targetSurface: "pms-web",
          }),
        );
        return;
      } catch {
        // Require target-app authentication when the one-time exchange is unavailable.
      }
    }
    try {
      const reauthenticationReturnTo =
        propertyId?.trim() || isSetupExitPath(targetPath)
          ? productHandoffReturnTo(targetPath, propertyId?.trim() || null, {
              organizationId: getAuthOrganizationId(),
              workosOrganizationId: getAuthWorkosOrganizationId(),
            })
          : targetPath;
      window.location.replace(
        crossAppReauthenticationUrl(PMS_FRONTEND_URL, reauthenticationReturnTo),
      );
    } catch {
      setHandoffError("We couldn't open that app. Please check the app URL and try again.");
    }
  };

  const handleExit = (selectedPropertyId?: string | null) => {
    const propertyId = selectedPropertyId?.trim() || initialPropertyId?.trim() || null;
    const query = searchParams.toString();
    if (isPmsSetupContext(query)) {
      void handoffToPms(setupExitPathForContext(query, propertyId), propertyId);
      return;
    }
    if (propertyId) localStorage.setItem("selectedSharedPropertyId", propertyId);
    window.location.assign(setupExitPath(propertyId));
  };

  if (checkingAuth || !authorized || checkingPrepared) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-gray-50 px-6"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm font-medium text-gray-600">Confirming your setup session…</p>
      </div>
    );
  }

  if (handoffError) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-gray-50 px-6 py-12">
        <div
          className="w-full max-w-xl rounded-2xl border border-red-200 bg-white px-6 py-8 text-center sm:px-10"
          role="alert"
        >
          <h1 className="text-xl font-semibold text-gray-950">Unable to open the app</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-600">{handoffError}</p>
          <button
            type="button"
            onClick={() => setHandoffError(null)}
            className="mt-5 min-h-10 rounded-full bg-primary-600 px-5 py-2 text-sm font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
          >
            Return to setup
          </button>
        </div>
      </main>
    );
  }

  if (
    !isSharedAccountDetailsComplete({
      name: accountName,
      phone: accountContactPhone,
      profilePictureUrl: accountProfilePictureUrl,
      profilePictureMediaObjectId: accountProfilePictureMediaObjectId,
    })
  ) {
    return (
      <SharedAccountDetailsStep
        accountType="hotel"
        email={accountContactEmail ?? ""}
        initialName={accountName}
        initialPhone={accountContactPhone}
        initialProfilePictureUrl={accountProfilePictureUrl}
        initialProfilePictureMediaObjectId={accountProfilePictureMediaObjectId}
        onUploadProfileImage={(file) => {
          const userId = getAuthSessionUser()?.id;
          if (!userId) throw new Error("Your session has expired. Please sign in again.");
          return sharedAccountProfileImageUploader(userId, file);
        }}
        onSubmit={async (accountDetails) => {
          await authService.updateAccountDetails(accountDetails);
          setAccountName(
            normalizeSharedAccountName(accountDetails.firstName, accountDetails.lastName),
          );
          setAccountContactPhone(accountDetails.phone ?? null);
          if (accountDetails.profilePictureUrl) {
            setAccountProfilePictureUrl(accountDetails.profilePictureUrl);
          }
          if (accountDetails.profilePictureMediaObjectId) {
            setAccountProfilePictureMediaObjectId(accountDetails.profilePictureMediaObjectId);
          }
        }}
      />
    );
  }

  return (
    <RoomImportRevisionContext.Provider value={roomImportRevision}>
      {initialPropertyId && !initialAddProperty && (
        <div className="mx-auto max-w-4xl px-6">
          <PreparedHotelImportPanel
            key={initialPropertyId}
            client={sharedSetupClient}
            onSaved={() => setRoomImportRevision((revision) => revision + 1)}
            propertyId={initialPropertyId}
          />
        </div>
      )}
      <SharedFirstRunPropertySetupWizard
        initialProfileSuggestions={
          !initialAddProperty && !preparedSource?.propertyId
            ? preparedSource?.data.property
            : undefined
        }
        propertyCreateIdempotencyKey={
          !initialAddProperty && preparedSource
            ? `prepared-property:${preparedSource.sourceId}`
            : undefined
        }
        api={sharedHotelSetupApi}
        availableTracks={BOOKING_ADMIN_SETUP_TRACKS}
        entryProduct={entryProduct}
        initialPropertyId={initialPropertyId}
        initialAddProperty={initialAddProperty}
        propertyLaunchSettingsApi={PROPERTY_LAUNCH_SETTINGS_API}
        onPropertySelected={handlePropertySelected}
        renderSetupActions={
          airbnbImportEnabled
            ? (propertyId) => (
                <div className="mx-auto max-w-4xl px-6 py-4">
                  <a
                    href={`/setup/airbnb-connect/${encodeURIComponent(propertyId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-semibold text-primary-700 underline"
                  >
                    Connect Airbnb to import rooms (opens in a new tab)
                  </a>
                </div>
              )
            : undefined
        }
        renderAfterHotelDetails={(propertyId, onEditHotelDetails) => (
          <AdaptiveSetupHandoff
            propertyId={propertyId}
            onEditHotelDetails={onEditHotelDetails}
            onExit={() => handleExit(propertyId)}
          />
        )}
      />
    </RoomImportRevisionContext.Provider>
  );
}

function AdaptiveSetupHandoff({
  propertyId,
  onExit,
  onEditHotelDetails,
}: {
  propertyId: string;
  onExit: () => void;
  onEditHotelDetails: () => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const scoped = searchParams.get("propertyId") === propertyId && !searchParams.has("mode");

  useEffect(() => {
    localStorage.setItem("selectedSharedPropertyId", propertyId);
    if (!scoped) {
      router.replace(setupPathForSelectedProperty(searchParams.toString(), propertyId), {
        scroll: false,
      });
    }
  }, [propertyId, router, scoped, searchParams]);

  // Persist automatically selected hotels before mounting forms, so refresh and
  // step navigation cannot lose the property or interrupt a newly edited draft.
  if (!scoped) return <p role="status">Opening your hotel setup…</p>;

  return (
    <AdaptiveRoomAuthoringSetupController
      key={propertyId}
      propertyId={propertyId}
      requestedStepId={searchParams.get("step")}
      onEditHotelDetails={onEditHotelDetails}
      onExit={onExit}
    />
  );
}

/** Login keeps the setup context (entry/return product, step, recovery) for a hotel without a session here. */
function loginPathForSetup(): string {
  if (typeof window === "undefined") return ROUTES.LOGIN;
  const returnTo = `${window.location.pathname}${window.location.search}`;
  return `${ROUTES.LOGIN}?returnTo=${encodeURIComponent(returnTo)}`;
}

export function setupPathForSelectedProperty(query: string, propertyId: string): string {
  const searchParams = new URLSearchParams(query);
  const stripeReturn = ["return", "refresh"].includes(searchParams.get("stripe") ?? "");
  if (
    searchParams.get("mode") === "add" ||
    (searchParams.get("propertyId") !== propertyId && !stripeReturn)
  ) {
    searchParams.delete("step");
  }
  searchParams.set("propertyId", propertyId);
  searchParams.delete("mode");
  return `${ROUTES.SETUP}?${searchParams.toString()}`;
}

/** A hotel that entered from the PMS, or returns to it, leaves setup through pms-web. */
export function isPmsSetupContext(query: string): boolean {
  const params = new URLSearchParams(query);
  return params.get("returnProduct") === "pms" || params.get("entryProduct") === "pms";
}

export function setupExitPathForContext(query: string, propertyId: string | null): string {
  const params = new URLSearchParams(query);
  return params.get("recovery") === "pms-calendar" && params.get("returnProduct") === "pms"
    ? safeSharedHotelSetupReturnTo(params.get("returnTo"), "/settings#calendar")
    : setupExitPath(propertyId);
}
