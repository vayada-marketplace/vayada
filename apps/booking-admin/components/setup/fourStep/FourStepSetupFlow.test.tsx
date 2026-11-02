import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { FourStepSetupFlow, type FourStepSetupFlowProps } from "./FourStepSetupFlow";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));
vi.mock("@vayada/product-onboarding/GooglePlacesAddressField", () => ({ default: () => null }));
vi.mock("@vayada/product-onboarding/GoogleAddressMap", () => ({ default: () => null }));
vi.mock("@vayada/product-onboarding/TimezoneField", () => ({ default: () => null }));
vi.mock("@vayada/product-onboarding/googleMaps", () => ({ findAddressOnMap: vi.fn() }));

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const KEY = "vayada.quickSetup.v1.hotel";
const status = (properties: string[] = []) => ({
  organization: {
    organizationId: "org-1",
    displayName: "Lumansa Group",
    selectedTracks: ["hotel_operations"],
    trackRevision: 1,
  },
  propertySelection: {
    selectedPropertyId: properties[0] ?? null,
    availableProperties: properties.map((propertyId) => ({ propertyId })),
  },
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

function props(overrides: Partial<FourStepSetupFlowProps> = {}) {
  const setup = {
    getStatus: vi.fn(async () => status()),
    getPropertyTypes: vi.fn(async () => ({
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [
        { value: "hotel", label: "Hotel" },
        { value: "villa", label: "Villa" },
        { value: "motel", label: "Motel" },
        { value: "homestay", label: "Homestay" },
      ],
    })),
    updateTracks: vi.fn(async () => ({})),
    createPropertyProfile: vi.fn(async () => ({ propertyId: PROPERTY, profileRevision: 1 })),
    uploadPropertyLogo: vi.fn(),
    assignPropertyLogo: vi.fn(),
  };
  return {
    setup,
    value: {
      account: { email: "owner@lumansa.example", name: "Asha Perera", phone: "+94 77 308 7696" },
      saveAccount: vi.fn(async () => undefined),
      setup: setup as never,
      saveCurrency: vi.fn(async () => undefined),
      propertyId: null,
      onPropertyCreated: vi.fn(),
      onSaveAndExit: vi.fn(),
      storage: storage(),
      firstRun: { read: vi.fn(), run: vi.fn() } as never,
      rooms: { loadWorkspace: vi.fn(), saveRoom: vi.fn() } as never,
      readCurrency: vi.fn(async () => "LKR"),
      onFinished: vi.fn(),
      ...overrides,
    } as FourStepSetupFlowProps & { saveCurrency: ReturnType<typeof vi.fn> } & {
      onPropertyCreated: ReturnType<typeof vi.fn>;
    },
  };
}

async function mount(value: FourStepSetupFlowProps) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<FourStepSetupFlow {...value} />);
  });
  await act(async () => undefined);
  return renderer!;
}

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const button = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.find((node) => node.type === "button" && textOf(node) === label);
const click = (renderer: ReactTestRenderer, label: string) =>
  act(async () => button(renderer, label).props.onClick());

const READY = {
  displayName: "Lumansa Hiriketiya",
  propertyType: "villa",
  streetAddress: "Hiriketiya Road 4",
  postalCode: "",
  city: "Dickwella",
  countryCode: "LK",
  latitude: 5.96,
  longitude: 80.71,
  timezone: "Asia/Colombo",
  contactEmail: "stay@lumansa.example",
  phone: "+94 77 308 7696",
  currency: "",
};

describe("FourStepSetupFlow (VAY-2451)", () => {
  it("welcomes a new owner, then Your property: Continue waits for a name and a type", async () => {
    const kept = storage();
    const { value } = props({ storage: kept });
    const renderer = await mount(value);
    expect(textOf(renderer.root)).toContain("Welcome to vayada");
    await click(renderer, "Start setup");
    expect(textOf(renderer.root)).toContain("Step 1 of 4");
    expect(button(renderer, "Continue").props.disabled).toBe(true);
    expect(textOf(renderer.root)).toContain("Add your property's name to continue");
    // The grid: the mockup's types the catalog has, Homestay included; Motel isn't offered.
    const types = renderer.root.findAll((node) => node.props.role === "radio");
    expect(types.map((type) => textOf(type))).toEqual(["Hotel", "Villa", "Homestay"]);
    await act(async () =>
      renderer.root
        .findByProps({ id: "setup-property-name" })
        .props.onChange({ target: { value: "Lumansa Hiriketiya" } }),
    );
    await act(async () => types[1]!.props.onClick());
    expect(button(renderer, "Continue").props.disabled).toBe(false);
    // The booking page preview follows the name.
    expect(textOf(renderer.root)).toContain("lumansa-hiriketiya.booking.vayada.com");
    // Kept on this device, with the step, before the hotel exists.
    expect(JSON.parse(kept.values.get(KEY)!)).toMatchObject({
      step: "property",
      draft: { displayName: "Lumansa Hiriketiya", propertyType: "villa" },
    });
    await click(renderer, "Continue");
    expect(textOf(renderer.root)).toContain("Location & contact");
    expect(JSON.parse(kept.values.get(KEY)!).step).toBe("location");
    renderer.unmount();
  });

  it("creates the hotel on step 2 with WhatsApp, the social links and the currency, then clears the draft", async () => {
    const kept = storage({
      [KEY]: JSON.stringify({
        draftKey: "draft-7",
        step: "location",
        draft: { ...READY, instagram: "https://instagram.com/lumansa" },
      }),
    });
    const { value, setup } = props({ storage: kept });
    const renderer = await mount(value);
    expect(textOf(renderer.root)).toContain("Step 2 of 4");
    // A partial link holds Continue with the reason.
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "TikTok link" })
        .props.onChange({ target: { value: "tiktok.com/@lumansa" } }),
    );
    expect(button(renderer, "Continue").props.disabled).toBe(true);
    expect(textOf(renderer.root)).toContain("Use the full social links, starting with https://");
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "TikTok link" })
        .props.onChange({ target: { value: "https://tiktok.com/@lumansa" } }),
    );
    await click(renderer, "Continue");
    expect(setup.createPropertyProfile).toHaveBeenCalledOnce();
    const [request, key] = setup.createPropertyProfile.mock.calls[0] as unknown as [
      { contacts: unknown[]; initialLaunchSettings: Record<string, string> },
      string,
    ];
    expect(key).toBe("quick-setup:create:draft-7");
    expect(request.contacts).toContainEqual({
      channelType: "whatsapp",
      value: "+94 77 308 7696",
      purpose: "general",
      isPublic: true,
    });
    expect(request.initialLaunchSettings).toMatchObject({
      defaultCurrency: "LKR",
      instagram: "https://instagram.com/lumansa",
      tiktok: "https://tiktok.com/@lumansa",
    });
    // The country's currency is saved at once, so the hotel's PMS opens for its first room.
    expect(value.saveCurrency).toHaveBeenCalledWith(PROPERTY, "LKR");
    expect(value.onPropertyCreated).toHaveBeenCalledWith(PROPERTY);
    expect(kept.values.has(KEY)).toBe(false);
    renderer.unmount();
  });

  it("shows a save error on step 2 and keeps everything typed", async () => {
    const kept = storage({
      [KEY]: JSON.stringify({ draftKey: "draft-8", step: "location", draft: READY }),
    });
    const { value, setup } = props({ storage: kept });
    setup.createPropertyProfile.mockRejectedValueOnce(new Error("We couldn't save. Try again."));
    const renderer = await mount(value);
    await click(renderer, "Continue");
    expect(textOf(renderer.root)).toContain("We couldn't save. Try again.");
    expect(value.onPropertyCreated).not.toHaveBeenCalled();
    expect(JSON.parse(kept.values.get(KEY)!).draft.displayName).toBe("Lumansa Hiriketiya");
    renderer.unmount();
  });

  it("asks About you first, without a step number, when the account has no phone", async () => {
    const { value } = props({
      account: { email: "owner@lumansa.example", name: "Asha Perera", phone: null },
    });
    const renderer = await mount(value);
    expect(textOf(renderer.root)).toContain("Your phone");
    expect(textOf(renderer.root)).not.toContain("Step 1 of");
    renderer.unmount();
  });

  it("hands a hotel that exists to its own steps", async () => {
    const renderHotelSteps = vi.fn(() => <p>Room steps</p>);
    const { value, setup } = props({ propertyId: PROPERTY, renderHotelSteps });
    setup.getStatus.mockResolvedValue(status([PROPERTY]));
    const renderer = await mount(value);
    expect(textOf(renderer.root)).toBe("Room steps");
    expect(renderHotelSteps).toHaveBeenCalledWith(PROPERTY);
    renderer.unmount();
  });
});
