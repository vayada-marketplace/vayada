import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  QuickHotelStep,
  orderedPropertyTypes,
  quickHotelPartErrors,
  type QuickHotelStepProps,
} from "./QuickHotelStep";
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

/** A node's visible text, nested elements included. */
function label(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(label).join("");
}

/** The first button with this text (the footer renders once for desktop and once for phones). */
function button(renderer: ReactTestRenderer, name: string) {
  return renderer.root.findAll((node) => node.type === "button" && label(node) === name)[0]!;
}

describe("QuickHotelStep (VAY-2247 steps 2–4, the approved split)", () => {
  it("opens on Your hotel: the name, the logo upload strip, type cards and the live preview", () => {
    const markup = renderToStaticMarkup(<QuickHotelStep {...props({ draft: FILLED })} />);
    expect(markup).toContain("Step 2 of 7");
    expect(markup).toContain(">Your hotel</h1>");
    expect(markup).toContain("Guests see it on your booking page and in emails.");
    expect(markup).toContain("Upload your logo");
    expect(markup).toContain("PNG or SVG · optional");
    expect(markup).toContain("Choose file");
    expect(markup).toContain("Your booking page, live as you type");
    expect(markup).toContain("hotel-alpenrose.booking.vayada.com");
    expect(markup).toContain("Saved as you type");
    // The other two screens come after it.
    expect(markup).not.toContain("address slot");
    expect(markup).not.toContain("Reception email");
    const empty = renderToStaticMarkup(<QuickHotelStep {...props()} />);
    expect(empty).toContain("Your hotel name");
    expect(empty).toContain("Your address comes next");
  });

  it("shows the property types as cards, Hotel first, the rarer ones behind More…", async () => {
    const onChange = vi.fn();
    const renderer = create(<QuickHotelStep {...props({ onChange })} />);
    const radios = () => renderer.root.findAll((node) => node.props.role === "radio");
    expect(radios().map(label)).toEqual(["Hotel", "Guesthouse", "Apartment"]);
    await act(async () => button(renderer, "More…").props.onClick());
    expect(radios().map(label)).toEqual(["Hotel", "Guesthouse", "Apartment", "Motel", "Other"]);
    await act(async () => radios()[0]!.props.onClick());
    expect(onChange).toHaveBeenCalledWith({ propertyType: "hotel" });
    renderer.unmount();
  });

  it("goes screen by screen, each checking its own fields, and Back returns", async () => {
    const empty = create(<QuickHotelStep {...props()} />);
    await submit(empty);
    expect(text(empty)).toContain("Enter your hotel's name.");
    expect(text(empty)).toContain("Choose a property type.");
    expect(text(empty)).not.toContain("Enter an email guests can write to.");
    empty.unmount();

    const onBack = vi.fn();
    const onSubmit = vi.fn(async () => undefined);
    const renderer = create(<QuickHotelStep {...props({ draft: FILLED, onBack, onSubmit })} />);
    await submit(renderer);
    expect(text(renderer)).toContain("Step 3 of 7");
    expect(text(renderer)).toContain("Where it is");
    expect(text(renderer)).toContain("address slot");
    await submit(renderer);
    expect(text(renderer)).toContain("Step 4 of 7");
    expect(text(renderer)).toContain("How guests reach you");
    expect(text(renderer)).toContain("Reception email");
    // The reception phone is country + number, in the hotel's country.
    expect(renderer.root.findByProps({ "aria-haspopup": "listbox" }).props["aria-label"]).toBe(
      "Reception phone country: Germany +49",
    );
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => button(renderer, "Back").props.onClick());
    expect(text(renderer)).toContain("Step 3 of 7");
    await act(async () => button(renderer, "Back").props.onClick());
    expect(text(renderer)).toContain("Step 2 of 7");
    await act(async () => button(renderer, "Back").props.onClick());
    expect(onBack).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  it("checks the contacts before the save, and sends a gap on an earlier screen back there", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const noContacts = { ...FILLED, contactEmail: "", phone: "" };
    const renderer = create(
      <QuickHotelStep {...props({ draft: noContacts, onSubmit, initialPart: "contacts" })} />,
    );
    await submit(renderer);
    expect(text(renderer)).toContain("Enter an email guests can write to.");
    expect(text(renderer)).toContain("Enter a phone number guests can call.");
    expect(onSubmit).not.toHaveBeenCalled();
    renderer.unmount();

    const noName = create(
      <QuickHotelStep
        {...props({ draft: { ...FILLED, displayName: "" }, onSubmit, initialPart: "contacts" })}
      />,
    );
    await submit(noName);
    expect(text(noName)).toContain("Step 2 of 7");
    expect(text(noName)).toContain("Enter your hotel's name.");
    expect(onSubmit).not.toHaveBeenCalled();
    noName.unmount();
  });

  it("saves a complete hotel on the last screen and shows why a save failed", async () => {
    const onSubmit = vi
      .fn<(draft: QuickHotelDraft) => Promise<void>>()
      .mockRejectedValueOnce(new Error("That hotel name is already taken."))
      .mockResolvedValueOnce(undefined);
    const renderer = create(
      <QuickHotelStep {...props({ draft: FILLED, onSubmit, initialPart: "contacts" })} />,
    );
    expect(text(renderer)).toContain("clara@example.com");
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

  it("splits the checks by screen", () => {
    const empty = EMPTY_QUICK_HOTEL_DRAFT;
    expect(Object.keys(quickHotelPartErrors("hotel", empty))).toEqual([
      "displayName",
      "propertyType",
    ]);
    expect(Object.keys(quickHotelPartErrors("where", empty))).toEqual(["address"]);
    expect(Object.keys(quickHotelPartErrors("contacts", empty))).toEqual(["contactEmail", "phone"]);
  });

  it("shows the address the server reserves: the name, URL-safe", () => {
    expect(previewBookingHost("Hotel Alpenrose")).toBe("hotel-alpenrose.booking.vayada.com");
    expect(previewBookingHost("  Gästehaus  Weiß & Co. ")).toBe(
      "gastehaus-wei-co.booking.vayada.com",
    );
    expect(previewBookingHost("")).toBe("yourhotel.booking.vayada.com");
  });

  it("orders the property types for the cards", () => {
    expect(orderedPropertyTypes(TYPES).shown.map((option) => option.value)).toEqual([
      "hotel",
      "guesthouse",
      "apartment",
    ]);
  });
});
