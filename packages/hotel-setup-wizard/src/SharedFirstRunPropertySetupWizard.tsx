"use client";

import { useEffect, useMemo, useState } from "react";

import {
  SHARED_HOTEL_SETUP_PRODUCTS,
  isSharedHotelSetupProductSelectable,
  resolveSharedFirstRunSetupView,
  selectedProductsForProperty,
  type SharedFirstRunSetupViewModel,
  type SharedHotelSetupEntryProduct,
  type SharedHotelSetupProduct,
  type SharedHotelSetupStatus,
  type SharedPropertyProfile,
  type SharedPropertyProfileInput,
  type SharedSetupProperty,
} from "./sharedFirstRunSetupFlow";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";

type ProductLabels = Record<SharedHotelSetupProduct, string>;

export type SharedFirstRunProductContinueInput = {
  product: SharedHotelSetupProduct;
  propertyId: string;
  returnTo: string | null;
  action: "complete_product_activation" | "enter_product";
};

export type SharedFirstRunPropertySetupWizardProps = {
  api: SharedHotelSetupApi;
  entryProduct: SharedHotelSetupEntryProduct;
  returnTo?: string | null;
  initialAddProperty?: boolean;
  productLabels?: Partial<ProductLabels>;
  onProductContinue: (input: SharedFirstRunProductContinueInput) => void;
};

type ProfileDraft = {
  displayName: string;
  countryCode: string;
  region: string;
  city: string;
  streetAddress: string;
  postalCode: string;
  timezone: string;
  website: string;
  phone: string;
  shortDescription: string;
  longDescription: string;
  mediaUrl: string;
};

const DEFAULT_PRODUCT_LABELS: ProductLabels = {
  booking: "Booking Engine",
  pms: "PMS",
  marketplace: "Creator Marketplace",
};

const EMPTY_DRAFT: ProfileDraft = {
  displayName: "",
  countryCode: "",
  region: "",
  city: "",
  streetAddress: "",
  postalCode: "",
  timezone: "",
  website: "",
  phone: "",
  shortDescription: "",
  longDescription: "",
  mediaUrl: "",
};

export default function SharedFirstRunPropertySetupWizard({
  api,
  entryProduct,
  returnTo = null,
  initialAddProperty = false,
  productLabels,
  onProductContinue,
}: SharedFirstRunPropertySetupWizardProps) {
  const labels = { ...DEFAULT_PRODUCT_LABELS, ...productLabels };
  const [status, setStatus] = useState<SharedHotelSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [forceCreateProperty, setForceCreateProperty] = useState(initialAddProperty);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileLoadFailed, setProfileLoadFailed] = useState(false);
  const [profileReloadToken, setProfileReloadToken] = useState(0);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [selectedProducts, setSelectedProducts] = useState<SharedHotelSetupProduct[]>([
    entryProduct,
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const view = useMemo(
    () => resolveSharedFirstRunSetupView(status, { forceCreateProperty }),
    [forceCreateProperty, status],
  );

  useEffect(() => {
    setForceCreateProperty(initialAddProperty);
  }, [initialAddProperty]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    api
      .getStatus({ entryProduct, returnTo })
      .then((nextStatus) => {
        if (cancelled) return;
        setStatus(nextStatus);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, entryProduct, returnTo]);

  useEffect(() => {
    const propertyId = view.profileMode === "update" ? view.selectedPropertyId : null;
    if (!propertyId) {
      setProfileLoadFailed(false);
      setDraft(EMPTY_DRAFT);
      return;
    }

    let cancelled = false;
    setProfileLoading(true);
    setProfileLoadFailed(false);
    setError("");

    api
      .getPropertyProfile(propertyId)
      .then((nextProfile) => {
        if (cancelled) return;
        setDraft(draftFromProfile(nextProfile));
      })
      .catch((err) => {
        if (cancelled) return;
        setProfileLoadFailed(true);
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, profileReloadToken, view.profileMode, view.selectedPropertyId]);

  useEffect(() => {
    if (view.screen !== "product_selection") return;
    setSelectedProducts(selectedProductsForProperty(view.selectedProperty, entryProduct));
  }, [entryProduct, view.screen, view.selectedProperty]);

  const reloadStatus = async (propertyId?: string | null) => {
    const nextStatus = await api.getStatus({ entryProduct, returnTo, propertyId });
    setStatus(nextStatus);
    return nextStatus;
  };

  const handleSelectProperty = async (propertyId: string) => {
    setError("");
    setForceCreateProperty(false);
    setLoading(true);
    try {
      await reloadStatus(propertyId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfile = async () => {
    setError("");
    setFieldErrors({});
    if (!draft.displayName.trim()) {
      setFieldErrors({ displayName: ["Property name is required."] });
      return;
    }

    setSaving(true);
    try {
      const input = profileInputFromDraft(draft);
      const saved =
        view.profileMode === "update" && view.selectedPropertyId
          ? await api.updatePropertyProfile(view.selectedPropertyId, input)
          : await api.createPropertyProfile(input);
      setForceCreateProperty(false);
      await reloadStatus(saved.propertyId);
    } catch (err) {
      setFieldErrors(fieldErrorsFromError(err));
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveProducts = async () => {
    if (!view.selectedPropertyId) return;
    setError("");
    setSaving(true);
    try {
      const selectableProducts = selectedProducts.filter((product) =>
        isSharedHotelSetupProductSelectable(view.selectedProperty, product),
      );
      await api.saveProductSelection(view.selectedPropertyId, selectableProducts);
      await reloadStatus(view.selectedPropertyId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleContinueProduct = () => {
    if (!view.selectedPropertyId || !view.product) return;
    onProductContinue({
      product: view.product,
      propertyId: view.selectedPropertyId,
      returnTo: status?.entry.returnTo ?? returnTo,
      action: view.screen === "enter_product" ? "enter_product" : "complete_product_activation",
    });
  };

  if (loading || !status) {
    if (!loading && error) {
      return (
        <WizardShell title="Setup unavailable" view={view}>
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        </WizardShell>
      );
    }

    return <WizardShell title="Setting up your property" view={view} loading />;
  }

  return (
    <WizardShell title={view.title} view={view} status={status}>
      {error && !(view.screen === "property_profile" && profileLoadFailed) && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {view.screen === "property_selection" && (
        <PropertySelection
          properties={status.properties}
          onSelect={handleSelectProperty}
          onAdd={() => {
            setDraft(EMPTY_DRAFT);
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
          mode={view.profileMode ?? "create"}
          loading={profileLoading}
          saving={saving}
          selectedProperty={view.selectedProperty}
          fieldErrors={fieldErrors}
          onChange={setDraft}
          onCancel={
            status.properties.length > 0 && view.profileMode === "create"
              ? () => setForceCreateProperty(false)
              : undefined
          }
          onSave={handleSaveProfile}
        />
      )}

      {view.screen === "product_selection" && (
        <ProductSelection
          labels={labels}
          selectedProducts={selectedProducts}
          selectedProperty={view.selectedProperty}
          saving={saving}
          onToggle={(product) => {
            setSelectedProducts((current) =>
              current.includes(product)
                ? current.filter((item) => item !== product)
                : [...current, product],
            );
          }}
          onSave={handleSaveProducts}
        />
      )}

      {(view.screen === "product_activation" || view.screen === "enter_product") && (
        <ProductContinue labels={labels} view={view} onContinue={handleContinueProduct} />
      )}
    </WizardShell>
  );
}

function WizardShell({
  children,
  title,
  view,
  status,
  loading = false,
}: {
  children?: React.ReactNode;
  title: string;
  view: SharedFirstRunSetupViewModel;
  status?: SharedHotelSetupStatus;
  loading?: boolean;
}) {
  const progress =
    view.screen === "product_selection" ? 2 : view.screen === "enter_product" ? 3 : 1;
  return (
    <main className="min-h-screen bg-gray-50 px-4 py-8 text-gray-900 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            {status?.hotelGroup.displayName ?? "Hotel setup"}
          </p>
          <h1 className="mt-2 text-xl font-semibold text-gray-950">{title}</h1>
          <div className="mt-5 space-y-3">
            {["Property", "Products", "Continue"].map((label, index) => {
              const active = index + 1 <= progress;
              return (
                <div key={label} className="flex items-center gap-3">
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                      active ? "bg-gray-950 text-white" : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {index + 1}
                  </span>
                  <span className={`text-sm ${active ? "text-gray-950" : "text-gray-500"}`}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
          {status?.entry.entryProduct && (
            <p className="mt-6 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
              Started from {DEFAULT_PRODUCT_LABELS[status.entry.entryProduct]}.
            </p>
          )}
        </aside>

        <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
          {loading ? (
            <div className="flex min-h-80 items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-950" />
            </div>
          ) : (
            children
          )}
        </section>
      </div>
    </main>
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
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-950">Choose property</h2>
          <p className="mt-1 text-sm text-gray-500">
            Pick the hotel you want to finish setting up.
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center justify-center rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
        >
          Add property
        </button>
      </div>

      <div className="grid gap-3">
        {properties.map((property) => (
          <button
            key={property.propertyId}
            type="button"
            onClick={() => onSelect(property.propertyId)}
            className="rounded-lg border border-gray-200 p-4 text-left transition hover:border-gray-950 hover:bg-gray-50"
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
              <div className="text-sm text-gray-500">
                {property.sharedProfile.completionPercent}% profile
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ProfileLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4">
      <h2 className="text-lg font-semibold text-red-900">Property profile unavailable</h2>
      <p className="mt-2 text-sm text-red-700">
        {error || "The existing property profile could not be loaded."}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-lg bg-red-900 px-4 py-2 text-sm font-medium text-white hover:bg-red-800"
      >
        Retry
      </button>
    </div>
  );
}

function ProfileForm({
  draft,
  mode,
  loading,
  saving,
  selectedProperty,
  fieldErrors,
  onChange,
  onCancel,
  onSave,
}: {
  draft: ProfileDraft;
  mode: "create" | "update";
  loading: boolean;
  saving: boolean;
  selectedProperty: SharedSetupProperty | null;
  fieldErrors: Record<string, string[]>;
  onChange: (draft: ProfileDraft) => void;
  onCancel?: () => void;
  onSave: () => void;
}) {
  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-950" />
      </div>
    );
  }

  const setField = (field: keyof ProfileDraft, value: string) => {
    onChange({ ...draft, [field]: value });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
      className="space-y-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-950">
            {mode === "create" ? "Add property" : "Property profile"}
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            {(selectedProperty?.displayName ?? draft.displayName) || "Shared hotel details"}
          </p>
        </div>
        {selectedProperty && (
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
            {selectedProperty.sharedProfile.completionPercent}% complete
          </span>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          label="Property name"
          value={draft.displayName}
          error={fieldErrors.displayName?.[0]}
          onChange={(value) => setField("displayName", value)}
        />
        <TextField
          label="Country code"
          value={draft.countryCode}
          placeholder="DE"
          error={fieldErrors["location.countryCode"]?.[0]}
          onChange={(value) => setField("countryCode", value.toUpperCase().slice(0, 2))}
        />
        <TextField
          label="City"
          value={draft.city}
          error={fieldErrors["location.city"]?.[0]}
          onChange={(value) => setField("city", value)}
        />
        <TextField
          label="Region"
          value={draft.region}
          error={fieldErrors["location.region"]?.[0]}
          onChange={(value) => setField("region", value)}
        />
        <TextField
          label="Street address"
          value={draft.streetAddress}
          error={fieldErrors["location.streetAddress"]?.[0]}
          onChange={(value) => setField("streetAddress", value)}
        />
        <TextField
          label="Postal code"
          value={draft.postalCode}
          error={fieldErrors["location.postalCode"]?.[0]}
          onChange={(value) => setField("postalCode", value)}
        />
        <TextField
          label="Website"
          type="url"
          value={draft.website}
          placeholder="https://example.com"
          error={fieldErrors.website?.[0]}
          onChange={(value) => setField("website", value)}
        />
        <TextField
          label="Phone"
          value={draft.phone}
          error={fieldErrors.phone?.[0]}
          onChange={(value) => setField("phone", value)}
        />
        <TextField
          label="Timezone"
          value={draft.timezone}
          placeholder="Europe/Berlin"
          error={fieldErrors["location.timezone"]?.[0]}
          onChange={(value) => setField("timezone", value)}
        />
        <TextField
          label="Photo URL"
          type="url"
          value={draft.mediaUrl}
          placeholder="https://example.com/photo.jpg"
          error={fieldErrors["media.0.url"]?.[0] ?? fieldErrors.media?.[0]}
          onChange={(value) => setField("mediaUrl", value)}
        />
      </div>

      <TextArea
        label="Short description"
        value={draft.shortDescription}
        error={fieldErrors.shortDescription?.[0]}
        onChange={(value) => setField("shortDescription", value)}
      />
      <TextArea
        label="Long description"
        value={draft.longDescription}
        error={fieldErrors.longDescription?.[0]}
        onChange={(value) => setField("longDescription", value)}
      />

      <div className="flex flex-col-reverse gap-3 border-t border-gray-100 pt-5 sm:flex-row sm:justify-end">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Back
          </button>
        )}
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving..." : "Save and continue"}
        </button>
      </div>
    </form>
  );
}

function ProductSelection({
  labels,
  selectedProducts,
  selectedProperty,
  saving,
  onToggle,
  onSave,
}: {
  labels: ProductLabels;
  selectedProducts: SharedHotelSetupProduct[];
  selectedProperty: SharedSetupProperty | null;
  saving: boolean;
  onToggle: (product: SharedHotelSetupProduct) => void;
  onSave: () => void;
}) {
  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-950">Choose products</h2>
        <p className="mt-1 text-sm text-gray-500">
          {selectedProperty?.displayName ?? "Selected property"}
        </p>
      </div>

      <div className="grid gap-3">
        {SHARED_HOTEL_SETUP_PRODUCTS.map((product) => {
          const checked = selectedProducts.includes(product);
          const disabled = !isSharedHotelSetupProductSelectable(selectedProperty, product);
          return (
            <label
              key={product}
              className={`flex items-center justify-between rounded-lg border p-4 transition ${
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
              } ${
                checked
                  ? "border-gray-950 bg-gray-50"
                  : disabled
                    ? "border-gray-200"
                    : "border-gray-200 hover:border-gray-400"
              }`}
            >
              <span>
                <span className="block text-sm font-medium text-gray-950">{labels[product]}</span>
                <span className="mt-1 block text-xs text-gray-500">
                  {productStatusLabel(selectedProperty, product)}
                </span>
              </span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300 text-gray-950"
                checked={checked}
                disabled={disabled}
                onChange={() => {
                  if (!disabled) onToggle(product);
                }}
              />
            </label>
          );
        })}
      </div>

      <div className="mt-5 flex justify-end border-t border-gray-100 pt-5">
        <button
          type="button"
          disabled={saving || selectedProducts.length === 0}
          onClick={onSave}
          className="rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving..." : "Save products"}
        </button>
      </div>
    </div>
  );
}

function ProductContinue({
  labels,
  view,
  onContinue,
}: {
  labels: ProductLabels;
  view: SharedFirstRunSetupViewModel;
  onContinue: () => void;
}) {
  const product = view.product;
  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-950">
          {product ? labels[product] : "Product setup"}
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          {view.selectedProperty?.displayName ?? "Selected property"}
        </p>
      </div>
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
        <p className="text-sm text-gray-700">
          {view.screen === "enter_product"
            ? "This property is ready for the selected product."
            : "The shared profile is ready. Continue into the selected product setup."}
        </p>
      </div>
      <div className="mt-5 flex justify-end border-t border-gray-100 pt-5">
        <button
          type="button"
          disabled={!product}
          onClick={onContinue}
          className="rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  error,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-gray-900 ${
          error ? "border-red-300" : "border-gray-200"
        }`}
      />
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-gray-900 ${
          error ? "border-red-300" : "border-gray-200"
        }`}
      />
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

function productStatusLabel(
  property: SharedSetupProperty | null,
  product: SharedHotelSetupProduct,
): string {
  const status = property?.products[product].status ?? "not_selected";
  if (status === "active") return "Active";
  if (status === "selected_incomplete") return "Setup needed";
  if (status === "suspended") return "Suspended";
  if (status === "unavailable") return "Unavailable";
  return "Not selected";
}

function draftFromProfile(profile: SharedPropertyProfile): ProfileDraft {
  const firstMedia = profile.media[0];
  return {
    displayName: profile.displayName,
    countryCode: profile.location.countryCode ?? "",
    region: profile.location.region ?? "",
    city: profile.location.city ?? "",
    streetAddress: profile.location.streetAddress ?? "",
    postalCode: profile.location.postalCode ?? "",
    timezone: profile.location.timezone ?? "",
    website: profile.website ?? "",
    phone: profile.phone ?? "",
    shortDescription: profile.shortDescription ?? "",
    longDescription: profile.longDescription ?? "",
    mediaUrl: firstMedia?.url ?? "",
  };
}

function profileInputFromDraft(draft: ProfileDraft): SharedPropertyProfileInput {
  const mediaUrl = nullIfBlank(draft.mediaUrl);
  return {
    displayName: draft.displayName.trim(),
    location: {
      countryCode: nullIfBlank(draft.countryCode.toUpperCase()),
      region: nullIfBlank(draft.region),
      city: nullIfBlank(draft.city),
      streetAddress: nullIfBlank(draft.streetAddress),
      postalCode: nullIfBlank(draft.postalCode),
      rawMarketplaceLocation: null,
      timezone: nullIfBlank(draft.timezone),
      latitude: null,
      longitude: null,
      addressPublic: true,
      mapDisplayMode: "hidden",
    },
    website: nullIfBlank(draft.website),
    phone: nullIfBlank(draft.phone),
    shortDescription: nullIfBlank(draft.shortDescription),
    longDescription: nullIfBlank(draft.longDescription),
    media: mediaUrl
      ? [
          {
            mediaType: "gallery_image",
            url: mediaUrl,
            altText: null,
            sortOrder: 0,
          },
        ]
      : [],
  };
}

function nullIfBlank(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Please try again.";
}

function fieldErrorsFromError(error: unknown): Record<string, string[]> {
  if (!error || typeof error !== "object") return {};
  const data = (error as { data?: { fields?: unknown } }).data;
  if (!data || !data.fields || typeof data.fields !== "object" || Array.isArray(data.fields)) {
    return {};
  }
  return data.fields as Record<string, string[]>;
}
