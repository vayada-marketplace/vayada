/** @vitest-environment jsdom */
import type { ComponentProps } from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import type { PricingRoom } from "@/services/api/replacementOffers";
import RoomDetailModal from "./RoomDetailModal";

// The hotel's check-in and check-out times, from its settings, as the page loaded them.
const hotel = vi.hoisted(() => ({ checkInTime: "", checkOutTime: "" }));
vi.mock("@/contexts/HotelContext", () => ({ useHotel: () => ({ hotel }) }));
vi.mock("next/image", () => ({
  default: ({ fill, ...props }: ComponentProps<"img"> & { fill?: boolean }) => {
    void fill;
    return createElement("img", props);
  },
}));
vi.mock("./RoomPlace", () => ({ default: () => null }));

const room = {
  roomTypeId: "villa-five",
  name: "Villa Five",
  description: "A quiet villa above the paddy fields.",
  amenities: ["Private pool", "Air conditioning"],
  images: [],
  offers: [],
} as unknown as PricingRoom;

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.assign(hotel, { checkInTime: "14:00", checkOutTime: "11:00" });
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const render = (locale = "en") =>
  act(() =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: locale === "de" ? de : en,
        children: createElement(RoomDetailModal, {
          room,
          roomCount: 1,
          soldOut: false,
          onClose: () => {},
          children: null,
        }),
      }),
    ),
  );
const details = () => document.querySelector('[role="dialog"]')?.textContent ?? "";
// The times' row: the one block whose text starts with them (its clock icon has none).
const timesRow = () =>
  Array.from(document.querySelectorAll('[role="dialog"] div')).find((element) =>
    /^Check-(in|out)/.test(element.textContent ?? ""),
  )?.textContent;

it("shows the hotel's check-in and check-out times under the description, above the amenities (VAY-2488)", () => {
  render();
  expect(timesRow()).toBe("Check-in from 14:00·Check-out by 11:00");
  const text = details();
  expect(text.indexOf(room.description!)).toBeLessThan(text.indexOf("Check-in from 14:00"));
  expect(text.indexOf("Check-out by 11:00")).toBeLessThan(text.indexOf("Private pool"));
});

it("says them in the guest's language", () => {
  render("de");
  expect(timesRow()).toBe("Check-in ab 14:00·Check-out bis 11:00");
});

it("shows only the time the hotel has, and no row without either", () => {
  hotel.checkOutTime = "";
  render();
  expect(timesRow()).toBe("Check-in from 14:00");

  Object.assign(hotel, { checkInTime: "", checkOutTime: "10:30" });
  render();
  expect(timesRow()).toBe("Check-out by 10:30");

  hotel.checkOutTime = "";
  render();
  expect(timesRow()).toBeUndefined();
  expect(details()).toContain(room.description);
});
