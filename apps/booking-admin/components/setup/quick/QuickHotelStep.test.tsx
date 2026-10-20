import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { QuickHotelStep, orderedPropertyTypes, type QuickHotelStepProps } from "./QuickHotelStep";
import {
  EMPTY_QUICK_HOTEL_DRAFT,
  previewBookingHost,
  quickHotelErrors,
  type QuickHotelDraft,
} from "./quickHotelDraft";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));

const TYPES = [
  { value: "apartment", label: "Apartment" },
  { value: "hotel", label: "Hotel" },
  { value: "motel", label: "Motel" },
  { value: "guesthouse", label: "Guesthouse" },
  { value: "other", label: "Other" },
];
const FILLED: QuickHotelDraft = {
  displayName: "Hotel Alpenrose",
  propertyType: "hotel",
  streetAddress: "Sendlinger Straße 12",
  postalCode: "80331",
  city: "Munich",
  countryCode: "DE",
  latitude: 48.135,
  longitude: 11.567,
  timezone: "Europe/Berlin",
  contactEmail: "clara@example.com",
  phone: "+49 30 0000 0000",
  currency: "",
};

function props(overrides: Partial<QuickHotelStepProps> = {}): QuickHotelStepProps {
  return {
    draft: EMPTY_QUICK_HOTEL_DRAFT,
    onChange: vi.fn(),
    propertyTypes: TYPES,
    address: (error) => <p>address slot {error}</p>,
    onLogoSelected: vi.fn(),
    onSubmit: vi.fn(async () => undefined),
    onSaveAndExit: vi.fn(),
    ...overrides,
  };
}

async function submit(renderer: ReactTestRenderer) {
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}

const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

describe("QuickHotelStep (VAY-2247 step 2, fields)", () => {
  it("shows step 2 with the three sections, the address slot and the live preview", () => {
    const markup = renderToStaticMarkup(<QuickHotelStep {...props({ draft: FILLED })} />);
    expect(markup).toContain("Step 2 of 5");
    for (const heading of ["Your hotel", "Where it is", "How guests reach you"])
      expect(markup).toContain(`>${heading}</h2>`);
    expect(markup).toContain("address slot");
    expect(markup).toContain("Logo optional — you can add it later.");
    expect(markup).toContain("Your booking page, live as you type");
    expect(markup).toContain("alpenrose-munich.booking.vayada.com");
    expect(markup).toContain("Sendlinger Straße 12, Munich");
    expect(markup).toContain("Your first room");
    expect(renderToStaticMarkup(<QuickHotelStep {...props()} />)).toContain("Your hotel name");
    expect(markup).toContain("Saved as you type");
  });

  it("offers Hotel first and keeps the rarer types behind More…", async () => {
    const onChange = vi.fn();
    const renderer = create(<QuickHotelStep {...props({ onChange })} />);
    const radios = () => renderer.root.findAll((node) => node.props.role === "radio");
    expect(radios().map((radio) => radio.children.join(""))).toEqual([
      "Hotel",
      "Guesthouse",
      "Apartment",
    ]);
    const more = renderer.root.findAll(
      (node) => node.type === "button" && node.children.join("") === "More…",
    );
    await act(async () => more[0]!.props.onClick());
    expect(radios().map((radio) => radio.children.join(""))).toEqual([
      "Hotel",
      "Guesthouse",
      "Apartment",
      "Motel",
      "Other",
    ]);
    await act(async () => radios()[0]!.props.onClick());
    expect(onChange).toHaveBeenCalledWith({ propertyType: "hotel" });
    renderer.unmount();
  });

  it("names every missing field and saves nothing until they are filled", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const renderer = create(<QuickHotelStep {...props({ onSubmit })} />);
    await submit(renderer);
    expect(onSubmit).not.toHaveBeenCalled();
    for (const message of [
      "Enter your hotel's name.",
      "Choose a property type.",
      "Choose your address from the list, or enter it manually.",
      "Enter an email guests can write to.",
      "Enter a phone number guests can call.",
    ])
      expect(text(renderer)).toContain(message);
    renderer.unmount();
  });

  it("saves a complete hotel and shows why a save failed", async () => {
    const onSubmit = vi
      .fn<(draft: QuickHotelDraft) => Promise<void>>()
      .mockRejectedValueOnce(new Error("That hotel name is already taken."))
      .mockResolvedValueOnce(undefined);
    const renderer = create(<QuickHotelStep {...props({ draft: FILLED, onSubmit })} />);
    await submit(renderer);
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toBe(
      "That hotel name is already taken.",
    );
    await submit(renderer);
    expect(onSubmit).toHaveBeenLastCalledWith(FILLED);
    expect(renderer.root.findAll((node) => node.props.role === "alert")).toHaveLength(0);
    renderer.unmount();
  });

  it("passes the chosen logo file on", async () => {
    const onLogoSelected = vi.fn();
    const renderer = create(<QuickHotelStep {...props({ onLogoSelected })} />);
    const file = { name: "logo.png" } as File;
    const input = renderer.root.findByProps({ type: "file" });
    await act(async () => input.props.onChange({ target: { files: [file], value: "x" } }));
    expect(onLogoSelected).toHaveBeenCalledWith(file);
    renderer.unmount();
  });
});

describe("quickHotelDraft", () => {
  it("keeps the logo optional and checks email and phone", () => {
    expect(quickHotelErrors(FILLED)).toEqual({});
    expect(quickHotelErrors({ ...FILLED, contactEmail: "reception@", phone: "12" })).toEqual({
      contactEmail: "Enter a valid email address.",
      phone: "Enter a valid phone number.",
    });
    expect(quickHotelErrors({ ...FILLED, countryCode: "XX" })).toEqual({
      address: "Choose your address from the list, or enter it manually.",
    });
    expect(quickHotelErrors({ ...FILLED, timezone: "" })).toHaveProperty("address");
  });

  it("builds the preview's booking-page address from the name and city", () => {
    expect(previewBookingHost("Hotel Alpenrose", "Munich")).toBe(
      "alpenrose-munich.booking.vayada.com",
    );
    expect(previewBookingHost("Gästehaus Weiß", "München")).toBe(
      "gastehaus-weiss-munchen.booking.vayada.com",
    );
    expect(previewBookingHost("", "")).toBe("yourhotel.booking.vayada.com");
  });

  it("orders the property types for the pills", () => {
    expect(orderedPropertyTypes(TYPES).shown.map((option) => option.value)).toEqual([
      "hotel",
      "guesthouse",
      "apartment",
    ]);
  });
});
