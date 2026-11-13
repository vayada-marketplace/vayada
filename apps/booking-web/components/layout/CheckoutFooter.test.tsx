/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import enMessages from "../../messages/en.json";
import CheckoutFooter from "./CheckoutFooter";

const contact = vi.hoisted(() => ({
  phone: "+41 44 000 00 00",
  email: "stay@alpenrose.test",
  whatsapp: "+41 79 123 45 67" as string | undefined,
}));
const choices = vi.hoisted(() => vi.fn());
vi.mock("@/contexts/HotelContext", () => ({
  useHotel: () => ({
    hotel: { name: "Aether Hilltop Villas", contact: { address: "", ...contact } },
  }),
}));
vi.mock("@/services/api/analyticsConsent", () => ({ openAnalyticsChoices: choices }));
vi.mock("@/components/booking/FindBookingModal", () => ({
  default: ({ open }: { open: boolean }) => (open ? <div role="dialog">Find booking</div> : null),
}));

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  choices.mockClear();
});
const render = () =>
  act(() =>
    root.render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CheckoutFooter />
      </NextIntlClientProvider>,
    ),
  );
const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent === name);

// VAY-2495 (Timo's boards): the phone checkout's slim footer.
it("shows the name, Contact, Find my booking, Privacy choices and Powered by vayada on phones", () => {
  render();
  const footer = document.querySelector("footer")!;
  expect(footer.className).toContain("lg:hidden");
  expect(footer.className).toContain("bg-primary-600");
  expect(footer.textContent).toBe(
    "Aether Hilltop VillasContactFind My BookingPrivacy choicesPowered by vayada",
  );
  // Contact opens the hotel's phone, WhatsApp and email under it.
  const open = button("Contact")!;
  expect(open.getAttribute("aria-expanded")).toBe("false");
  act(() => open.click());
  expect(open.getAttribute("aria-expanded")).toBe("true");
  const links = Array.from(
    document.getElementById(open.getAttribute("aria-controls")!)!.querySelectorAll("a"),
  );
  expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
    ["Phone: +41 44 000 00 00", "tel:+41440000000"],
    ["WhatsApp: +41 79 123 45 67", "https://wa.me/41791234567"],
    ["Email: stay@alpenrose.test", "mailto:stay@alpenrose.test"],
  ]);
  expect(links[1].getAttribute("target")).toBe("_blank");
  // Privacy choices reopens the analytics prompt; Find my booking opens its lookup.
  act(() => button("Privacy choices")!.click());
  expect(choices).toHaveBeenCalledWith(button("Privacy choices"));
  act(() => button("Find My Booking")!.click());
  expect(document.querySelector('[role="dialog"]')!.textContent).toBe("Find booking");
});

it("leaves out a contact the hotel doesn't give", () => {
  contact.whatsapp = undefined;
  try {
    render();
    act(() => button("Contact")!.click());
    expect(document.body.textContent).not.toContain("WhatsApp");
    expect(document.body.textContent).toContain("Email: stay@alpenrose.test");
  } finally {
    contact.whatsapp = "+41 79 123 45 67";
  }
});
