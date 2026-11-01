import type { PropertyProfile } from "@vayada/domain-hotels";
import GoogleAddressMap from "@vayada/product-onboarding/GoogleAddressMap";
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
const maps = vi.hoisted(() => ({ findAddressOnMap: vi.fn() }));
vi.mock("@vayada/product-onboarding/googleMaps", () => maps);

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

  async function mount({
    profile = PROFILE,
    googleMapsApiKey,
  }: { profile?: PropertyProfile; googleMapsApiKey?: string } = {}) {
    const updatePropertyProfile = vi.fn(async () => ({
      propertyId: PROPERTY,
      profileRevision: 5,
      profile,
    }));
    const saveCurrency = vi.fn(async () => undefined);
    const onDone = vi.fn();
    const onSaveAndExit = vi.fn();
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
                profile,
              })),
              updatePropertyProfile,
              uploadPropertyLogo: vi.fn(),
              assignPropertyLogo: vi.fn(),
            } as never
          }
          propertyTypes={[{ value: "hotel", label: "Hotel" }] as never}
          readCurrency={async () => null}
          saveCurrency={saveCurrency}
          googleMapsApiKey={googleMapsApiKey}
          onDone={onDone}
          onSaveAndExit={onSaveAndExit}
        />,
      );
    });
    await act(async () => undefined);
    return { renderer: renderer!, updatePropertyProfile, saveCurrency, onDone, onSaveAndExit };
  }

  /** The first Back (the footer renders once for desktop and once for phones). */
  const back = (renderer: ReactTestRenderer) =>
    renderer.root.findAll((node) => node.type === "button" && textOf(node) === "Back")[0]!;
  const saveAndExit = (renderer: ReactTestRenderer) =>
    renderer.root.find((node) => node.type === "button" && textOf(node) === "Save & exit");
  const nameField = (renderer: ReactTestRenderer) =>
    renderer.root.findAllByType("input").find((input) => input.props.value === "Hotel Alpenrose")!;

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

  it("saves an edit through Save & exit with the same save as Continue, then leaves (VAY-2383)", async () => {
    const { renderer, updatePropertyProfile, onDone, onSaveAndExit } = await mount();
    // The footer never says the edits are saved as you type.
    expect(textOf(renderer.root)).toContain(
      "Not saved yet: finish with Continue, or use Save & exit",
    );
    expect(textOf(renderer.root)).not.toContain("Saved as you type");
    await act(async () => back(renderer).props.onClick());
    await act(async () => back(renderer).props.onClick());
    await act(async () =>
      nameField(renderer).props.onChange({ target: { value: "Hotel Alpenrose Munich" } }),
    );
    await act(async () => saveAndExit(renderer).props.onClick());
    expect(updatePropertyProfile).toHaveBeenCalledWith(
      PROPERTY,
      {
        expectedProfileRevision: 4,
        patch: expect.objectContaining({ displayName: "Hotel Alpenrose Munich" }),
      },
      `quick-setup:edit:${PROPERTY}:4`,
    );
    expect(onSaveAndExit).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("stays with the reason when Save & exit can't save the edit, and leaves without a write when nothing changed", async () => {
    const { renderer, updatePropertyProfile, onSaveAndExit } = await mount();
    updatePropertyProfile.mockRejectedValueOnce(new Error("Someone else changed this hotel."));
    await act(async () => back(renderer).props.onClick());
    await act(async () => back(renderer).props.onClick());
    await act(async () =>
      nameField(renderer).props.onChange({ target: { value: "Hotel Alpenrose Munich" } }),
    );
    await act(async () => saveAndExit(renderer).props.onClick());
    expect(updatePropertyProfile).toHaveBeenCalledTimes(1);
    expect(onSaveAndExit).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toBe(
      "Someone else changed this hotel.",
    );
    // The edit is still on the screen.
    expect(
      renderer.root
        .findAllByType("input")
        .some((input) => input.props.value === "Hotel Alpenrose Munich"),
    ).toBe(true);
    renderer.unmount();

    const untouched = await mount();
    await act(async () => saveAndExit(untouched.renderer).props.onClick());
    expect(untouched.updatePropertyProfile).not.toHaveBeenCalled();
    expect(untouched.onSaveAndExit).toHaveBeenCalledTimes(1);
    untouched.renderer.unmount();
  });

  it("goes back to step 5 without a write on Back from its first screen with no edit, or one typed back", async () => {
    const { renderer, updatePropertyProfile, onDone } = await mount();
    for (let screen = 0; screen < 3; screen += 1)
      await act(async () => back(renderer).props.onClick());
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(updatePropertyProfile).not.toHaveBeenCalled();
    renderer.unmount();

    const typedBack = await mount();
    await act(async () => back(typedBack.renderer).props.onClick());
    await act(async () => back(typedBack.renderer).props.onClick());
    await act(async () =>
      nameField(typedBack.renderer).props.onChange({ target: { value: "Hotel Alpenrose Munich" } }),
    );
    // Typed back to what it was: no edit.
    await act(async () =>
      typedBack.renderer.root
        .findAllByType("input")
        .find((input) => input.props.value === "Hotel Alpenrose Munich")!
        .props.onChange({ target: { value: "Hotel Alpenrose" } }),
    );
    await act(async () => back(typedBack.renderer).props.onClick());
    expect(typedBack.onDone).toHaveBeenCalledTimes(1);
    expect(typedBack.updatePropertyProfile).not.toHaveBeenCalled();
    typedBack.renderer.unmount();
  });

  it("saves an edit on Back from its first screen with the same save as Continue, then goes back to step 5 (VAY-2394)", async () => {
    const { renderer, updatePropertyProfile, onDone, onSaveAndExit } = await mount();
    await act(async () => back(renderer).props.onClick());
    await act(async () => back(renderer).props.onClick());
    await act(async () =>
      nameField(renderer).props.onChange({ target: { value: "Hotel Alpenrose Munich" } }),
    );
    await act(async () => back(renderer).props.onClick());
    expect(updatePropertyProfile).toHaveBeenCalledOnce();
    expect(updatePropertyProfile).toHaveBeenCalledWith(
      PROPERTY,
      {
        expectedProfileRevision: 4,
        patch: expect.objectContaining({ displayName: "Hotel Alpenrose Munich" }),
      },
      `quick-setup:edit:${PROPERTY}:4`,
    );
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onSaveAndExit).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("stays with the reason when Back from its first screen can't save the edit (VAY-2394)", async () => {
    const { renderer, updatePropertyProfile, onDone } = await mount();
    updatePropertyProfile.mockRejectedValueOnce(new Error("Someone else changed this hotel."));
    await act(async () => back(renderer).props.onClick());
    await act(async () => back(renderer).props.onClick());
    await act(async () =>
      nameField(renderer).props.onChange({ target: { value: "Hotel Alpenrose Munich" } }),
    );
    await act(async () => back(renderer).props.onClick());
    expect(updatePropertyProfile).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(textOf(renderer.root)).toContain("Step 2 of 7");
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toBe(
      "Someone else changed this hotel.",
    );
    // The edit is still on the screen.
    expect(
      renderer.root
        .findAllByType("input")
        .some((input) => input.props.value === "Hotel Alpenrose Munich"),
    ).toBe(true);
    renderer.unmount();

    // An edit with a gap can't be saved yet: it stays, says so, and writes nothing.
    const gap = await mount();
    await act(async () => back(gap.renderer).props.onClick());
    await act(async () => back(gap.renderer).props.onClick());
    await act(async () => nameField(gap.renderer).props.onChange({ target: { value: "" } }));
    await act(async () => back(gap.renderer).props.onClick());
    expect(textOf(gap.renderer.root)).toContain("Enter your hotel's name.");
    expect(textOf(gap.renderer.root)).toContain("Your hotel can't be saved yet");
    expect(gap.updatePropertyProfile).not.toHaveBeenCalled();
    expect(gap.onDone).not.toHaveBeenCalled();
    gap.renderer.unmount();
  });

  describe("a hotel without a map pin (VAY-2394)", () => {
    const UNPINNED: PropertyProfile = {
      ...PROFILE,
      location: { ...PROFILE.location, latitude: null, longitude: null },
    };
    // An email is missing too: the looked-up pin alone must never stop Back with "can't be saved yet".
    const UNPINNED_NO_EMAIL: PropertyProfile = {
      ...UNPINNED,
      contacts: PROFILE.contacts.filter((contact) => contact.channelType !== "email"),
    };

    /** Back to "Where it is", where an address without a pin is looked up after 600 ms. */
    async function openWhereItIs(renderer: ReactTestRenderer) {
      await act(async () => back(renderer).props.onClick());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
    }

    async function withFakeTimers(run: () => Promise<void>) {
      vi.useFakeTimers();
      try {
        await run();
      } finally {
        vi.useRealTimers();
      }
    }

    it("leaves without a write when the looked-up pin is the only change", () =>
      withFakeTimers(async () => {
        maps.findAddressOnMap.mockResolvedValue({
          position: { lat: 48.1372, lng: 11.5756 },
          precise: true,
        });
        const { renderer, updatePropertyProfile, onDone } = await mount({
          profile: UNPINNED_NO_EMAIL,
          googleMapsApiKey: "key",
        });
        await openWhereItIs(renderer);
        expect(maps.findAddressOnMap).toHaveBeenCalledWith(
          "key",
          "Sendlinger Straße 12, 80331 Munich, Germany",
        );
        expect(textOf(renderer.root)).toContain("Pin placed on the map");
        await act(async () => back(renderer).props.onClick());
        await act(async () => back(renderer).props.onClick());
        expect(textOf(renderer.root)).not.toContain("can't be saved yet");
        expect(onDone).toHaveBeenCalledTimes(1);
        expect(updatePropertyProfile).not.toHaveBeenCalled();
        renderer.unmount();

        const exit = await mount({ profile: UNPINNED_NO_EMAIL, googleMapsApiKey: "key" });
        await openWhereItIs(exit.renderer);
        await act(async () => saveAndExit(exit.renderer).props.onClick());
        expect(textOf(exit.renderer.root)).not.toContain("can't be saved yet");
        expect(exit.onSaveAndExit).toHaveBeenCalledTimes(1);
        expect(exit.updatePropertyProfile).not.toHaveBeenCalled();
        exit.renderer.unmount();
      }));

    it("saves the looked-up pin along with a real edit", () =>
      withFakeTimers(async () => {
        maps.findAddressOnMap.mockResolvedValue({
          position: { lat: 48.1372, lng: 11.5756 },
          precise: true,
        });
        const { renderer, updatePropertyProfile, onDone } = await mount({
          profile: UNPINNED,
          googleMapsApiKey: "key",
        });
        await openWhereItIs(renderer);
        await act(async () => back(renderer).props.onClick());
        await act(async () =>
          nameField(renderer).props.onChange({ target: { value: "Hotel Alpenrose Munich" } }),
        );
        await act(async () => back(renderer).props.onClick());
        expect(updatePropertyProfile).toHaveBeenCalledOnce();
        expect(updatePropertyProfile).toHaveBeenCalledWith(
          PROPERTY,
          {
            expectedProfileRevision: 4,
            patch: expect.objectContaining({
              displayName: "Hotel Alpenrose Munich",
              location: expect.objectContaining({ latitude: 48.1372, longitude: 11.5756 }),
            }),
          },
          `quick-setup:edit:${PROPERTY}:4`,
        );
        expect(onDone).toHaveBeenCalledTimes(1);
        renderer.unmount();
      }));

    it("counts a pin the owner moves or sets as an edit", () =>
      withFakeTimers(async () => {
        // Moved: the looked-up pin, then dragged elsewhere.
        maps.findAddressOnMap.mockResolvedValue({
          position: { lat: 48.1372, lng: 11.5756 },
          precise: true,
        });
        const moved = await mount({ profile: UNPINNED, googleMapsApiKey: "key" });
        await openWhereItIs(moved.renderer);
        // VAY-2444: the room editor's map takes a pin at once, without "Adjust".
        await act(async () =>
          moved.renderer.root.findByType(GoogleAddressMap).props.onPick({ lat: 48.14, lng: 11.58 }),
        );
        await act(async () => back(moved.renderer).props.onClick());
        await act(async () => back(moved.renderer).props.onClick());
        expect(moved.updatePropertyProfile).toHaveBeenCalledOnce();
        expect(moved.updatePropertyProfile).toHaveBeenCalledWith(
          PROPERTY,
          {
            expectedProfileRevision: 4,
            patch: expect.objectContaining({
              location: expect.objectContaining({ latitude: 48.14, longitude: 11.58 }),
            }),
          },
          `quick-setup:edit:${PROPERTY}:4`,
        );
        expect(moved.onDone).toHaveBeenCalledTimes(1);
        moved.renderer.unmount();

        // Set: the lookup found nothing, so the owner clicks the map.
        maps.findAddressOnMap.mockResolvedValue(null);
        const set = await mount({ profile: UNPINNED, googleMapsApiKey: "key" });
        await openWhereItIs(set.renderer);
        await act(async () =>
          set.renderer.root.findByType(GoogleAddressMap).props.onPick({ lat: 48.14, lng: 11.58 }),
        );
        await act(async () => back(set.renderer).props.onClick());
        await act(async () => back(set.renderer).props.onClick());
        expect(set.updatePropertyProfile).toHaveBeenCalledOnce();
        expect(set.onDone).toHaveBeenCalledTimes(1);
        set.renderer.unmount();
      }));
  });
});
