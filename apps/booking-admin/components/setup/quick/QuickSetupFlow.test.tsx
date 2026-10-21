import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import type { HotelFirstRunClient } from "@/services/api/hotelFirstRunClient";
import { QuickSetupFlow, quickSetupLanguage, type QuickSetupFlowProps } from "./QuickSetupFlow";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));
vi.mock("@vayada/product-onboarding/GooglePlacesAddressField", () => ({ default: () => null }));
vi.mock("@vayada/product-onboarding/GoogleAddressMap", () => ({ default: () => null }));
vi.mock("@vayada/product-onboarding/TimezoneField", () => ({ default: () => null }));
vi.mock("@vayada/product-onboarding/googleMaps", () => ({ findAddressOnMap: vi.fn() }));

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const status = (properties: string[] = []) => ({
  organization: {
    organizationId: "org-1",
    displayName: "Alpenrose Hotel Group",
    selectedTracks: ["hotel_operations"],
    trackRevision: 1,
  },
  propertySelection: {
    selectedPropertyId: properties[0] ?? null,
    availableProperties: properties.map((propertyId) => ({ propertyId })),
  },
});
const firstRunState = (planDone: boolean) => ({
  contractVersion: "hotel-first-run.v1" as const,
  propertyId: PROPERTY,
  steps: ["currency", "rooms", "payments", "pricing", "calendar", "guest_rules", "plan"].map(
    (id) => ({ id, state: id === "plan" && !planDone ? "todo" : "done" }),
  ),
  nextStep: planDone ? null : "plan",
});

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function props(overrides: Partial<QuickSetupFlowProps> = {}): QuickSetupFlowProps {
  return {
    account: { email: "clara@example.com", name: "Clara Schumann", phone: "+49 30 0000 0000" },
    saveAccount: vi.fn(async () => undefined),
    setup: {
      getStatus: vi.fn(async () => status()),
      getPropertyTypes: vi.fn(async () => ({
        contractVersion: "adaptive-hotel-property-types.v1",
        propertyTypes: [{ value: "hotel", label: "Hotel" }],
      })),
    } as never,
    firstRun: {
      read: vi.fn(async () => firstRunState(false)),
      run: vi.fn(),
    } as unknown as HotelFirstRunClient,
    saveCurrency: vi.fn(async () => undefined),
    readCurrency: vi.fn(async () => null),
    readCheckoutPending: vi.fn(async () => false),
    openCheckout: vi.fn(),
    propertyId: null,
    onPropertyCreated: vi.fn(),
    onSaveAndExit: vi.fn(),
    storage: storage(),
    publication: { load: vi.fn(), publish: vi.fn() },
    organizationId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f99887766",
    publicationStorage: storage(),
    openPage: vi.fn(),
    ...overrides,
  };
}

async function mount(value: QuickSetupFlowProps) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<QuickSetupFlow {...value} />);
  });
  await act(async () => undefined);
  return renderer!;
}

const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

describe("QuickSetupFlow (VAY-2247, ONBOARDING_V2)", () => {
  it("asks About you first when the account has no phone", async () => {
    const renderer = await mount(
      props({ account: { email: "clara@example.com", name: "Clara Schumann", phone: null } }),
    );
    expect(text(renderer)).toContain("Hi! Who's setting up the hotel?");
    // One card since 2026-10-21: the phone field, no team preview.
    expect(text(renderer)).toContain("Your phone");
    expect(text(renderer)).not.toContain("How your team sees you");
    renderer.unmount();
  });

  it("goes to Your hotel for a group without a hotel, and welcomes a draft back", async () => {
    const fresh = await mount(props());
    expect(text(fresh)).toContain("Step 2 of 5");
    expect(text(fresh)).not.toContain("Welcome back");
    fresh.unmount();

    const saved = storage({
      "vayada.quickSetup.v1.hotel": JSON.stringify({
        draftKey: "draft-1",
        draft: { displayName: "Hotel Alpenrose" },
      }),
    });
    const resumed = await mount(props({ storage: saved }));
    expect(text(resumed)).toContain(
      "Welcome back, Clara. Everything you entered is saved — you're on step 2 of 5.",
    );
    expect(text(resumed)).toContain("hotel-alpenrose.booking.vayada.com");
    expect(text(resumed)).toContain("Use my details");
    resumed.unmount();

    // Contacts copied with "Use my details" keep their note after a reload.
    const copied = storage({
      "vayada.quickSetup.v1.hotel": JSON.stringify({
        draftKey: "draft-2",
        draft: { contactEmail: "clara@example.com", phone: "+49 30 0000 0000" },
        contactsFromAccount: true,
      }),
    });
    const withNote = await mount(props({ storage: copied }));
    expect(text(withNote)).toContain("Filled from your account.");
    expect(text(withNote)).not.toContain("Use my details");
    withNote.unmount();
  });

  it("resumes a hotel that exists at the first screen that still needs an answer", async () => {
    const renderHotelStep = vi.fn((step: number) => <p>{`step ${step}`}</p>);
    const partly = await mount(
      props({
        setup: { ...props().setup, getStatus: vi.fn(async () => status([PROPERTY])) } as never,
        renderHotelStep,
      }),
    );
    expect(renderHotelStep).toHaveBeenLastCalledWith(4, PROPERTY);
    partly.unmount();

    const done = await mount(
      props({
        propertyId: PROPERTY,
        firstRun: {
          read: vi.fn(async () => firstRunState(true)),
          run: vi.fn(),
        } as unknown as HotelFirstRunClient,
        renderHotelStep,
      }),
    );
    expect(renderHotelStep).toHaveBeenLastCalledWith(5, PROPERTY);
    done.unmount();
  });

  it("says setup is temporarily unavailable and tries again", async () => {
    const getStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(status());
    const renderer = await mount(props({ setup: { ...props().setup, getStatus } as never }));
    expect(text(renderer)).toContain("Setup is temporarily unavailable");
    const retry = renderer.root.find(
      (node) => node.type === "button" && node.children.includes("Try again"),
    );
    await act(async () => retry.props.onClick());
    await act(async () => undefined);
    expect(text(renderer)).toContain("Step 2 of 5");
    renderer.unmount();
  });

  it("creates the hotel on Continue and clears the kept draft", async () => {
    const draft = {
      displayName: "Hotel Alpenrose",
      propertyType: "hotel",
      streetAddress: "Sendlinger Straße 12",
      postalCode: "80331",
      city: "Munich",
      countryCode: "DE",
      latitude: 48.135,
      longitude: 11.567,
      timezone: "Europe/Berlin",
      contactEmail: "reception@alpenrose.example",
      phone: "+49 89 1234567",
      currency: "",
    };
    const saved = storage({
      "vayada.quickSetup.v1.hotel": JSON.stringify({ draftKey: "draft-1", draft }),
    });
    const createPropertyProfile = vi.fn(async () => ({ propertyId: PROPERTY, profileRevision: 1 }));
    const onPropertyCreated = vi.fn();
    const renderer = await mount(
      props({
        storage: saved,
        onPropertyCreated,
        setup: { ...props().setup, createPropertyProfile } as never,
      }),
    );
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(createPropertyProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Hotel Alpenrose",
        initialLaunchSettings: expect.objectContaining({ defaultCurrency: "EUR" }),
      }),
      "quick-setup:create:draft-1",
    );
    expect(onPropertyCreated).toHaveBeenCalledWith(PROPERTY);
    expect(saved.values.has("vayada.quickSetup.v1.hotel")).toBe(false);
    renderer.unmount();
  });

  it("picks the booking page's first language from the browser when it is offered", () => {
    expect(quickSetupLanguage(["de-DE", "en"])).toBe("de");
    expect(quickSetupLanguage(["xx-YY"])).toBe("en");
    expect(quickSetupLanguage(undefined)).toBe("en");
  });
});
