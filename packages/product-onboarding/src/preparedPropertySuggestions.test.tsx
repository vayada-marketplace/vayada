import type { AdaptiveHotelSetupStatus } from "@vayada/domain-hotels";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import Wizard from "./SharedFirstRunPropertySetupWizard";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";

describe("prepared property suggestions", () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(() => act(() => renderer?.unmount()));

  it.each([0, 2])(
    "uses the source key only for initial creation, with %s existing hotels",
    async (count) => {
      const add = false;
      const status: AdaptiveHotelSetupStatus = {
        contractVersion: "adaptive-hotel-setup.v1",
        organization: {
          organizationId: "organization-1",
          displayName: "Hotel group",
          websiteUrl: null,
          selectedTracks: ["hotel_operations"],
          trackRevision: 1,
          canManageTracks: true,
          tracks: [],
        },
        propertySelection: {
          state:
            count === 0 ? "no_property" : count === 1 ? "single_property" : "multiple_properties",
          selectedPropertyId: count === 1 ? "property-1" : null,
          availableProperties: Array.from({ length: count }, (_, i) => ({
            propertyId: `property-${i + 1}`,
            publicId: `hotel-${i + 1}`,
            displayName: `Hotel ${i + 1}`,
            locationSummary: "Berlin, Germany",
          })),
        },
        setupPlan: null,
        entryDecision: null,
        updatedAt: "2026-09-09T00:00:00Z",
      };
      const api = {
        getStatus: vi.fn().mockResolvedValue(status),
        updatePropertyProfile: vi.fn(),
        createPropertyProfile: vi.fn().mockRejectedValue(new Error("Connection lost")),
        getPropertyTypes: vi
          .fn()
          .mockResolvedValue({ propertyTypes: [{ value: "hotel", label: "Hotel" }] }),
      } as unknown as SharedHotelSetupApi;
      await act(async () => {
        renderer = create(
          <Wizard
            api={api}
            entryProduct="pms"
            initialAddProperty={add}
            initialProfileSuggestions={{
              displayName: "Prepared Hotel",
              propertyType: "hotel",
              streetAddress: "Street 1",
              postalCode: "10115",
              city: "Berlin",
              countryCode: "DE",
              timezone: "Europe/Berlin",
            }}
            propertyCreateIdempotencyKey="prepared-property:invite"
            onContinue={() => undefined}
            renderTaskForm={() => null}
          />,
        );
      });
      expect(api.getStatus).toHaveBeenCalledWith({ entryProduct: "pms", propertyId: null });
      {
        if (count > 0)
          await act(async () =>
            renderer!.root
              .findAll((node) => typeof node.props.onAdd === "function")[0]
              .props.onAdd(),
          );
        const form = () =>
          renderer!.root.findAll(
            (node) => typeof node.props.onSave === "function" && node.props.mode === "create",
          )[0];
        expect(form().props.draft.displayName).toBe(count === 0 ? "Prepared Hotel" : "");
        await act(async () =>
          form().props.onChange({
            ...form().props.draft,
            displayName: "Owner Hotel",
            propertyType: "hotel",
            streetAddress: "Street 1",
            postalCode: "10115",
            city: "Berlin",
            countryCode: "DE",
            timezone: "Europe/Berlin",
            phone: "+49301234567",
            contactEmail: "hotel@example.test",
            logoPublicUrl: "https://example.test/logo.png",
          }),
        );
        await act(async () => form().props.onSave());
        await act(async () => form().props.onSave());
        expect(api.createPropertyProfile).toHaveBeenCalledTimes(2);
        expect(
          vi
            .mocked(api.createPropertyProfile)
            .mock.calls.every((call) =>
              count === 0
                ? call[1] === "prepared-property:invite"
                : call[1] !== "prepared-property:invite",
            ),
        ).toBe(true);
        expect(api.updatePropertyProfile).not.toHaveBeenCalled();
        if (count === 0) {
          vi.mocked(api.createPropertyProfile).mockRejectedValue({
            data: { code: "idempotency_key_conflict", propertyId: "original-property" },
          });
          await act(async () => form().props.onSave());
          expect(api.updatePropertyProfile).not.toHaveBeenCalled();
          expect(
            renderer!.root
              .findAllByProps({ role: "alert" })
              .some((node) => JSON.stringify(node.children).includes("already created a hotel")),
          ).toBe(true);
        }
      }
    },
  );
});
