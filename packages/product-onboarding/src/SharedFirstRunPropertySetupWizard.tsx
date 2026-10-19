"use client";

import {
  type ComponentType,
  type ReactNode,
  type RefObject,
  type SVGProps,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowRightIcon,
  BuildingOffice2Icon,
  BuildingOfficeIcon,
  BuildingStorefrontIcon,
  CakeIcon,
  CheckIcon,
  EllipsisHorizontalIcon,
  ExclamationCircleIcon,
  HomeModernIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  PhotoIcon,
  PlusIcon,
  SunIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import type {
  AdaptiveHotelSetupStatus,
  CreatePropertyProfileRequest,
  PreparedHotelImport,
  PropertyProfileContact,
  PropertyProfilePatch,
  PropertyProfileResponse,
  PublicPropertyProfileResponse,
  SetupTrack,
  UpdatePropertyProfileRequest,
} from "@vayada/domain-hotels";
import { SETUP_TRACKS } from "@vayada/domain-hotels";
import {
  COUNTRY_OPTIONS,
  CURRENCY_OPTIONS,
  LANGUAGE_OPTIONS,
  POPULAR_CURRENCY_CODES,
  POPULAR_LANGUAGE_CODES,
} from "@vayada/locale-constants";
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/min";

import { HotelIcon } from "./HotelIcon";
import { LocalizationMultiSelect } from "./LocalizationMultiSelect";
import GoogleAddressMap, {
  coveredMapInsets,
  type MapCoveredInsets,
  type MapPosition,
} from "./GoogleAddressMap";
import GooglePlacesAddressField from "./GooglePlacesAddressField";
import { findAddressOnMap } from "./googleMaps";
import TimezoneField from "./TimezoneField";
import { availableTimezones, defaultTimezoneForCountry, timezoneForCoordinates } from "./timezones";
import {
  resolveSharedFirstRunSetupView,
  toggleSetupTrackSelection,
  type SharedFirstRunSetupViewModel,
  type SharedHotelSetupEntryProduct,
  type SharedSetupProperty,
} from "./sharedFirstRunSetupFlow";
import type { SharedHotelSetupApi, SharedPropertyTypeOption } from "./sharedHotelSetupApi";
import {
  clearPendingPropertyLogo,
  readPendingPropertyLogo,
  sharedPropertyLogoError,
  writePendingPropertyLogo,
  type PendingPropertyLogoAssignment,
} from "./sharedPropertyLogo";
import {
  propertyLaunchSettingsDefaults,
  validatePropertyLaunchSettings,
  type PropertyLaunchSettings,
  type PropertyLaunchSettingsApi,
} from "./propertyLaunchSettings";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export type SharedFirstRunPropertySetupWizardProps = {
  initialProfileSuggestions?: PreparedHotelImport["property"];
  propertyCreateIdempotencyKey?: string;
  api: SharedHotelSetupApi;
  entryProduct: SharedHotelSetupEntryProduct;
  initialPropertyId?: string | null;
  initialAddProperty?: boolean;
  embedded?: boolean;
  propertyLaunchSettingsApi?: PropertyLaunchSettingsApi;
  onPropertySelected?: (propertyId: string) => void | Promise<void>;
  /** Renders the step-by-step setup once the selected hotel's basics are saved. */
  renderAfterHotelDetails: (propertyId: string, onEditHotelDetails: () => void) => ReactNode;
  renderSetupActions?: (propertyId: string) => ReactNode;
  /** The tracks a new hotel can choose from; every setup track by default. */
  availableTracks?: readonly SetupTrack[];
  /** Opens the selected hotel's details on this field, e.g. from a Booking readiness item. */
  editFocus?: "location";
  /** Called after a save that `editFocus` opened, instead of returning to the setup plan. */
  onEditFocusSaved?: (propertyId: string) => void;
};

type ProfileDraft = {
  displayName: string;
  propertyType: string;
  countryCode: string;
  city: string;
  streetAddress: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  contactEmail: string;
  phone: string;
  whatsapp: string;
  localityPublic: boolean;
  logoFile: File | null;
  logoMediaObjectId: string | null;
  logoPublicUrl: string;
};

type ManualAddressReset = {
  latitude?: null;
  longitude?: null;
};

export function locationResetForManualAddressEdit(field: string): ManualAddressReset {
  if (!["streetAddress", "postalCode", "city", "countryCode"].includes(field)) return {};

  return {
    latitude: null,
    longitude: null,
  };
}

export function canConfirmLocation(
  location: Pick<
    ProfileDraft,
    "streetAddress" | "postalCode" | "city" | "countryCode" | "timezone"
  >,
): boolean {
  return Boolean(
    location.streetAddress.trim() &&
    location.city.trim() &&
    COUNTRY_OPTIONS.some((country) => country.code === location.countryCode) &&
    isValidIanaTimezone(location.timezone.trim()),
  );
}

function isValidIanaTimezone(value: string): boolean {
  if (!/^[A-Za-z_]+\/[A-Za-z0-9_+./-]+$/.test(value)) return false;

  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function parsedCoordinate(value: string): number | null {
  const coordinate = value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(coordinate) ? coordinate : null;
}

function locationAddressLine(
  location: Pick<ProfileDraft, "streetAddress" | "postalCode" | "city" | "countryCode">,
): string {
  const country = COUNTRY_OPTIONS.find((option) => option.code === location.countryCode);
  return [
    location.streetAddress,
    [location.postalCode, location.city].filter(Boolean).join(" "),
    country?.name ?? location.countryCode,
  ]
    .filter(Boolean)
    .join(", ");
}

export function hasMapCoordinates(location: Pick<ProfileDraft, "latitude" | "longitude">): boolean {
  return (
    typeof location.latitude === "number" &&
    Number.isFinite(location.latitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    typeof location.longitude === "number" &&
    Number.isFinite(location.longitude) &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

const ALL_SETUP_TRACKS: readonly SetupTrack[] = SETUP_TRACKS;

const TRACK_CONTENT: Record<
  SetupTrack,
  { title: string; subtitle: string | null; description: string; icon: IconComponent }
> = {
  hotel_operations: {
    title: "Hotel Operations",
    subtitle: "PMS + Booking Engine",
    description: "Manage rooms, rates, reservations, and direct bookings.",
    icon: HotelIcon,
  },
};

const BASE_PROFILE_STEP_FIELDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["displayName", "propertyType", "logo"],
  [
    "location.streetAddress",
    "location.postalCode",
    "location.city",
    "location.countryCode",
    "location.timezone",
  ],
  ["phone", "whatsapp", "contactEmail"],
];
const LAUNCH_SETTINGS_STEP_FIELDS = [
  "defaultCurrency",
  "defaultLanguage",
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
] as const;
const BASE_PROFILE_STEP_TITLES = ["About your hotel", "Location", "Contact information"] as const;
const PROFILE_STEP_FIELDS_WITH_LAUNCH: ReadonlyArray<ReadonlyArray<string>> = [
  BASE_PROFILE_STEP_FIELDS[0],
  BASE_PROFILE_STEP_FIELDS[1],
  LAUNCH_SETTINGS_STEP_FIELDS,
  BASE_PROFILE_STEP_FIELDS[2],
];
const PROFILE_STEP_TITLES_WITH_LAUNCH = [
  "About your hotel",
  "Location",
  "Guest preferences",
  "Contact information",
] as const;

const PROPERTY_TYPE_ICONS = new Map<string, IconComponent>([
  ["hotel", HotelIcon],
  ["resort", SunIcon],
  ["hostel", UsersIcon],
  ["apartment", BuildingOffice2Icon],
  ["aparthotel", BuildingOfficeIcon],
  ["guesthouse", BuildingStorefrontIcon],
  ["bed_and_breakfast", CakeIcon],
  ["villa", HomeModernIcon],
  ["vacation_rental", KeyIcon],
  ["motel", MapPinIcon],
  ["other", EllipsisHorizontalIcon],
]);

const TIMEZONE_PICKER_OPTIONS = availableTimezones();

export default function SharedFirstRunPropertySetupWizard({
  api,
  entryProduct,
  initialPropertyId = null,
  initialAddProperty = false,
  embedded = false,
  propertyLaunchSettingsApi,
  onPropertySelected,
  renderAfterHotelDetails,
  renderSetupActions,
  initialProfileSuggestions,
  propertyCreateIdempotencyKey,
  availableTracks = ALL_SETUP_TRACKS,
  editFocus,
  onEditFocusSaved,
}: SharedFirstRunPropertySetupWizardProps) {
  const [status, setStatus] = useState<AdaptiveHotelSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusReloadToken, setStatusReloadToken] = useState(0);
  const [forceCreateProperty, setForceCreateProperty] = useState(initialAddProperty);
  const [editPropertyProfile, setEditPropertyProfile] = useState(false);
  // A "Fix in setup" link opens the location form directly and saves from there (VAY-2288).
  const [pendingEditFocus, setPendingEditFocus] = useState(editFocus ?? null);
  const [profileLoadFailed, setProfileLoadFailed] = useState(false);
  const [profileReloadToken, setProfileReloadToken] = useState(0);
  const [loadedProfile, setLoadedProfile] = useState<PropertyProfileResponse | null>(null);
  const [propertyTypeOptions, setPropertyTypeOptions] = useState<SharedPropertyTypeOption[] | null>(
    null,
  );
  const [draft, setDraft] = useState<ProfileDraft>(() => ({
    ...newPropertyDraft(),
    ...initialProfileSuggestions,
  }));
  const [launchSettings, setLaunchSettings] = useState<PropertyLaunchSettings>(() =>
    propertyLaunchSettingsDefaults(""),
  );
  const [launchSettingsTouched, setLaunchSettingsTouched] = useState(false);
  const [skipLaunchSettings, setSkipLaunchSettings] = useState(false);
  const [selectedTracks, setSelectedTracks] = useState<SetupTrack[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [profileStep, setProfileStep] = useState(0);
  const profileHeading = useRef<HTMLHeadingElement>(null);
  const trackCommandKey = useRef<string | null>(null);
  const createPropertyCommandKey = useRef<string | null>(null);
  const pendingCreateFingerprint = useRef<string | null>(null);
  const ambiguousCreateAttempt = useRef(false);
  const launchSettingsEnabled =
    Boolean(propertyLaunchSettingsApi) &&
    Boolean(status?.organization.selectedTracks.includes("hotel_operations"));
  const usePreparedProperty =
    !forceCreateProperty && status?.propertySelection.availableProperties.length === 0;
  const logoUploadKey = useRef<string | null>(null);
  const logoAssignmentKey = useRef<string | null>(null);
  // One key per intended profile edit; an ambiguous failure retries the same save.
  const profileUpdateKey = useRef<string | null>(null);
  const profileSaveInFlight = useRef(false);

  const view = useMemo(
    () =>
      resolveSharedFirstRunSetupView(status, {
        forceCreateProperty,
        editPropertyProfile,
      }),
    [editPropertyProfile, forceCreateProperty, status],
  );

  useEffect(() => {
    setForceCreateProperty(initialAddProperty);
    setEditPropertyProfile(!initialAddProperty && Boolean(editFocus));
    setPendingEditFocus(initialAddProperty ? null : (editFocus ?? null));
  }, [editFocus, initialAddProperty]);

  const focusedEdit = view.profileMode === "update" && pendingEditFocus === "location";
  useEffect(() => {
    setProfileStep(focusedEdit ? 1 : 0);
  }, [focusedEdit, view.profileMode, view.selectedPropertyId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStatus(null);
    setError("");

    api
      .getStatus({ entryProduct, propertyId: initialPropertyId })
      .then((nextStatus) => {
        if (cancelled) return;
        setStatus(nextStatus);
        setSelectedTracks(nextStatus.organization.selectedTracks);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(setupErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, entryProduct, initialPropertyId, statusReloadToken]);

  useEffect(() => {
    if (view.screen !== "property_profile") return;

    const propertyId = view.profileMode === "update" ? view.selectedPropertyId : null;
    let cancelled = false;
    setProfileLoadFailed(false);
    setPropertyTypeOptions(null);
    setError("");

    Promise.all([
      api.getPropertyTypes(),
      propertyId
        ? api.getPropertyProfile(propertyId)
        : Promise.resolve<PropertyProfileResponse | null>(null),
      propertyId
        ? api.getPublicPropertyProfile(propertyId)
        : Promise.resolve<PublicPropertyProfileResponse | null>(null),
      propertyId && launchSettingsEnabled && propertyLaunchSettingsApi
        ? propertyLaunchSettingsApi.get(propertyId)
        : Promise.resolve<PropertyLaunchSettings | null>(null),
    ])
      .then(([catalog, nextProfile, publicProfile, existingLaunchSettings]) => {
        if (cancelled) return;
        setPropertyTypeOptions(propertyTypeOptionsFromCatalog(catalog.propertyTypes));
        setLoadedProfile(nextProfile);
        const pendingLogo =
          propertyId && typeof window !== "undefined"
            ? readPendingPropertyLogo(window.localStorage, propertyId)
            : null;
        const publicLogo = publicProfile?.publicProfile.media.find(
          ({ mediaType }) => mediaType === "logo",
        );
        if (
          propertyId &&
          pendingLogo &&
          publicLogo?.mediaObjectId === pendingLogo.mediaObjectId &&
          typeof window !== "undefined"
        ) {
          clearPendingPropertyLogo(window.localStorage, propertyId);
        }
        const unconfirmedPendingLogo =
          pendingLogo && publicLogo?.mediaObjectId !== pendingLogo.mediaObjectId
            ? pendingLogo
            : null;
        setDraft(
          nextProfile
            ? draftFromProfile(nextProfile, publicProfile, unconfirmedPendingLogo)
            : {
                ...newPropertyDraft(),
                ...(usePreparedProperty ? initialProfileSuggestions : undefined),
              },
        );
        setLaunchSettings(
          existingLaunchSettings ??
            propertyLaunchSettingsDefaults(nextProfile?.profile.location.countryCode ?? ""),
        );
        setLaunchSettingsTouched(Boolean(existingLaunchSettings));
        setSkipLaunchSettings(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadedProfile(null);
        setProfileLoadFailed(true);
        setError(setupErrorMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [
    api,
    profileReloadToken,
    initialProfileSuggestions,
    usePreparedProperty,
    propertyLaunchSettingsApi,
    launchSettingsEnabled,
    view.profileMode,
    view.screen,
    view.selectedPropertyId,
  ]);

  const reloadStatus = async (propertyId?: string | null) => {
    const nextStatus = await api.getStatus({ entryProduct, propertyId });
    setStatus(nextStatus);
    setSelectedTracks(nextStatus.organization.selectedTracks);
    return nextStatus;
  };

  const handleSelectProperty = async (propertyId: string) => {
    setError("");
    setForceCreateProperty(false);
    setEditPropertyProfile(false);
    setPendingEditFocus(null);
    setLoading(true);
    try {
      await reloadStatus(propertyId);
      await onPropertySelected?.(propertyId);
    } catch (err) {
      setError(setupErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfile = async () => {
    if (profileSaveInFlight.current) return;
    setError("");
    setFieldErrors({});
    const nextFieldErrors = validateProfileDraft(draft);
    // A focused location edit never shows the guest preferences, so it leaves them as saved.
    if (launchSettingsEnabled && !skipLaunchSettings && !focusedEdit) {
      Object.assign(nextFieldErrors, validatePropertyLaunchSettings(launchSettings));
    }
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      return;
    }

    profileSaveInFlight.current = true;
    setSaving(true);
    try {
      const profile = createProfileFromDraft(draft);
      if (launchSettingsEnabled && !skipLaunchSettings) {
        profile.initialLaunchSettings = normalizedPropertyLaunchSettings(launchSettings);
      }
      const createFingerprint = JSON.stringify(profile);
      if (
        view.profileMode === "create" &&
        pendingCreateFingerprint.current &&
        pendingCreateFingerprint.current !== createFingerprint
      ) {
        setError(
          "This hotel was already submitted. Reload setup to review its saved details before making changes.",
        );
        return;
      }
      if (view.profileMode === "update" && !loadedProfile) {
        setError("The existing property profile could not be loaded.");
        return;
      }
      let saved: PropertyProfileResponse;
      if (view.profileMode === "update" && view.selectedPropertyId && loadedProfile) {
        const update = profileUpdateFromDraft(draft, loadedProfile);
        saved = loadedProfile;
        if (update) {
          saved = await api.updatePropertyProfile(
            view.selectedPropertyId,
            update,
            (profileUpdateKey.current = idempotencyKeyForRetry(profileUpdateKey.current)),
          );
          // Committed: a later logo, settings or reload failure must not pin this key.
          profileUpdateKey.current = null;
        }
      } else if (loadedProfile) {
        saved = loadedProfile;
      } else {
        pendingCreateFingerprint.current = createFingerprint;
        const idempotencyKey = (createPropertyCommandKey.current = idempotencyKeyForRetry(
          createPropertyCommandKey.current ??
            (usePreparedProperty ? (propertyCreateIdempotencyKey ?? null) : null),
        ));
        try {
          saved = await api.createPropertyProfile(profile, idempotencyKey);
        } catch (createError) {
          if ([403, 422].includes(setupErrorStatus(createError) ?? 0)) {
            if (!ambiguousCreateAttempt.current) pendingCreateFingerprint.current = null;
          } else {
            ambiguousCreateAttempt.current = true;
          }
          const code = setupErrorCode(createError);
          if (code !== "idempotency_key_conflict" && code !== "command_in_progress") {
            throw createError;
          }

          if (profile.initialLaunchSettings) throw createError;

          if (
            usePreparedProperty &&
            propertyCreateIdempotencyKey &&
            code === "idempotency_key_conflict"
          ) {
            setError(
              "This invitation already created a hotel. Reload setup to review its saved details before making changes.",
            );
            return;
          }
          const createdPropertyId = setupErrorPropertyId(createError);
          if (!createdPropertyId) throw createError;
          saved = await api.getPropertyProfile(createdPropertyId);
          const recoveredUpdate = profileUpdateFromDraft(draft, saved);
          if (recoveredUpdate) {
            saved = await api.updatePropertyProfile(createdPropertyId, recoveredUpdate);
          }
        }
      }
      setLoadedProfile(saved);
      saved = await savePropertyLogo({
        api,
        draft,
        profile: saved,
        uploadKey: logoUploadKey,
        assignmentKey: logoAssignmentKey,
      });
      setLoadedProfile(saved);
      if (
        view.profileMode === "update" &&
        launchSettingsEnabled &&
        propertyLaunchSettingsApi &&
        !skipLaunchSettings &&
        !focusedEdit
      ) {
        await propertyLaunchSettingsApi.update(
          saved.propertyId,
          normalizedPropertyLaunchSettings(launchSettings),
        );
      }
      if (focusedEdit && onEditFocusSaved) {
        logoUploadKey.current = null;
        logoAssignmentKey.current = null;
        onEditFocusSaved(saved.propertyId);
        return;
      }
      await reloadStatus(saved.propertyId);
      setForceCreateProperty(false);
      setEditPropertyProfile(false);
      setPendingEditFocus(null);
      if (view.profileMode === "create") {
        await onPropertySelected?.(saved.propertyId);
      }
      createPropertyCommandKey.current = null;
      pendingCreateFingerprint.current = null;
      ambiguousCreateAttempt.current = false;
      logoUploadKey.current = null;
      logoAssignmentKey.current = null;
    } catch (err) {
      if (
        ["profile_revision_conflict", "idempotency_key_conflict"].includes(
          setupErrorCode(err) ?? "",
        ) &&
        view.profileMode === "update" &&
        view.selectedPropertyId
      ) {
        profileUpdateKey.current = null;
        try {
          const latestProfile = await api.getPropertyProfile(view.selectedPropertyId);
          setLoadedProfile(latestProfile);
          setError(
            "These hotel details changed in another session. We refreshed the latest version—review your entries and save again.",
          );
        } catch (refreshError) {
          setError(setupErrorMessage(refreshError));
        }
      } else {
        setFieldErrors(fieldErrorsFromError(err));
        setError(setupErrorMessage(err));
      }
    } finally {
      profileSaveInFlight.current = false;
      setSaving(false);
    }
  };

  const handleSaveTracks = async () => {
    if (!status || selectedTracks.length === 0 || !status.organization.canManageTracks) return;
    setError("");
    setSaving(true);
    try {
      await api.updateTracks(
        {
          selectedTracks,
          expectedRevision: status.organization.trackRevision,
        },
        (trackCommandKey.current = idempotencyKeyForRetry(trackCommandKey.current)),
      );
      await reloadStatus(status.propertySelection.selectedPropertyId);
      trackCommandKey.current = null;
    } catch (err) {
      if (setupErrorCode(err) === "track_revision_conflict") {
        try {
          const latestStatus = await api.getStatus({
            entryProduct,
            propertyId: status.propertySelection.selectedPropertyId,
          });
          setStatus(latestStatus);
          trackCommandKey.current = null;
          if (sameTrackSelection(selectedTracks, latestStatus.organization.selectedTracks)) {
            setSelectedTracks(latestStatus.organization.selectedTracks);
          } else {
            setSelectedTracks(
              mergeTrackSelectionAfterConflict(
                selectedTracks,
                latestStatus.organization.selectedTracks,
              ),
            );
            setError(
              "Your hotel group’s services changed in another session. We refreshed them—review your selection and continue.",
            );
          }
        } catch (refreshError) {
          setError(setupErrorMessage(refreshError));
        }
      } else {
        setError(setupErrorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading || !status) {
    if (!loading && error) {
      return (
        <WizardShell title="Setup unavailable" view={view} embedded={embedded}>
          <div
            className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            role="alert"
          >
            {error}
          </div>
          <button
            type="button"
            className="mt-4 rounded-full bg-primary-600 px-5 py-2 font-semibold text-white"
            onClick={() => setStatusReloadToken((value) => value + 1)}
          >
            Retry
          </button>
        </WizardShell>
      );
    }

    return <WizardShell title="Setting up your property" view={view} loading embedded={embedded} />;
  }

  if (view.screen === "setup_plan" && view.selectedPropertyId) {
    if (saving)
      return <WizardShell title="Saving hotel details" view={view} loading embedded={embedded} />;
    return (
      <>
        {renderSetupActions?.(view.selectedPropertyId)}
        {renderAfterHotelDetails(view.selectedPropertyId, () => {
          setPendingEditFocus(null);
          setEditPropertyProfile(true);
        })}
      </>
    );
  }

  return (
    <WizardShell
      title={view.title}
      view={view}
      embedded={embedded}
      mapFirst={view.screen === "property_profile" && profileStep === 1}
      headingRef={view.screen === "property_profile" ? profileHeading : undefined}
    >
      {error && !(view.screen === "property_profile" && profileLoadFailed) && (
        <div
          className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          role="alert"
        >
          {error}
        </div>
      )}

      {view.screen === "property_selection" && (
        <PropertySelection
          properties={status.propertySelection.availableProperties}
          onSelect={handleSelectProperty}
          onAdd={() => {
            createPropertyCommandKey.current = null;
            pendingCreateFingerprint.current = null;
            ambiguousCreateAttempt.current = false;
            setDraft(newPropertyDraft());
            setLaunchSettings(propertyLaunchSettingsDefaults(""));
            setLaunchSettingsTouched(false);
            setSkipLaunchSettings(false);
            setLoadedProfile(null);
            setForceCreateProperty(true);
          }}
        />
      )}

      {view.screen === "property_profile" && profileLoadFailed && (
        <ProfileLoadError
          error={error}
          onRetry={() => setProfileReloadToken((value) => value + 1)}
        />
      )}

      {view.screen === "property_profile" && !profileLoadFailed && (
        <ProfileForm
          draft={draft}
          step={profileStep}
          mode={view.profileMode ?? "create"}
          embedded={embedded}
          loading={!propertyTypeOptions}
          saving={saving}
          fieldErrors={fieldErrors}
          launchSettings={launchSettingsEnabled ? launchSettings : null}
          skipLaunchSettings={skipLaunchSettings}
          launchSettingsTouched={launchSettingsTouched}
          propertyTypeOptions={propertyTypeOptions ?? []}
          pageHeadingRef={profileHeading}
          onChange={(nextDraft) => {
            if (
              view.profileMode === "create" &&
              !pendingCreateFingerprint.current &&
              (!usePreparedProperty || !propertyCreateIdempotencyKey)
            )
              createPropertyCommandKey.current = null;
            if (nextDraft.logoFile !== draft.logoFile) {
              logoUploadKey.current = null;
              logoAssignmentKey.current = null;
            }
            setDraft(nextDraft);
          }}
          onFieldErrors={setFieldErrors}
          onLaunchSettingsChange={(nextSettings) => {
            setLaunchSettings(nextSettings);
            setLaunchSettingsTouched(true);
            setSkipLaunchSettings(false);
          }}
          onPrepareLaunchSettings={(countryCode) => {
            if (!launchSettingsTouched) {
              setLaunchSettings(propertyLaunchSettingsDefaults(countryCode));
            }
          }}
          onConfirmLaunchSettings={() => setSkipLaunchSettings(false)}
          onSkipLaunchSettings={() => setSkipLaunchSettings(true)}
          onStepChange={setProfileStep}
          saveStep={focusedEdit ? 1 : undefined}
          highlightLocality={focusedEdit}
          onCancel={
            editPropertyProfile
              ? () => {
                  setPendingEditFocus(null);
                  setEditPropertyProfile(false);
                }
              : status.propertySelection.availableProperties.length > 0 &&
                  view.profileMode === "create"
                ? () => setForceCreateProperty(false)
                : undefined
          }
          cancelLabel={editPropertyProfile ? "Back to setup" : undefined}
          onSave={handleSaveProfile}
        />
      )}

      {view.screen === "track_selection" && (
        <TrackSelection
          availableTracks={availableTracks}
          selectedTracks={selectedTracks}
          canManageTracks={status.organization.canManageTracks}
          saving={saving}
          onToggle={(track) => {
            trackCommandKey.current = null;
            setSelectedTracks((current) =>
              toggleSetupTrackSelection(current, status.organization.selectedTracks, track),
            );
          }}
          onSave={handleSaveTracks}
        />
      )}
    </WizardShell>
  );
}

function WizardShell({
  children,
  title,
  view,
  headingRef,
  loading = false,
  embedded = false,
  mapFirst = false,
}: {
  children?: React.ReactNode;
  title: string;
  view: SharedFirstRunSetupViewModel;
  headingRef?: RefObject<HTMLHeadingElement>;
  loading?: boolean;
  embedded?: boolean;
  mapFirst?: boolean;
}) {
  const progress =
    view.screen === "track_selection"
      ? 1
      : view.screen === "property_selection" || view.screen === "property_profile"
        ? 2
        : 3;
  const subtitle =
    view.screen === "track_selection"
      ? "Choose one or both. Your selection applies to every hotel in this group."
      : view.screen === "property_selection"
        ? "Pick an existing property or add a new one to this hotel group."
        : view.screen === "property_profile"
          ? null
          : "Complete one guided step at a time. We only include tasks for the services you selected.";
  const isProfileScreen = view.screen === "property_profile";
  const isSetupPlan = view.screen === "setup_plan";
  const useWideSetupLayout = view.screen === "track_selection" || view.screen === "setup_plan";

  if (embedded) {
    return (
      <section className="min-w-0">
        {!mapFirst && (
          <div className="mb-4 px-1 sm:px-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2
                  ref={headingRef}
                  tabIndex={headingRef ? -1 : undefined}
                  className="text-lg font-semibold text-gray-950 outline-none"
                >
                  {title}
                </h2>
                {subtitle && <p className="mt-1 max-w-2xl text-sm text-gray-500">{subtitle}</p>}
              </div>
              {view.screen !== "setup_plan" && (
                <span className="w-fit rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
                  Step {progress} of 3
                </span>
              )}
            </div>
          </div>
        )}
        {loading ? (
          <div className="overflow-hidden rounded-3xl border border-gray-100 bg-white shadow-[0_24px_80px_-50px_rgba(15,23,42,0.55)]">
            <div className="flex min-h-80 items-center justify-center p-5 sm:p-6">
              <LoadingSpinner label="Loading setup" />
            </div>
          </div>
        ) : (
          <div className="min-w-0">{children}</div>
        )}
      </section>
    );
  }

  return (
    <main
      className={`flex min-h-[100dvh] text-gray-900 ${
        mapFirst ? "" : `${isSetupPlan ? "items-start" : "items-center"} px-4 py-6 sm:px-6 lg:px-8`
      } ${isProfileScreen || useWideSetupLayout ? "bg-gray-50" : "bg-white"}`}
    >
      <div
        className={`mx-auto w-full ${
          mapFirst
            ? "max-w-none"
            : isProfileScreen
              ? "max-w-7xl"
              : useWideSetupLayout
                ? "max-w-6xl"
                : "max-w-5xl"
        }`}
      >
        {!mapFirst && !isSetupPlan && (
          <header
            className={`mx-auto text-center ${
              isProfileScreen
                ? "mb-4 max-w-2xl"
                : useWideSetupLayout
                  ? "mb-8 max-w-2xl"
                  : "mb-5 max-w-xl"
            }`}
          >
            <h1
              ref={headingRef}
              tabIndex={headingRef ? -1 : undefined}
              className="text-3xl font-semibold tracking-tight text-gray-950 outline-none"
            >
              {title}
            </h1>
            {subtitle && <p className="mt-2 text-sm text-gray-500">{subtitle}</p>}
          </header>
        )}

        {loading ? (
          <div className="flex min-h-80 items-center justify-center">
            <LoadingSpinner label="Loading setup" />
          </div>
        ) : (
          children
        )}
      </div>
    </main>
  );
}

function LoadingSpinner({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label}>
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-950" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

function PropertySelection({
  properties,
  onSelect,
  onAdd,
}: {
  properties: SharedSetupProperty[];
  onSelect: (propertyId: string) => void;
  onAdd: () => void;
}) {
  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-950">Select a property</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Pick an existing property to finish setup, or add a new one to this hotel group.
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-700"
        >
          <PlusIcon className="h-4 w-4" aria-hidden="true" />
          Add property
        </button>
      </div>

      <div className="grid gap-3">
        {properties.map((property) => (
          <button
            key={property.propertyId}
            type="button"
            onClick={() => onSelect(property.propertyId)}
            className="rounded-3xl border border-gray-100 p-4 text-left transition hover:border-primary-200 hover:bg-primary-50/40 focus:outline-none focus:ring-2 focus:ring-primary-100"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium text-gray-950">
                  {property.displayName ?? "Unnamed property"}
                </p>
                {property.locationSummary && (
                  <p className="mt-1 text-sm text-gray-500">{property.locationSummary}</p>
                )}
              </div>
              <ArrowRightIcon className="h-4 w-4 text-gray-400" aria-hidden="true" />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ProfileLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="rounded-3xl border border-red-200 bg-red-50 p-5" role="alert">
      <div className="flex gap-3">
        <ExclamationCircleIcon
          className="mt-0.5 h-5 w-5 shrink-0 text-red-600"
          aria-hidden="true"
        />
        <div>
          <h2 className="text-lg font-semibold text-red-900">Property setup unavailable</h2>
          <p className="mt-2 text-sm text-red-700">
            {error || "The property setup details could not be loaded."}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-full bg-red-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-red-800"
      >
        Retry
      </button>
    </div>
  );
}

function HotelFacadeIllustration() {
  return (
    <svg
      viewBox="0 0 260 220"
      className="mx-auto h-auto w-full max-w-[32rem] text-gray-900"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M29 190h202" />
      <path d="M76 81v109h109V81" />
      <rect x="68" y="65" width="125" height="20" rx="3" fill="white" />
      <path d="M130 65V31" />
      <path d="m130 33 30 5v20l-30-5" fill="#2948E8" />
      <path d="M111 190v-48a19 19 0 0 1 38 0v48" fill="#2948E8" />
      <circle cx="141" cy="166" r="2" fill="currentColor" stroke="none" />
      <path d="M91 118V99a11 11 0 0 1 22 0v19Z" fill="#EEF1FF" />
      <path d="M148 118V99a11 11 0 0 1 22 0v19Z" fill="#EEF1FF" />
      <path d="M199 190h28l-4-30h-20Z" fill="white" />
      <path d="M213 160v-31M213 148l-13-14M213 143l13-16" />
      <path
        d="M200 134c9 0 13 5 13 14-9 0-13-5-13-14ZM226 127c0 9-4 14-13 16 0-9 4-14 13-16Z"
        fill="#2948E8"
      />
    </svg>
  );
}

/**
 * On a phone the location card spans the screen width, at the bottom or (while focused) the top.
 * Reports how much of the map it covers there; null from Tailwind's `sm` up, where the panels sit
 * beside the pin.
 */
function useCoveredMapInsets(
  active: boolean,
  areaRef: RefObject<HTMLDivElement | null>,
  cardRef: RefObject<HTMLDivElement | null>,
): MapCoveredInsets | null {
  const [insets, setInsets] = useState<MapCoveredInsets | null>(null);

  useEffect(() => {
    const area = areaRef.current;
    const card = cardRef.current;
    if (!active || !area || !card) return;
    const narrow = window.matchMedia("(max-width: 639.98px)");
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      // Next frame: :focus-within has moved the card by then.
      frame = requestAnimationFrame(() => {
        const next = narrow.matches
          ? coveredMapInsets(area.getBoundingClientRect(), card.getBoundingClientRect())
          : null;
        setInsets((current) =>
          current?.top === next?.top && current?.bottom === next?.bottom ? current : next,
        );
      });
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(area);
    resize.observe(card);
    // Focus can also leave without an event (a focused button turning disabled drops the card to
    // the bottom), so any change inside the card re-measures too.
    const changes = new MutationObserver(measure);
    changes.observe(card, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    card.addEventListener("focusin", measure);
    card.addEventListener("focusout", measure);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      changes.disconnect();
      card.removeEventListener("focusin", measure);
      card.removeEventListener("focusout", measure);
    };
  }, [active, areaRef, cardRef]);

  return insets;
}

function ProfileForm({
  draft,
  launchSettings,
  skipLaunchSettings,
  launchSettingsTouched,
  step,
  mode,
  embedded,
  loading,
  saving,
  fieldErrors,
  propertyTypeOptions,
  pageHeadingRef,
  onChange,
  onLaunchSettingsChange,
  onPrepareLaunchSettings,
  onConfirmLaunchSettings,
  onSkipLaunchSettings,
  onFieldErrors,
  onStepChange,
  onCancel,
  cancelLabel = "Back to properties",
  onSave,
  saveStep,
  highlightLocality = false,
}: {
  draft: ProfileDraft;
  launchSettings: PropertyLaunchSettings | null;
  skipLaunchSettings: boolean;
  launchSettingsTouched: boolean;
  step: number;
  mode: "create" | "update";
  embedded: boolean;
  loading: boolean;
  saving: boolean;
  fieldErrors: Record<string, string[]>;
  propertyTypeOptions: SharedPropertyTypeOption[];
  pageHeadingRef: RefObject<HTMLHeadingElement>;
  onChange: (draft: ProfileDraft) => void;
  onLaunchSettingsChange: (settings: PropertyLaunchSettings) => void;
  onPrepareLaunchSettings: (countryCode: string) => void;
  onConfirmLaunchSettings: () => void;
  onSkipLaunchSettings: () => void;
  onFieldErrors: (errors: Record<string, string[]>) => void;
  onStepChange: (step: number) => void;
  onCancel?: () => void;
  cancelLabel?: string;
  onSave: () => void;
  /** Saves from this step instead of the last one (a focused edit). */
  saveStep?: number;
  /** Points the hotel at "Show city and country publicly" while it is off. */
  highlightLocality?: boolean;
}) {
  const profileStepFields = launchSettings
    ? PROFILE_STEP_FIELDS_WITH_LAUNCH
    : BASE_PROFILE_STEP_FIELDS;
  const profileStepTitles = launchSettings
    ? PROFILE_STEP_TITLES_WITH_LAUNCH
    : BASE_PROFILE_STEP_TITLES;
  const contactStep = launchSettings ? 3 : 2;
  // A focused edit saves from its step, and from any later step a field error sends it to.
  const savesHere =
    saveStep === undefined ? step === profileStepFields.length - 1 : step >= saveStep;
  // A focused edit doesn't save guest preferences, so Back doesn't offer them.
  const previousStep =
    saveStep !== undefined && launchSettings && step === contactStep ? saveStep : step - 1;
  const googleMapsApiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim();
  const LocationHeading = embedded ? "h2" : "h1";
  const [showAddressFields, setShowAddressFields] = useState(
    () =>
      !googleMapsApiKey ||
      (mode === "update" && !(canConfirmLocation(draft) && hasMapCoordinates(draft))),
  );
  const [addressSearchUnavailable, setAddressSearchUnavailable] = useState(false);
  // Without a map (blocked script, key failure) coordinates are typed in; text keeps partial input.
  const [mapUnavailable, setMapUnavailable] = useState(false);
  const [coordinateText, setCoordinateText] = useState({
    latitude: draft.latitude?.toString() ?? "",
    longitude: draft.longitude?.toString() ?? "",
  });
  const coordinateTyped = useRef(false);
  // "Find on map" lookup of the typed address; `address` ties a result to the text it searched.
  const [mapLookup, setMapLookup] = useState<{
    status: "searching" | "not_found" | "area";
    address: string;
  } | null>(null);
  const [mapFocus, setMapFocus] = useState<MapPosition | null>(null);
  // The map keeps the pin in the strip the location card leaves visible on a phone.
  const locationMapArea = useRef<HTMLDivElement>(null);
  const locationCard = useRef<HTMLDivElement>(null);
  const mapCoveredInsets = useCoveredMapInsets(step === 1, locationMapArea, locationCard);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const mounted = useRef(false);
  // A keyboard path to a pin when the address search is down (the map itself needs a pointer).
  const [coordinatesRequested, setCoordinatesRequested] = useState(false);
  const coordinateFields = useRef<HTMLDivElement>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState(draft.logoPublicUrl);
  const addressRevision = useRef(0);
  const addressFields = useRef<HTMLDivElement>(null);
  const addressFieldsId = useId();
  const addressFieldsWereLoading = useRef(loading);
  const editAddressButton = useRef<HTMLButtonElement>(null);
  const focusAddressFieldsWhenShown = useRef(false);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const timezoneWasAutoDetected = useRef(false);
  const [whatsappFollowsPhone, setWhatsappFollowsPhone] = useState<boolean | null>(null);
  const localityCheckbox = useRef<HTMLInputElement>(null);
  const localityHighlighted = highlightLocality && step === 1 && !draft.localityPublic;
  const localityShown = useRef(false);

  useEffect(() => {
    if (!localityHighlighted || loading || localityShown.current) return;
    localityShown.current = true;
    requestAnimationFrame(() => {
      localityCheckbox.current?.scrollIntoView({ block: "center" });
      localityCheckbox.current?.focus({ preventScroll: true });
    });
  }, [loading, localityHighlighted]);

  useEffect(() => {
    const errorStep = profileStepFields.findIndex((fields) =>
      fields.some((field) => fieldErrors[field]),
    );
    if (errorStep >= 0 && errorStep !== step) {
      onStepChange(errorStep);
      requestAnimationFrame(() =>
        (errorStep === 1 ? pageHeadingRef.current : stepHeading.current)?.focus(),
      );
    }
  }, [fieldErrors, onStepChange, pageHeadingRef, profileStepFields, step]);

  useEffect(() => {
    if (BASE_PROFILE_STEP_FIELDS[1].some((field) => fieldErrors[field])) {
      setShowAddressFields(true);
      requestAnimationFrame(() =>
        addressFields.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
    }
  }, [fieldErrors]);

  useEffect(() => {
    const finishedLoading = addressFieldsWereLoading.current && !loading;
    addressFieldsWereLoading.current = loading;
    if (finishedLoading && googleMapsApiKey && mode === "update") {
      setShowAddressFields(!(canConfirmLocation(draft) && hasMapCoordinates(draft)));
    }
  }, [draft, googleMapsApiKey, loading, mode]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // Typed coordinates keep their text (e.g. "48."); others (a pin, a cleared pin) replace it.
    if (coordinateTyped.current) {
      coordinateTyped.current = false;
      return;
    }
    setCoordinateText({
      latitude: draft.latitude?.toString() ?? "",
      longitude: draft.longitude?.toString() ?? "",
    });
  }, [draft.latitude, draft.longitude]);

  useEffect(() => {
    if (showAddressFields && focusAddressFieldsWhenShown.current) {
      focusAddressFieldsWhenShown.current = false;
      focusFirstIncompleteAddressField(addressFields.current);
    }
  }, [showAddressFields]);

  useEffect(() => {
    if (!draft.logoFile) {
      setLogoPreviewUrl(draft.logoPublicUrl);
      return;
    }
    const previewUrl = URL.createObjectURL(draft.logoFile);
    setLogoPreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [draft.logoFile, draft.logoPublicUrl]);

  useEffect(() => {
    if (
      mode === "create" &&
      step === contactStep &&
      (whatsappFollowsPhone ?? (!draft.whatsapp || draft.whatsapp === draft.phone)) &&
      draft.phone &&
      draft.whatsapp !== draft.phone
    ) {
      onChange({ ...draft, whatsapp: draft.phone });
    }
  }, [contactStep, draft, mode, onChange, step, whatsappFollowsPhone]);

  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center">
        <LoadingSpinner label="Loading property profile" />
      </div>
    );
  }

  const setField = (field: keyof ProfileDraft, value: string) => {
    const locationReset = locationResetForManualAddressEdit(field);
    if ("latitude" in locationReset) addressRevision.current += 1;
    if (field === "timezone") timezoneWasAutoDetected.current = false;
    onChange({
      ...draft,
      [field]: value,
      ...(timezoneWasAutoDetected.current && "latitude" in locationReset
        ? { timezone: defaultTimezoneForCountry(draft.countryCode) }
        : {}),
      ...locationReset,
    });
  };
  const placePin = ({ lat, lng }: MapPosition) => {
    // Read the latest draft: a "Find on map" result lands after other edits may have happened.
    const current = latestDraft.current;
    const followPin = timezoneWasAutoDetected.current || !current.timezone.trim();
    if (followPin) timezoneWasAutoDetected.current = true;
    onChange({
      ...current,
      latitude: lat,
      longitude: lng,
      ...(followPin ? { timezone: timezoneForCoordinates(lat, lng) } : {}),
    });
    // Like a picked suggestion: fold the fields away so the pin is in view to confirm.
    if (canConfirmLocation(current)) setShowAddressFields(false);
  };
  const pickMapLocation = (position: MapPosition) => {
    // The hotel's own pin wins over a Places selection still loading for the old address.
    addressRevision.current += 1;
    placePin(position);
  };
  const findTypedAddressOnMap = async (address: string) => {
    if (!googleMapsApiKey) return;
    setMapLookup({ status: "searching", address });
    let result: Awaited<ReturnType<typeof findAddressOnMap>> = null;
    try {
      result = await findAddressOnMap(googleMapsApiKey, address);
    } catch {
      // A failed lookup reads like a miss: the hotel can still click its property on the map.
    }
    if (!mounted.current) return;
    // Only the address it searched, still without a pin: a newer edit, suggestion or pin wins.
    const current = latestDraft.current;
    if (locationAddressLine(current) !== address || hasMapCoordinates(current)) {
      setMapLookup(null);
      return;
    }
    if (result?.precise) {
      setMapLookup(null);
      placePin(result.position);
      return;
    }
    // An area match (street, postcode, town) shows the area; the hotel clicks its property there.
    if (result) setMapFocus(result.position);
    setMapLookup({ status: result ? "area" : "not_found", address });
  };
  const changeStep = (nextStep: number) => {
    onFieldErrors({});
    onStepChange(nextStep);
    requestAnimationFrame(() =>
      (nextStep === 1 ? pageHeadingRef.current : stepHeading.current)?.focus(),
    );
  };
  const continueToNextStep = () => {
    const currentFields = new Set(profileStepFields[step]);
    const allErrors = {
      ...validateProfileDraft(draft),
      ...(launchSettings && (step === 2 || !skipLaunchSettings)
        ? validatePropertyLaunchSettings(launchSettings)
        : {}),
    };
    const currentErrors = Object.fromEntries(
      Object.entries(allErrors).filter(([field]) => currentFields.has(field)),
    );
    onFieldErrors(currentErrors);
    if (Object.keys(currentErrors).length === 0) {
      if (step === 1 && launchSettings && mode === "create" && !launchSettingsTouched) {
        onPrepareLaunchSettings(draft.countryCode);
      }
      if (step === 2 && launchSettings) onConfirmLaunchSettings();
      changeStep(step + 1);
    }
  };
  const visiblePropertyTypeOptions =
    draft.propertyType && !propertyTypeOptions.some(({ value }) => value === draft.propertyType)
      ? [
          { value: draft.propertyType, label: `${draft.propertyType} (existing)` },
          ...propertyTypeOptions,
        ]
      : propertyTypeOptions;
  const hasCompleteLocation = canConfirmLocation(draft);
  const hasMappedLocation = hasCompleteLocation && hasMapCoordinates(draft);
  // The pin can only be placed on a map, so without one there's nothing to prompt for.
  const showLocationSummary = Boolean(googleMapsApiKey) && hasCompleteLocation;
  const addressLine = locationAddressLine(draft);
  const lookupForAddress = mapLookup?.address === addressLine ? mapLookup.status : null;
  const showCoordinateFields = mapUnavailable || !googleMapsApiKey || coordinatesRequested;
  const profileProgress = (
    <div
      className={
        step === 1
          ? "flex shrink-0 items-center gap-2 rounded-full bg-primary-50 px-3 py-1.5"
          : "flex flex-col items-center gap-2"
      }
    >
      <p
        className={`shrink-0 font-semibold text-gray-500 ${step === 1 ? "text-xs" : "text-sm"}`}
        aria-live="polite"
      >
        Step {step + 1} of {profileStepFields.length}
        {step !== 1 && ` · ${profileStepTitles[step]}`}
      </p>
      <ol
        className={`grid w-full ${step === 1 ? "max-w-10 gap-1" : "max-w-[12rem] gap-2"}`}
        style={{ gridTemplateColumns: `repeat(${profileStepTitles.length}, minmax(0, 1fr))` }}
        aria-label="Hotel setup progress"
      >
        {profileStepTitles.map((title, index) => {
          const isCurrent = index === step;
          const isComplete = index < step;

          return (
            <li
              key={title}
              aria-current={isCurrent ? "step" : undefined}
              title={title}
              className={`h-1.5 rounded-full transition-colors duration-300 ${
                isCurrent || isComplete ? "bg-primary-600" : "bg-primary-100"
              }`}
            >
              <span className="sr-only">{title}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
  const actions = (
    <div
      className={
        step === 1
          ? "grid w-full grid-cols-2 gap-3 sm:w-auto sm:grid-cols-[auto_auto]"
          : "flex w-full flex-col-reverse items-center gap-3 sm:flex-row sm:justify-center"
      }
    >
      {(step > 0 || onCancel) && (
        <button
          type="button"
          disabled={saving}
          onClick={() => (step > 0 ? changeStep(previousStep) : onCancel?.())}
          className={`w-full rounded-full border border-gray-200 bg-white px-5 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto ${
            step === 1 ? "sm:min-w-32" : ""
          }`}
        >
          {step > 0 ? "Back" : cancelLabel}
        </button>
      )}
      <button
        type="submit"
        disabled={savesHere && saving}
        className={`inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto ${
          step === 1 ? "sm:min-w-32" : ""
        }`}
      >
        {savesHere && saving && (
          <span
            className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
            aria-hidden="true"
          />
        )}
        <span>{savesHere ? (saving ? "Saving..." : "Save and continue") : "Continue"}</span>
        {!(savesHere && saving) && <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />}
      </button>
    </div>
  );

  return (
    <form
      noValidate
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault();
        if (savesHere) onSave();
        else continueToNextStep();
      }}
      className={`mx-auto ${step === 1 ? "max-w-none" : "max-w-7xl space-y-8"}`}
    >
      {step !== 1 && profileProgress}

      <section
        aria-busy={saving}
        className={`${step === 0 ? "grid" : "hidden"} gap-6 xl:grid-cols-2`}
      >
        <div className="flex flex-col rounded-[2rem] bg-white p-5 text-left shadow-[0_30px_90px_-50px_rgba(15,23,42,0.45)] sm:p-6 xl:min-h-[32rem] xl:p-8">
          <div className="mb-4">
            <h3
              ref={step === 0 ? stepHeading : undefined}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight text-gray-950 outline-none"
            >
              {mode === "create"
                ? "What should we call your hotel?"
                : "Are these hotel details correct?"}
            </h3>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              We’ll use this name and property type wherever your hotel appears.
            </p>
          </div>
          <div className="space-y-4">
            <TextField
              label="Hotel name"
              value={draft.displayName}
              placeholder="Hotel Alpenrose"
              required
              error={fieldErrors.displayName?.[0]}
              onChange={(value) => setField("displayName", value)}
            />
            <PropertyTypeField
              value={draft.propertyType}
              required
              error={fieldErrors.propertyType?.[0]}
              options={visiblePropertyTypeOptions}
              onChange={(value) => setField("propertyType", value)}
            />
            <PropertyLogoField
              previewUrl={logoPreviewUrl}
              pending={Boolean(draft.logoMediaObjectId && !draft.logoPublicUrl && !draft.logoFile)}
              error={fieldErrors.logo?.[0]}
              onChange={(file) => {
                const validationError = sharedPropertyLogoError(file);
                if (validationError) {
                  onFieldErrors({ ...fieldErrors, logo: [validationError] });
                  return;
                }
                const { logo: _logoError, ...remainingErrors } = fieldErrors;
                onFieldErrors(remainingErrors);
                onChange({
                  ...draft,
                  logoFile: file,
                  logoMediaObjectId: null,
                  logoPublicUrl: "",
                });
              }}
            />
          </div>
        </div>
        <aside className="hidden min-h-[32rem] items-center justify-center p-8 xl:flex">
          <HotelFacadeIllustration />
        </aside>
      </section>

      <section aria-busy={saving} className={step === contactStep ? "block" : "hidden"}>
        <div className="mx-auto max-w-3xl rounded-[2rem] bg-white p-5 text-left shadow-[0_30px_90px_-50px_rgba(15,23,42,0.45)] sm:p-8">
          <div className="mb-4">
            <h3
              ref={step === contactStep ? stepHeading : undefined}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight text-gray-950 outline-none"
            >
              How can guests reach you?
            </h3>
            <p className="mt-2 text-sm text-gray-500">
              {mode === "update"
                ? "Only contact details you change here are published on your booking page. Unchanged contacts keep their current visibility."
                : "This information is shown when guests click 'Contact' on your booking page."}
            </p>
          </div>
          <div className="space-y-4">
            <PhoneField
              label="Phone number"
              value={draft.phone}
              countryCode={draft.countryCode}
              placeholder="+94 77 123 4567"
              required
              error={fieldErrors.phone?.[0]}
              onChange={(value) => {
                const follow =
                  whatsappFollowsPhone ??
                  (draft.whatsapp ? draft.whatsapp === draft.phone : mode === "create");
                setWhatsappFollowsPhone(follow);
                onChange({
                  ...draft,
                  phone: value,
                  whatsapp: follow ? value : draft.whatsapp,
                });
              }}
            />
            <PhoneField
              label="WhatsApp number"
              value={draft.whatsapp}
              countryCode={draft.countryCode}
              placeholder="Same as phone or a different number."
              helper="Leave blank if you don't use WhatsApp."
              error={fieldErrors.whatsapp?.[0]}
              onChange={(value) => {
                setWhatsappFollowsPhone(value === draft.phone && Boolean(value));
                setField("whatsapp", value);
              }}
            />
            <TextField
              label="Email"
              value={draft.contactEmail}
              placeholder="hello@yourhotel.com"
              type="email"
              required
              error={fieldErrors.contactEmail?.[0]}
              onChange={(value) => setField("contactEmail", value)}
            />
          </div>
        </div>
      </section>

      {launchSettings && (
        <section aria-busy={saving} className={step === 2 ? "block" : "hidden"}>
          <div className="mx-auto max-w-4xl rounded-[2rem] bg-white p-5 text-left shadow-[0_30px_90px_-50px_rgba(15,23,42,0.45)] sm:p-8">
            <div className="mb-6">
              <h3
                ref={step === 2 ? stepHeading : undefined}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight text-gray-950 outline-none"
              >
                Set up guest preferences
              </h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
                We suggested a currency and language from your location. You can change these now or
                later in Booking settings.
              </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-5 rounded-2xl border border-gray-100 p-4 sm:p-5">
                <SelectField
                  label="Default currency"
                  value={launchSettings.defaultCurrency}
                  placeholder="Select a currency"
                  required
                  error={fieldErrors.defaultCurrency?.[0]}
                  options={CURRENCY_OPTIONS.map((option) => ({
                    value: option.code,
                    label: `${option.flag} ${option.code} · ${option.name}`,
                  }))}
                  onChange={(defaultCurrency) =>
                    onLaunchSettingsChange({
                      ...launchSettings,
                      defaultCurrency,
                      supportedCurrencies: launchSettings.supportedCurrencies.filter(
                        (code) => code !== defaultCurrency,
                      ),
                    })
                  }
                />
                <div>
                  <label
                    htmlFor="hotel-setup-additional-currencies"
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700"
                  >
                    <span>Additional currencies</span>
                    <span aria-hidden="true" className="text-xs text-gray-400">
                      Optional
                    </span>
                  </label>
                  <p className="mt-1 text-xs text-gray-500">
                    Guests can view prices in these currencies.
                  </p>
                  <div className="mt-3">
                    <LocalizationMultiSelect
                      id="hotel-setup-additional-currencies"
                      selected={launchSettings.supportedCurrencies}
                      onToggle={(code) =>
                        onLaunchSettingsChange({
                          ...launchSettings,
                          supportedCurrencies: launchSettings.supportedCurrencies.includes(code)
                            ? launchSettings.supportedCurrencies.filter((value) => value !== code)
                            : [...launchSettings.supportedCurrencies, code],
                        })
                      }
                      options={CURRENCY_OPTIONS}
                      excludeCode={launchSettings.defaultCurrency}
                      placeholder={`Search currencies, e.g. "Dollar" or "USD"...`}
                      getLabel={(option) => option.code}
                      getSearchLabel={(option) => `${option.name} · ${option.code}`}
                      popularCodes={POPULAR_CURRENCY_CODES}
                      emptyMessage={`No additional currencies added — your booking page will show only ${launchSettings.defaultCurrency}`}
                      comfortable
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-5 rounded-2xl border border-gray-100 p-4 sm:p-5">
                <SelectField
                  label="Default language"
                  value={launchSettings.defaultLanguage}
                  placeholder="Select a language"
                  required
                  error={fieldErrors.defaultLanguage?.[0]}
                  options={LANGUAGE_OPTIONS.map((option) => ({
                    value: option.code,
                    label: `${option.flag} ${option.name} · ${option.nativeName}`,
                  }))}
                  onChange={(defaultLanguage) =>
                    onLaunchSettingsChange({
                      ...launchSettings,
                      defaultLanguage,
                      supportedLanguages: launchSettings.supportedLanguages.filter(
                        (code) => code !== defaultLanguage,
                      ),
                    })
                  }
                />
                <div>
                  <label
                    htmlFor="hotel-setup-additional-languages"
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700"
                  >
                    <span>Additional languages</span>
                    <span aria-hidden="true" className="text-xs text-gray-400">
                      Optional
                    </span>
                  </label>
                  <p className="mt-1 text-xs text-gray-500">
                    Add languages you can support for international guests.
                  </p>
                  <div className="mt-3">
                    <LocalizationMultiSelect
                      id="hotel-setup-additional-languages"
                      selected={launchSettings.supportedLanguages}
                      onToggle={(code) =>
                        onLaunchSettingsChange({
                          ...launchSettings,
                          supportedLanguages: launchSettings.supportedLanguages.includes(code)
                            ? launchSettings.supportedLanguages.filter((value) => value !== code)
                            : [...launchSettings.supportedLanguages, code],
                        })
                      }
                      options={LANGUAGE_OPTIONS}
                      excludeCode={launchSettings.defaultLanguage}
                      placeholder={`Search languages, e.g. "German" or "Deutsch"...`}
                      getLabel={(option) => option.nativeName}
                      getSearchLabel={(option) => `${option.name} · ${option.nativeName}`}
                      popularCodes={POPULAR_LANGUAGE_CODES}
                      emptyMessage={`No additional languages added — your booking page will show only ${launchSettings.defaultLanguage.toUpperCase()}`}
                      comfortable
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 rounded-2xl border border-gray-100 p-4 sm:p-5">
              <h4 className="text-base font-semibold text-gray-950">Social media</h4>
              <p className="mt-1 text-sm text-gray-500">
                Optional links help guests discover your hotel.
              </p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {(
                  [
                    ["instagram", "Instagram", "https://instagram.com/yourhotel"],
                    ["facebook", "Facebook", "https://facebook.com/yourhotel"],
                    ["tiktok", "TikTok", "https://tiktok.com/@yourhotel"],
                    ["youtube", "YouTube", "https://youtube.com/@yourhotel"],
                  ] as const
                ).map(([field, label, placeholder]) => (
                  <TextField
                    key={field}
                    label={label}
                    value={launchSettings[field]}
                    placeholder={placeholder}
                    type="url"
                    error={fieldErrors[field]?.[0]}
                    onChange={(value) =>
                      onLaunchSettingsChange({ ...launchSettings, [field]: value })
                    }
                  />
                ))}
              </div>
              <p className="mt-4 text-xs leading-5 text-gray-500">
                You can add, remove, or update these links later in Booking settings.
              </p>
            </div>

            <div className="mt-6 text-center">
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  onSkipLaunchSettings();
                  changeStep(3);
                }}
                className="text-sm font-semibold text-gray-600 underline decoration-gray-300 underline-offset-4 transition hover:text-gray-950 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Skip for now, configure later
              </button>
            </div>
          </div>
        </section>
      )}

      <section aria-busy={saving} className={step === 1 ? "block" : "hidden"}>
        <div
          ref={locationMapArea}
          className="relative isolate min-h-[100dvh] overflow-hidden bg-slate-100 text-left"
        >
          {googleMapsApiKey && (
            <GoogleAddressMap
              active={step === 1}
              apiKey={googleMapsApiKey}
              latitude={draft.latitude}
              longitude={draft.longitude}
              focus={mapFocus}
              coveredInsets={mapCoveredInsets}
              onPick={pickMapLocation}
              onUnavailable={() => setMapUnavailable(true)}
            />
          )}

          <div className="pointer-events-none absolute inset-0 z-10 flex items-end p-3 sm:block sm:p-0">
            <div
              ref={locationCard}
              className="pointer-events-auto flex max-h-[70dvh] w-full flex-col rounded-3xl border border-white/80 bg-white/95 shadow-[0_18px_50px_-20px_rgba(15,23,42,0.35)] backdrop-blur focus-within:self-start sm:contents"
            >
              <div
                data-testid="location-search-panel"
                className={`pointer-events-auto min-h-0 flex-1 p-4 sm:absolute sm:left-6 sm:top-6 sm:flex-none sm:rounded-2xl sm:border sm:border-white/80 sm:bg-white/95 sm:shadow-[0_18px_50px_-20px_rgba(15,23,42,0.35)] sm:backdrop-blur lg:left-8 lg:top-8 ${
                  showAddressFields
                    ? // Leaves room for the action bar, which asks for the pin while the fields are open.
                      "overflow-y-auto sm:max-h-[calc(100dvh-13rem)] sm:w-[calc(100%-3rem)] sm:max-w-md"
                    : "sm:w-[calc(100%-3rem)] sm:max-w-lg"
                }`}
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <LocationHeading
                    ref={step === 1 ? pageHeadingRef : undefined}
                    tabIndex={-1}
                    className="text-xl font-semibold tracking-tight text-gray-950 outline-none"
                  >
                    Where is your property?
                  </LocationHeading>
                  {step === 1 && profileProgress}
                </div>

                {/* Search stays visible next to the fields: they never set map coordinates. */}
                {googleMapsApiKey && (
                  <GooglePlacesAddressField
                    addressRevision={addressRevision}
                    apiKey={googleMapsApiKey}
                    label="Search for your address"
                    onUnavailable={(autocompleteWasFocused) => {
                      setAddressSearchUnavailable(true);
                      if (!showAddressFields) focusAddressFieldsWhenShown.current = true;
                      setShowAddressFields(true);
                      if (showAddressFields && autocompleteWasFocused) {
                        requestAnimationFrame(() =>
                          focusFirstIncompleteAddressField(addressFields.current),
                        );
                      }
                    }}
                    onSelect={(address, isExactAddress) => {
                      setAddressSearchUnavailable(false);
                      const timezone =
                        typeof address.latitude === "number" &&
                        typeof address.longitude === "number"
                          ? timezoneForCoordinates(address.latitude, address.longitude)
                          : defaultTimezoneForCountry(address.countryCode);
                      timezoneWasAutoDetected.current = true;
                      const nextDraft = { ...draft, ...address, timezone };
                      const canCollapse =
                        isExactAddress &&
                        canConfirmLocation(nextDraft) &&
                        hasMapCoordinates(nextDraft);
                      onChange(nextDraft);
                      setShowAddressFields(!canCollapse);
                      if (!canCollapse) {
                        requestAnimationFrame(() =>
                          focusFirstIncompleteAddressField(addressFields.current),
                        );
                      }
                    }}
                  />
                )}

                {googleMapsApiKey && showAddressFields && !addressSearchUnavailable && (
                  <p className="mt-1.5 text-xs text-gray-500">
                    {mode === "update"
                      ? "Or correct the address below, then place the pin."
                      : "Or enter the address below, then place the pin."}
                  </p>
                )}

                {!showAddressFields && (
                  <button
                    ref={editAddressButton}
                    type="button"
                    aria-controls={addressFieldsId}
                    aria-expanded={false}
                    onClick={() => {
                      setShowAddressFields(true);
                      requestAnimationFrame(() =>
                        focusFirstIncompleteAddressField(addressFields.current),
                      );
                    }}
                    className="mt-2 text-sm font-semibold text-primary-700 transition hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
                  >
                    {hasCompleteLocation ? "Edit address details" : "Enter address manually"}
                  </button>
                )}

                {showAddressFields && (
                  <div
                    ref={addressFields}
                    id={addressFieldsId}
                    className={`${googleMapsApiKey && !addressSearchUnavailable ? "mt-4 " : ""}border-t border-gray-100 pt-4`}
                  >
                    {addressSearchUnavailable && (
                      <p
                        className="mb-4 rounded-xl bg-gray-50 px-3 py-2.5 text-sm text-gray-600"
                        role="status"
                      >
                        Address suggestions are unavailable. Enter the address, then click your
                        property on the map.
                      </p>
                    )}
                    {googleMapsApiKey && hasCompleteLocation && (
                      <div className="mb-3 flex justify-end">
                        <button
                          type="button"
                          aria-controls={addressFieldsId}
                          aria-expanded={true}
                          onClick={() => {
                            setShowAddressFields(false);
                            requestAnimationFrame(() => editAddressButton.current?.focus());
                          }}
                          className="text-sm font-semibold text-primary-700 transition hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
                        >
                          Done editing
                        </button>
                      </div>
                    )}
                    <div className="grid gap-4">
                      <TextField
                        label="Street address"
                        value={draft.streetAddress}
                        placeholder="Marienplatz 1"
                        required
                        error={fieldErrors["location.streetAddress"]?.[0]}
                        onChange={(value) => setField("streetAddress", value)}
                      />
                      <TextField
                        label="Postal code (optional)"
                        value={draft.postalCode}
                        placeholder="80331"
                        error={fieldErrors["location.postalCode"]?.[0]}
                        onChange={(value) => setField("postalCode", value)}
                      />
                      <TextField
                        label="City"
                        value={draft.city}
                        placeholder="Munich"
                        required
                        error={fieldErrors["location.city"]?.[0]}
                        onChange={(value) => setField("city", value)}
                      />
                      <SelectField
                        label="Country"
                        value={draft.countryCode}
                        placeholder="Select a country"
                        required
                        error={fieldErrors["location.countryCode"]?.[0]}
                        options={COUNTRY_OPTIONS.map((country) => ({
                          value: country.code,
                          label: `${country.flag} ${country.name}`,
                        }))}
                        onChange={(value) => {
                          addressRevision.current += 1;
                          timezoneWasAutoDetected.current = true;
                          onChange({
                            ...draft,
                            countryCode: value,
                            timezone: defaultTimezoneForCountry(value),
                            ...locationResetForManualAddressEdit("countryCode"),
                          });
                        }}
                      />
                      <TimezoneField
                        value={draft.timezone}
                        error={fieldErrors["location.timezone"]?.[0]}
                        options={TIMEZONE_PICKER_OPTIONS}
                        onChange={(value) => setField("timezone", value)}
                      />
                    </div>
                  </div>
                )}
                {!showCoordinateFields && addressSearchUnavailable && (
                  <button
                    type="button"
                    onClick={() => {
                      setCoordinatesRequested(true);
                      requestAnimationFrame(() =>
                        coordinateFields.current?.querySelector<HTMLElement>("input")?.focus(),
                      );
                    }}
                    className="mt-3 text-sm font-semibold text-primary-700 transition hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
                  >
                    Enter coordinates instead
                  </button>
                )}
                {showCoordinateFields && (
                  <div
                    ref={coordinateFields}
                    className="mt-4 rounded-xl border border-gray-200 p-3"
                  >
                    <p className="text-sm text-gray-600">
                      {mapUnavailable ? "The map couldn’t load. " : ""}Enter your property’s
                      coordinates, for example copied from Google Maps.
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      {(["latitude", "longitude"] as const).map((field) => (
                        <TextField
                          key={field}
                          label={field === "latitude" ? "Latitude" : "Longitude"}
                          value={coordinateText[field]}
                          placeholder={field === "latitude" ? "48.137154" : "11.576124"}
                          required
                          onChange={(value) => {
                            setCoordinateText((text) => ({ ...text, [field]: value }));
                            const coordinate = parsedCoordinate(value);
                            const limit = field === "latitude" ? 90 : 180;
                            const next =
                              coordinate !== null && Math.abs(coordinate) <= limit
                                ? coordinate
                                : null;
                            if (next === draft[field]) return;
                            coordinateTyped.current = true;
                            const nextDraft = { ...draft, [field]: next };
                            const { latitude, longitude } = nextDraft;
                            // Like a pin: an auto-detected time zone follows complete coordinates.
                            const followPin =
                              latitude !== null &&
                              longitude !== null &&
                              hasMapCoordinates(nextDraft) &&
                              (timezoneWasAutoDetected.current || !draft.timezone.trim());
                            if (followPin) timezoneWasAutoDetected.current = true;
                            onChange(
                              followPin
                                ? {
                                    ...nextDraft,
                                    timezone: timezoneForCoordinates(latitude, longitude),
                                  }
                                : nextDraft,
                            );
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <label
                  className={`mt-4 flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-left ${
                    localityHighlighted
                      ? "border-amber-300 bg-amber-50 ring-2 ring-amber-300"
                      : "border-gray-200 bg-gray-50"
                  }`}
                >
                  <input
                    ref={localityCheckbox}
                    type="checkbox"
                    checked={draft.localityPublic}
                    onChange={(event) =>
                      onChange({ ...draft, localityPublic: event.target.checked })
                    }
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-gray-900">
                      Show city and country publicly
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-gray-600">
                      {mode === "update"
                        ? "Guests see your city and country on your booking page. Street address and postal code stay private, and changing the address turns off your guest map."
                        : "Guests see your city and country on your booking page. Street address, postal code, and map pin stay private."}
                    </span>
                    {localityHighlighted && (
                      <span className="mt-1 block text-xs font-medium leading-5 text-amber-800">
                        Your booking page needs this before it can go live.
                      </span>
                    )}
                  </span>
                </label>
              </div>

              <div
                data-testid="location-action-bar"
                className={`pointer-events-auto shrink-0 border-t border-gray-100 p-4 sm:absolute sm:bottom-8 sm:left-1/2 sm:flex sm:-translate-x-1/2 sm:items-center sm:justify-between sm:rounded-2xl sm:border sm:border-white/80 sm:bg-white/95 sm:shadow-[0_18px_50px_-20px_rgba(15,23,42,0.35)] sm:backdrop-blur ${
                  showLocationSummary
                    ? "sm:w-[calc(100%-3rem)] sm:max-w-4xl"
                    : "sm:w-auto sm:min-w-[19rem]"
                }`}
              >
                {showLocationSummary && (
                  <div
                    className="flex min-w-0 items-start gap-3 sm:flex-1 sm:items-center"
                    aria-live="polite"
                  >
                    <span
                      className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full sm:mt-0 ${
                        hasMappedLocation
                          ? "bg-primary-600 text-white"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      <MapPinIcon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-950">
                        {hasMappedLocation ? "Is this the right location?" : "Add your map pin"}
                      </p>
                      <p className="mt-0.5 text-sm text-gray-700 sm:truncate">{addressLine}</p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {hasMappedLocation
                          ? [
                              !mapUnavailable &&
                                "Drag the pin if it isn’t exactly on your property",
                              draft.timezone && `Time zone · ${draft.timezone}`,
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : mapUnavailable
                            ? "Needed for your booking page’s map. Enter your property’s coordinates above."
                            : lookupForAddress === "not_found"
                              ? "We couldn’t find this address on the map. Click your property on the map instead."
                              : lookupForAddress === "area"
                                ? "Google found the area, not the exact address. Click your property on the map."
                                : addressSearchUnavailable
                                  ? "Needed for your booking page’s map. Zoom in and click your property; drag the pin to adjust."
                                  : "Needed for your booking page’s map. Click your property on the map."}
                      </p>
                    </div>
                  </div>
                )}

                <div
                  className={
                    showLocationSummary
                      ? "mt-4 flex flex-col gap-3 sm:ml-6 sm:mt-0 sm:shrink-0 sm:flex-row sm:items-center"
                      : ""
                  }
                >
                  {showLocationSummary &&
                    !hasMappedLocation &&
                    !addressSearchUnavailable &&
                    !mapUnavailable && (
                      <button
                        type="button"
                        disabled={saving || mapLookup?.status === "searching"}
                        onClick={() => void findTypedAddressOnMap(addressLine)}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-primary-200 bg-primary-50 px-5 py-3 text-sm font-semibold text-primary-700 transition hover:bg-primary-100 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                      >
                        <MagnifyingGlassIcon className="h-4 w-4" aria-hidden="true" />
                        {mapLookup?.status === "searching" ? "Finding…" : "Find on map"}
                      </button>
                    )}
                  {actions}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {step !== 1 && actions}

      <span className="sr-only" role="status" aria-live="polite">
        {saving ? "Saving hotel details." : ""}
      </span>
    </form>
  );
}

function TrackSelection({
  availableTracks,
  selectedTracks,
  canManageTracks,
  saving,
  onToggle,
  onSave,
}: {
  availableTracks: readonly SetupTrack[];
  selectedTracks: SetupTrack[];
  canManageTracks: boolean;
  saving: boolean;
  onToggle: (track: SetupTrack) => void;
  onSave: () => void;
}) {
  const needsSelection = selectedTracks.length === 0;

  return (
    <section className="mx-auto max-w-5xl">
      <div className="grid gap-5 md:grid-cols-2">
        {availableTracks.map((track) => {
          const content = TRACK_CONTENT[track];
          const checked = selectedTracks.includes(track);
          const disabled = !canManageTracks;
          const Icon = content.icon;
          return (
            <label
              key={track}
              className={`flex min-h-64 flex-col rounded-3xl bg-white p-6 text-left shadow-sm transition focus-within:outline-none focus-within:ring-2 focus-within:ring-primary-600 focus-within:ring-offset-2 ${
                disabled
                  ? "cursor-not-allowed ring-1 ring-gray-200"
                  : checked
                    ? "cursor-pointer ring-2 ring-primary-500"
                    : "cursor-pointer ring-1 ring-gray-200 hover:ring-primary-200"
              }`}
            >
              <span className="flex items-start justify-between gap-4">
                <span
                  className={`flex h-12 w-12 items-center justify-center rounded-2xl ${
                    checked ? "bg-primary-600 text-white" : "bg-primary-50 text-primary-700"
                  }`}
                >
                  <Icon className="h-6 w-6" aria-hidden="true" />
                </span>
                <input
                  type="checkbox"
                  className="sr-only"
                  aria-label={content.title}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggle(track)}
                />
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${
                    checked
                      ? "border-primary-600 bg-primary-600 text-white"
                      : "border-gray-300 text-transparent"
                  }`}
                  aria-hidden="true"
                >
                  <CheckIcon className="h-3.5 w-3.5" />
                </span>
              </span>
              <span className="mt-5 text-xl font-semibold text-gray-950">{content.title}</span>
              {content.subtitle && (
                <span className="mt-1 text-sm font-semibold text-primary-700">
                  {content.subtitle}
                </span>
              )}
              <span className="mt-3 text-sm leading-6 text-gray-600">{content.description}</span>
            </label>
          );
        })}
      </div>

      {!canManageTracks && (
        <div
          className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center text-sm text-amber-900"
          role="status"
        >
          Ask a hotel group owner to choose or add vayada services.
        </div>
      )}

      <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <button
          type="button"
          disabled={saving || needsSelection || !canManageTracks}
          onClick={onSave}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-500 disabled:hover:bg-gray-200 sm:w-auto"
        >
          {saving && (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
              aria-hidden="true"
            />
          )}
          <span>{saving ? "Saving..." : "Continue"}</span>
          {!saving && <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
    </section>
  );
}

export function idempotencyKeyForRetry(
  current: string | null,
  create: () => string = () => globalThis.crypto.randomUUID(),
): string {
  return current ?? create();
}

async function savePropertyLogo({
  api,
  draft,
  profile,
  uploadKey,
  assignmentKey,
}: {
  api: SharedHotelSetupApi;
  draft: ProfileDraft;
  profile: PropertyProfileResponse;
  uploadKey: { current: string | null };
  assignmentKey: { current: string | null };
}): Promise<PropertyProfileResponse> {
  if (draft.logoPublicUrl && !draft.logoFile) return profile;
  const storage = window.localStorage;
  let pending = readPendingPropertyLogo(storage, profile.propertyId);

  if (draft.logoFile) {
    const mediaObjectId = await api.uploadPropertyLogo(
      profile.propertyId,
      draft.logoFile,
      (uploadKey.current = idempotencyKeyForRetry(uploadKey.current)),
    );
    pending = {
      mediaObjectId,
      expectedProfileRevision: profile.profileRevision,
      assignmentIdempotencyKey: (assignmentKey.current = idempotencyKeyForRetry(
        assignmentKey.current,
      )),
    };
    writePendingPropertyLogo(storage, profile.propertyId, pending);
  }

  if (!pending || (pending.mediaObjectId !== draft.logoMediaObjectId && !draft.logoFile)) {
    throw new Error("Choose a hotel logo before continuing.");
  }
  let assigned: Awaited<ReturnType<SharedHotelSetupApi["assignPropertyLogo"]>>;
  try {
    assigned = await api.assignPropertyLogo(
      profile.propertyId,
      {
        expectedProfileRevision: pending.expectedProfileRevision,
        mediaObjectId: pending.mediaObjectId,
        altText: null,
      },
      pending.assignmentIdempotencyKey,
    );
  } catch (error) {
    if (setupErrorCode(error) === "profile_revision_conflict") {
      const latest = await api.getPropertyProfile(profile.propertyId);
      const retry = {
        ...pending,
        expectedProfileRevision: latest.profileRevision,
        assignmentIdempotencyKey: idempotencyKeyForRetry(null),
      };
      assignmentKey.current = retry.assignmentIdempotencyKey;
      writePendingPropertyLogo(storage, profile.propertyId, retry);
      throw new Error(
        "These hotel details changed in another session. Review them, then save the logo again.",
      );
    }
    throw error;
  }
  if (assigned.logoAssignment?.mediaObjectId !== pending.mediaObjectId) {
    throw new Error("The hotel logo assignment could not be confirmed.");
  }
  clearPendingPropertyLogo(storage, profile.propertyId);
  return { ...profile, profileRevision: assigned.profileRevision };
}

export function validateProfileDraft(draft: ProfileDraft): Record<string, string[]> {
  const errors: Record<string, string[]> = {};

  if (!draft.displayName.trim()) errors.displayName = ["Hotel name is required."];
  if (!draft.propertyType) errors.propertyType = ["Property type is required."];
  if (!draft.logoFile && !draft.logoMediaObjectId && !draft.logoPublicUrl) {
    errors.logo = ["Hotel logo is required."];
  }
  if (!draft.streetAddress.trim()) {
    errors["location.streetAddress"] = ["Street address is required."];
  }
  if (!draft.city.trim()) {
    errors["location.city"] = ["City is required."];
  }
  if (!draft.countryCode.trim()) {
    errors["location.countryCode"] = ["Country is required."];
  } else if (!COUNTRY_OPTIONS.some((country) => country.code === draft.countryCode)) {
    errors["location.countryCode"] = ["Select a valid country."];
  }
  if (!draft.timezone.trim()) {
    errors["location.timezone"] = ["Time zone is required."];
  }
  if (!draft.contactEmail.trim()) errors.contactEmail = ["Email is required."];
  if (!draft.phone.trim()) errors.phone = ["Phone number is required."];
  if (draft.timezone.trim() && !isValidIanaTimezone(draft.timezone.trim())) {
    errors["location.timezone"] = ["Enter a valid IANA time zone."];
  }
  if (draft.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.contactEmail)) {
    errors.contactEmail = ["Enter a valid email address."];
  }
  if (draft.phone.trim() && !isValidInternationalPhone(draft.phone)) {
    errors.phone = ["Enter a valid phone number."];
  }
  if (draft.whatsapp && !isValidInternationalPhone(draft.whatsapp)) {
    errors.whatsapp = ["Enter a valid WhatsApp number."];
  }

  return errors;
}

function focusFirstIncompleteAddressField(container: HTMLDivElement | null) {
  const fields = Array.from(
    container?.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select") ?? [],
  );
  (fields.find((field) => !field.value.trim()) ?? fields[0])?.focus();
}

function TextField({
  label,
  value,
  onChange,
  error,
  helper,
  placeholder,
  type = "text",
  readOnly = false,
  required = false,
  listOptions,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  helper?: string;
  placeholder?: string;
  type?: string;
  readOnly?: boolean;
  required?: boolean;
  listOptions?: string[];
}) {
  const generatedId = useId();
  const inputId = `setup-${generatedId}`;
  const helperId = helper ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div>
      <label
        htmlFor={inputId}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700"
      >
        <span>{label}</span>
        {!required && (
          <span aria-hidden="true" className="text-xs text-gray-400">
            Optional
          </span>
        )}
      </label>
      {helper && (
        <p id={helperId} className="mt-1 text-xs text-gray-500">
          {helper}
        </p>
      )}
      <input
        id={inputId}
        type={type}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        aria-required={required}
        list={listOptions ? `${inputId}-options` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-2 w-full rounded-xl border px-4 py-2.5 text-base outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100 sm:text-sm ${
          error ? "border-red-300 bg-red-50" : "border-gray-200"
        } ${readOnly ? "bg-gray-50 text-gray-600" : ""}`}
      />
      {listOptions && (
        <datalist id={`${inputId}-options`}>
          {listOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const SUPPORTED_PHONE_COUNTRIES = new Set(getCountries());
const PHONE_COUNTRY_OPTIONS = COUNTRY_OPTIONS.filter(({ code }) =>
  SUPPORTED_PHONE_COUNTRIES.has(code as CountryCode),
).map((country) => ({
  ...country,
  callingCode: `+${getCountryCallingCode(country.code as CountryCode)}`,
}));

function phoneCountry(value: string, fallback: string): CountryCode {
  const parsed = parsePhoneNumberFromString(value);
  if (parsed?.country) return parsed.country;
  const normalizedFallback = fallback.trim().toUpperCase() as CountryCode;
  return SUPPORTED_PHONE_COUNTRIES.has(normalizedFallback) ? normalizedFallback : "US";
}

export function normalizedPhoneNumber(value: string, countryCode?: CountryCode): string {
  const parsed = parsePhoneNumberFromString(value, countryCode);
  return parsed?.isValid() ? parsed.formatInternational() : value;
}

function isValidInternationalPhone(value: string): boolean {
  return value.trim().startsWith("+") && Boolean(parsePhoneNumberFromString(value)?.isValid());
}

export function phoneWithCountryCallingCode(
  value: string,
  countryCode: CountryCode,
  previousCountryCode?: CountryCode,
): string {
  const callingCode = `+${getCountryCallingCode(countryCode)}`;
  const parsed = parsePhoneNumberFromString(value);
  if (parsed?.nationalNumber) return `${callingCode} ${parsed.nationalNumber}`;

  const digits = value.replace(/\D/g, "");
  const previousCallingCode = previousCountryCode
    ? getCountryCallingCode(previousCountryCode)
    : undefined;
  const nationalNumber =
    previousCallingCode && digits.startsWith(previousCallingCode)
      ? digits.slice(previousCallingCode.length)
      : digits.replace(/^0+/, "");
  return nationalNumber ? `${callingCode} ${nationalNumber}` : `${callingCode} `;
}

function PhoneField({
  label,
  value,
  countryCode,
  onChange,
  error,
  helper,
  placeholder,
  required = false,
}: {
  label: string;
  value: string;
  countryCode: string;
  onChange: (value: string) => void;
  error?: string;
  helper?: string;
  placeholder: string;
  required?: boolean;
}) {
  const generatedId = useId();
  const inputId = `setup-${generatedId}`;
  const helperId = helper ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;
  const [selectedCountry, setSelectedCountry] = useState<CountryCode>(() =>
    phoneCountry(value, countryCode),
  );

  useEffect(() => {
    const parsedCountry = parsePhoneNumberFromString(value)?.country;
    if (parsedCountry) {
      setSelectedCountry((current) => (current === parsedCountry ? current : parsedCountry));
    } else if (!value.trim()) {
      const fallbackCountry = phoneCountry("", countryCode);
      setSelectedCountry((current) => (current === fallbackCountry ? current : fallbackCountry));
    }
  }, [countryCode, value]);

  return (
    <div>
      <label
        htmlFor={inputId}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700"
      >
        <span>{label}</span>
        {!required && (
          <span aria-hidden="true" className="text-xs text-gray-400">
            Optional
          </span>
        )}
      </label>
      {helper && (
        <p id={helperId} className="mt-1 text-xs text-gray-500">
          {helper}
        </p>
      )}
      <div
        className={`mt-2 flex overflow-hidden rounded-xl border transition focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-100 ${
          error ? "border-red-300 bg-red-50" : "border-gray-200 bg-white"
        }`}
      >
        <select
          aria-label={`${label} country code`}
          value={selectedCountry}
          onChange={(event) => {
            const nextCountry = event.target.value as CountryCode;
            const previousCountry = selectedCountry;
            setSelectedCountry(nextCountry);
            onChange(phoneWithCountryCallingCode(value, nextCountry, previousCountry));
          }}
          className="w-32 shrink-0 border-0 border-r border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none"
        >
          {PHONE_COUNTRY_OPTIONS.map((country) => (
            <option key={country.code} value={country.code}>
              {country.flag} {country.callingCode}
            </option>
          ))}
        </select>
        <input
          id={inputId}
          type="tel"
          value={value}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          aria-required={required}
          onChange={(event) => onChange(normalizedPhoneNumber(event.target.value, selectedCountry))}
          onBlur={() => {
            const normalized = normalizedPhoneNumber(value, selectedCountry);
            if (normalized !== value) onChange(normalized);
          }}
          className="min-w-0 flex-1 border-0 bg-transparent px-4 py-2.5 text-base outline-none sm:text-sm"
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

function PropertyLogoField({
  previewUrl,
  pending,
  error,
  onChange,
}: {
  previewUrl: string;
  pending: boolean;
  error?: string;
  onChange: (file: File) => void;
}) {
  const inputId = `property-logo-${useId()}`;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div>
      <p className="text-sm font-medium text-gray-700">
        Hotel logo
        <span className="ml-1 text-red-500" aria-hidden="true">
          *
        </span>
        <span className="sr-only"> (required)</span>
      </p>
      <label
        htmlFor={inputId}
        className={`mt-2 flex cursor-pointer items-center gap-4 rounded-xl border bg-white p-3 transition hover:border-primary-300 focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-2 ${
          error ? "border-red-300 bg-red-50" : "border-gray-200"
        }`}
      >
        <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gray-100 text-gray-500">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Hotel logo preview"
              className="h-full w-full object-contain"
            />
          ) : pending ? (
            <CheckIcon className="h-7 w-7 text-primary-700" aria-hidden="true" />
          ) : (
            <PhotoIcon className="h-7 w-7" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-gray-900">
            {previewUrl
              ? "Change hotel logo"
              : pending
                ? "Logo ready to finish"
                : "Choose hotel logo"}
          </span>
          <span className="mt-1 block text-xs leading-5 text-gray-500">
            JPG, PNG, or WebP. Max 10 MB. The logo is published only after assignment.
          </span>
        </span>
        <input
          id={inputId}
          type="file"
          aria-label="Hotel logo file"
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          aria-invalid={Boolean(error)}
          aria-describedby={errorId}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onChange(file);
            event.target.value = "";
          }}
        />
      </label>
      {error && (
        <p id={errorId} className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PropertyTypeField({
  value,
  options,
  onChange,
  error,
  required = false,
}: {
  value: string;
  options: SharedPropertyTypeOption[];
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
}) {
  const generatedId = useId();
  const groupName = `property-type-${generatedId}`;
  const errorId = error ? `${groupName}-error` : undefined;

  return (
    <fieldset aria-describedby={errorId} aria-invalid={Boolean(error)}>
      <legend className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700">
        <span>Property type</span>
        {!required && (
          <span aria-hidden="true" className="text-xs text-gray-400">
            Optional
          </span>
        )}
      </legend>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {options.map((option) => {
          const checked = value === option.value;
          const Icon = PROPERTY_TYPE_ICONS.get(option.value) ?? EllipsisHorizontalIcon;

          return (
            <label key={option.value} className="relative block cursor-pointer">
              <input
                type="radio"
                name={groupName}
                value={option.value}
                checked={checked}
                required={required}
                aria-invalid={Boolean(error)}
                aria-describedby={errorId}
                onChange={(event) => onChange(event.target.value)}
                className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
              />
              <span
                className={`relative flex min-h-16 items-center gap-2 rounded-xl border p-2.5 transition peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-primary-600 peer-focus-visible:ring-offset-2 ${
                  checked
                    ? "border-primary-500 bg-primary-50 shadow-[0_12px_30px_-24px_rgba(30,62,219,0.8)]"
                    : "border-gray-200 bg-white hover:border-primary-300 hover:bg-primary-50/40"
                }`}
              >
                <span
                  className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    checked ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-700"
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {checked && (
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary-700 text-white ring-2 ring-white">
                      <CheckIcon className="h-3 w-3" aria-hidden="true" />
                    </span>
                  )}
                </span>
                <span className="text-sm font-medium leading-5 text-gray-900">{option.label}</span>
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p id={errorId} className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

function SelectField({
  label,
  value,
  placeholder,
  options,
  onChange,
  error,
  required = false,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
}) {
  const generatedId = useId();
  const inputId = `setup-${generatedId}`;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div>
      <label
        htmlFor={inputId}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700"
      >
        <span>{label}</span>
        {!required && (
          <span aria-hidden="true" className="text-xs text-gray-400">
            Optional
          </span>
        )}
      </label>
      <select
        id={inputId}
        value={value}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={errorId}
        aria-required={required}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-2 w-full rounded-xl border bg-white px-4 py-2.5 text-base outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100 sm:text-sm ${
          error ? "border-red-300 bg-red-50" : "border-gray-200"
        }`}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <p id={errorId} className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function draftFromProfile(
  response: PropertyProfileResponse,
  publicResponse: PublicPropertyProfileResponse | null,
  pendingLogo: PendingPropertyLogoAssignment | null,
): ProfileDraft {
  const profile = response.profile;
  const publicLogo = publicResponse?.publicProfile.media.find(
    ({ mediaType }) => mediaType === "logo",
  );
  const phone = contactValue(profile.contacts, "phone");
  const whatsapp = contactValue(profile.contacts, "whatsapp");
  const profileCountry = profile.location.countryCode.trim().toUpperCase() as CountryCode;
  const profilePhoneCountry = SUPPORTED_PHONE_COUNTRIES.has(profileCountry)
    ? profileCountry
    : undefined;
  return {
    displayName: profile.displayName,
    propertyType: profile.propertyType,
    countryCode: profileCountry,
    city: profile.location.city,
    streetAddress: profile.location.streetAddress,
    postalCode: profile.location.postalCode,
    latitude: profile.location.latitude,
    longitude: profile.location.longitude,
    timezone: profile.location.timezone,
    contactEmail: contactValue(profile.contacts, "email"),
    phone: normalizedPhoneNumber(phone, profilePhoneCountry),
    whatsapp: normalizedPhoneNumber(whatsapp, profilePhoneCountry),
    localityPublic: profile.location.localityPublic,
    logoFile: null,
    logoMediaObjectId: pendingLogo?.mediaObjectId ?? publicLogo?.mediaObjectId ?? null,
    logoPublicUrl: pendingLogo ? "" : (publicLogo?.url ?? ""),
  };
}

export function createProfileFromDraft(draft: ProfileDraft): CreatePropertyProfileRequest {
  return {
    displayName: draft.displayName.trim(),
    propertyType: draft.propertyType,
    location: {
      countryCode: draft.countryCode.trim().toUpperCase(),
      city: draft.city.trim(),
      streetAddress: draft.streetAddress.trim(),
      postalCode: draft.postalCode.trim(),
      timezone: draft.timezone.trim(),
      latitude: draft.latitude,
      longitude: draft.longitude,
      localityPublic: draft.localityPublic,
      geoPublic: false,
      mapDisplayMode: "hidden",
    },
    contacts: contactsFromDraft(draft),
  };
}

export function profileUpdateFromDraft(
  draft: ProfileDraft,
  existing: PropertyProfileResponse,
): UpdatePropertyProfileRequest | null {
  const profile = existing.profile;
  const baseline = draftFromProfile(existing, null, null);
  const original = createProfileFromDraft(baseline);
  const edited = createProfileFromDraft(draft);
  const patch: PropertyProfilePatch = {};
  if (edited.displayName !== original.displayName) patch.displayName = edited.displayName;
  if (edited.propertyType !== original.propertyType) patch.propertyType = edited.propertyType;

  const locationPatch = Object.fromEntries(
    Object.entries(edited.location).filter(
      ([key, value]) => value !== original.location[key as keyof typeof original.location],
    ),
  ) as NonNullable<PropertyProfilePatch["location"]>;
  if (Object.keys(locationPatch).length > 0) {
    // Consent for an existing location does not publish newly entered location details. The city
    // and country box alone changes no address, so a public guest map stays on (VAY-2288).
    if (Object.keys(locationPatch).some((key) => key !== "localityPublic")) {
      if (profile.location.geoPublic) locationPatch.geoPublic = false;
      if (profile.location.mapDisplayMode !== "hidden") locationPatch.mapDisplayMode = "hidden";
    }
    patch.location = locationPatch;
  }

  const contacts = contactsFromDraft(draft, profile.contacts, baseline);
  if (!sameContacts(contacts, profile.contacts)) patch.contacts = contacts;
  if (Object.keys(patch).length === 0) return null;

  return {
    expectedProfileRevision: existing.profileRevision,
    patch,
  };
}

function newPropertyDraft(timezone = ""): ProfileDraft {
  return {
    displayName: "",
    propertyType: "",
    countryCode: "",
    city: "",
    streetAddress: "",
    postalCode: "",
    latitude: null,
    longitude: null,
    timezone,
    contactEmail: "",
    phone: "",
    whatsapp: "",
    // A booking page needs a public city and country; street, postal code and pin stay private
    // (VAY-2288). Existing hotels keep the choice they saved.
    localityPublic: true,
    logoFile: null,
    logoMediaObjectId: null,
    logoPublicUrl: "",
  };
}

function normalizedPropertyLaunchSettings(
  settings: PropertyLaunchSettings,
): PropertyLaunchSettings {
  return {
    defaultCurrency: settings.defaultCurrency,
    supportedCurrencies: Array.from(new Set(settings.supportedCurrencies)).filter(
      (code) => code !== settings.defaultCurrency,
    ),
    defaultLanguage: settings.defaultLanguage,
    supportedLanguages: Array.from(new Set(settings.supportedLanguages)).filter(
      (code) => code !== settings.defaultLanguage,
    ),
    instagram: settings.instagram.trim(),
    facebook: settings.facebook.trim(),
    tiktok: settings.tiktok.trim(),
    youtube: settings.youtube.trim(),
  };
}

function contactsFromDraft(
  draft: ProfileDraft,
  existing: PropertyProfileContact[] = [],
  baseline?: ProfileDraft,
): PropertyProfileContact[] {
  return (
    [
      ["phone", draft.phone, baseline?.phone],
      ["whatsapp", draft.whatsapp, baseline?.whatsapp],
      ["email", draft.contactEmail, baseline?.contactEmail],
    ] as const
  ).reduce<PropertyProfileContact[]>((contacts, [channelType, value, original]) => {
    const displayed = channelType === "email" ? value.trim() : normalizedPhoneNumber(value.trim());
    if (original !== undefined && displayed === original.trim()) return contacts;
    return replaceContact(contacts, channelType, value);
  }, existing);
}

function replaceContact(
  contacts: PropertyProfileContact[],
  channelType: PropertyProfileContact["channelType"],
  rawValue: string,
): PropertyProfileContact[] {
  const trimmed = rawValue.trim();
  const exactIndex = contacts.findIndex(
    (contact) => contact.channelType === channelType && contact.value === trimmed,
  );
  if (!trimmed) {
    return contacts.filter((contact) => contact.channelType !== channelType || !contact.isPublic);
  }

  if (exactIndex >= 0) {
    return contacts.flatMap((contact, contactIndex) => {
      if (contactIndex === exactIndex) {
        return [{ ...contact, purpose: "general" as const, isPublic: true }];
      }
      return contact.channelType === channelType && contact.isPublic ? [] : [contact];
    });
  }

  return [
    ...contacts.filter((contact) => contact.channelType !== channelType || !contact.isPublic),
    {
      channelType,
      value: trimmed,
      purpose: "general",
      isPublic: true,
    },
  ];
}

function contactValue(
  contacts: PropertyProfileContact[],
  channelType: PropertyProfileContact["channelType"],
): string {
  return (
    contacts.find(
      (contact) =>
        contact.channelType === channelType && contact.purpose === "general" && contact.isPublic,
    )?.value ??
    contacts.find((contact) => contact.channelType === channelType && contact.isPublic)?.value ??
    contacts.find((contact) => contact.channelType === channelType && contact.purpose === "general")
      ?.value ??
    contacts.find((contact) => contact.channelType === channelType)?.value ??
    ""
  );
}

function sameContacts(
  left: readonly PropertyProfileContact[],
  right: readonly PropertyProfileContact[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (contact, index) =>
        contact.channelType === right[index]?.channelType &&
        contact.value === right[index]?.value &&
        contact.purpose === right[index]?.purpose &&
        contact.isPublic === right[index]?.isPublic,
    )
  );
}

export function mergeTrackSelectionAfterConflict(
  intended: readonly SetupTrack[],
  current: readonly SetupTrack[],
): SetupTrack[] {
  return SETUP_TRACKS.filter((track) => intended.includes(track) || current.includes(track));
}

function sameTrackSelection(left: readonly SetupTrack[], right: readonly SetupTrack[]): boolean {
  return left.length === right.length && left.every((track, index) => track === right[index]);
}

function propertyTypeOptionsFromCatalog(options: unknown): SharedPropertyTypeOption[] {
  if (
    !Array.isArray(options) ||
    options.length === 0 ||
    !options.every(
      (option) =>
        typeof option === "object" &&
        option !== null &&
        typeof option.value === "string" &&
        option.value.length > 0 &&
        typeof option.label === "string" &&
        option.label.length > 0,
    )
  ) {
    throw new Error("Property types are unavailable. Please try again.");
  }
  return options as SharedPropertyTypeOption[];
}

export function setupErrorMessage(error: unknown): string {
  const status = setupErrorStatus(error);
  const code = setupErrorCode(error);
  if (status === 503 && code === "hotel_setup_unavailable") {
    return "Hotel setup is temporarily unavailable. Please try again in a few minutes.";
  }
  if (status !== null && status >= 500) {
    return "Something went wrong on our end. Please try again.";
  }

  if (code === "command_in_progress") {
    return "We're still finishing your setup. Please try again in a moment.";
  }
  if (code === "idempotency_key_conflict") {
    return "Your setup changed during this save. Review it and try again.";
  }
  if (code === "profile_edit_not_provisioned") {
    return "Editing hotel details isn't enabled for your account on this hotel yet, so trying again won't help. Please contact Vayada support.";
  }

  const data =
    error && typeof error === "object"
      ? (error as { data?: { detail?: unknown; message?: unknown; error?: unknown } }).data
      : null;
  const serverMessage = [data?.detail, data?.message, data?.error].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (serverMessage && !isRawApiErrorMessage(serverMessage)) return serverMessage;

  if (status === 409) {
    return "We couldn't save because your setup changed elsewhere. Refresh and try again.";
  }
  if (
    error instanceof TypeError ||
    (error instanceof Error && /failed to fetch|network/i.test(error.message))
  ) {
    return "Couldn't save. Check your connection and try again.";
  }
  if (error instanceof Error && error.message && !isRawApiErrorMessage(error.message)) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function setupErrorStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status)) return status;
  }
  if (error instanceof Error) {
    const match = /^API Error: (\d{3})$/i.exec(error.message.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

function setupErrorPropertyId(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: { propertyId?: unknown } }).data;
  return typeof data?.propertyId === "string" && data.propertyId.length > 0
    ? data.propertyId
    : null;
}

function isRawApiErrorMessage(message: string): boolean {
  return /^API Error: \d{3}$/i.test(message.trim());
}

function setupErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: { code?: unknown } }).data;
  return typeof data?.code === "string" ? data.code : null;
}

function fieldErrorsFromError(error: unknown): Record<string, string[]> {
  if (!error || typeof error !== "object") return {};
  const data = (error as { data?: { fields?: unknown } }).data;
  if (!data || !data.fields || typeof data.fields !== "object" || Array.isArray(data.fields)) {
    return {};
  }
  return data.fields as Record<string, string[]>;
}
