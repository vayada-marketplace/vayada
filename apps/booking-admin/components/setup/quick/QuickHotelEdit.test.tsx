import type { PropertyProfile } from "@vayada/domain-hotels";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { QuickHotelEdit } from "./QuickHotelEdit";
import { quickHotelCurrency } from "./quickHotelCurrency";
import {
  quickHotelCurrencyToSave,
  quickHotelDraftFromProfile,
  quickHotelProfilePatch,
} from "./quickHotelEdit";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));
vi.mock("@vayada/product-onboarding/GooglePlacesAddressField", () => ({ default: () => null }));
vi.mock("@vayada/product-onboarding/GoogleAddressMap", () => ({ default: () => null }));
vi.mock("@vayada/product-onboarding/TimezoneField", () => ({ default: () => null }));
vi.mock("@vayada/product-onboarding/googleMaps", () => ({ findAddressOnMap: vi.fn() }));

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const PROFILE: PropertyProfile = {
  displayName: "Hotel Alpenrose",
  propertyType: "hotel",
  location: {
    streetAddress: "Sendlinger Straße 12",
    postalCode: "80331",
    city: "Munich",
    countryCode: "DE",
    timezone: "Europe/Berlin",
    latitude: 48.135,
    longitude: 11.567,
    localityPublic: true,
    geoPublic: true,
    mapDisplayMode: "approximate",
  },
  contacts: [
    { channelType: "phone", value: "+49 89 1234567", purpose: "general", isPublic: true },
    {
      channelType: "email",
      value: "reception@alpenrose.example",
      purpose: "general",
      isPublic: true,
    },
    {
      channelType: "website",
      value: "https://alpenrose.example",
      purpose: "general",
      isPublic: true,
    },
  ] as PropertyProfile["contacts"],
};

describe("quickHotelEdit (VAY-2247 Your hotel for a hotel that exists)", () => {
  it("fills the form from the profile, with the currency only when it isn't the country's", () => {
    expect(quickHotelDraftFromProfile(PROFILE, null)).toMatchObject({
      displayName: "Hotel Alpenrose",
      streetAddress: "Sendlinger Straße 12",
      contactEmail: "reception@alpenrose.example",
      phone: "+49 89 1234567",
      currency: "",
    });
    expect(quickHotelDraftFromProfile(PROFILE, "EUR").currency).toBe("");
    expect(quickHotelDraftFromProfile(PROFILE, "CHF").currency).toBe("CHF");
  });

  it("changes only what the form shows and keeps the rest of the profile", () => {
    const draft = {
      ...quickHotelDraftFromProfile(PROFILE, null),
      displayName: " Hotel Alpenrose Munich ",
      phone: "+49 89 7654321",
    };
    const patch = quickHotelProfilePatch(draft, PROFILE);
    expect(patch).toMatchObject({ displayName: "Hotel Alpenrose Munich", propertyType: "hotel" });
    // What the map shows and the city being public aren't in the patch, so they stay.
    expect(patch.location).not.toHaveProperty("geoPublic");
    expect(patch.location).not.toHaveProperty("mapDisplayMode");
    expect(patch.contacts).toEqual([
      { channelType: "phone", value: "+49 89 7654321", purpose: "general", isPublic: true },
      PROFILE.contacts[1],
      PROFILE.contacts[2],
    ]);
  });

  it("saves a currency the way creating the hotel does", () => {
    const fromCountry = quickHotelCurrency("DE", "")!;
    const chosen = quickHotelCurrency("DE", "CHF")!;
    expect(quickHotelCurrencyToSave(fromCountry, null)).toBeNull();
    expect(quickHotelCurrencyToSave(chosen, null)).toBe("CHF");
    expect(quickHotelCurrencyToSave(fromCountry, "EUR")).toBeNull();
    expect(quickHotelCurrencyToSave(fromCountry, "CHF")).toBe("EUR");
  });
});

describe("QuickHotelEdit", () => {
  const textOf = (node: ReactTestInstance): string =>
    node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

  async function mount() {
    const updatePropertyProfile = vi.fn(async () => ({
      propertyId: PROPERTY,
      profileRevision: 5,
      profile: PROFILE,
    }));
    const saveCurrency = vi.fn(async () => undefined);
    const onDone = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <QuickHotelEdit
          propertyId={PROPERTY}
          setup={
            {
              getPropertyProfile: vi.fn(async () => ({
                propertyId: PROPERTY,
                profileRevision: 4,
                profile: PROFILE,
              })),
              updatePropertyProfile,
              uploadPropertyLogo: vi.fn(),
              assignPropertyLogo: vi.fn(),
            } as never
          }
          propertyTypes={[{ value: "hotel", label: "Hotel" }] as never}
          readCurrency={async () => null}
          saveCurrency={saveCurrency}
          onDone={onDone}
          onSaveAndExit={vi.fn()}
        />,
      );
    });
    await act(async () => undefined);
    return { renderer: renderer!, updatePropertyProfile, saveCurrency, onDone };
  }

  /** The first Back (the footer renders once for desktop and once for phones). */
  const back = (renderer: ReactTestRenderer) =>
    renderer.root.findAll((node) => node.type === "button" && textOf(node) === "Back")[0]!;

  it("opens filled in on its last screen, saves the change to the profile and goes back to step 5", async () => {
    const { renderer, updatePropertyProfile, saveCurrency, onDone } = await mount();
    // Back from the rooms step: "How guests reach you", the last of the three hotel screens.
    expect(textOf(renderer.root)).toContain("Step 4 of 7");
    await act(async () => back(renderer).props.onClick());
    await act(async () => back(renderer).props.onClick());
    expect(textOf(renderer.root)).toContain("Step 2 of 7");
    // Filled in from the profile.
    const name = renderer.root
      .findAllByType("input")
      .find((input) => input.props.value === "Hotel Alpenrose");
    expect(name).toBeDefined();
    await act(async () => name!.props.onChange({ target: { value: "Hotel Alpenrose Munich" } }));
    // Continue through the three screens; the last one saves.
    for (let screen = 0; screen < 3; screen += 1)
      await act(async () =>
        renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }),
      );
    expect(updatePropertyProfile).toHaveBeenCalledWith(
      PROPERTY,
      {
        expectedProfileRevision: 4,
        patch: expect.objectContaining({ displayName: "Hotel Alpenrose Munich" }),
      },
      `quick-setup:edit:${PROPERTY}:4`,
    );
    expect(saveCurrency).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("goes back to step 5 without saving on Back from its first screen", async () => {
    const { renderer, updatePropertyProfile, onDone } = await mount();
    for (let screen = 0; screen < 3; screen += 1)
      await act(async () => back(renderer).props.onClick());
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(updatePropertyProfile).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
