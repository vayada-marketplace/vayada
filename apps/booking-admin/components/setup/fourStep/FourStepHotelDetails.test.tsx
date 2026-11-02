import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { FourStepHotelDetails, type FourStepHotelDetailsProps } from "./FourStepHotelDetails";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));
vi.mock("@vayada/product-onboarding/GooglePlacesAddressField", () => ({ default: () => null }));
vi.mock("@vayada/product-onboarding/GoogleAddressMap", () => ({ default: () => null }));
vi.mock("@vayada/product-onboarding/TimezoneField", () => ({ default: () => null }));
vi.mock("@vayada/product-onboarding/googleMaps", () => ({ findAddressOnMap: vi.fn() }));

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const PROFILE = {
  displayName: "Lumansa Hiriketiya",
  propertyType: "villa",
  location: {
    streetAddress: "Hiriketiya Road 4",
    postalCode: "",
    city: "Dickwella",
    countryCode: "LK",
    timezone: "Asia/Colombo",
    latitude: 5.96,
    longitude: 80.71,
    localityPublic: true,
    geoPublic: true,
    mapDisplayMode: "exact",
  },
  contacts: [
    { channelType: "email", value: "stay@lumansa.example", purpose: "general", isPublic: true },
    { channelType: "phone", value: "", purpose: "general", isPublic: true },
  ],
};

function props(overrides: Partial<FourStepHotelDetailsProps> = {}) {
  const setup = {
    getPropertyProfile: vi.fn(async () => ({
      propertyId: PROPERTY,
      profileRevision: 4,
      profile: PROFILE,
    })),
    updatePropertyProfile: vi.fn(async () => ({
      propertyId: PROPERTY,
      profileRevision: 5,
      profile: PROFILE,
    })),
    uploadPropertyLogo: vi.fn(),
    assignPropertyLogo: vi.fn(),
  };
  const value: FourStepHotelDetailsProps = {
    propertyId: PROPERTY,
    setup: setup as never,
    propertyTypes: [
      { value: "hotel", label: "Hotel" },
      { value: "villa", label: "Villa" },
    ],
    readCurrency: vi.fn(async () => null),
    saveCurrency: vi.fn(async () => undefined),
    initialStep: "location",
    onDone: vi.fn(),
    onSaveAndExit: vi.fn(),
    ...overrides,
  };
  return { value, setup };
}

async function mount(value: FourStepHotelDetailsProps) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<FourStepHotelDetails {...value} />);
  });
  await act(async () => undefined);
  return renderer!;
}

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const button = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.find((node) => node.type === "button" && textOf(node) === label);

describe("FourStepHotelDetails (VAY-2451 resume)", () => {
  it("opens an older setup's hotel at Location & contact, filled in, and saves what it lacked", async () => {
    const { value, setup } = props();
    const renderer = await mount(value);
    expect(textOf(renderer.root)).toContain("Location & contact");
    expect(textOf(renderer.root)).toContain("Step 2 of 4");
    // Its social links stay in Settings › Booking page.
    expect(
      renderer.root.findAll((node) => node.props["aria-label"] === "Instagram link"),
    ).toHaveLength(0);
    expect(renderer.root.findByProps({ id: "setup-reception-email" }).props.value).toBe(
      "stay@lumansa.example",
    );
    expect(textOf(renderer.root)).toContain("Add a valid reception phone to continue");
    expect(button(renderer, "Continue").props.disabled).toBe(true);

    // The phone field (CountryPhoneField) hands back the full number.
    const phone = renderer.root.find(
      (node) => node.props.label === "Reception phone" && typeof node.props.onChange === "function",
    );
    await act(async () => phone.props.onChange("+94 77 308 7696"));
    await act(async () => button(renderer, "Continue").props.onClick());
    expect(setup.updatePropertyProfile).toHaveBeenCalledOnce();
    const [, request, key] = setup.updatePropertyProfile.mock.calls[0] as unknown as [
      string,
      {
        expectedProfileRevision: number;
        patch: { contacts: { channelType: string; value: string }[] };
      },
      string,
    ];
    expect(request.expectedProfileRevision).toBe(4);
    expect(key).toBe(`four-step:edit:${PROPERTY}:4`);
    expect(request.patch.contacts.map((contact) => contact.channelType)).toEqual([
      "email",
      "phone",
      "whatsapp",
    ]);
    // The four-step setup always keeps a currency: the country's, when none was saved.
    expect(value.saveCurrency).toHaveBeenCalledWith(PROPERTY, "LKR");
    expect(value.onDone).toHaveBeenCalledWith("room");
    renderer.unmount();
  });

  it("leaves without a write when nothing changed", async () => {
    const complete = {
      ...PROFILE,
      contacts: [
        PROFILE.contacts[0]!,
        { channelType: "phone", value: "+94 77 308 7696", purpose: "general", isPublic: true },
        { channelType: "whatsapp", value: "+94 77 308 7696", purpose: "general", isPublic: true },
      ],
    };
    const { value, setup } = props({
      initialStep: "property",
      readCurrency: vi.fn(async () => "LKR"),
    });
    setup.getPropertyProfile.mockResolvedValue({
      propertyId: PROPERTY,
      profileRevision: 4,
      profile: complete,
    });
    const renderer = await mount(value);
    expect(textOf(renderer.root)).toContain("Step 1 of 4");
    await act(async () => button(renderer, "Continue").props.onClick());
    expect(textOf(renderer.root)).toContain("Location & contact");
    await act(async () => button(renderer, "Continue").props.onClick());
    expect(setup.updatePropertyProfile).not.toHaveBeenCalled();
    expect(value.saveCurrency).not.toHaveBeenCalled();
    expect(value.onDone).toHaveBeenCalledWith("room");
    renderer.unmount();
  });
});
