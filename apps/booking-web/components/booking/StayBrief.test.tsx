/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import StayBrief from "./StayBrief";

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => createElement("img", { src, alt }),
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
});
const villa = {
  selectionId: "a",
  name: "Villa Five",
  choice: "Non-refundable",
  image: "/villa.jpg",
};
const render = (props: Record<string, unknown> = {}, locale = "en") =>
  act(() =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: locale === "de" ? de : en,
        children: createElement(StayBrief, {
          rooms: [villa],
          checkIn: "2026-11-13",
          checkOut: "2026-11-14",
          guests: "2 adults",
          onEdit: () => {},
          ...props,
        }),
      }),
    ),
  );
const brief = () => document.querySelector('[data-testid="stay-brief"]')!;

// VAY-2495: the stay in one small card at the top of a phone's details step.
it("shows the room and rate, dates, nights and guests, and Edit goes back to the rooms", () => {
  const onEdit = vi.fn();
  render({ onEdit });
  expect(brief().className).toContain("lg:hidden");
  expect(brief().textContent).toContain("Villa Five · Non-refundable");
  // The browser's own range ("Fri 13 Nov – Sat 14 Nov"), then the nights and guests.
  expect(brief().textContent).toMatch(/Fri 13(\sNov)?\s*–\s*Sat 14 Nov · 1 night · 2 adults/);
  expect(brief().querySelector("img")!.getAttribute("src")).toBe("/villa.jpg");
  const edit = brief().querySelector("button")!;
  expect(edit.textContent).toBe("Edit");
  expect(edit.getAttribute("aria-label")).toBe("Edit your stay");
  // Timo's boards: a tap anywhere on the card is Edit.
  expect(brief().className).toContain("relative");
  expect(edit.className).toContain("after:inset-0");
  act(() => edit.click());
  expect(onEdit).toHaveBeenCalledTimes(1);
  render({ locked: true });
  expect(brief().querySelector("button")!.disabled).toBe(true);
});

it("names a group's rooms, falls back to the hotel's photo and speaks the page's language", () => {
  render({
    rooms: [
      { ...villa, image: undefined },
      { selectionId: "b", name: "Garden Room", choice: "Flexible rate" },
    ],
    checkOut: "2026-11-16",
    image: "/hotel.jpg",
  });
  expect(brief().textContent).toContain("2 Rooms · Villa Five, Garden Room");
  expect(brief().textContent).toContain("3 nights");
  expect(brief().querySelector("img")!.getAttribute("src")).toBe("/hotel.jpg");
  render({}, "de");
  expect(brief().querySelector("button")!.textContent).toBe("Ändern");
  expect(brief().textContent).toContain("1 Nacht");
});
