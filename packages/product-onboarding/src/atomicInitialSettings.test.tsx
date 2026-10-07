import type { AdaptiveHotelSetupStatus, PropertyProfileResponse } from "@vayada/domain-hotels";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Wizard, { createProfileFromDraft } from "./SharedFirstRunPropertySetupWizard";
import { propertyLaunchSettingsDefaults } from "./propertyLaunchSettings";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";

const draft = {
  displayName: "Owner Hotel",
  propertyType: "hotel",
  countryCode: "LK",
  city: "Ahangama",
  streetAddress: "Street 1",
  postalCode: "80650",
  timezone: "Asia/Colombo",
  latitude: null,
  longitude: null,
  contactEmail: "hotel@example.test",
  phone: "+94771021677",
  whatsapp: "",
  localityPublic: false,
  logoFile: null,
  logoMediaObjectId: null,
  logoPublicUrl: "https://example.test/logo.png",
};
const settings = {
  ...propertyLaunchSettingsDefaults("LK"),
  defaultLanguage: "fr",
  supportedCurrencies: ["LKR", "EUR"],
  supportedLanguages: ["fr", "en"],
  instagram: " https://instagram.com/owner-hotel ",
  facebook: "https://facebook.com/owner-hotel",
  tiktok: "https://tiktok.com/@owner-hotel",
  youtube: "https://youtube.com/@owner-hotel",
};

function statusFor(existing = false, hotelOperations = true): AdaptiveHotelSetupStatus {
  return {
    contractVersion: "adaptive-hotel-setup.v1",
    organization: {
      organizationId: "organization-1",
      displayName: "Hotel group",
      websiteUrl: null,
      selectedTracks: hotelOperations ? ["hotel_operations"] : ["creator_marketplace"],
      trackRevision: 1,
      canManageTracks: true,
      tracks: [],
    },
    propertySelection: {
      state: existing ? "single_property" : "no_property",
      selectedPropertyId: existing ? "property-1" : null,
      availableProperties: existing
        ? [
            {
              propertyId: "property-1",
              publicId: "hotel-1",
              displayName: "Owner Hotel",
              locationSummary: "Sri Lanka",
            },
          ]
        : [],
    },
    setupPlan: existing
      ? ({
          tasks: [
            {
              taskId: "shared_identity",
              ownerProgress: "not_started",
              readiness: "actionable",
              callerCapability: "allowed",
            },
          ],
        } as AdaptiveHotelSetupStatus["setupPlan"])
      : null,
    entryDecision: null,
    updatedAt: "2026-10-03T00:00:00Z",
  };
}

describe("atomic initial hotel settings", () => {
  let renderer: ReactTestRenderer | undefined;
  beforeEach(() =>
    vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
  afterEach(() => {
    act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  });
  const form = () =>
    renderer!.root.findAll(
      (node) => typeof node.props.onSave === "function" && node.props.draft,
    )[0];
  async function mount(existing = false, hotelOperations = true) {
    const status = statusFor(existing, hotelOperations);
    const saved: PropertyProfileResponse = {
      propertyId: "property-1",
      profileRevision: 1,
      profile: createProfileFromDraft(draft),
    };
    const api = {
      getStatus: vi.fn().mockResolvedValue(status),
      getPropertyProfile: vi.fn().mockResolvedValue(saved),
      getPublicPropertyProfile: vi.fn().mockResolvedValue({
        publicProfile: { media: [{ mediaType: "logo", url: draft.logoPublicUrl }] },
      }),
      createPropertyProfile: vi.fn().mockResolvedValue(saved),
      updatePropertyProfile: vi.fn().mockResolvedValue(saved),
      getPropertyTypes: vi
        .fn()
        .mockResolvedValue({ propertyTypes: [{ value: "hotel", label: "Hotel" }] }),
    };
    const launchApi = {
      get: vi.fn().mockResolvedValue(settings),
      update: vi.fn().mockResolvedValue(undefined),
    };
    await act(async () => {
      renderer = create(
        <Wizard
          api={api as unknown as SharedHotelSetupApi}
          entryProduct="marketplace"
          propertyLaunchSettingsApi={launchApi}
          onContinue={() => undefined}
          renderTaskForm={() => null}
        />,
      );
    });
    await act(async () => form().props.onChange(draft));
    return { api, launchApi };
  }

  it("creates locale/social settings once and retries a failed reload without property PUT", async () => {
    const { api, launchApi } = await mount();
    await act(async () => form().props.onLaunchSettingsChange(settings));
    api.getStatus.mockRejectedValueOnce(new Error("Reload failed"));
    await act(async () => form().props.onSave());
    expect(api.createPropertyProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        initialLaunchSettings: {
          ...settings,
          supportedCurrencies: ["EUR"],
          supportedLanguages: ["en"],
          instagram: settings.instagram.trim(),
        },
      }),
      expect.any(String),
    );
    api.getStatus.mockResolvedValue({ ...statusFor(true), setupPlan: null });
    await act(async () => form().props.onSave());
    expect(api.createPropertyProfile).toHaveBeenCalledTimes(1);
    expect(api.getStatus).toHaveBeenLastCalledWith({
      entryProduct: "marketplace",
      propertyId: "property-1",
    });
    expect(launchApi.update).not.toHaveBeenCalled();
    expect(launchApi.get).not.toHaveBeenCalled();
    expect(api.updatePropertyProfile).not.toHaveBeenCalled();
  });

  it("keeps the same key after an ambiguous create failure and rejects edited retries", async () => {
    const { api, launchApi } = await mount();
    await act(async () => form().props.onLaunchSettingsChange(settings));
    api.createPropertyProfile.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => form().props.onSave());
    await act(async () =>
      form().props.onLaunchSettingsChange({ ...settings, defaultCurrency: "USD" }),
    );
    await act(async () => form().props.onSave());
    expect(api.createPropertyProfile).toHaveBeenCalledTimes(1);
    expect(
      renderer!.root
        .findAllByProps({ role: "alert" })
        .some((node) => JSON.stringify(node.children).includes("already submitted")),
    ).toBe(true);
    await act(async () => form().props.onLaunchSettingsChange(settings));
    await act(async () => form().props.onSave());
    expect(api.createPropertyProfile.mock.calls[1][1]).toBe(
      api.createPropertyProfile.mock.calls[0][1],
    );
    expect(launchApi.update).not.toHaveBeenCalled();
  });

  it("keeps native launch-settings PUT for existing property edits", async () => {
    const { api, launchApi } = await mount(true);
    await act(async () => form().props.onSave());
    expect(launchApi.get).toHaveBeenCalledWith("property-1");
    expect(launchApi.update).toHaveBeenCalledWith(
      "property-1",
      expect.objectContaining({ defaultCurrency: "LKR", defaultLanguage: "fr" }),
    );
    expect(api.createPropertyProfile).not.toHaveBeenCalled();
  });

  it("retries an ambiguous hotel-detail edit with the same profile key", async () => {
    const { api } = await mount(true, false);
    await act(async () => form().props.onChange({ ...draft, displayName: "Edited Hotel" }));
    api.updatePropertyProfile.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => form().props.onSave());
    await act(async () => form().props.onSave());
    expect(api.updatePropertyProfile).toHaveBeenCalledTimes(2);
    const [first, retry] = api.updatePropertyProfile.mock.calls;
    expect(first[1]).toMatchObject({ patch: { displayName: "Edited Hotel" } });
    expect(first[2]).toEqual(expect.any(String));
    expect(retry[2]).toBe(first[2]);
  });

  it("starts a new profile key after a committed edit even when a later step fails", async () => {
    const { api } = await mount(true, false);
    await act(async () => form().props.onChange({ ...draft, displayName: "Edited Hotel" }));
    api.getStatus.mockRejectedValueOnce(new Error("Reload failed"));
    await act(async () => form().props.onSave());
    await act(async () => form().props.onChange({ ...draft, displayName: "Edited Again" }));
    await act(async () => form().props.onSave());
    const [first, second] = api.updatePropertyProfile.mock.calls;
    expect(second[1]).toMatchObject({ patch: { displayName: "Edited Again" } });
    expect(second[2]).not.toBe(first[2]);
  });

  it("refreshes the profile and drops the key after an idempotency conflict", async () => {
    const { api } = await mount(true, false);
    await act(async () => form().props.onChange({ ...draft, displayName: "Edited Hotel" }));
    api.updatePropertyProfile.mockRejectedValueOnce({
      status: 409,
      data: { code: "idempotency_key_conflict" },
    });
    await act(async () => form().props.onSave());
    expect(api.getPropertyProfile).toHaveBeenCalledTimes(2);
    await act(async () => form().props.onSave());
    const [first, retry] = api.updatePropertyProfile.mock.calls;
    expect(retry[2]).not.toBe(first[2]);
  });

  it("retains the key after an ambiguous submission followed by permission denial", async () => {
    const { api, launchApi } = await mount();
    await act(async () => form().props.onLaunchSettingsChange(settings));
    api.createPropertyProfile.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    api.createPropertyProfile.mockRejectedValueOnce({ status: 403 });
    await act(async () => form().props.onSave());
    await act(async () => form().props.onSave());
    await act(async () => form().props.onChange({ ...draft, displayName: "Edited Hotel" }));
    await act(async () => form().props.onSave());
    expect(api.createPropertyProfile).toHaveBeenCalledTimes(2);
    await act(async () => form().props.onChange(draft));
    await act(async () => form().props.onSave());
    expect(new Set(api.createPropertyProfile.mock.calls.map((call) => call[1])).size).toBe(1);
    expect(launchApi.update).not.toHaveBeenCalled();
    expect(api.updatePropertyProfile).not.toHaveBeenCalled();
  });

  it.each([403, 422])("allows corrected retries after pre-write rejection %s", async (status) => {
    const { api, launchApi } = await mount();
    await act(async () => form().props.onLaunchSettingsChange(settings));
    api.createPropertyProfile.mockRejectedValueOnce({ status });
    await act(async () => form().props.onSave());
    await act(async () => form().props.onLaunchSettingsChange({ ...settings, instagram: "" }));
    await act(async () => form().props.onSave());
    expect(api.createPropertyProfile).toHaveBeenCalledTimes(2);
    expect(api.createPropertyProfile.mock.calls[1][0]).toMatchObject({
      initialLaunchSettings: { instagram: "" },
    });
    expect(launchApi.update).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "hides and ignores launch settings for Creator-only setup (existing=%s)",
    async (existing) => {
      const { api, launchApi } = await mount(existing, false);
      expect(form().props.launchSettings).toBeNull();
      expect(launchApi.get).not.toHaveBeenCalled();
      await act(async () =>
        form().props.onLaunchSettingsChange({
          ...settings,
          defaultCurrency: "invalid",
          instagram: "invalid",
        }),
      );
      await act(async () => form().props.onSave());
      expect(launchApi.update).not.toHaveBeenCalled();
      if (!existing)
        expect(api.createPropertyProfile.mock.calls[0][0]).not.toHaveProperty(
          "initialLaunchSettings",
        );
    },
  );
});
