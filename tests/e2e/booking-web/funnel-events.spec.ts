import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

// The old room → add-ons → details → payment funnel is retired. The hotel page still
// reports its visit, and only with analytics consent.
for (const analytics of [true, false]) {
  test(`reports the hotel page visit with analytics ${analytics ? "on" : "off"}`, async ({
    page,
  }) => {
    await mockBookingApis(page);
    await page.addInitScript(
      ({ slug, analytics }) =>
        localStorage.setItem(
          `vayada_booking_analytics:${slug}`,
          JSON.stringify({ version: 1, analytics }),
        ),
      { slug: SEEDED_BOOKING_SLUG, analytics },
    );
    const events: { eventType: string; sessionId: string }[] = [];
    await page.route("**/api/booking-web/events", (route) => {
      events.push(route.request().postDataJSON());
      return route.fulfill({ status: 204 });
    });
    await page.goto("/?checkIn=2026-09-12&checkOut=2026-09-15");
    await page.getByRole("link", { name: "Choose rooms and get a price" }).click();
    await expect(page).toHaveURL(/\/en\/book\?checkIn=2026-09-12&checkOut=2026-09-15$/);
    if (!analytics) {
      expect(events).toEqual([]);
      return;
    }
    await expect.poll(() => events.map((event) => event.eventType)).toEqual(["page_visit"]);
    expect(events[0].sessionId).toBeTruthy();
  });
}
