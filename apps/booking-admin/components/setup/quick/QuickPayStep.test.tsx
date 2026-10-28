import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HotelFirstRunError } from "@/services/api/hotelFirstRunClient";
import { QuickPayStep, type QuickPayStepProps } from "./QuickPayStep";
import {
  QuickPropertySetup,
  quickFirstRunErrorMessage,
  quickRoomStorageKey,
} from "./QuickPropertySetup";
import { quickFixedFeePrice } from "./quickPlanPrice";

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const hotel = {
  name: "Hotel Alpenrose",
  place: "Sendlinger Straße 12, Munich",
  url: "hotel-alpenrose.booking.vayada.com",
};
// Saved as the first version did: one room with its taxes tick (the setup reads both shapes).
const ROOM = {
  name: "Classic Double",
  numberOfRooms: "8",
  maxGuests: "2",
  pricePerNight: "145",
  pricesIncludeMandatoryCharges: true,
};

function props(overrides: Partial<QuickPayStepProps> = {}): QuickPayStepProps {
  return {
    hotel,
    currency: { code: "EUR", symbol: "€" },
    rooms: [{ name: "Classic Double", details: "Up to 2 guests", price: "€145" }],
    onSubmit: vi.fn(async () => undefined),
    onBack: vi.fn(),
    onSaveAndExit: vi.fn(),
    ...overrides,
  };
}
const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());
async function submit(renderer: ReactTestRenderer) {
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}

describe("QuickPayStep (VAY-2247 step 4)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts with paying at the hotel and Commission, and shows the Fixed Fee in the hotel's currency", () => {
    const markup = renderToStaticMarkup(<QuickPayStep {...props()} />);
    expect(markup).toContain("Step 6 of 7");
    expect(markup).toContain("Pay at the hotel");
    expect(markup).toContain("Ready now");
    expect(markup).toContain("Later");
    expect(markup).toContain("5% per direct booking");
    expect(markup).toContain("€30 / month");
    expect(markup).toContain("€30 for the first active room + €5 for each additional room.");
    expect(markup).toContain("Guests see “Pay at the hotel” at checkout");
    expect(markup).not.toContain("Stripe checkout");
  });

  it("says when the Fixed Fee is not offered in the hotel's currency", () => {
    const renderer = create(
      <QuickPayStep {...props({ currency: { code: "CHF", symbol: "CHF" } })} />,
    );
    expect(text(renderer)).toContain("Not available in CHF yet.");
    expect(text(renderer)).toContain(
      "Your hotel uses Swiss francs. Commission works in every currency.",
    );
    const fixed = renderer.root.find(
      (node) => node.type === "input" && node.props.value === "fixed_fee",
    );
    expect(fixed.props.disabled).toBe(true);
    renderer.unmount();
  });

  it("sends the chosen plan and explains the Stripe checkout for the Fixed Fee", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const renderer = create(<QuickPayStep {...props({ onSubmit })} />);
    const fixed = renderer.root.findAll(
      (node) => node.type === "input" && node.props.value === "fixed_fee",
    )[0]!;
    await act(async () => fixed.props.onChange());
    expect(text(renderer)).toContain("You'll confirm the Fixed Fee in Stripe checkout.");
    await submit(renderer);
    expect(onSubmit).toHaveBeenCalledWith("fixed_fee");
    renderer.unmount();
  });

  it("disables the choices while the first run runs, and a failed run gives them back as they were (VAY-2399)", async () => {
    let fail: (error: Error) => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise<void>((_resolve, reject) => (fail = reject)));
    const renderer = create(<QuickPayStep {...props({ onSubmit })} />);
    // Every control of the form sits in the one fieldset.
    const controls = (node: ReactTestInstance) =>
      node.findAll((each) => ["input", "select", "textarea", "button"].includes(String(each.type)))
        .length;
    const fieldset = () => renderer.root.findByType("fieldset");
    const plan = (value: string) =>
      renderer.root.find((node) => node.type === "input" && node.props.value === value);
    expect(controls(fieldset())).toBeGreaterThan(0);
    expect(controls(fieldset())).toBe(controls(renderer.root.findByType("form")));
    expect(fieldset().props.disabled).toBe(false);

    await act(async () => plan("fixed_fee").props.onChange());
    // A slow first run: the plan can't be changed while it runs, as the change wouldn't be part of it.
    await act(async () => {
      void renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    expect(onSubmit).toHaveBeenCalledWith("fixed_fee");
    expect(fieldset().props.disabled).toBe(true);
    expect(text(renderer)).toContain("Setting up your hotel…");

    await act(async () => fail(new Error("We couldn't finish setting up your hotel.")));
    expect(fieldset().props.disabled).toBe(false);
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toBe(
      "We couldn't finish setting up your hotel.",
    );
    expect(plan("fixed_fee").props.checked).toBe(true);
    expect(plan("commission").props.checked).toBe(false);
    renderer.unmount();
  });

  it("stays disabled after a run that opens Stripe, until the browser brings the page back (VAY-2402)", async () => {
    // The Fixed Fee run worked and the browser is on its way to Stripe: the step is still on screen.
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    const onSubmit = vi.fn(async () => undefined);
    const renderer = create(<QuickPayStep {...props({ onSubmit })} />);
    const fieldset = () => renderer.root.findByType("fieldset");
    const inFieldset = (node: ReactTestInstance | null): boolean =>
      node !== null && (node.type === "fieldset" || inFieldset(node.parent));
    // Back, Continue (desktop and phone footers) and Save & exit sit outside the form's fieldset.
    const footer = () =>
      new Set(
        renderer.root
          .findAllByType("button")
          .filter((each) => !inFieldset(each))
          .map((each) => each.props.disabled),
      );
    const pageshow = (persisted: boolean) =>
      act(async () => {
        page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));
      });

    await act(async () =>
      renderer.root
        .find((node) => node.type === "input" && node.props.value === "fixed_fee")
        .props.onChange(),
    );
    await submit(renderer);
    expect(onSubmit).toHaveBeenCalledWith("fixed_fee");
    expect(fieldset().props.disabled).toBe(true);
    expect(footer()).toEqual(new Set([true]));
    expect(text(renderer)).toContain("Setting up your hotel…");

    await pageshow(false);
    expect(fieldset().props.disabled).toBe(true);
    // Back from Stripe, the page comes out of the back/forward cache as it left.
    await pageshow(true);
    expect(fieldset().props.disabled).toBe(false);
    expect(footer()).toEqual(new Set([false]));
    expect(text(renderer)).not.toContain("Setting up your hotel…");
    renderer.unmount();
  });

  it("keeps a checkout that is already open in Stripe", () => {
    const markup = renderToStaticMarkup(
      <QuickPayStep {...props({ checkoutPending: true, initialPlan: "fixed_fee" })} />,
    );
    expect(markup).toContain("Your Fixed Fee checkout is open in Stripe.");
  });
});

describe("step 4 sends the first run (VAY-2247 3.7)", () => {
  function storage(room: object | null) {
    const values = new Map<string, string>(
      room ? [[quickRoomStorageKey(PROPERTY), JSON.stringify(room)]] : [],
    );
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
  }
  const setup = {
    getPropertyProfile: vi.fn(async () => ({
      profile: {
        displayName: "Hotel Alpenrose",
        location: { streetAddress: "Sendlinger Straße 12", city: "Munich", countryCode: "DE" },
      },
    })),
  } as never;

  async function mount(run: ReturnType<typeof vi.fn>, room: object | null, openCheckout = vi.fn()) {
    // Step 5 loads the booking page review; here it fails, which step 5 shows in its own words.
    const publication = {
      load: vi.fn(async () => {
        throw new Error("Review unavailable in this test.");
      }),
      publish: vi.fn(),
    };
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <QuickPropertySetup
          propertyId={PROPERTY}
          initialStep={4}
          setup={setup}
          readCurrency={async () => "EUR"}
          firstRun={{ run } as never}
          readCheckoutPending={async () => false}
          openCheckout={openCheckout}
          storage={storage(room)}
          onSaveAndExit={vi.fn()}
          publication={publication}
          organizationId="9a8b7c6d-5e4f-4a3b-8c2d-1e0f99887766"
          publicationStorage={storage(null)}
          openPage={vi.fn()}
        />,
      );
    });
    return { renderer: renderer!, openCheckout };
  }

  it("runs the first run with the room and Commission, then goes live (step 5)", async () => {
    const run = vi.fn(async () => ({ state: {}, ran: [], checkoutUrl: null }));
    const { renderer } = await mount(run, ROOM);
    await submit(renderer);
    expect(run).toHaveBeenCalledWith(PROPERTY, {
      rooms: [{ name: "Classic Double", numberOfRooms: 8, maxGuests: 2, pricePerNight: "145" }],
      pricesIncludeMandatoryCharges: true,
      guestPayment: "pay_at_property",
      plan: "commission",
      // The defaults when the owner didn't change them (1.12b).
      cancellation: { kind: "free_until_days_before_arrival", days: 3 },
      bed: "double",
    });
    // On to step 5, "Does this look right?", with the room in the preview.
    expect(text(renderer)).toContain("Does this look right?");
    expect(text(renderer)).toContain("Classic Double");
    renderer.unmount();
  });

  it("sends the owner's cancellation and bed choices, and step 5 says the chosen days (1.12b)", async () => {
    const run = vi.fn(async () => ({ state: {}, ran: [], checkoutUrl: null }));
    const { renderer } = await mount(run, { ...ROOM, freeCancellationDays: 7, bed: "twin" });
    await submit(renderer);
    expect(run).toHaveBeenCalledWith(
      PROPERTY,
      expect.objectContaining({
        cancellation: { kind: "free_until_days_before_arrival", days: 7 },
        bed: "twin",
      }),
    );
    expect(text(renderer)).toContain("free cancellation until 7 days");
    renderer.unmount();
  });

  it("opens Stripe for the Fixed Fee checkout", async () => {
    const run = vi.fn(async () => ({
      state: {},
      ran: [],
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test",
    }));
    const { renderer, openCheckout } = await mount(run, ROOM);
    await submit(renderer);
    expect(openCheckout).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test");
    expect(text(renderer)).not.toContain("Does this look right?");
    // The step stays disabled while the browser leaves for Stripe (VAY-2402).
    expect(renderer.root.findByType("fieldset").props.disabled).toBe(true);
    renderer.unmount();
  });

  it("asks for the room again when this device doesn't have it", async () => {
    const run = vi.fn();
    const { renderer } = await mount(run, null);
    await submit(renderer);
    expect(run).not.toHaveBeenCalled();
    expect(text(renderer)).toContain("Your first room and price");
    renderer.unmount();
  });

  it("explains a stopped first run in the owner's words", async () => {
    const run = vi.fn(async () => {
      throw new HotelFirstRunError("first_run_in_progress", null, null);
    });
    const { renderer } = await mount(run, ROOM);
    await submit(renderer);
    expect(text(renderer)).toContain(
      "Your hotel is being set up in another tab. Try again in a moment.",
    );
    expect(quickFirstRunErrorMessage(new Error("boom"))).toBe(
      "We couldn't finish setting up your hotel. Try again in a minute.",
    );
    renderer.unmount();
  });
});

describe("quickFixedFeePrice", () => {
  it("uses the finance catalogue and knows where it isn't offered", () => {
    expect(quickFixedFeePrice("EUR")).toEqual({ available: true, base: "€30", extraRoom: "€5" });
    expect(quickFixedFeePrice("CHF")).toEqual({ available: false });
  });
});
