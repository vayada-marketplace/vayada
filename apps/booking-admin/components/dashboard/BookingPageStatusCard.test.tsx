import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/lib/i18n";
import type { BookingPageStatus } from "@/lib/utils/bookingPageStatus";
import { BookingPageStatusView } from "./BookingPageStatusCard";

const ALL = [
  "booking.hotel_profile",
  "booking.page_style",
  "booking.rooms",
  "booking.pricing",
  "booking.calendar",
  "booking.guest_experience",
  "booking.payments",
];

function render(status: BookingPageStatus | null, { busy = false, stalled = false } = {}) {
  return renderToStaticMarkup(
    <LanguageProvider>
      <BookingPageStatusView
        status={status}
        propertyId="f6853000-0000-4000-8000-000000000001"
        busy={busy}
        stalled={stalled}
        onPublish={vi.fn()}
        onRefresh={vi.fn()}
      />
    </LanguageProvider>,
  );
}

function buttons(markup: string) {
  return Array.from(markup.matchAll(/<button[^>]*?(disabled="")?[^>]*>([^<]*)</g), (match) => ({
    label: match[2],
    disabled: match[0].includes('disabled=""'),
  }));
}

describe("BookingPageStatusView", () => {
  it("shows an online page with its link and an open button", () => {
    const markup = render({
      kind: "online",
      url: "https://hotel-alpenrose.booking.vayada.com/",
      items: [],
    });
    expect(markup).toContain("Your booking page");
    expect(markup).toContain(">Online<");
    expect(markup).toContain(">hotel-alpenrose.booking.vayada.com<");
    expect(markup).toContain("Guests can book. Changes you save go live automatically.");
    expect(markup).toContain("Open booking page");
    expect(buttons(markup)).toEqual([]);
  });

  it("says guests can't open a published page that has no guest URL", () => {
    const markup = render({
      kind: "hidden",
      items: [
        { groupId: "booking.payments", message: "Choose how guests can pay.", step: "payments" },
      ],
    });
    expect(markup).toContain(">Offline<");
    expect(markup).toContain("Your page is published, but guests can&#x27;t open it right now.");
    expect(markup).not.toContain("Guests can book");
    expect(markup).toContain("Fix in setup");
    expect(buttons(markup)).toEqual([{ label: "Check again", disabled: false }]);
  });

  it("offers Publish when the page is ready", () => {
    const markup = render({ kind: "ready", readyGroups: ALL });
    expect(markup).toContain(">Offline<");
    expect(markup).toContain("Everything is ready. Publish it so guests can book.");
    expect(markup).toContain("All 7 ready");
    expect(markup).toContain("Guest experience");
    expect(buttons(markup)).toEqual([{ label: "Publish booking page", disabled: false }]);
  });

  it("lists missing items with links to their setup step and keeps Publish off", () => {
    const markup = render({
      kind: "not_ready",
      items: [
        {
          groupId: "booking.calendar",
          message: "Open your calendar and confirm your starting availability.",
          step: "calendar",
        },
        { groupId: "booking.payments", message: "Choose how guests can pay.", step: "payments" },
      ],
      readyGroups: ALL.slice(0, 4),
    });
    expect(markup).toContain("Fix 2 things before you can publish. Guests can&#x27;t book yet.");
    expect(markup).toContain("Open your calendar and confirm your starting availability.");
    const links = Array.from(
      markup.matchAll(/href="([^"]+)"[^>]*>Fix in setup/g),
      // Links are relative since Booking Admin hosts /setup itself (VAY-2261).
      ([, href]) => new URL(href!.replaceAll("&amp;", "&"), "http://booking-admin.test"),
    );
    expect(links.map((url) => url.searchParams.get("step"))).toEqual(["calendar", "payments"]);
    expect(links[0]!.pathname).toBe("/setup");
    expect(links[0]!.searchParams.get("propertyId")).toBe("f6853000-0000-4000-8000-000000000001");
    expect(links[0]!.searchParams.get("returnTo")).toBe("/dashboard");
    expect(markup).toContain(">Ready<");
    expect(buttons(markup)).toEqual([{ label: "Publish booking page", disabled: true }]);
  });

  it("links a hotel location item to the location form (VAY-2288)", () => {
    const markup = render({
      kind: "not_ready",
      readyGroups: [],
      items: [
        {
          groupId: "booking.hotel_profile",
          message: "Turn on 'Show city and country publicly' so guests see where you are.",
          step: "present_hotel",
          focus: "location",
        },
      ],
    });
    expect(markup).toContain("step=present_hotel&amp;focus=location");
  });

  it("does not link items that only need waiting", () => {
    const markup = render({
      kind: "waiting",
      items: [{ groupId: "booking.rooms", message: null, step: null }],
      readyGroups: [],
    });
    expect(markup).toContain("This is still being processed.");
    expect(markup).not.toContain("Fix in setup");
    expect(buttons(markup)).toEqual([{ label: "Check again", disabled: false }]);
  });

  it("shows progress while publishing, then a way to check again", () => {
    expect(buttons(render({ kind: "publishing" }))).toEqual([
      { label: "Publishing…", disabled: true },
    ]);
    const stalled = render({ kind: "publishing" }, { stalled: true });
    expect(stalled).toContain("This is taking longer than usual.");
    expect(buttons(stalled)).toEqual([{ label: "Check again", disabled: false }]);
  });

  it("lets the hotel try again after a failed publication", () => {
    const markup = render({ kind: "failed", readyGroups: ALL });
    expect(markup).toContain("Publishing failed");
    expect(markup).toContain("Nothing changed for guests.");
    expect(buttons(markup)).toEqual([{ label: "Try again", disabled: false }]);
  });

  it("asks to check again when the status can't be read", () => {
    const markup = render({ kind: "unavailable" });
    expect(markup).toContain("We couldn&#x27;t check your booking page right now.");
    expect(buttons(markup)).toEqual([{ label: "Check again", disabled: false }]);
  });
});
